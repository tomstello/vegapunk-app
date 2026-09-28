import {
	MAX_ASSISTANT_CODE_POINTS,
	MAX_CAPTURE_ERRORS,
	MAX_CHECKPOINT_BODY_BYTES,
	MAX_SNAPSHOT_MESSAGES,
	MAX_TRANSCRIPT_UTF16,
	MAX_TRANSCRIPT_UTF8,
	MAX_USER_CODE_POINTS,
	countCodePoints,
	utf8Length,
} from "./constants";
import type {
	CheckpointRequest,
	SnapshotCounters,
	V2Message,
	V2PersistedState,
	V2Snapshot,
} from "./types";

function withTerminalReserve(
	state: V2PersistedState,
	now: string,
): V2PersistedState {
	let captureErrors = state.captureErrors.map((error) => ({ ...error }));
	// Leave room for independent storage/parent/checkpoint/transcript failure
	// metadata that can arrive between preflight and final capture. Simulate the
	// exact append-and-trim behavior even when the error list is already full,
	// and reserve the schema's maximum 100-character code rather than a short
	// placeholder that would underestimate the final JSON size.
	for (let index = 0; index < 4; index += 1) {
		captureErrors.push({
			atISO: now,
			stage: "transcript",
			code: `capacity_reserve_${index}_`.padEnd(100, "x"),
		});
		captureErrors = captureErrors.slice(-MAX_CAPTURE_ERRORS);
	}
	return {
		...state,
		lifecycle: "completed",
		chatEndISO: now,
		terminalReason: "completed",
		captureErrors,
	};
}

export interface SerializedSnapshot {
	snapshot: V2Snapshot;
	json: string;
	utf16CodeUnits: number;
	utf8Bytes: number;
}

function publicState(
	lifecycle: V2PersistedState["lifecycle"],
): V2Snapshot["state"] {
	if (lifecycle === "completed") return "completed";
	if (lifecycle === "interrupted") return "interrupted";
	if (lifecycle === "capture_error") return "capture_error";
	return "active";
}

function countMessages(messages: V2Message[]): SnapshotCounters {
	return {
		totalMessages: messages.length,
		initialMessages: messages.filter((message) => message.isInitial).length,
		userMessages: messages.filter(
			(message) => message.role === "user" && !message.isInitial,
		).length,
		assistantMessages: messages.filter(
			(message) => message.role === "assistant" && !message.isInitial,
		).length,
		completeAssistantMessages: messages.filter(
			(message) =>
				message.role === "assistant" &&
				(message.completionStatus === "complete" ||
					message.completionStatus === "capped"),
		).length,
		incompleteAssistantMessages: messages.filter(
			(message) =>
				message.role === "assistant" &&
				!["complete", "capped"].includes(message.completionStatus),
		).length,
		totalContentCodePoints: messages.reduce(
			(total, message) => total + countCodePoints(message.content),
			0,
		),
		serializedUtf16CodeUnits: 0,
		serializedUtf8Bytes: 0,
	};
}

export function serializeSnapshot(state: V2PersistedState): SerializedSnapshot {
	const snapshot: V2Snapshot = {
		schemaVersion: 2,
		snapshotSequence: state.snapshotSequence,
		condition: state.condition,
		chatSessionKey: state.chatSessionKey,
		configVersion: state.configVersion,
		configHash: state.configHash,
		state: publicState(state.lifecycle),
		createdAtISO: state.createdAtISO,
		updatedAtISO: state.updatedAtISO,
		chatEndISO: state.chatEndISO,
		messages: state.messages.map((message) => ({ ...message })),
		counters: countMessages(state.messages),
		checkpoint: {
			hasHandle: state.checkpointHandle !== null,
			lastAcknowledgedRevision:
				state.lastAcknowledgedCheckpointRevision,
		},
		parent: {
			lastAcknowledgedRevision: state.lastParentAcknowledgedRevision,
			syncCount: state.parentSyncCount,
		},
		captureErrors: state.captureErrors.map((error) => ({ ...error })),
	};

	let json = "";
	for (let iteration = 0; iteration < 12; iteration += 1) {
		json = JSON.stringify(snapshot);
		const utf16CodeUnits = json.length;
		const utf8Bytes = utf8Length(json);
		if (
			snapshot.counters.serializedUtf16CodeUnits === utf16CodeUnits &&
			snapshot.counters.serializedUtf8Bytes === utf8Bytes
		) {
			return { snapshot, json, utf16CodeUnits, utf8Bytes };
		}
		snapshot.counters.serializedUtf16CodeUnits = utf16CodeUnits;
		snapshot.counters.serializedUtf8Bytes = utf8Bytes;
	}

	throw new Error("snapshot_length_counters_did_not_converge");
}

export function transcriptFits(serialized: SerializedSnapshot): boolean {
	return (
		serialized.snapshot.messages.length <= MAX_SNAPSHOT_MESSAGES &&
		serialized.utf16CodeUnits <= MAX_TRANSCRIPT_UTF16 &&
		serialized.utf8Bytes <= MAX_TRANSCRIPT_UTF8
	);
}

/**
 * The serialization-facing view of client state while user turns await their
 * server-canonical (redacted) text from the chat stream's meta event.
 *
 * Every persisted or transmitted artifact (sessionStorage state, parent
 * snapshot, checkpoint body, rollback clone) must be built from this view so
 * raw participant text never leaves component memory before redaction. The
 * excluded turn's raw text is parked in `draft` — browser-local by design —
 * so a reload puts the question back in the composer instead of losing it.
 * The filtered view is the consistent pre-turn conversation, so a non-
 * terminal in-flight lifecycle maps back to "ready"; terminal states are
 * preserved so an end-of-chat capture stays terminal.
 *
 * Identity when no turn is pending: the streaming hot path pays nothing.
 */
export function canonicalView(
	state: V2PersistedState,
	pendingTurnIds: ReadonlySet<string>,
): V2PersistedState {
	if (pendingTurnIds.size === 0) return state;
	const isPending = (message: V2Message): boolean =>
		message.turnId !== undefined && pendingTurnIds.has(message.turnId);
	const excluded = state.messages.filter(isPending);
	if (excluded.length === 0) return state;
	const messages = state.messages.filter((message) => !isPending(message));
	// The newest still-live pending user turn (not one retired by Skip) is the
	// participant's active question; keep its raw text recoverable as a draft.
	const liveUser = [...excluded]
		.reverse()
		.find((message) => message.role === "user" && !message.excludedFromModel);
	const lifecycle =
		state.chatEndISO === null &&
		(state.lifecycle === "waiting" ||
			state.lifecycle === "streaming" ||
			state.lifecycle === "interrupted")
			? "ready"
			: state.lifecycle;
	return {
		...state,
		messages,
		draft: liveUser ? liveUser.content : state.draft,
		lifecycle,
	};
}

export function checkpointBodyFits(
	state: V2PersistedState,
	serialized: SerializedSnapshot,
	reasonHint?: string,
): boolean {
	const request: CheckpointRequest = {
		v: 2,
		createOperationId: state.createOperationId,
		snapshotSequence: serialized.snapshot.snapshotSequence,
		state: serialized.snapshot.state,
		...(reasonHint ? { reasonHint } : {}),
		transcriptJson: serialized.json,
		...(state.checkpointHandle
			? { checkpointHandle: state.checkpointHandle }
			: {}),
	};
	return utf8Length(JSON.stringify(request)) <= MAX_CHECKPOINT_BODY_BYTES;
}

export function canStartUserTurn(
	state: V2PersistedState,
	userContent: string,
): { ok: true } | { ok: false; reason: string } {
	if (state.messages.length + 2 > MAX_SNAPSHOT_MESSAGES) {
		return {
			ok: false,
			reason:
				"This conversation has reached its safe message limit. Please finish the chat so your answers can be saved.",
		};
	}
	if (countCodePoints(userContent) > MAX_USER_CODE_POINTS) {
		return {
			ok: false,
			reason: `Questions can be up to ${MAX_USER_CODE_POINTS.toLocaleString()} characters.`,
		};
	}

	const now = new Date().toISOString();
	const turnId = "00000000-0000-4000-8000-000000000000";
	const reserve: V2PersistedState = withTerminalReserve({
		...state,
		snapshotSequence: state.snapshotSequence + 10,
		updatedAtISO: now,
		messages: [
			...state.messages,
			{
				id: turnId,
				turnId,
				role: "user",
				content: userContent,
				createdAtISO: now,
				isInitial: false,
				completionStatus: "complete",
				excludedFromModel: false,
			},
			{
				id: "00000000-0000-4000-8000-000000000001",
				turnId,
				role: "assistant",
				// JSON escapes control characters to six code units, which is a
				// larger checkpoint envelope than an equally long emoji answer.
				content: "\u0000".repeat(MAX_ASSISTANT_CODE_POINTS),
				createdAtISO: now,
				isInitial: false,
				completionStatus: "complete",
				excludedFromModel: false,
			},
		],
	}, now);
	let serialized: SerializedSnapshot;
	try {
		serialized = serializeSnapshot(reserve);
	} catch {
		return {
			ok: false,
			reason:
				"The conversation could not be prepared for safe storage. Please finish the chat.",
		};
	}
	if (!transcriptFits(serialized)) {
		return {
			ok: false,
			reason:
				"This conversation has reached its safe storage limit. Please finish the chat so your answers can be saved.",
		};
	}
	if (!checkpointBodyFits(reserve, serialized, "turn_capacity_check")) {
		return {
			ok: false,
			reason:
				"This conversation has reached its safe storage limit. Please finish the chat so your answers can be saved.",
		};
	}
	return { ok: true };
}

export function canRetryAssistant(
	state: V2PersistedState,
	turnId: string,
): { ok: true } | { ok: false; reason: string } {
	if (state.messages.length + 1 > MAX_SNAPSHOT_MESSAGES) {
		return {
			ok: false,
			reason:
				"This conversation has reached its safe message limit. Skip this answer or finish the chat.",
		};
	}

	const now = new Date().toISOString();
	const reserve: V2PersistedState = withTerminalReserve({
		...state,
		snapshotSequence: state.snapshotSequence + 10,
		updatedAtISO: now,
		messages: [
			...state.messages.map((message) =>
				message.role === "assistant" &&
				message.turnId === turnId &&
				message.completionStatus === "incomplete"
					? {
						...message,
						completionStatus: "superseded" as const,
						excludedFromModel: true,
					}
					: message,
			),
			{
				id: "00000000-0000-4000-8000-000000000002",
				turnId,
				role: "assistant",
				content: "\u0000".repeat(MAX_ASSISTANT_CODE_POINTS),
				createdAtISO: now,
				isInitial: false,
				completionStatus: "incomplete",
				excludedFromModel: true,
				failureReason: "retry_capacity_reserve",
			},
		],
	}, now);

	try {
		const serialized = serializeSnapshot(reserve);
		if (
			transcriptFits(serialized) &&
			checkpointBodyFits(reserve, serialized, "retry_capacity_check")
		) {
			return { ok: true };
		}
	} catch {
		// Return the participant-safe capacity response below.
	}
	return {
		ok: false,
		reason:
			"This conversation has reached its safe storage limit. Skip this answer or finish the chat.",
	};
}
