import { env } from '$env/dynamic/private';

// Shared vocabulary for the transcript checkpoint writers. Two stores exist
// during the migration window: the legacy Qualtrics checkpoint survey
// (qualtricsCheckpoint.ts) and the S3 bucket (s3Checkpoint.ts). The route picks
// one per request from CHECKPOINT_STORE; the browser protocol is identical for
// both, so the client never learns which store acknowledged a snapshot.

export type CheckpointStoreKind = 'qualtrics' | 's3';

export type CheckpointSnapshot = {
	createOperationId: string;
	snapshotSequence: number;
	state: 'active' | 'interrupted' | 'completed' | 'capture_error';
	reasonHint?: string;
	transcriptJson: string;
};

export class CheckpointStoreError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code: string,
		public readonly ambiguousCreate = false,
		public readonly retryAfter?: string,
		public readonly attempts = 1,
		public readonly upstreamName?: string,
		// Bounded AWS error text, present only for configuration-class failures.
		public readonly upstreamMessage?: string
	) {
		super(message);
	}
}

// Dashboard pastes arrive with stray whitespace, wrapping quotes (straight or
// curly), and invisible characters (zero-width spaces, BOM, NBSP). Accept all.
export function dequote(value: string): string {
	return value
		.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
		.trim()
		.replace(/^["'‘’“”]+|["'‘’“”]+$/g, '')
		.trim();
}

export function checkpointUnavailable(): CheckpointStoreError {
	return new CheckpointStoreError('Checkpoint service is not configured', 503, 'checkpoint_unavailable');
}

/**
 * Production may retain legacy Qualtrics credentials during the store
 * migration. ENABLE_V2_CHECKPOINT stays the master switch so a deployment
 * cannot silently write anywhere; CHECKPOINT_STORE then names the sink.
 * Unset or "qualtrics" keeps the legacy writer, so merging the S3 code changes
 * nothing until the environment says otherwise.
 */
export function selectCheckpointStore(): CheckpointStoreKind {
	if (dequote(env.ENABLE_V2_CHECKPOINT ?? '') !== 'true') throw checkpointUnavailable();
	const raw = dequote(env.CHECKPOINT_STORE ?? '').toLowerCase();
	if (raw === '' || raw === 'qualtrics') return 'qualtrics';
	if (raw === 's3') return 's3';
	throw checkpointUnavailable();
}
