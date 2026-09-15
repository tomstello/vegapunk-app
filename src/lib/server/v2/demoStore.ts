import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import { CheckpointStoreError, selectCheckpointStore } from './checkpointStore';
import { demoTranscriptObject, getS3CheckpointConfig, putS3Object, s3PutInput } from './s3Checkpoint';
import type { StudyConfig } from './studyConfig';
import type { HistoryMessage, SessionClaims } from './tokens';

// Standalone-demo transcript recording. The demo has no Qualtrics parent and
// no browser-side checkpoint worker, so the server keeps the (already-
// redacted) canonical history itself after each turn. Fire-and-forget; never
// blocks or fails a chat turn. Two sinks, each independently optional:
//
// - Vercel Blob: one JSON object per session, overwritten as the conversation
//   grows. Requires BLOB_READ_WRITE_TOKEN. Silently no-ops without it.
// - S3: one immutable object per turn under v2/<configVersion>/demo/..., using
//   the checkpoint writer's client and role. Active when the checkpoint store
//   is enabled and set to "s3" (ENABLE_V2_CHECKPOINT + CHECKPOINT_STORE); a
//   missing or invalid S3 configuration is logged once per turn and skipped.

const BLOB_API = 'https://blob.vercel-storage.com';

/** Provider provenance for the assistant turn that produced this write. The
 * Blob object is overwritten per turn, so only the latest turn's generation is
 * kept there; every turn's generation ID is also in the v2_turn_complete log
 * event, and the S3 copy keeps one object per turn. */
export type TurnGeneration = Readonly<{
	sequence: number;
	assistantMessageId: string;
	generationId: string | null;
	finishReason: string;
	completionStatus: 'complete' | 'capped';
}>;

export async function recordDemoTranscript(
	session: SessionClaims,
	config: StudyConfig,
	history: readonly HistoryMessage[],
	generation?: TurnGeneration
): Promise<void> {
	if (!config.demo) return;
	const userTurns = history.filter((m) => m.role === 'user').length;
	const body = JSON.stringify({
		schemaVersion: 1,
		kind: 'demo-transcript',
		condition: config.condition,
		configVersion: config.configVersion,
		configHash: config.configHash,
		chatSessionKey: session.sid,
		updatedAtISO: new Date().toISOString(),
		userTurns,
		messages: history.map(({ id, role, content }) => ({ id, role, content })),
		...(generation ? { lastTurn: generation } : {})
	});
	await Promise.all([
		recordToBlob(session, config, body),
		recordToS3(session, config, body, generation?.sequence ?? userTurns)
	]);
}

async function recordToBlob(session: SessionClaims, config: StudyConfig, body: string): Promise<void> {
	const token = env.BLOB_READ_WRITE_TOKEN?.trim();
	if (!token) return;
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
			logger.warn({ event: 'demo_transcript_store_failed', sink: 'blob', status: response.status }, 'demo transcript not stored');
		}
	} catch {
		logger.warn({ event: 'demo_transcript_store_failed', sink: 'blob' }, 'demo transcript not stored');
	}
}

async function recordToS3(
	session: SessionClaims,
	config: StudyConfig,
	body: string,
	sequence: number
): Promise<void> {
	// The demo follows the checkpoint store switch. Say so when skipping, so a
	// silent bucket is distinguishable from a write that never ran.
	let store: string;
	try {
		store = selectCheckpointStore();
	} catch {
		store = 'disabled';
	}
	if (store !== 's3') {
		logger.info({ event: 'demo_transcript_store_skipped', sink: 's3', store }, 'demo transcript S3 sink not selected');
		return;
	}
	try {
		const s3 = getS3CheckpointConfig();
		const object = demoTranscriptObject({
			configVersion: config.configVersion,
			sessionKey: session.sid,
			sequence,
			body
		});
		const result = await putS3Object({ config: s3, input: s3PutInput(s3, object) });
		logger.info(
			{ event: 'demo_transcript_stored', sink: 's3', attempts: result.attempts, configVersion: config.configVersion },
			'demo transcript stored'
		);
	} catch (error) {
		const fields =
			error instanceof CheckpointStoreError
				? {
						code: error.code,
						status: error.status,
						attempts: error.attempts,
						upstream: error.upstreamName,
						upstreamMessage: error.upstreamMessage
					}
				: {};
		logger.warn({ event: 'demo_transcript_store_failed', sink: 's3', ...fields }, 'demo transcript not stored');
	}
}
