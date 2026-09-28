/**
 * Parse the deployment's explicit Qualtrics parent-origin allowlist.
 *
 * Operators commonly paste an origin with its conventional trailing slash.
 * Accept that harmless spelling and canonicalize it to URL.origin, but reject
 * paths, credentials, queries, fragments, and non-HTTPS values.  This module is
 * deliberately shared by svelte.config.js (CSP) and the browser bridge so the
 * two enforcement layers cannot silently drift.
 *
 * @param {string | undefined | null} raw
 * @returns {string[]}
 */
export function parseQualtricsParentOrigins(raw) {
	const origins = [];
	for (const supplied of String(raw ?? '').split(',')) {
		const candidate = supplied.trim();
		if (!candidate) continue;
		let parsed;
		try {
			parsed = new URL(candidate);
		} catch {
			throw new Error(`Invalid Qualtrics parent origin: ${candidate}`);
		}
		if (
			parsed.protocol !== 'https:' ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			(parsed.pathname !== '' && parsed.pathname !== '/')
		) {
			throw new Error(
				`PUBLIC_QUALTRICS_PARENT_ORIGINS must contain HTTPS origins, not URLs with paths or parameters: ${candidate}`
			);
		}
		origins.push(parsed.origin);
	}
	return [...new Set(origins)];
}
