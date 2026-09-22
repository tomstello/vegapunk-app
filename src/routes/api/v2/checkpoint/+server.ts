import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import {
	CheckpointStoreError,
	selectCheckpointStore,
	type CheckpointSnapshot,
	type CheckpointStoreKind
} from '$lib/server/v2/checkpointStore';
import {
	bearerToken,
	errorResponse,
	jsonResponse,
	parseWithSchema,
	readJsonWithByteLimit,
	V2HttpError
} from '$lib/server/v2/http';
import { MAX_CHECKPOINT_REQUEST_BYTES, MAX_TRANSCRIPT_UTF8_BYTES } from '$lib/server/v2/limits';
import { loadtestPolicy } from '$lib/server/v2/loadtestStub';
import {
	checkpointEmbeddedData,
	createQualtricsCheckpoint,
	getQualtricsCheckpointConfig,
	isQualtricsResponseId,
	updateQualtricsCheckpoint
} from '$lib/server/v2/qualtricsCheckpoint';
import {
	checkpointObject,
	getS3CheckpointConfig,
	putCheckpointObject
} from '$lib/server/v2/s3Checkpoint';
import { CheckpointRequestSchema, validateTranscriptSnapshot } from '$lib/server/v2/schemas';
import { getStudyConfigRevision } from '$lib/server/v2/studyConfig';
import {
	issueCheckpointHandle,
	signingKey,
	verifyCheckpointHandle,
	verifySessionToken,
	type CheckpointHandleClaims
} from '$lib/server/v2/tokens';
import type { RequestHandler } from './$types';

// Load-test instrumentation only, under the same host guard as
// x-loadtest-instance: absent on the study production project, so a generator
// that requires it cannot be pointed at a Qualtrics-backed deployment by
// accident. Bulk checkpoint load must reach S3, never Qualtrics.
function storeHeader(store: CheckpointStoreKind | 'unselected'): Record<string, string> | undefined {
	return loadtestPolicy().instanceHeader ? { 'x-loadtest-checkpoint-store': store } : undefined;
}

export const POST: RequestHandler = async ({ request }) => {
	let secret: string;
	try {
		secret = signingKey(env.SESSION_SIGNING_KEY);
	} catch (error) {
		logger.error(error, 'v2 checkpoint: invalid server signing configuration');
		return errorResponse(new V2HttpError(503, 'checkpoint_unavailable', 'Transcript backup is unavailable'));
	}

	let store: CheckpointStoreKind | 'unselected' = 'unselected';
	try {
		let session;
		try {
			session = verifySessionToken(bearerToken(request), secret);
		} catch {
			throw new V2HttpError(401, 'invalid_session', 'The study session is invalid or expired');
		}
		const config = getStudyConfigRevision(
			session.condition,
			session.configVersion,
			session.configHash
		);
		if (!config) {
			throw new V2HttpError(409, 'config_revision_unavailable', 'The saved chat configuration is unavailable');
		}
		const body = parseWithSchema(
			CheckpointRequestSchema,
			await readJsonWithByteLimit(request, MAX_CHECKPOINT_REQUEST_BYTES)
		);
		const utf8Length = new TextEncoder().encode(body.transcriptJson).byteLength;
		if (utf8Length > MAX_TRANSCRIPT_UTF8_BYTES) {
			throw new V2HttpError(413, 'transcript_too_large', 'Transcript exceeds checkpoint capacity');
		}
		try {
			validateTranscriptSnapshot(body.transcriptJson, {
				sessionKey: session.sid,
				condition: session.condition,
				configVersion: session.configVersion,
				configHash: session.configHash,
				snapshotSequence: body.snapshotSequence,
				state: body.state
			});
		} catch (error) {
			throw new V2HttpError(
				400,
				'invalid_transcript',
				error instanceof Error ? error.message : 'Transcript snapshot is invalid'
			);
		}
		const snapshot: CheckpointSnapshot = {
			createOperationId: body.createOperationId,
			snapshotSequence: body.snapshotSequence,
			state: body.state,
			reasonHint: body.reasonHint,
			transcriptJson: body.transcriptJson
		};
		store = selectCheckpointStore();

		// The handle guards sequence monotonicity and stream identity for both
		// stores. It is verified before any upstream write regardless of store.
		let handle: CheckpointHandleClaims | null = null;
		if (body.checkpointHandle) {
			try {
				handle = verifyCheckpointHandle({ token: body.checkpointHandle, secret, session });
			} catch {
				throw new V2HttpError(409, 'invalid_checkpoint_handle', 'Checkpoint handle is invalid or expired');
			}
			if (handle.createOperationId !== body.createOperationId) {
				throw new V2HttpError(409, 'checkpoint_stream_mismatch', 'Checkpoint operation does not match its handle');
			}
			if (body.snapshotSequence <= handle.acknowledgedSequence) {
				throw new V2HttpError(409, 'stale_checkpoint', 'Checkpoint revision is not newer than the acknowledged revision');
			}
		}
		const operation = handle ? 'update' : 'create';

		let storeRef: string;
		let checksum: string;
		let attempts = 1;
		if (store === 's3') {
			const s3 = getS3CheckpointConfig();
			const object = checkpointObject({ session, snapshot });
			const result = await putCheckpointObject({ config: s3, object });
			storeRef = object.streamRef;
			checksum = object.checksum;
			attempts = result.attempts;
		} else {
			const checkpoint = checkpointEmbeddedData({ session, snapshot });
			const qualtrics = getQualtricsCheckpointConfig();
			checksum = checkpoint.checksum;
			// A handle sealed while CHECKPOINT_STORE was "s3" carries an object
			// prefix, not a Qualtrics response ID. After a rollback to Qualtrics
			// such a stream starts a fresh response rather than failing forever.
			if (handle && isQualtricsResponseId(handle.checkpointResponseId)) {
				storeRef = handle.checkpointResponseId;
				await updateQualtricsCheckpoint({
					config: qualtrics,
					checkpointResponseId: storeRef,
					fields: checkpoint.fields
				});
			} else {
				storeRef = await createQualtricsCheckpoint({
					config: qualtrics,
					fields: checkpoint.fields,
					idempotencyKey: body.createOperationId
				});
			}
		}
		const checkpointHandle = issueCheckpointHandle({
			secret,
			session,
			checkpointResponseId: storeRef,
			createOperationId: body.createOperationId,
			acknowledgedSequence: body.snapshotSequence,
			acknowledgedChecksum: checksum
		});
		logger.info(
			{
				event: operation === 'create' ? 'v2_checkpoint_create_ok' : 'v2_checkpoint_update_ok',
				operation,
				store,
				attempts,
				condition: session.condition,
				configVersion: session.configVersion
			},
			'v2 checkpoint stored'
		);
		return jsonResponse(
			{
				v: 2,
				checkpointHandle,
				acknowledgedSequence: body.snapshotSequence,
				checksum
			},
			200,
			storeHeader(store)
		);
	} catch (error) {
		if (error instanceof CheckpointStoreError) {
			const fields = {
				event: error.ambiguousCreate
					? 'v2_checkpoint_ambiguous_create'
					: 'v2_checkpoint_upstream_failure',
				code: error.code,
				status: error.status,
				store,
				attempts: error.attempts,
				upstream: error.upstreamName,
				upstreamMessage: error.upstreamMessage,
				ambiguousCreate: error.ambiguousCreate
			};
			if (error.code === 'checkpoint_unavailable') {
				logger.error(fields, 'v2 checkpoint: store is not configured or refused the writer');
			} else {
				logger.warn(fields, 'v2 checkpoint: store operation failed');
			}
			return jsonResponse(
				{
					v: 2,
					error: {
						code: error.code,
						message: error.ambiguousCreate
							? 'Transcript backup may have been created, but confirmation was lost. It will not be retried immediately.'
							: 'Transcript backup could not be confirmed.',
						ambiguousCreate: error.ambiguousCreate,
						retryable: !error.ambiguousCreate && error.status >= 500
					}
				},
				error.status,
				{
					...storeHeader(store),
					...(error.retryAfter ? { 'retry-after': error.retryAfter } : {})
				}
			);
		}
		if (!(error instanceof V2HttpError)) logger.error(error, 'v2 checkpoint: unexpected request failure');
		const response = errorResponse(error);
		// A rejection raised after the store was selected still reports which
		// store it would have written to. The load generator uses exactly that:
		// it probes with an invalid handle, which is refused here before any
		// upstream write, and reads the store from this response.
		for (const [name, value] of Object.entries(storeHeader(store) ?? {})) {
			response.headers.set(name, value);
		}
		return response;
	}
};
