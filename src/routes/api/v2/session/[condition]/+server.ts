import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import { errorResponse, jsonResponse, parseWithSchema, readJsonWithByteLimit, V2HttpError } from '$lib/server/v2/http';
import { MAX_SESSION_REQUEST_BYTES } from '$lib/server/v2/limits';
import { SessionRequestSchema } from '$lib/server/v2/schemas';
import {
	getPublicStudyConfig,
	getStudyConfigForNewSession,
	getStudyConfigRevision,
	isStudyCondition
} from '$lib/server/v2/studyConfig';
import { assertScreenedConfiguration } from '$lib/server/v2/provenance';
import { issueHistoryTag, issueSessionToken, signingKey, verifyHistoryTagBinding } from '$lib/server/v2/tokens';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	try {
		if (!isStudyCondition(params.condition)) {
			throw new V2HttpError(404, 'unknown_study', 'Unknown study route');
		}
		const body = parseWithSchema(
			SessionRequestSchema,
			await readJsonWithByteLimit(request, MAX_SESSION_REQUEST_BYTES)
		);
		let secret: string;
		try {
			secret = signingKey(env.SESSION_SIGNING_KEY);
		} catch (error) {
			logger.error(error, 'v2 session: invalid server signing configuration');
			throw new V2HttpError(503, 'service_unavailable', 'The study session service is unavailable');
		}
			const config = body.resumeConfig
				? getStudyConfigRevision(
					params.condition,
					body.resumeConfig.configVersion,
					body.resumeConfig.configHash
				)
				: getStudyConfigForNewSession(params.condition, body.preferredConfigVersion);
			if (!config) {
				throw new V2HttpError(
					409,
					'config_revision_unavailable',
					'This saved chat uses a configuration revision that is no longer available'
				);
			}
		try { assertScreenedConfiguration(config); }
		catch { throw new V2HttpError(409, 'config_revision_unsupported', 'This older chat configuration is no longer supported'); }
		const issued = issueSessionToken({
			secret,
			chatSessionKey: body.chatSessionKey,
			attemptNonce: body.attemptNonce,
			condition: config.condition,
			configVersion: config.configVersion,
			configHash: config.configHash
		});
		if (body.resumeConfig) {
			const proof = request.headers.get('x-session-resume-proof') ?? '';
			try { verifyHistoryTagBinding({ token: proof, secret, session: issued.claims }); }
			catch { throw new V2HttpError(403, 'invalid_resume_proof', 'The saved chat could not be verified. Its existing data has not been changed.'); }
		}
		const historyTag = issueHistoryTag({
			secret,
			session: issued.claims,
			sequence: 0,
			history: []
		});
		logger.info(
			{
				event: 'v2_session_issued',
				condition: config.condition,
				configVersion: config.configVersion
			},
			'v2 session issued'
		);
		return jsonResponse({
			v: 2,
			sessionToken: issued.token,
			sessionKey: issued.claims.sid,
			...getPublicStudyConfig(config),
			historyTag
		});
	} catch (error) {
		if (!(error instanceof V2HttpError)) logger.warn('v2 session: request rejected');
		return errorResponse(error);
	}
};
