import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import type { StudyConfig } from './studyConfig';
import type { HistoryMessage, SessionClaims } from './tokens';

// Standalone-demo transcript recording. The demo has no Qualtrics parent and
// no checkpoint survey, so the server keeps the (already-redacted) canonical
// history itself: one JSON object per session, overwritten as the
// conversation grows. Fire-and-forget; never blocks or fails a chat turn.
// Requires BLOB_READ_WRITE_TOKEN (Vercel Blob). Silently no-ops without it.

const BLOB_API = 'https://blob.vercel-storage.com';

export async function recordDemoTranscript(
	session: SessionClaims,
	config: StudyConfig,
	history: readonly HistoryMessage[]
): Promise<void> {
	const token = env.BLOB_READ_WRITE_TOKEN?.trim();
	if (!token || !config.demo) return;
	const body = JSON.stringify({
		schemaVersion: 1,
		kind: 'demo-transcript',
		condition: config.condition,
		configVersion: config.configVersion,
		configHash: config.configHash,
		chatSessionKey: session.sid,
		updatedAtISO: new Date().toISOString(),
		userTurns: history.filter((m) => m.role === 'user').length,
		messages: history.map(({ id, role, content }) => ({ id, role, content }))
	});
	try {
		const response = await fetch(
			`${BLOB_API}/demo-transcripts/${config.configVersion}/${session.sid}.json`,
			{
				method: 'PUT',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
					'x-api-version': '7',
					'x-add-random-suffix': '0',
					'x-content-type': 'application/json'
				},
				body,
				signal: AbortSignal.timeout(8_000)
			}
		);
		if (!response.ok) {
			logger.warn({ event: 'demo_transcript_store_failed', status: response.status }, 'demo transcript not stored');
		}
	} catch {
		logger.warn({ event: 'demo_transcript_store_failed' }, 'demo transcript not stored');
	}
}
