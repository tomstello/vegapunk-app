import { providerFetch } from './loadtestStub';
import type { StudyConfig } from './studyConfig';
import {
	MAX_PROVIDER_SSE_EVENT_CHARS,
	OPENROUTER_DEFAULT_RETRY_DELAY_MS,
	OPENROUTER_FIRST_BYTE_TIMEOUT_MS,
	OPENROUTER_HARD_TIMEOUT_MS,
	OPENROUTER_MAX_ATTEMPTS,
	OPENROUTER_MAX_RETRY_AFTER_MS,
	OPENROUTER_RETRYABLE_STATUS_CODES,
	OPENROUTER_STREAM_IDLE_TIMEOUT_MS
} from './limits';
import { networkErrorDiagnostic, type NetworkErrorDiagnostic } from './providerDiagnostics';
import type { HistoryMessage } from './tokens';

const RETRYABLE_STATUS = new Set<number>(OPENROUTER_RETRYABLE_STATUS_CODES);
const MAX_PROVIDER_ERROR_BODY_BYTES = 32_768;
const MAX_PROVIDER_DIAGNOSTIC_ITEMS = 12;
const SAFE_PROVIDER_TOKEN = /^[a-z0-9][a-z0-9._/-]{0,95}$/i;
const SAFE_PROVIDER_ERROR_CODE = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const SAFE_GENERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type ProviderEvent =
	| { kind: 'delta'; text: string }
	| { kind: 'done'; finishReason: string }
	/** `cause` is present when a transport or timeout error, rather than a
	 * provider-emitted error payload, ended the stream. Log-safe; see
	 * providerDiagnostics.ts. */
	| { kind: 'error'; code: string; cause?: NetworkErrorDiagnostic };

/** Which deadline or party stopped a provider attempt. `none` means the fetch
 * itself failed (DNS, TLS, connection reset) without any abort. */
export type ProviderAbortedBy = 'first_byte_timeout' | 'hard_timeout' | 'client' | 'none';

export class OpenRouterStartError extends Error {
	/** Attempts made before this error was surfaced (set by the retry loop). */
	attempts = 1;

	constructor(
		message: string,
		public readonly status: number,
		public readonly code: string,
		public readonly retryable: boolean,
		public readonly retryAfterMs?: number,
		public readonly diagnostic: Readonly<{
			upstreamStatus?: number;
			upstreamCode?: string;
			routingFailure?: 'no_allowed_providers';
			requestedProviders?: readonly string[];
			availableProviders?: readonly string[];
			/** `connect`: fetch() rejected before any response; `first_byte`: the
			 * response started but failed before the first content delta. */
			phase?: 'connect' | 'first_byte';
			abortedBy?: ProviderAbortedBy;
			network?: NetworkErrorDiagnostic;
		}> = {}
	) {
		super(message);
	}
}

function safeGenerationId(value: unknown): string | null {
	return typeof value === 'string' && SAFE_GENERATION_ID.test(value) ? value : null;
}

/** OpenRouter stamps the generation ID on every streamed chunk as `id`; the
 * response header is not guaranteed. Called only until an ID is found. */
function payloadGenerationId(payload: string): string | null {
	if (payload === '[DONE]') return null;
	try {
		const data: unknown = JSON.parse(payload);
		if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
		return safeGenerationId((data as { id?: unknown }).id);
	} catch {
		return null;
	}
}

function abortedBy(args: {
	hardSignal: AbortSignal;
	firstByteSignal: AbortSignal;
	clientSignal: AbortSignal;
}): ProviderAbortedBy {
	if (args.clientSignal.aborted) return 'client';
	if (args.hardSignal.aborted) return 'hard_timeout';
	if (args.firstByteSignal.aborted) return 'first_byte_timeout';
	return 'none';
}

async function boundedProviderErrorJson(response: Response): Promise<unknown> {
	const declaredLength = response.headers.get('content-length');
	if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_PROVIDER_ERROR_BODY_BYTES) {
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
			if (totalBytes > MAX_PROVIDER_ERROR_BODY_BYTES) {
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

function safeProviderList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const safe = value
		.filter((item): item is string => typeof item === 'string' && SAFE_PROVIDER_TOKEN.test(item))
		.slice(0, MAX_PROVIDER_DIAGNOSTIC_ITEMS);
	return safe.length > 0 ? Object.freeze(safe) : undefined;
}

function providerErrorDiagnostic(
	upstreamStatus: number,
	payload: unknown
): OpenRouterStartError['diagnostic'] {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { upstreamStatus };
	const error = 'error' in payload ? payload.error : undefined;
	if (!error || typeof error !== 'object' || Array.isArray(error)) return { upstreamStatus };
	const rawCode = 'code' in error ? error.code : undefined;
	const codeString = typeof rawCode === 'number' ? String(rawCode) : rawCode;
	const upstreamCode =
		typeof codeString === 'string' && SAFE_PROVIDER_ERROR_CODE.test(codeString)
			? codeString
			: undefined;
	const metadata = 'metadata' in error ? error.metadata : undefined;
	const requestedProviders =
		metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'requested_providers' in metadata
			? safeProviderList(metadata.requested_providers)
			: undefined;
	const availableProviders =
		metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'available_providers' in metadata
			? safeProviderList(metadata.available_providers)
			: undefined;
	const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
	const noAllowedProviders =
		upstreamStatus === 404 &&
		Boolean(requestedProviders?.length) &&
		(Array.isArray(
			metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'available_providers' in metadata
				? metadata.available_providers
				: undefined
		) || /no allowed providers are available/i.test(message));
	return {
		upstreamStatus,
		...(upstreamCode ? { upstreamCode } : {}),
		...(noAllowedProviders ? { routingFailure: 'no_allowed_providers' as const } : {}),
		...(requestedProviders ? { requestedProviders } : {}),
		...(availableProviders ? { availableProviders } : {})
	};
}

class ProviderStreamProtocolError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}

class SseDataParser {
	private buffer = '';

	push(text: string): string[] {
		this.buffer += text;
		const output: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer)) !== null) {
			const block = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			if (block.length > MAX_PROVIDER_SSE_EVENT_CHARS) {
				throw new ProviderStreamProtocolError('provider_event_too_large');
			}
			const data = block
				.split(/\r\n|\n|\r/)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).replace(/^ /, ''))
				.join('\n');
			if (data) output.push(data);
		}
		if (this.buffer.length > MAX_PROVIDER_SSE_EVENT_CHARS) {
			throw new ProviderStreamProtocolError('provider_event_too_large');
		}
		return output;
	}

	finish(): string[] {
		if (!this.buffer.trim()) return [];
		return this.push('\n\n');
	}
}

function parseProviderPayload(payload: string): ProviderEvent[] {
	// [DONE] is only a transport terminator. It is not evidence that the model
	// finished normally; a real choices[0].finish_reason must precede it.
	if (payload === '[DONE]') return [{ kind: 'error', code: 'missing_finish_reason' }];
	let data: {
		type?: unknown;
		error?: { code?: unknown } | unknown;
		error_type?: unknown;
		choices?: Array<{
			delta?: { content?: unknown };
			finish_reason?: unknown;
		}>;
	};
	try {
		data = JSON.parse(payload) as typeof data;
	} catch {
		return [{ kind: 'error', code: 'malformed_upstream_event' }];
	}
	if (data?.error || data?.type === 'error' || data?.type === 'response.error' || data?.type === 'response.failed') {
		const errorCode =
			data.error && typeof data.error === 'object' && 'code' in data.error
				? data.error.code
				: undefined;
		const code = String(errorCode ?? data?.error_type ?? data?.type ?? 'provider_error').slice(0, 64);
		return [{ kind: 'error', code }];
	}
	const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
	const content = choice?.delta?.content;
	const events: ProviderEvent[] = [];
	if (typeof content === 'string' && content.length > 0) events.push({ kind: 'delta', text: content });
	if (choice?.finish_reason) {
		events.push({ kind: 'done', finishReason: String(choice.finish_reason).slice(0, 64) });
	}
	return events;
}

function retryAfterMs(response: Response): number | undefined {
	const raw = response.headers.get('retry-after');
	if (!raw) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(raw.trim())) return Math.max(0, Number(raw) * 1_000);
	const date = Date.parse(raw);
	if (!Number.isFinite(date)) return undefined;
	return Math.max(0, date - Date.now());
}

function abortSignal(signals: AbortSignal[]): AbortSignal {
	return AbortSignal.any(signals);
}

async function jitteredDelay(maximumMs: number, signal: AbortSignal): Promise<void> {
	const duration = Math.floor(Math.random() * Math.max(1, maximumMs));
	await new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(resolve, duration);
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

type PreparedAttempt = {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	decoder: TextDecoder;
	parser: SseDataParser;
	pending: ProviderEvent[];
	abort: AbortController;
	generationId: string | null;
};

async function prepareAttempt(args: {
	config: StudyConfig;
	history: readonly HistoryMessage[];
	userMessage: string;
	providerSessionId: string;
	apiKey: string;
	hardSignal: AbortSignal;
	firstByteSignal: AbortSignal;
	clientSignal: AbortSignal;
}): Promise<PreparedAttempt> {
	const attemptAbort = new AbortController();
	const signal = abortSignal([
		attemptAbort.signal,
		args.hardSignal,
		args.firstByteSignal,
		args.clientSignal
	]);
	let response: Response;
	try {
		response = await providerFetch(args.config.model.baseUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${args.apiKey}`,
				'content-type': 'application/json',
				'http-referer': 'https://vegapunk-albertsons.vercel.app',
				'x-title': 'Albertsons Vaccine Information Study'
			},
			body: JSON.stringify({
				model: args.config.model.name,
				session_id: args.providerSessionId,
				messages: [
					{
						role: 'system',
						content: [
							{
								type: 'text',
								text: args.config.systemPrompt,
								cache_control: args.config.model.cacheControl
							}
						]
					},
					...args.config.initialMessages.map(({ content }) => ({ role: 'assistant', content })),
					...args.history.map(({ role, content }) => ({ role, content })),
					{ role: 'user', content: args.userMessage }
				],
					stream: true,
				...(args.config.model.temperature === null
					? {}
					: { temperature: args.config.model.temperature }),
				...(args.config.model.reasoning ? { reasoning: args.config.model.reasoning } : {}),
				// Bounds OpenRouter's pre-flight credit hold, not the answer: see
				// StudyConfig['model'].maxTokens. Absent on revisions before v11.
				...(args.config.model.maxTokens !== undefined ? { max_tokens: args.config.model.maxTokens } : {}),
				provider: args.config.model.provider
			}),
			signal
		});
	} catch (error) {
		attemptAbort.abort();
		const timeout = !args.hardSignal.aborted && !args.clientSignal.aborted;
		// The generic fetch failure hides the useful part (DNS, TLS, reset,
		// undici connect timeout) in `cause`; keep a sanitized copy for the log.
		throw new OpenRouterStartError(
			timeout ? 'Provider did not start in time' : 'Provider request was cancelled',
			503,
			timeout ? 'provider_start_timeout' : 'provider_unavailable',
			timeout,
			undefined,
			{ phase: 'connect', abortedBy: abortedBy(args), network: networkErrorDiagnostic(error) }
		);
	}
	if (!response.ok || !response.body) {
		const payload = await boundedProviderErrorJson(response);
		const diagnostic = providerErrorDiagnostic(response.status, payload);
		attemptAbort.abort();
		const routingFailure = diagnostic.routingFailure === 'no_allowed_providers';
		const retryable = !routingFailure && RETRYABLE_STATUS.has(response.status);
		throw new OpenRouterStartError(
			`Provider returned ${response.status}`,
			response.status === 429 ? 429 : 503,
			routingFailure
				? 'provider_route_unavailable'
				: response.status === 429
					? 'provider_busy'
					: 'provider_unavailable',
			retryable,
			retryAfterMs(response),
			diagnostic
		);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const parser = new SseDataParser();
	const pending: ProviderEvent[] = [];
	let generationId = safeGenerationId(response.headers.get('x-generation-id'));
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				throw new OpenRouterStartError('Provider ended before producing output', 503, 'provider_empty', true);
			}
			const payloads = parser.push(decoder.decode(result.value, { stream: true }));
			for (const payload of payloads) {
				generationId ??= payloadGenerationId(payload);
				const events = parseProviderPayload(payload);
				for (const event of events) {
					const hasDelta = pending.some((candidate) => candidate.kind === 'delta');
					if (event.kind === 'error' && !hasDelta) {
						throw new OpenRouterStartError('Provider failed before producing output', 503, 'provider_error', true);
					}
					if (event.kind === 'done' && !hasDelta) {
						throw new OpenRouterStartError('Provider returned no answer', 503, 'provider_empty', true);
					}
					pending.push(event);
				}
			}
			if (pending.some((event) => event.kind === 'delta')) {
				return {
					reader,
					decoder,
					parser,
					pending,
					abort: attemptAbort,
					generationId
				};
			}
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		attemptAbort.abort();
		if (error instanceof OpenRouterStartError) throw error;
		if (error instanceof ProviderStreamProtocolError) {
			throw new OpenRouterStartError(
				'Provider returned an invalid stream',
				503,
				error.code,
				true,
				undefined,
				{ phase: 'first_byte' }
			);
		}
		const timeout = !args.hardSignal.aborted && !args.clientSignal.aborted;
		throw new OpenRouterStartError(
			timeout ? 'Provider did not start in time' : 'Provider request was cancelled',
			503,
			timeout ? 'provider_start_timeout' : 'provider_unavailable',
			timeout,
			undefined,
			{ phase: 'first_byte', abortedBy: abortedBy(args), network: networkErrorDiagnostic(error) }
		);
	}
}

export type OpenRouterStream = {
	generationId: string | null;
	events: () => AsyncGenerator<ProviderEvent>;
	cancel: () => void;
};

export async function startOpenRouterStream(args: {
	config: StudyConfig;
	history: readonly HistoryMessage[];
	userMessage: string;
	providerSessionId: string;
	apiKey: string;
	clientSignal: AbortSignal;
}): Promise<OpenRouterStream> {
	const configuredMaxAttempts = args.config.runtimePolicy.providerMaxAttempts;
	const maxAttempts =
		typeof configuredMaxAttempts === 'number' &&
		Number.isSafeInteger(configuredMaxAttempts) &&
		configuredMaxAttempts >= 1 &&
		configuredMaxAttempts <= OPENROUTER_MAX_ATTEMPTS
			? configuredMaxAttempts
			: OPENROUTER_MAX_ATTEMPTS;
	const hardAbort = new AbortController();
	const firstByteAbort = new AbortController();
	const hardTimer = setTimeout(
		() => hardAbort.abort(new Error('hard_model_timeout')),
		OPENROUTER_HARD_TIMEOUT_MS
	);
	const firstByteTimer = setTimeout(
		() => firstByteAbort.abort(new Error('first_byte_timeout')),
		OPENROUTER_FIRST_BYTE_TIMEOUT_MS
	);
	let prepared: PreparedAttempt | undefined;
	let lastError: OpenRouterStartError | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			prepared = await prepareAttempt({
				...args,
				hardSignal: hardAbort.signal,
				firstByteSignal: firstByteAbort.signal
			});
			break;
		} catch (error) {
			lastError =
				error instanceof OpenRouterStartError
					? error
					: new OpenRouterStartError('Provider unavailable', 503, 'provider_unavailable', false, undefined, {
							network: networkErrorDiagnostic(error)
						});
			lastError.attempts = attempt;
			const shortRetryAfter =
				lastError.retryAfterMs === undefined || lastError.retryAfterMs <= OPENROUTER_MAX_RETRY_AFTER_MS;
			if (
				attempt >= maxAttempts ||
				!lastError.retryable ||
				!shortRetryAfter ||
				hardAbort.signal.aborted ||
				firstByteAbort.signal.aborted ||
				args.clientSignal.aborted
			) {
				clearTimeout(firstByteTimer);
				clearTimeout(hardTimer);
				throw lastError;
			}
			try {
				await jitteredDelay(
					lastError.retryAfterMs ?? OPENROUTER_DEFAULT_RETRY_DELAY_MS,
					abortSignal([hardAbort.signal, firstByteAbort.signal, args.clientSignal])
				);
			} catch {
				clearTimeout(firstByteTimer);
				clearTimeout(hardTimer);
				throw lastError;
			}
		}
	}
	if (!prepared) {
		clearTimeout(firstByteTimer);
		clearTimeout(hardTimer);
		throw lastError ?? new OpenRouterStartError('Provider unavailable', 503, 'provider_unavailable', false);
	}
	clearTimeout(firstByteTimer);

	const eventGenerator = async function* (): AsyncGenerator<ProviderEvent> {
		try {
			for (const event of prepared.pending) {
				yield event;
				if (event.kind === 'done' || event.kind === 'error') return;
			}
			while (true) {
				let idleTimer: ReturnType<typeof setTimeout> | undefined;
				const idle = new Promise<never>((_, reject) => {
					idleTimer = setTimeout(() => reject(new Error('stream_idle_timeout')), OPENROUTER_STREAM_IDLE_TIMEOUT_MS);
				});
				let result: ReadableStreamReadResult<Uint8Array>;
				try {
					result = await Promise.race([prepared.reader.read(), idle]);
				} finally {
					if (idleTimer) clearTimeout(idleTimer);
				}
				if (result.done) {
					const finalText = prepared.decoder.decode();
					if (finalText) {
						for (const payload of prepared.parser.push(finalText)) {
							for (const event of parseProviderPayload(payload)) yield event;
						}
					}
					for (const payload of prepared.parser.finish()) {
						for (const event of parseProviderPayload(payload)) yield event;
					}
					yield { kind: 'error', code: 'upstream_eof' };
					return;
				}
				const text = prepared.decoder.decode(result.value, { stream: true });
				for (const payload of prepared.parser.push(text)) {
					for (const event of parseProviderPayload(payload)) {
						yield event;
						if (event.kind === 'done' || event.kind === 'error') return;
					}
				}
			}
		} catch (error) {
			// Not a provider error payload: the socket dropped, a decoder or SSE
			// bound tripped, the idle/hard deadline fired, or the client went
			// away. The code stays coarse for the participant; `cause` carries
			// the specifics (error name, ECONNRESET-style code, idle vs hard
			// timeout message) to the route's v2_stream_failure log event.
			yield {
				kind: 'error',
				code:
					error instanceof ProviderStreamProtocolError
						? error.code
						: hardAbort.signal.aborted
							? 'model_timeout'
							: 'stream_interrupted',
				...(error instanceof ProviderStreamProtocolError ? {} : { cause: networkErrorDiagnostic(error) })
			};
		} finally {
			clearTimeout(hardTimer);
			await prepared.reader.cancel().catch(() => undefined);
			prepared.abort.abort();
		}
	};

	return {
		generationId: prepared.generationId,
		events: eventGenerator,
		cancel: () => {
			clearTimeout(firstByteTimer);
			clearTimeout(hardTimer);
			prepared?.abort.abort();
			hardAbort.abort();
		}
	};
}
