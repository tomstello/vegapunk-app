import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';

// Load-test provider stub. When active, the OpenRouter calls made by the
// scrubber (non-streaming JSON) and the answer relay (SSE) are answered
// in-process with synthetic responses whose timing mirrors the measured
// production profile, so Vercel concurrency, cold starts, and streaming
// duration can be exercised at zero model spend.
//
// The stub is fail-closed on host: it engages only on the local dev server
// or on the dedicated load-test Vercel project. Any other Vercel project that
// sets PROVIDER_STUB=1 (env drift, a copied env file) is refused and logs an
// error, and real provider traffic continues unchanged.

export const LOADTEST_PRODUCTION_HOST = 'vaccine-chat-loadtest.vercel.app';

export type StubSettings = Readonly<{
	/** Scrubber (non-streaming) response delay. */
	scrubMs: number;
	/** Delay before the first answer delta. */
	firstByteMs: number;
	/** Duration over which the answer deltas are spread. */
	streamMs: number;
	/** Total answer length in characters. */
	answerChars: number;
	/** Target interval between deltas. */
	chunkMs: number;
	/** Fractional +/- jitter applied to every delay (0.3 = +/-30%). */
	jitter: number;
	/** Probability that a provider call returns HTTP 429 instead. */
	errorRate: number;
	/** Retry-After seconds sent with a synthetic 429. */
	retryAfterSeconds: number;
}>;

export type LoadtestPolicy = Readonly<{
	/** Provider calls are answered by the stub. */
	stub: boolean;
	/** Responses carry the x-loadtest-instance header. */
	instanceHeader: boolean;
	/** A stub/header request was present but refused by the host guard. */
	refused: boolean;
	settings: StubSettings;
}>;

type EnvSource = Readonly<Record<string, string | undefined>>;

// Defaults follow the single-request production measurements recorded in
// "WHAT WE ALREADY KNOW.md" (2026-08): scrub ~0.75 s, first delta ~2 s,
// short answers complete in ~5-10 s.
const DEFAULT_SETTINGS: StubSettings = Object.freeze({
	scrubMs: 750,
	firstByteMs: 2_000,
	streamMs: 6_000,
	answerChars: 900,
	chunkMs: 50,
	jitter: 0.3,
	errorRate: 0,
	retryAfterSeconds: 1
});

function numberSetting(
	source: EnvSource,
	key: string,
	fallback: number,
	minimum: number,
	maximum: number
): number {
	const raw = source[key];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, value));
}

export function resolveStubSettings(source: EnvSource): StubSettings {
	return Object.freeze({
		scrubMs: numberSetting(source, 'STUB_SCRUB_MS', DEFAULT_SETTINGS.scrubMs, 0, 60_000),
		firstByteMs: numberSetting(source, 'STUB_FIRST_BYTE_MS', DEFAULT_SETTINGS.firstByteMs, 0, 120_000),
		streamMs: numberSetting(source, 'STUB_STREAM_MS', DEFAULT_SETTINGS.streamMs, 0, 240_000),
		answerChars: numberSetting(source, 'STUB_ANSWER_CHARS', DEFAULT_SETTINGS.answerChars, 1, 15_000),
		chunkMs: numberSetting(source, 'STUB_CHUNK_MS', DEFAULT_SETTINGS.chunkMs, 1, 10_000),
		jitter: numberSetting(source, 'STUB_JITTER', DEFAULT_SETTINGS.jitter, 0, 1),
		errorRate: numberSetting(source, 'STUB_ERROR_RATE', DEFAULT_SETTINGS.errorRate, 0, 1),
		retryAfterSeconds: numberSetting(
			source,
			'STUB_RETRY_AFTER_SECONDS',
			DEFAULT_SETTINGS.retryAfterSeconds,
			0,
			60
		)
	});
}

/**
 * Pure policy resolution. Exported for tests; runtime callers use
 * loadtestPolicy(), which reads the process environment once.
 *
 * Allowed hosts: the Vite dev server (NODE_ENV=development), or a Vercel
 * deployment whose project production URL is the load-test project. The
 * Vercel check relies on the project's "automatically expose system
 * environment variables" setting (on by default); with it off the stub is
 * refused, which is the safe direction.
 */
export function resolveLoadtestPolicy(source: EnvSource): LoadtestPolicy {
	const settings = resolveStubSettings(source);
	const wantStub = source.PROVIDER_STUB === '1';
	const wantHeader = wantStub || source.LOADTEST_INSTANCE_HEADER === '1';
	if (!wantHeader) return { stub: false, instanceHeader: false, refused: false, settings };

	const onDevServer = source.NODE_ENV === 'development';
	const onVercel = source.VERCEL === '1';
	const onLoadtestProject =
		onVercel && source.VERCEL_PROJECT_PRODUCTION_URL === LOADTEST_PRODUCTION_HOST;
	if (!onDevServer && !onLoadtestProject) {
		return { stub: false, instanceHeader: false, refused: true, settings };
	}
	return { stub: wantStub, instanceHeader: wantHeader, refused: false, settings };
}

let cachedPolicy: LoadtestPolicy | undefined;

/** Process-wide policy, resolved once from the environment. This module stays
 * free of the logger so unit tests can bundle it; hooks.server.ts logs the
 * outcome once per instance. */
export function loadtestPolicy(): LoadtestPolicy {
	if (!cachedPolicy) cachedPolicy = resolveLoadtestPolicy(env);
	return cachedPolicy;
}

// --- Instance identity -------------------------------------------------------
// One id per module instantiation, which on Vercel approximates one function
// instance. The header lets a load generator count distinct instances and
// separate the first requests an instance serves from its steady state.

const INSTANCE_ID = randomUUID().slice(0, 8);
const BOOT_AT = Date.now();
let served = 0;

export function instanceHeaderValue(): string {
	served += 1;
	return `${INSTANCE_ID};age=${Date.now() - BOOT_AT};n=${served}`;
}

// --- Synthetic provider responses ---------------------------------------------

const encoder = new TextEncoder();
const FILLER =
	'Vaccines are reviewed for safety before approval and monitored afterwards. ' +
	'Most side effects are mild, such as a sore arm or tiredness, and pass within a day or two. ' +
	'A pharmacist or doctor can help with questions about your own situation. ';

function answerText(chars: number): string {
	let text = '';
	while (text.length < chars) text += FILLER;
	return text.slice(0, chars);
}

function jittered(ms: number, jitter: number): number {
	if (ms <= 0) return 0;
	const factor = 1 + (Math.random() * 2 - 1) * jitter;
	return Math.max(0, Math.round(ms * factor));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error('aborted'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error('aborted'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function sseData(payload: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function stubAnswerStream(
	generationId: string,
	settings: StubSettings,
	signal: AbortSignal
): ReadableStream<Uint8Array> {
	const text = answerText(settings.answerChars);
	const chunkCount = Math.max(1, Math.round(settings.streamMs / settings.chunkMs));
	const chunkChars = Math.max(1, Math.ceil(text.length / chunkCount));
	const chunkInterval = settings.streamMs / chunkCount;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			let offset = 0;
			const stop = () => {
				finished = true;
				if (timer) clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
			};
			const onAbort = () => {
				if (finished) return;
				stop();
				try {
					controller.error(signal.reason ?? new Error('aborted'));
				} catch {
					// Already closed or errored.
				}
			};
			const tick = () => {
				if (finished) return;
				if (offset >= text.length) {
					controller.enqueue(
						sseData({
							id: generationId,
							object: 'chat.completion.chunk',
							choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
						})
					);
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					stop();
					controller.close();
					return;
				}
				const piece = text.slice(offset, offset + chunkChars);
				offset += piece.length;
				controller.enqueue(
					sseData({
						id: generationId,
						object: 'chat.completion.chunk',
						choices: [
							{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }
						]
					})
				);
				timer = setTimeout(tick, jittered(chunkInterval, settings.jitter));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
			// OpenRouter emits keep-alive comments before the first delta.
			controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
			timer = setTimeout(tick, jittered(settings.firstByteMs, settings.jitter));
		},
		cancel() {
			finished = true;
			if (timer) clearTimeout(timer);
		}
	});
}

/**
 * Builds the synthetic provider Response for one chat-completions request.
 * Streaming requests get an SSE answer; everything else is treated as a
 * scrubber call and receives an empty span report after the scrub delay.
 */
export async function createStubProviderResponse(
	requestBody: string,
	settings: StubSettings,
	signal?: AbortSignal | null
): Promise<Response> {
	const effectiveSignal = signal ?? new AbortController().signal;
	let body: { stream?: unknown } = {};
	try {
		body = JSON.parse(requestBody) as typeof body;
	} catch {
		// A malformed body is still answered; the stub never inspects message text.
	}
	if (settings.errorRate > 0 && Math.random() < settings.errorRate) {
		return new Response(
			JSON.stringify({ error: { code: 429, message: 'loadtest stub: synthetic provider_busy' } }),
			{
				status: 429,
				headers: {
					'content-type': 'application/json',
					'retry-after': String(settings.retryAfterSeconds)
				}
			}
		);
	}
	const generationId = `stub-${randomUUID()}`;
	if (body.stream !== true) {
		await sleep(jittered(settings.scrubMs, settings.jitter), effectiveSignal);
		return new Response(
			JSON.stringify({
				id: generationId,
				object: 'chat.completion',
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: '{"spans":[]}' },
						finish_reason: 'stop'
					}
				]
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	}
	return new Response(stubAnswerStream(generationId, settings, effectiveSignal), {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			'x-generation-id': generationId
		}
	});
}

/**
 * Drop-in for fetch() at the two provider call sites. Resolves to the real
 * global fetch (so unit tests that replace globalThis.fetch keep working)
 * unless the load-test stub is active.
 */
export async function providerFetch(url: string, init: RequestInit): Promise<Response> {
	const policy = loadtestPolicy();
	if (policy.stub) {
		return createStubProviderResponse(
			typeof init.body === 'string' ? init.body : '',
			policy.settings,
			init.signal
		);
	}
	return fetch(url, init);
}
