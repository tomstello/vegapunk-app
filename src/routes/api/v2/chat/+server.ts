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
import { loadtestPolicy } from '$lib/server/v2/loadtestStub';
import { OpenRouterStartError, startOpenRouterStream } from '$lib/server/v2/openrouter';
import { networkErrorDiagnostic } from '$lib/server/v2/providerDiagnostics';
import { ScrubberError, scrubUserMessage } from '$lib/server/v2/scrubber';
import { ChatRequestSchema } from '$lib/server/v2/schemas';
import { effectiveMaxTurns, getStudyConfigRevision } from '$lib/server/v2/studyConfig';
import { recordDemoTranscript } from '$lib/server/v2/demoStore';
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
	// The load-test stub never contacts a provider, so a stubbed deployment may
	// run with no OpenRouter credential at all (guaranteed zero model spend).
	if (loadtestPolicy().stub) return 'loadtest-stub';
	if (!key || /\s/.test(key) || key.length > 512) {
		throw new V2HttpError(503, 'service_unavailable', 'The response service is unavailable');
	}
	return key;
}

export const POST: RequestHandler = async ({ request }) => {
	const requestStartedAt = Date.now();
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
		// Per-configuration turn cap (the demo runs shorter than the study's
		// schema-level maximum). sequence is the 1-based index of this user turn.
		if (body.sequence > effectiveMaxTurns(config)) {
			throw new V2HttpError(409, 'turn_limit_reached', 'This chat has reached its question limit.');
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

		// The incoming turn is the only unsigned text in the protocol. When the
		// active revision configures a scrubber, the redacted text becomes the
		// canonical turn everywhere downstream: the provider relay, both signed
		// completedHistory entries, and the client's stored transcript (the
		// canonical text is delivered to the browser in the `meta` event). The
		// context guard above deliberately measured the raw turn; the scrubbed
		// text is bounded to MAX_USER_CODE_POINTS, so the ceiling still holds.
		// Failure is fail-closed: the raw turn is never relayed or signed.
		let canonicalUserMessage = body.turn.userMessage;
		let scrubApplied = false;
		if (config.scrubber) {
			const scrubStartedAt = Date.now();
			try {
				const scrubbed = await scrubUserMessage({
					scrubber: config.scrubber,
					history: body.history,
					userMessage: body.turn.userMessage,
					apiKey: validOpenRouterKey(env.OPENROUTER_API_KEY),
					clientSignal: request.signal
				});
				canonicalUserMessage = scrubbed.text;
				scrubApplied = true;
				if (scrubbed.usedFallback) {
					// Operationally notable: both primary routes failed and the
					// cross-vendor secondary carried the turn. Counts only.
					logger.warn(
						{
							event: 'v2_scrub_fallback_used',
							condition: config.condition,
							configVersion: config.configVersion,
							attempts: scrubbed.attempts,
							scrubLatencyMs: Date.now() - scrubStartedAt
						},
						'v2 chat: redaction fallback model used'
					);
				}
				logger.debug(
					{
						event: 'v2_scrub_applied',
						condition: config.condition,
						configVersion: config.configVersion,
						spanCount: scrubbed.spanCount,
						attempts: scrubbed.attempts,
						usedFallback: scrubbed.usedFallback,
						scrubLatencyMs: Date.now() - scrubStartedAt
					},
					'v2 chat: turn redacted'
				);
			} catch (error) {
				if (error instanceof ScrubberError) {
					logger.warn(
						{
							event: 'v2_scrub_failure',
							condition: config.condition,
							configVersion: config.configVersion,
							code: error.code,
							retryable: error.retryable,
							upstreamStatus: error.diagnostic.upstreamStatus,
							network: error.diagnostic.network,
							clientAborted: request.signal.aborted,
							scrubLatencyMs: Date.now() - scrubStartedAt
						},
						'v2 chat: redaction screen did not complete'
					);
					throw error.code === 'scrub_length'
						? new V2HttpError(
								422,
								'scrub_length',
								'Your question could not be processed safely. Please shorten it and try again.',
								false
							)
						: new V2HttpError(
								503,
								'scrub_unavailable',
								'The vaccine information service could not process your question just now. Please try again.',
								error.retryable
							);
				}
				throw error;
			}
		}

		const providerStartedAt = Date.now();
		let providerStream;
		try {
			providerStream = await startOpenRouterStream({
				config,
				history: body.history,
				userMessage: canonicalUserMessage,
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
						attempts: error.attempts,
						phase: error.diagnostic.phase,
						abortedBy: error.diagnostic.abortedBy,
						network: error.diagnostic.network,
						upstreamStatus: error.diagnostic.upstreamStatus,
						upstreamCode: error.diagnostic.upstreamCode,
						upstreamMessage: error.diagnostic.upstreamMessage,
						upstreamHeaders: error.diagnostic.upstreamHeaders,
						routingFailure: error.diagnostic.routingFailure,
						requestedProviders: error.diagnostic.requestedProviders,
						availableProviders: error.diagnostic.availableProviders,
						retryable: error.retryable,
						clientAborted: request.signal.aborted,
						providerStartMs: Date.now() - providerStartedAt
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
		const providerStartMs = Date.now() - providerStartedAt;
		const generationId = providerStream.generationId;

		// A retry reuses the user turn ID but is a distinct assistant attempt. A
		// fresh ID lets the transcript retain a superseded partial attempt and the
		// later answer without duplicating either message ID.
		const assistantMessageId = randomUUID();
		let controllerClosed = false;
		let assistantText = '';
		let assistantCodePoints = 0;
		let deltasDelivered = 0;
		let firstDeltaAt: number | null = null;
		let outcomeLogged = false;

		// Shared context for every stream-phase log event, so one turn can be
		// followed from provider start to its outcome and joined to OpenRouter
		// through generationId. Identifiers only: never the turn text.
		const turnContext = () => ({
			condition: config.condition,
			configVersion: config.configVersion,
			sequence: body.sequence,
			turnId: body.turn.id,
			assistantMessageId,
			generationId,
			deltasDelivered,
			partialCodePoints: assistantCodePoints,
			providerStartMs,
			firstDeltaMs: firstDeltaAt === null ? null : firstDeltaAt - providerStartedAt,
			streamMs: Date.now() - providerStartedAt,
			totalMs: Date.now() - requestStartedAt,
			clientAborted: request.signal.aborted
		});
		const logStreamFailure = (code: string, extra: Record<string, unknown> = {}) => {
			if (outcomeLogged) return;
			outcomeLogged = true;
			logger.warn(
				{ event: 'v2_stream_failure', code, ...extra, ...turnContext() },
				'v2 chat: answer stream did not complete'
			);
		};
		const logTurnComplete = (finishReason: string, completionStatus: 'complete' | 'capped') => {
			if (outcomeLogged) return;
			outcomeLogged = true;
			logger.info(
				{ event: 'v2_turn_complete', finishReason, completionStatus, ...turnContext() },
				'v2 chat: answer delivered'
			);
		};

		const responseBody = new ReadableStream<Uint8Array>({
			async start(controller) {
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
							configHash: session.configHash,
							// Present exactly when a scrubber ran (identity results
							// included): the client adopts this as the stored canonical
							// turn text, matching what `done` will sign into history.
							...(scrubApplied ? { scrubbedUserMessage: canonicalUserMessage } : {})
						})
					);
					for await (const event of providerStream.events()) {
						if (event.kind === 'delta') {
							firstDeltaAt ??= Date.now();
							const available = MAX_ASSISTANT_CODE_POINTS - assistantCodePoints;
							const codePoints = Array.from(event.text);
							const accepted = available > 0 ? codePoints.slice(0, available).join('') : '';
							if (accepted) {
								assistantText += accepted;
								assistantCodePoints += Array.from(accepted).length;
								deltasDelivered += 1;
								controller.enqueue(sse('delta', { v: 2, text: accepted }));
							}
							if (codePoints.length > available) {
								providerStream.cancel();
								if (!assistantText) {
									logStreamFailure('empty_response');
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
									{ id: body.turn.id, role: 'user', content: canonicalUserMessage },
									{ id: assistantMessageId, role: 'assistant', content: assistantText }
								];
								logTurnComplete('application_limit', 'capped');
								if (config.demo) {
									void recordDemoTranscript(session, config, completedHistory, {
										sequence: body.sequence,
										assistantMessageId,
										generationId,
										finishReason: 'application_limit',
										completionStatus: 'capped'
									});
								}
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
								logStreamFailure('empty_response', { finishReason: event.finishReason });
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
								logStreamFailure('invalid_finish_reason', { finishReason });
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
							const completionStatus = capped ? 'capped' : 'complete';
							const completedHistory: HistoryMessage[] = [
								...body.history,
								{ id: body.turn.id, role: 'user', content: canonicalUserMessage },
								{ id: assistantMessageId, role: 'assistant', content: assistantText }
							];
							logTurnComplete(finishReason, completionStatus);
							if (config.demo) {
								void recordDemoTranscript(session, config, completedHistory, {
									sequence: body.sequence,
									assistantMessageId,
									generationId,
									finishReason,
									completionStatus
								});
							}
							controller.enqueue(
								sse('done', {
									v: 2,
									sequence: body.sequence,
									turnId: body.turn.id,
									assistantMessageId,
									finishReason,
									capped,
									completionStatus,
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
							// Provider-side end: an error payload from OpenRouter, an
							// upstream EOF without finish_reason, or (with `cause`) a
							// transport/timeout failure inside the relay.
							logStreamFailure(event.code, { endedBy: 'provider', cause: event.cause });
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
				} catch (error) {
					// Reached when the relay itself fails: enqueue on a closed
					// controller after the client left, or a signing/serialization
					// failure while emitting `done`.
					logStreamFailure('stream_interrupted', {
						endedBy: request.signal.aborted ? 'client' : 'relay',
						error: networkErrorDiagnostic(error)
					});
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
				// The client closed the response (tab closed, navigation, network
				// drop) before the answer finished. The provider stream is stopped
				// so no further tokens are paid for.
				controllerClosed = true;
				providerStream.cancel();
				if (!outcomeLogged) {
					outcomeLogged = true;
					logger.info(
						{ event: 'v2_stream_cancelled', endedBy: 'client', ...turnContext() },
						'v2 chat: client closed the answer stream'
					);
				}
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
