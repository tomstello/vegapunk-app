import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import { randomUUID } from 'node:crypto';
import {
	bearerToken,
	errorResponse,
	parseWithSchema,
	readJsonWithByteLimit,
	V2HttpError
} from '$lib/server/v2/http';
import {
	MAX_ASSISTANT_CODE_POINTS,
	MAX_CHAT_REQUEST_BYTES,
	MAX_CONTEXT_UTF8_BYTES
} from '$lib/server/v2/limits';
import { openRouterSessionId } from '$lib/server/v2/crypto';
import { OpenRouterStartError, startOpenRouterStream } from '$lib/server/v2/openrouter';
import { ChatRequestSchema } from '$lib/server/v2/schemas';
import { getStudyConfigRevision } from '$lib/server/v2/studyConfig';
import {
	issueHistoryTag,
	signingKey,
	verifyHistoryTag,
	verifySessionToken,
	type HistoryMessage
} from '$lib/server/v2/tokens';
import type { RequestHandler } from './$types';

const encoder = new TextEncoder();

function sse(event: 'meta' | 'delta' | 'done' | 'error', data: Record<string, unknown>): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function validOpenRouterKey(value: string | undefined): string {
	const key = value?.trim() ?? '';
	if (!key || /\s/.test(key) || key.length > 512) {
		throw new V2HttpError(503, 'service_unavailable', 'The response service is unavailable');
	}
	return key;
}

export const POST: RequestHandler = async ({ request }) => {
	let secret: string;
	try {
		secret = signingKey(env.SESSION_SIGNING_KEY);
	} catch (error) {
		logger.error(error, 'v2 chat: invalid server signing configuration');
		return errorResponse(new V2HttpError(503, 'service_unavailable', 'The response service is unavailable'));
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
			ChatRequestSchema,
			await readJsonWithByteLimit(request, MAX_CHAT_REQUEST_BYTES)
		);
		const idempotencyKey = request.headers.get('idempotency-key') ?? '';
		if (idempotencyKey !== body.turn.id) {
			throw new V2HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key must equal the turn ID');
		}
		try {
			verifyHistoryTag({
				token: body.historyTag,
				secret,
				session,
				sequence: body.sequence - 1,
				history: body.history
			});
		} catch {
			throw new V2HttpError(409, 'invalid_history', 'Conversation history failed its integrity check');
		}
		const contextBytes = encoder.encode(
			JSON.stringify({
				system: config.systemPrompt,
				opening: config.initialMessages.map(({ content }) => content),
				history: body.history,
				turn: body.turn.userMessage
			})
		).byteLength;
		if (contextBytes > MAX_CONTEXT_UTF8_BYTES) {
			throw new V2HttpError(413, 'context_too_large', 'The conversation is too large to continue');
		}

		let providerStream;
		try {
			providerStream = await startOpenRouterStream({
				config,
				history: body.history,
				userMessage: body.turn.userMessage,
				// Send an unlinkable HMAC, not the Qualtrics-joinable chat-session
				// UUID. OpenRouter uses it only for conversation/provider stickiness.
				providerSessionId: openRouterSessionId(secret, session.sid),
				apiKey: validOpenRouterKey(env.OPENROUTER_API_KEY),
				clientSignal: request.signal
			});
		} catch (error) {
			if (error instanceof V2HttpError) throw error;
			if (error instanceof OpenRouterStartError) {
				logger.warn(
					{
						event: 'v2_provider_start_failure',
						condition: config.condition,
						configVersion: config.configVersion,
						code: error.code,
						status: error.status,
						upstreamStatus: error.diagnostic.upstreamStatus,
						upstreamCode: error.diagnostic.upstreamCode,
						routingFailure: error.diagnostic.routingFailure,
						requestedProviders: error.diagnostic.requestedProviders,
						availableProviders: error.diagnostic.availableProviders,
						retryable: error.retryable
					},
					'v2 chat: provider did not start'
				);
				throw new V2HttpError(
					error.status,
					error.code,
					error.status === 429
						? 'The vaccine information service is busy. Please try again shortly.'
						: 'The vaccine information service could not answer just now.',
					error.retryable
				);
			}
			throw error;
		}

		// A retry reuses the user turn ID but is a distinct assistant attempt. A
		// fresh ID lets the transcript retain a superseded partial attempt and the
		// later answer without duplicating either message ID.
		const assistantMessageId = randomUUID();
		let controllerClosed = false;
		const responseBody = new ReadableStream<Uint8Array>({
			async start(controller) {
				let assistantText = '';
				let assistantCodePoints = 0;
				const close = () => {
					if (!controllerClosed) {
						controllerClosed = true;
						controller.close();
					}
				};
				try {
					controller.enqueue(
						sse('meta', {
							v: 2,
							sequence: body.sequence,
							turnId: body.turn.id,
							assistantMessageId,
							condition: session.condition,
							configVersion: session.configVersion,
							configHash: session.configHash
						})
					);
					for await (const event of providerStream.events()) {
						if (event.kind === 'delta') {
							const available = MAX_ASSISTANT_CODE_POINTS - assistantCodePoints;
							const codePoints = Array.from(event.text);
							const accepted = available > 0 ? codePoints.slice(0, available).join('') : '';
							if (accepted) {
								assistantText += accepted;
								assistantCodePoints += Array.from(accepted).length;
								controller.enqueue(sse('delta', { v: 2, text: accepted }));
							}
							if (codePoints.length > available) {
								providerStream.cancel();
								if (!assistantText) {
									controller.enqueue(
										sse('error', {
											v: 2,
											code: 'empty_response',
											message: 'No answer was received. Please try again.',
											completionStatus: 'incomplete',
											retryable: true
										})
									);
									close();
									return;
								}
								const completedHistory: HistoryMessage[] = [
									...body.history,
									{ id: body.turn.id, role: 'user', content: body.turn.userMessage },
									{ id: assistantMessageId, role: 'assistant', content: assistantText }
								];
								controller.enqueue(
									sse('done', {
										v: 2,
										sequence: body.sequence,
										turnId: body.turn.id,
										assistantMessageId,
										// This is our transcript/display cap, not a provider
										// finish_reason. Keep the provenance explicit.
										finishReason: 'application_limit',
										capped: true,
										completionStatus: 'capped',
										historyTag: issueHistoryTag({
											secret,
											session,
											sequence: body.sequence,
											history: completedHistory
										})
									})
								);
								close();
								return;
							}
						} else if (event.kind === 'done') {
							if (!assistantText) {
								controller.enqueue(
									sse('error', {
										v: 2,
										code: 'empty_response',
										message: 'No answer was received. Please try again.',
										completionStatus: 'incomplete',
										retryable: true
									})
								);
								close();
								return;
							}
							const finishReason = event.finishReason;
							if (!['stop', 'length', 'content_filter'].includes(finishReason)) {
								controller.enqueue(
									sse('error', {
										v: 2,
										code: 'invalid_finish_reason',
										message: 'The answer was interrupted. You can try again, skip it, or end the chat.',
										completionStatus: 'incomplete',
										retryable: true,
										partialCodePoints: assistantCodePoints,
										sequence: body.sequence,
										turnId: body.turn.id,
										assistantMessageId
									})
								);
								close();
								return;
							}
							const capped = finishReason === 'length' || finishReason === 'content_filter';
							const completedHistory: HistoryMessage[] = [
								...body.history,
								{ id: body.turn.id, role: 'user', content: body.turn.userMessage },
								{ id: assistantMessageId, role: 'assistant', content: assistantText }
							];
							controller.enqueue(
								sse('done', {
									v: 2,
									sequence: body.sequence,
									turnId: body.turn.id,
									assistantMessageId,
									finishReason,
									capped,
									completionStatus: capped ? 'capped' : 'complete',
									historyTag: issueHistoryTag({
										secret,
										session,
										sequence: body.sequence,
										history: completedHistory
									})
								})
							);
							close();
							return;
						} else {
							controller.enqueue(
								sse('error', {
									v: 2,
									code: event.code,
									message: 'The answer was interrupted. You can try again, skip it, or end the chat.',
									completionStatus: 'incomplete',
									retryable: true,
									partialCodePoints: assistantCodePoints,
									sequence: body.sequence,
									turnId: body.turn.id,
									assistantMessageId
								})
							);
							close();
							return;
						}
					}
				} catch {
					logger.warn('v2 chat: response stream interrupted');
					if (!controllerClosed) {
						controller.enqueue(
							sse('error', {
								v: 2,
								code: 'stream_interrupted',
								message: 'The answer was interrupted. You can try again, skip it, or end the chat.',
								completionStatus: 'incomplete',
								retryable: true,
								partialCodePoints: assistantCodePoints,
								sequence: body.sequence,
								turnId: body.turn.id,
								assistantMessageId
							})
						);
						close();
					}
				} finally {
					providerStream.cancel();
					close();
				}
			},
			cancel() {
				controllerClosed = true;
				providerStream.cancel();
			}
		});

		return new Response(responseBody, {
			status: 200,
			headers: {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store, no-cache, must-revalidate, no-transform',
				pragma: 'no-cache',
				'x-accel-buffering': 'no',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (error) {
		if (!(error instanceof V2HttpError)) logger.error(error, 'v2 chat: unexpected request failure');
		return errorResponse(error);
	}
};
