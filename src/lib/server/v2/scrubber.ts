import { MAX_USER_CODE_POINTS, OPENROUTER_RETRYABLE_STATUS_CODES } from './limits';
import type { ScrubberConfig, ScrubberModel } from './studyConfig';
import type { HistoryMessage } from './tokens';

// PII redaction screen for the incoming user turn. The scrubber model only
// REPORTS exact spans; this module verifies each span verbatim and performs
// the substitution itself, so the model can never rewrite, truncate, or
// paraphrase the participant's text outside verified spans. Failures are
// fail-closed: the caller must not relay or store the raw turn when this
// module throws. No function here may place message text in an Error,
// diagnostic, or log-bound value.

const RETRYABLE_STATUS = new Set<number>(OPENROUTER_RETRYABLE_STATUS_CODES);
const MAX_SCRUB_RESPONSE_BYTES = 65_536;
const MAX_SPANS_PER_MESSAGE = 50;
const MAX_SPAN_TEXT_CHARS = 300;
const MAX_CONTEXT_USER_TURNS = 6;
const SCRUB_RETRY_DELAY_MS = 250;
// Matches the placeholder grammar the study uses in stored transcripts. A
// span that IS a placeholder is the model misreading already-redacted text
// (possible on a retry re-scrub); it is dropped rather than double-wrapped.
const PLACEHOLDER_ONLY = /^\[[A-Z]{2,16}_\d{1,3}\]$/;
const PLACEHOLDER_SCAN = /\[([A-Z]{2,16})_(\d{1,3})\]/g;

export class ScrubberError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'scrub_unavailable'
			| 'scrub_timeout'
			| 'scrub_invalid_output'
			| 'scrub_length',
		public readonly retryable: boolean
	) {
		super(message);
	}
}

export type ScrubSpan = { text: string; category: string; reuse?: number };

export type ScrubResult = {
	text: string;
	spanCount: number;
	attempts: number;
	usedFallback: boolean;
};

function countCodePoints(value: string): number {
	return Array.from(value).length;
}

/** Highest placeholder index already used per category across the redacted
 * history. New placeholders continue numbering from here so a conversation
 * never reuses an index for a different entity. */
export function placeholderInventory(
	history: readonly HistoryMessage[],
	categories: readonly string[]
): Record<string, number> {
	const allowed = new Set(categories);
	const inventory: Record<string, number> = {};
	for (const message of history) {
		for (const match of message.content.matchAll(PLACEHOLDER_SCAN)) {
			const category = match[1];
			if (!allowed.has(category)) continue;
			const index = Number(match[2]);
			if (!Number.isSafeInteger(index) || index < 1) continue;
			if ((inventory[category] ?? 0) < index) inventory[category] = index;
		}
	}
	return inventory;
}

type ClaimedOccurrence = { start: number; end: number; placeholder: string };

/**
 * Deterministically applies model-reported spans to the raw message.
 *
 * Occurrences are located in the ORIGINAL string and claimed longest-span
 * first without overlap, then spliced right-to-left, so a replacement can
 * never corrupt an earlier insertion or a pre-existing placeholder.
 *
 * Throws ScrubberError('scrub_invalid_output') when the report is unfaithful
 * (a span that does not appear verbatim, or one text with two categories) —
 * the caller treats that as a failed attempt, never as "apply what matched".
 */
export function applySpans(
	rawMessage: string,
	spans: readonly ScrubSpan[],
	categories: readonly string[],
	inventory: Record<string, number>
): { text: string; spanCount: number } {
	const allowed = new Set(categories);
	const byText = new Map<string, ScrubSpan>();
	for (const span of spans) {
		if (PLACEHOLDER_ONLY.test(span.text)) continue;
		const existing = byText.get(span.text);
		if (existing && existing.category !== span.category) {
			throw new ScrubberError(
				'Scrubber reported one span with two categories',
				'scrub_invalid_output',
				true
			);
		}
		if (!existing) byText.set(span.text, span);
	}
	for (const span of byText.values()) {
		if (!allowed.has(span.category)) {
			throw new ScrubberError('Scrubber reported an unknown category', 'scrub_invalid_output', true);
		}
		if (!rawMessage.includes(span.text)) {
			throw new ScrubberError(
				'Scrubber reported a span that is not verbatim in the message',
				'scrub_invalid_output',
				true
			);
		}
	}

	const counters: Record<string, number> = { ...inventory };
	const ordered = [...byText.values()].sort(
		(a, b) => b.text.length - a.text.length || (a.text < b.text ? -1 : 1)
	);
	const claimed: ClaimedOccurrence[] = [];
	const overlaps = (start: number, end: number): boolean =>
		claimed.some((occupied) => start < occupied.end && end > occupied.start);

	for (const span of ordered) {
		let placeholder: string | undefined;
		let cursor = 0;
		while (cursor <= rawMessage.length) {
			const start = rawMessage.indexOf(span.text, cursor);
			if (start === -1) break;
			const end = start + span.text.length;
			cursor = start + 1;
			if (overlaps(start, end)) continue;
			if (!placeholder) {
				const maxExisting = inventory[span.category] ?? 0;
				const reuseValid =
					span.reuse !== undefined &&
					Number.isSafeInteger(span.reuse) &&
					span.reuse >= 1 &&
					span.reuse <= maxExisting;
				const index = reuseValid
					? (span.reuse as number)
					: (counters[span.category] = (counters[span.category] ?? 0) + 1);
				placeholder = `[${span.category}_${index}]`;
			}
			claimed.push({ start, end, placeholder });
			cursor = end;
		}
	}

	claimed.sort((a, b) => a.start - b.start);
	let text = '';
	let position = 0;
	for (const occurrence of claimed) {
		text += rawMessage.slice(position, occurrence.start) + occurrence.placeholder;
		position = occurrence.end;
	}
	text += rawMessage.slice(position);

	if (text.length === 0) {
		throw new ScrubberError('Redaction produced an empty message', 'scrub_invalid_output', true);
	}
	if (countCodePoints(text) > MAX_USER_CODE_POINTS) {
		throw new ScrubberError(
			'Redaction pushed the message over the protocol length limit',
			'scrub_length',
			false
		);
	}
	return { text, spanCount: claimed.length };
}

async function boundedJsonBody(response: Response): Promise<unknown> {
	const declaredLength = response.headers.get('content-length');
	if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_SCRUB_RESPONSE_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			totalBytes += result.value.byteLength;
			if (totalBytes > MAX_SCRUB_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				return undefined;
			}
			chunks.push(result.value);
		}
	} catch {
		await reader.cancel().catch(() => undefined);
		return undefined;
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
}

function parseSpanReport(content: string): ScrubSpan[] {
	// The contract demands a bare JSON object; tolerate a fenced block because
	// refusing one would fail the turn for pure formatting noise.
	let text = content.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
	if (fence) text = fence[1].trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ScrubberError('Scrubber output was not JSON', 'scrub_invalid_output', true);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('spans' in parsed)) {
		throw new ScrubberError('Scrubber output had the wrong shape', 'scrub_invalid_output', true);
	}
	const spans = (parsed as { spans: unknown }).spans;
	if (!Array.isArray(spans) || spans.length > MAX_SPANS_PER_MESSAGE) {
		throw new ScrubberError('Scrubber span list was invalid', 'scrub_invalid_output', true);
	}
	return spans.map((entry) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new ScrubberError('Scrubber span entry was invalid', 'scrub_invalid_output', true);
		}
		const record = entry as Record<string, unknown>;
		const text = record.text;
		const category = record.category;
		const reuse = record.reuse;
		if (
			typeof text !== 'string' ||
			text.length < 1 ||
			text.length > MAX_SPAN_TEXT_CHARS ||
			typeof category !== 'string'
		) {
			throw new ScrubberError('Scrubber span entry was invalid', 'scrub_invalid_output', true);
		}
		if (reuse !== undefined && (typeof reuse !== 'number' || !Number.isSafeInteger(reuse))) {
			throw new ScrubberError('Scrubber span entry was invalid', 'scrub_invalid_output', true);
		}
		return reuse === undefined ? { text, category } : { text, category, reuse };
	});
}

function scrubCallInput(
	userMessage: string,
	history: readonly HistoryMessage[],
	inventory: Record<string, number>
): string {
	// Redacted prior user turns give the model coreference context ("anything
	// else in [CITY_1]?") without shipping long assistant answers. History
	// content is already redacted under this revision, so nothing here widens
	// exposure beyond the new message itself.
	const recentUserTurns = history
		.filter((message) => message.role === 'user')
		.slice(-MAX_CONTEXT_USER_TURNS)
		.map((message) => message.content);
	return JSON.stringify({
		usedPlaceholders: inventory,
		recentUserTurns,
		newUserMessage: userMessage
	});
}

async function delay(durationMs: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, durationMs);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}

async function attemptModel(args: {
	model: ScrubberModel;
	prompt: string;
	categories: readonly string[];
	timeoutMs: number;
	input: string;
	rawMessage: string;
	inventory: Record<string, number>;
	apiKey: string;
	clientSignal: AbortSignal;
}): Promise<{ text: string; spanCount: number }> {
	const timeoutAbort = new AbortController();
	const timer = setTimeout(() => timeoutAbort.abort(new Error('scrub_timeout')), args.timeoutMs);
	try {
		let response: Response;
		try {
			response = await fetch(args.model.baseUrl, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${args.apiKey}`,
					'content-type': 'application/json',
					'http-referer': 'https://vegapunk-albertsons.vercel.app',
					'x-title': 'Albertsons Vaccine Information Study'
				},
				body: JSON.stringify({
					model: args.model.name,
					messages: [
						{ role: 'system', content: args.prompt },
						{ role: 'user', content: args.input }
					],
					stream: false,
					max_tokens: args.model.maxTokens,
					...(args.model.reasoning ? { reasoning: args.model.reasoning } : {}),
					...(args.model.temperature === undefined
						? {}
						: { temperature: args.model.temperature }),
					provider: args.model.provider
				}),
				signal: AbortSignal.any([timeoutAbort.signal, args.clientSignal])
			});
		} catch {
			const timedOut = timeoutAbort.signal.aborted && !args.clientSignal.aborted;
			throw new ScrubberError(
				timedOut ? 'Redaction screen timed out' : 'Redaction screen request failed',
				timedOut ? 'scrub_timeout' : 'scrub_unavailable',
				true
			);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new ScrubberError(
				`Redaction screen returned ${response.status}`,
				'scrub_unavailable',
				RETRYABLE_STATUS.has(response.status)
			);
		}
		const payload = await boundedJsonBody(response);
		const choice =
			payload && typeof payload === 'object' && 'choices' in payload && Array.isArray(payload.choices)
				? payload.choices[0]
				: undefined;
		const message =
			choice && typeof choice === 'object' && 'message' in choice ? choice.message : undefined;
		const content =
			message && typeof message === 'object' && 'content' in message ? message.content : undefined;
		if (typeof content !== 'string' || content.length === 0) {
			throw new ScrubberError('Redaction screen returned no report', 'scrub_invalid_output', true);
		}
		const spans = parseSpanReport(content);
		return applySpans(args.rawMessage, spans, args.categories, args.inventory);
	} finally {
		clearTimeout(timer);
	}
}

export async function scrubUserMessage(args: {
	scrubber: ScrubberConfig;
	history: readonly HistoryMessage[];
	userMessage: string;
	apiKey: string;
	clientSignal: AbortSignal;
}): Promise<ScrubResult> {
	const { scrubber } = args;
	const inventory = placeholderInventory(args.history, scrubber.categories);
	const input = scrubCallInput(args.userMessage, args.history, inventory);
	const maxAttempts = Math.min(Math.max(scrubber.maxAttempts, 1), 3);
	const shared = {
		prompt: scrubber.prompt,
		categories: scrubber.categories,
		timeoutMs: scrubber.timeoutMs,
		input,
		rawMessage: args.userMessage,
		inventory,
		apiKey: args.apiKey,
		clientSignal: args.clientSignal
	};
	let lastError: ScrubberError | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const applied = await attemptModel({ model: scrubber.model, ...shared });
			return { ...applied, attempts: attempt, usedFallback: false };
		} catch (error) {
			lastError =
				error instanceof ScrubberError
					? error
					: new ScrubberError('Redaction screen failed', 'scrub_unavailable', true);
			const canRetry = lastError.retryable && attempt < maxAttempts && !args.clientSignal.aborted;
			if (!canRetry) break;
			try {
				await delay(SCRUB_RETRY_DELAY_MS, args.clientSignal);
			} catch {
				break;
			}
		}
	}

	// Cross-vendor fail-over: one attempt, only after the primary is fully
	// exhausted and only when the participant hasn't cancelled. Content-
	// deterministic failures (scrub_length) are not model outages — a second
	// vendor would fail the same way, so those surface immediately.
	if (
		scrubber.fallbackModel &&
		lastError &&
		lastError.code !== 'scrub_length' &&
		!args.clientSignal.aborted
	) {
		try {
			const applied = await attemptModel({ model: scrubber.fallbackModel, ...shared });
			return { ...applied, attempts: maxAttempts + 1, usedFallback: true };
		} catch (error) {
			throw error instanceof ScrubberError ? error : lastError;
		}
	}
	throw lastError ?? new ScrubberError('Redaction screen failed', 'scrub_unavailable', true);
}
