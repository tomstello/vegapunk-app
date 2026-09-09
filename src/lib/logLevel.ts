// Log level resolution, kept dependency-free so unit tests can bundle it
// without pulling in pino. The logger reads the process environment once at
// module load, so a changed LOG_LEVEL takes effect on the next deployment (or
// dev-server restart), never on a running instance.

export const LOG_LEVELS = Object.freeze([
	'fatal',
	'error',
	'warn',
	'info',
	'debug',
	'trace',
	'silent'
] as const);

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_SET: ReadonlySet<string> = new Set(LOG_LEVELS);

export type ResolvedLogLevel = Readonly<{
	level: LogLevel;
	/** The LOG_LEVEL value that was ignored because it is not a pino level. */
	rejected?: string;
}>;

/**
 * LOG_LEVEL wins when it names a pino level (case-insensitive). Otherwise the
 * historical defaults apply: debug on the Vite dev server, info everywhere else.
 */
export function resolveLogLevel(
	source: Readonly<Record<string, string | undefined>>
): ResolvedLogLevel {
	const fallback: LogLevel = source.NODE_ENV === 'development' ? 'debug' : 'info';
	const raw = source.LOG_LEVEL?.trim() ?? '';
	if (raw === '') return { level: fallback };
	const requested = raw.toLowerCase();
	if (LEVEL_SET.has(requested)) return { level: requested as LogLevel };
	return { level: fallback, rejected: raw.slice(0, 32) };
}
