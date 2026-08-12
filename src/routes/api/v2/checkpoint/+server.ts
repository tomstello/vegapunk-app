import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import {
	bearerToken,
	errorResponse,
	jsonResponse,
	parseWithSchema,
	readJsonWithByteLimit,
	V2HttpError
} from '$lib/server/v2/http';
import { MAX_CHECKPOINT_REQUEST_BYTES, MAX_TRANSCRIPT_UTF8_BYTES } from '$lib/server/v2/limits';
import {
	checkpointEmbeddedData,
	createQualtricsCheckpoint,
	getQualtricsCheckpointConfig,
	QualtricsCheckpointError,
	updateQualtricsCheckpoint
} from '$lib/server/v2/qualtricsCheckpoint';
import { CheckpointRequestSchema, validateTranscriptSnapshot } from '$lib/server/v2/schemas';
import { getStudyConfigRevision } from '$lib/server/v2/studyConfig';
import {
	issueCheckpointHandle,
	signingKey,
	verifyCheckpointHandle,
	verifySessionToken
} from '$lib/server/v2/tokens';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	let secret: string;
	try {
		secret = signingKey(env.SESSION_SIGNING_KEY);
	} catch (error) {
		logger.error(error, 'v2 checkpoint: invalid server signing configuration');
		return errorResponse(new V2HttpError(503, 'checkpoint_unavailable', 'Transcript backup is unavailable'));
	}

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
		const checkpoint = checkpointEmbeddedData({
			session,
			snapshot: {
				createOperationId: body.createOperationId,
				snapshotSequence: body.snapshotSequence,
				state: body.state,
				reasonHint: body.reasonHint,
				transcriptJson: body.transcriptJson
			}
		});
		const qualtrics = getQualtricsCheckpointConfig();
		let checkpointResponseId: string;
		const operation = body.checkpointHandle ? 'update' : 'create';
		if (body.checkpointHandle) {
			let handle;
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
			checkpointResponseId = handle.checkpointResponseId;
			await updateQualtricsCheckpoint({
				config: qualtrics,
				checkpointResponseId,
				fields: checkpoint.fields
			});
		} else {
			checkpointResponseId = await createQualtricsCheckpoint({
				config: qualtrics,
				fields: checkpoint.fields,
				idempotencyKey: body.createOperationId
			});
		}
		const checkpointHandle = issueCheckpointHandle({
			secret,
			session,
			checkpointResponseId,
			createOperationId: body.createOperationId,
			acknowledgedSequence: body.snapshotSequence,
			acknowledgedChecksum: checkpoint.checksum
		});
		logger.info(
			{
				event: operation === 'create' ? 'v2_checkpoint_create_ok' : 'v2_checkpoint_update_ok',
				operation,
				condition: session.condition,
				configVersion: session.configVersion
			},
			'v2 checkpoint stored'
		);
		return jsonResponse({
			v: 2,
			checkpointHandle,
			acknowledgedSequence: body.snapshotSequence,
			checksum: checkpoint.checksum
		});
	} catch (error) {
		if (error instanceof QualtricsCheckpointError) {
			logger.warn(
				{
					event: error.ambiguousCreate
						? 'v2_checkpoint_ambiguous_create'
						: 'v2_checkpoint_upstream_failure',
					code: error.code,
					status: error.status,
					ambiguousCreate: error.ambiguousCreate
				},
				'v2 checkpoint: Qualtrics operation failed'
			);
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
				error.retryAfter ? { 'retry-after': error.retryAfter } : undefined
			);
		}
		if (!(error instanceof V2HttpError)) logger.error(error, 'v2 checkpoint: unexpected request failure');
		return errorResponse(error);
	}
};
