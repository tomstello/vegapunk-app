import { CONFIG_VERSIONS, MAX_ASSISTANT_CODE_POINTS, countCodePoints } from "./constants";
import type {
	ChatDoneEvent,
	ChatHistoryItem,
	PartnerThemeId,
	SessionResponse,
	StudyCondition,
} from "./types";
import { PARTNER_THEME_IDS } from "./types";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_SESSION_RESPONSE_CHARS = 100_000;
const MAX_SSE_BUFFER_CHARS = 65_536;
const MAX_HTTP_ERROR_RESPONSE_CHARS = 16_384;
const SAFE_SERVER_ERROR_CODE = /^[a-z0-9_]{1,64}$/;
// The server's 45/30/180-second provider clocks start after it has read and
// validated the request body. These larger browser wall-clock margins include
// slow cellular upload and queue/RTT time without slowing successful answers.
const FIRST_EVENT_TIMEOUT_MS = 75_000;
const STREAM_IDLE_TIMEOUT_MS = 35_000;
const HARD_STREAM_TIMEOUT_MS = 240_000;

export class ParticipantSafeError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly retryable: boolean,
	) {
		super(message);
		this.name = "ParticipantSafeError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

async function parseHttpErrorEnvelope(response: Response): Promise<{
	code?: string;
	retryable?: boolean;
}> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return {};
	}
	if (text.length > MAX_HTTP_ERROR_RESPONSE_CHARS) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return {};
	}
	if (!isRecord(value) || value.v !== 2 || !isRecord(value.error)) return {};
	const code = value.error.code;
	const retryable = value.error.retryable;
	return {
		...(typeof code === "string" && SAFE_SERVER_ERROR_CODE.test(code) ? { code } : {}),
		...(typeof retryable === "boolean" ? { retryable } : {}),
	};
}

function cleanUi(value: unknown): SessionResponse["ui"] | null {
	if (!isRecord(value)) return null;
	const ui: SessionResponse["ui"] = {};
	if (value.themeId !== undefined) {
		if (
			typeof value.themeId !== "string" ||
			!PARTNER_THEME_IDS.includes(value.themeId as PartnerThemeId)
		)
			return null;
		ui.themeId = value.themeId as PartnerThemeId;
	}
	if (value.headerTitle !== undefined) {
		if (typeof value.headerTitle !== "string" || value.headerTitle.length > 100)
			return null;
		ui.headerTitle = value.headerTitle;
	}
	if (value.headerSubtitle !== undefined) {
		if (typeof value.headerSubtitle !== "string" || value.headerSubtitle.length > 120)
			return null;
		ui.headerSubtitle = value.headerSubtitle;
	}
	if (value.privacyNote !== undefined) {
		if (typeof value.privacyNote !== "string" || value.privacyNote.length > 500)
			return null;
		ui.privacyNote = value.privacyNote;
	}
	if (value.placeholderInputText !== undefined) {
		if (
			typeof value.placeholderInputText !== "string" ||
			value.placeholderInputText.length > 150
		)
			return null;
		ui.placeholderInputText = value.placeholderInputText;
	}
	if (value.endChatText !== undefined) {
		if (typeof value.endChatText !== "string" || value.endChatText.length > 100)
			return null;
		ui.endChatText = value.endChatText;
	}
	if (value.maxUserMessages !== undefined) {
		if (value.maxUserMessages !== 35) return null;
		ui.maxUserMessages = value.maxUserMessages;
	}
	if (value.suggestedQuestions !== undefined) {
		if (
			!Array.isArray(value.suggestedQuestions) ||
			value.suggestedQuestions.length > 20 ||
			!value.suggestedQuestions.every(
				(item) => typeof item === "string" && item.length <= 500,
			)
		)
			return null;
		ui.suggestedQuestions = value.suggestedQuestions as string[];
	}
	return ui;
}

function parseSessionResponse(
	value: unknown,
	condition: StudyCondition,
	sessionKey: string,
	expectedConfigVersion: string,
): SessionResponse | null {
	if (!isRecord(value) || value.v !== 2) return null;
	if (
		value.condition !== condition ||
		value.sessionKey !== sessionKey ||
		typeof value.sessionToken !== "string" ||
		value.sessionToken.length < 20 ||
		value.sessionToken.length > 8_192 ||
		value.configVersion !== expectedConfigVersion ||
		typeof value.configHash !== "string" ||
		!SHA256_PATTERN.test(value.configHash) ||
		typeof value.historyTag !== "string" ||
		value.historyTag.length < 20 ||
		value.historyTag.length > 8_192 ||
		!Array.isArray(value.initialMessages) ||
		value.initialMessages.length > 20
	) {
		return null;
	}
	const initialMessages: SessionResponse["initialMessages"] = [];
	let totalInitialLength = 0;
	for (const item of value.initialMessages) {
		if (
			!isRecord(item) ||
			!isUuid(item.id) ||
			item.role !== "assistant" ||
			typeof item.content !== "string" ||
			countCodePoints(item.content) > MAX_ASSISTANT_CODE_POINTS
		) {
			return null;
		}
		totalInitialLength += item.content.length;
		if (totalInitialLength > 60_000) return null;
		initialMessages.push({
			id: item.id,
			role: "assistant",
			content: item.content,
		});
	}
	const ui = cleanUi(value.ui);
	if (ui === null) return null;
	return {
		v: 2,
		sessionToken: value.sessionToken,
		sessionKey,
		condition,
		configVersion: value.configVersion,
		configHash: value.configHash,
		initialMessages,
		ui,
		historyTag: value.historyTag,
	};
}

export async function createPublicSession(
	condition: StudyCondition,
	chatSessionKey: string,
	attemptNonce: string,
	signal?: AbortSignal,
	resumeConfig?: { configVersion: string; configHash: string },
): Promise<SessionResponse> {
	let response: Response;
	try {
		response = await fetch(`/api/v2/session/${condition}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				v: 2,
				chatSessionKey,
				attemptNonce,
				...(resumeConfig ? { resumeConfig } : {}),
			}),
			signal,
		});
	} catch {
		throw new ParticipantSafeError(
			"session_network_error",
			"The chat could not connect. Check your connection and try again.",
			true,
		);
	}
	if (!response.ok) {
		throw new ParticipantSafeError(
			`session_http_${response.status}`,
			"The chat is temporarily unavailable. Please try again.",
			response.status === 408 || response.status === 429 || response.status >= 500,
		);
	}
	const text = await response.text();
	if (text.length > MAX_SESSION_RESPONSE_CHARS) {
		throw new ParticipantSafeError(
			"session_response_too_large",
			"The chat received an invalid response. Please try again.",
			true,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ParticipantSafeError(
			"session_invalid_json",
			"The chat received an invalid response. Please try again.",
			true,
		);
	}
	const session = parseSessionResponse(
		parsed,
		condition,
		chatSessionKey,
		resumeConfig?.configVersion ?? CONFIG_VERSIONS[condition],
	);
	if (!session) {
		throw new ParticipantSafeError(
			"session_invalid_schema",
			"The chat configuration could not be verified. Please try again.",
			false,
		);
	}
	return session;
}

interface ChatRequestOptions {
	token: string;
	sequence: number;
	history: ChatHistoryItem[];
	historyTag: string;
	turn: { id: string; userMessage: string };
	signal?: AbortSignal;
	onMeta: () => void;
	onDelta: (text: string) => void;
}

interface ParsedSseEvent {
	event: string;
	data: string;
}

function parseJsonRecord(data: string): Record<string, unknown> {
	if (data.length > MAX_SSE_BUFFER_CHARS) {
		throw new ParticipantSafeError(
			"stream_event_too_large",
			"The answer was interrupted. You can try again.",
			true,
		);
	}
	try {
		const parsed: unknown = JSON.parse(data);
		if (!isRecord(parsed)) throw new Error("not an object");
		return parsed;
	} catch {
		throw new ParticipantSafeError(
			"stream_invalid_event",
			"The answer was interrupted. You can try again.",
			true,
		);
	}
}

async function consumeSse(
	response: Response,
	options: ChatRequestOptions,
	onTransportActivity: () => void,
): Promise<ChatDoneEvent> {
	if (!response.body) {
		throw new ParticipantSafeError(
			"stream_missing_body",
			"No answer was received. You can try again.",
			true,
		);
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("text/event-stream")) {
		throw new ParticipantSafeError(
			"stream_wrong_content_type",
			"The answer could not be read. You can try again.",
			true,
		);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	let eventName = "";
	let dataLines: string[] = [];
	let receivedMeta = false;
	let terminal: ChatDoneEvent | null = null;

	const dispatch = (): void => {
		if (!eventName && dataLines.length === 0) return;
		const parsedEvent: ParsedSseEvent = {
			event: eventName || "message",
			data: dataLines.join("\n"),
		};
		eventName = "";
		dataLines = [];
		const data = parseJsonRecord(parsedEvent.data);
		if (terminal) {
			throw new ParticipantSafeError(
				"stream_data_after_done",
				"The answer could not be verified. You can try again.",
				true,
			);
		}
		if (parsedEvent.event === "meta") {
			if (
				receivedMeta ||
				data.v !== 2 ||
				data.sequence !== options.sequence
			) {
				throw new ParticipantSafeError(
					"stream_invalid_meta",
					"The answer could not be verified. You can try again.",
					true,
				);
			}
			receivedMeta = true;
			options.onMeta();
			return;
		}
		if (!receivedMeta) {
			throw new ParticipantSafeError(
				"stream_missing_meta",
				"The answer could not be verified. You can try again.",
				true,
			);
		}
		if (parsedEvent.event === "delta") {
			if (data.v !== 2 || typeof data.text !== "string" || data.text.length > 16_384) {
				throw new ParticipantSafeError(
					"stream_invalid_delta",
					"The answer could not be verified. You can try again.",
					true,
				);
			}
			options.onDelta(data.text);
			return;
		}
		if (parsedEvent.event === "error") {
			const code = typeof data.code === "string" ? data.code.slice(0, 80) : "provider_error";
			throw new ParticipantSafeError(
				code,
				"The answer was interrupted. Your question is saved, and you can try again.",
				data.retryable !== false,
			);
		}
		if (parsedEvent.event !== "done") {
			throw new ParticipantSafeError(
				"stream_unknown_event",
				"The answer could not be verified. You can try again.",
				true,
			);
		}
		if (
			data.v !== 2 ||
			data.sequence !== options.sequence ||
			typeof data.historyTag !== "string" ||
			data.historyTag.length < 20 ||
			data.historyTag.length > 8_192 ||
			!isUuid(data.assistantMessageId) ||
			typeof data.finishReason !== "string" ||
			data.finishReason.length > 100 ||
			(data.completionStatus !== "complete" && data.completionStatus !== "capped")
		) {
			throw new ParticipantSafeError(
				"stream_invalid_done",
				"The answer could not be verified. You can try again.",
				true,
			);
		}
		terminal = {
			v: 2,
			sequence: data.sequence,
			historyTag: data.historyTag,
			assistantMessageId: data.assistantMessageId,
			finishReason: data.finishReason,
			completionStatus: data.completionStatus,
		};
	};

	const processLines = (flush: boolean): void => {
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line === "") {
				dispatch();
			} else if (line.startsWith("event:")) {
				eventName = line.slice(6).trimStart();
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).replace(/^ /, ""));
			} else if (!line.startsWith(":")) {
				throw new ParticipantSafeError(
					"stream_invalid_line",
					"The answer could not be read. You can try again.",
					true,
				);
			}
		}
		if (buffer.length > MAX_SSE_BUFFER_CHARS) {
			throw new ParticipantSafeError(
				"stream_buffer_too_large",
				"The answer could not be read. You can try again.",
				true,
			);
		}
		if (flush && buffer.length > 0) {
			let line = buffer;
			buffer = "";
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.startsWith("event:")) eventName = line.slice(6).trimStart();
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
			else if (line !== "" && !line.startsWith(":")) {
				throw new ParticipantSafeError(
					"stream_invalid_final_line",
					"The answer could not be read. You can try again.",
					true,
				);
			}
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			onTransportActivity();
			buffer += decoder.decode(value, { stream: true });
			processLines(false);
		}
		buffer += decoder.decode();
		processLines(true);
		if (eventName || dataLines.length > 0) dispatch();
	} catch (error) {
		try {
			await reader.cancel();
		} catch {
			// The original stream error is the useful failure.
		}
		throw error;
	} finally {
		reader.releaseLock();
	}

	if (!terminal) {
		throw new ParticipantSafeError(
			"stream_eof_before_done",
			"The answer ended before it could be verified. Your question is saved, and you can try again.",
			true,
		);
	}
	return terminal;
}

export async function streamChat(options: ChatRequestOptions): Promise<ChatDoneEvent> {
	const controller = new AbortController();
	let timeoutCode = "stream_cancelled";
	const firstEventTimer = window.setTimeout(() => {
		timeoutCode = "first_event_timeout";
		controller.abort();
	}, FIRST_EVENT_TIMEOUT_MS);
	let idleTimer = 0;
	const hardTimer = window.setTimeout(() => {
		timeoutCode = "hard_stream_timeout";
		controller.abort();
	}, HARD_STREAM_TIMEOUT_MS);
	const abortFromCaller = () => {
		timeoutCode = "participant_cancelled";
		controller.abort();
	};
	options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	const activity = () => {
		window.clearTimeout(firstEventTimer);
		window.clearTimeout(idleTimer);
		idleTimer = window.setTimeout(() => {
			timeoutCode = "stream_idle_timeout";
			controller.abort();
		}, STREAM_IDLE_TIMEOUT_MS);
	};

	try {
		let response: Response;
		try {
			response = await fetch("/api/v2/chat", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${options.token}`,
					"idempotency-key": options.turn.id,
				},
				body: JSON.stringify({
					v: 2,
					sequence: options.sequence,
					history: options.history,
					historyTag: options.historyTag,
					turn: options.turn,
				}),
				signal: controller.signal,
			});
		} catch {
			if (controller.signal.aborted) {
				throw new ParticipantSafeError(
					timeoutCode,
					timeoutCode === "participant_cancelled"
						? "The answer was stopped."
						: "The answer took too long. Your question is saved, and you can try again.",
					timeoutCode !== "participant_cancelled",
				);
			}
			throw new ParticipantSafeError(
				"chat_network_error",
				"The connection was interrupted. Your question is saved, and you can try again.",
				true,
			);
		}

		if (!response.ok) {
			const serverError = await parseHttpErrorEnvelope(response);
			const retryable = serverError.retryable ??
				(response.status === 408 || response.status === 429 || response.status >= 500);
			throw new ParticipantSafeError(
				serverError.code ? `chat_${serverError.code}` : `chat_http_${response.status}`,
				response.status === 429
					? "The chat is busy right now. Your question is saved; please wait a moment and try again."
					: retryable
						? "The chat is temporarily unavailable. Your question is saved, and you can try again."
						: "The chat is unavailable right now. Your question is saved; please skip this answer or end the chat.",
				retryable,
			);
		}
		return await consumeSse(response, options, activity);
	} finally {
		window.clearTimeout(firstEventTimer);
		window.clearTimeout(idleTimer);
		window.clearTimeout(hardTimer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}
