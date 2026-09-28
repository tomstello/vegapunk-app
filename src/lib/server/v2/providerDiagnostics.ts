// Sanitized transport-failure diagnostics for the two OpenRouter call sites.
//
// A failed fetch() surfaces as a generic TypeError('fetch failed') whose real
// story lives in `cause`: a Node system error with `code` (ENOTFOUND,
// ECONNRESET, ETIMEDOUT, ...), `syscall`, and `errno`, or an undici error with
// its own `code` (UND_ERR_CONNECT_TIMEOUT, UND_ERR_SOCKET, ...). Abort-driven
// failures arrive as the abort reason itself. This module flattens that chain
// into a small, log-safe record: error class names, codes, syscalls, and a
// bounded message. It never sees, and must never carry, request bodies,
// message text, or credentials.

export type NetworkErrorDiagnostic = Readonly<{
	/** Error class name of the thrown value (TypeError, AbortError, Error). */
	name: string;
	/** Node/undici error code from the first cause that has one. */
	code?: string;
	/** OS syscall from the first cause that has one (connect, getaddrinfo). */
	syscall?: string;
	errno?: number;
	/** Bounded message of the thrown value. */
	message?: string;
	/** Error class name of the deepest cause, when it differs from `name`. */
	causeName?: string;
	/** Bounded message of the deepest cause. */
	causeMessage?: string;
}>;

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_MESSAGE_CHARS = 200;
const MAX_CAUSE_DEPTH = 4;
// Defensive only: no transport error should ever quote a credential, but a
// bearer-shaped token in a message must not reach the log if one ever does.
const CREDENTIAL_SHAPES = /\b(?:sk-or-[A-Za-z0-9_-]+|Bearer\s+\S+)/g;

function safeToken(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
	return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;
}

function boundedMessage(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const text = value.replace(CREDENTIAL_SHAPES, '[redacted]').replace(/\s+/g, ' ').trim();
	if (!text) return undefined;
	return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function errorName(value: unknown): string {
	if (value && typeof value === 'object') {
		const name = (value as { name?: unknown }).name;
		if (typeof name === 'string' && SAFE_TOKEN.test(name)) return name;
		if (value instanceof Error) return value.constructor.name || 'Error';
		return 'Object';
	}
	return typeof value;
}

/**
 * Flatten an error and its `cause` chain into a log-safe diagnostic.
 * `includeMessage: false` keeps only names and codes, for modules that must
 * not place any free-form text in a log-bound value.
 */
export function networkErrorDiagnostic(
	error: unknown,
	options: { includeMessage?: boolean } = {}
): NetworkErrorDiagnostic {
	const includeMessage = options.includeMessage !== false;
	const name = errorName(error);
	let code: string | undefined;
	let syscall: string | undefined;
	let errno: number | undefined;
	let deepest: unknown = error;
	let cursor: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor && typeof cursor === 'object'; depth += 1) {
		const record = cursor as Record<string, unknown>;
		code ??= safeToken(record.code);
		syscall ??= safeToken(record.syscall);
		if (errno === undefined && typeof record.errno === 'number' && Number.isSafeInteger(record.errno)) {
			errno = record.errno;
		}
		deepest = cursor;
		cursor = record.cause;
	}
	const causeName = deepest !== error ? errorName(deepest) : undefined;
	const message = includeMessage ? boundedMessage((error as { message?: unknown })?.message) : undefined;
	const causeMessage =
		includeMessage && deepest !== error
			? boundedMessage((deepest as { message?: unknown })?.message)
			: undefined;
	return {
		name,
		...(code ? { code } : {}),
		...(syscall ? { syscall } : {}),
		...(errno !== undefined ? { errno } : {}),
		...(message ? { message } : {}),
		...(causeName && causeName !== name ? { causeName } : {}),
		...(causeMessage && causeMessage !== message ? { causeMessage } : {})
	};
}
