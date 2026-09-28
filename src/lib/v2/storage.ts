import {
	MAX_CAPTURE_ERRORS,
	MAX_SNAPSHOT_MESSAGES,
	MAX_USER_CODE_POINTS,
	countCodePoints,
} from "./constants";
import type { CaptureError, StudyCondition, V2PersistedState } from "./types";

const STATE_PREFIX = "vegapunk:v2:";
const ACTIVE_PREFIX = `${STATE_PREFIX}active:`;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const LIFECYCLES = [
	"ready",
	"waiting",
	"streaming",
	"interrupted",
	"completed",
	"capture_error",
];
const MESSAGE_STATUSES = [
	"complete",
	"streaming",
	"incomplete",
	"superseded",
	"skipped",
	"capped",
];
const TERMINAL_REASONS = [
	"completed",
	"participant_end",
	"inactivity",
	"never_engaged",
	"hard_cap",
	"init_failure",
];
const STATE_KEYS = new Set([
	"schemaVersion", "condition", "chatSessionKey", "attemptNonce", "configVersion",
	"configHash", "createOperationId", "messages", "sequence", "historyTag", "draft",
	"checkpointHandle", "lastAcknowledgedCheckpointRevision",
	"checkpointInFlightSequence", "checkpointInFlightStartedAtISO",
	"lastParentAcknowledgedRevision", "parentSyncCount", "snapshotSequence", "lifecycle",
	"createdAtISO", "updatedAtISO", "chatEndISO", "terminalReason", "captureErrors",
]);
const MESSAGE_KEYS = new Set([
	"id", "turnId", "role", "content", "createdAtISO", "isInitial",
	"completionStatus", "excludedFromModel", "failureReason",
]);

export function stateStorageKey(chatSessionKey: string): string {
	return `${STATE_PREFIX}${chatSessionKey}`;
}

export function activeStorageKey(condition: StudyCondition): string {
	return `${ACTIVE_PREFIX}${condition}`;
}

export function draftFitsStorage(value: string): boolean {
	return countCodePoints(value) <= MAX_USER_CODE_POINTS;
}

export function readActiveSessionKey(condition: StudyCondition): string | null {
	try {
		return sessionStorage.getItem(activeStorageKey(condition));
	} catch {
		return null;
	}
}

export type StateReadResult =
	| { status: "ok"; state: V2PersistedState }
	| { status: "missing" }
	| { status: "corrupt" }
	| { status: "unavailable" };

export function readPersistedState(chatSessionKey: string): StateReadResult {
	try {
		const raw = sessionStorage.getItem(stateStorageKey(chatSessionKey));
		if (!raw) return { status: "missing" };
		try {
			const parsed: unknown = JSON.parse(raw);
			return isPersistedState(parsed)
				? { status: "ok", state: parsed }
				: { status: "corrupt" };
		} catch {
			return { status: "corrupt" };
		}
	} catch {
		return { status: "unavailable" };
	}
}

export function persistState(state: V2PersistedState): CaptureError | null {
	try {
		sessionStorage.setItem(stateStorageKey(state.chatSessionKey), JSON.stringify(state));
		sessionStorage.setItem(activeStorageKey(state.condition), state.chatSessionKey);
		return null;
	} catch {
		return {
			atISO: new Date().toISOString(),
			stage: "storage",
			code: "session_storage_unavailable",
		};
	}
}

export function appendCaptureError(
	state: V2PersistedState,
	error: CaptureError,
): V2PersistedState {
	const duplicate = state.captureErrors.some(
		(item) => item.stage === error.stage && item.code === error.code,
	);
	if (duplicate) return state;
	return {
		...state,
		captureErrors: [...state.captureErrors, error].slice(-MAX_CAPTURE_ERRORS),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedState(value: unknown): value is V2PersistedState {
	if (!isRecord(value)) return false;
	if (
		!Object.keys(value).every((key) => STATE_KEYS.has(key)) ||
		value.schemaVersion !== 2 ||
		typeof value.chatSessionKey !== "string" ||
		typeof value.attemptNonce !== "string" ||
		!(["flu", "covid", "combo"] as unknown[]).includes(value.condition) ||
		typeof value.configVersion !== "string" ||
		value.configVersion.length < 1 ||
		value.configVersion.length > 96 ||
		typeof value.configHash !== "string" ||
		!HASH_PATTERN.test(value.configHash) ||
		typeof value.createOperationId !== "string" ||
		!UUID_PATTERN.test(value.createOperationId) ||
		!UUID_PATTERN.test(value.chatSessionKey) ||
		!UUID_PATTERN.test(value.attemptNonce) ||
		!Array.isArray(value.messages) ||
		value.messages.length > MAX_SNAPSHOT_MESSAGES ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) < 0 ||
		(value.sequence as number) > 35 ||
		typeof value.historyTag !== "string" ||
		value.historyTag.length < 1 ||
		value.historyTag.length > 8_192 ||
		typeof value.draft !== "string" ||
		!draftFitsStorage(value.draft) ||
		!Number.isSafeInteger(value.snapshotSequence) ||
		(value.snapshotSequence as number) < 0 ||
		(value.snapshotSequence as number) > 1_000_000 ||
		!LIFECYCLES.includes(String(value.lifecycle)) ||
		typeof value.createdAtISO !== "string" ||
		!Number.isFinite(Date.parse(value.createdAtISO)) ||
		typeof value.updatedAtISO !== "string" ||
		!Number.isFinite(Date.parse(value.updatedAtISO)) ||
		!(value.chatEndISO === null ||
			(typeof value.chatEndISO === "string" && Number.isFinite(Date.parse(value.chatEndISO)))) ||
		!(value.terminalReason === null ||
			(typeof value.terminalReason === "string" && TERMINAL_REASONS.includes(value.terminalReason))) ||
		((value.chatEndISO === null) !== (value.terminalReason === null)) ||
		!(value.checkpointHandle === null ||
			(typeof value.checkpointHandle === "string" && value.checkpointHandle.length <= 8_192)) ||
		!Number.isSafeInteger(value.lastAcknowledgedCheckpointRevision) ||
		(value.lastAcknowledgedCheckpointRevision as number) < 0 ||
		!((value.checkpointInFlightSequence === null && value.checkpointInFlightStartedAtISO === null) ||
			(Number.isSafeInteger(value.checkpointInFlightSequence) &&
				(value.checkpointInFlightSequence as number) >= 0 &&
				typeof value.checkpointInFlightStartedAtISO === "string" &&
				Number.isFinite(Date.parse(value.checkpointInFlightStartedAtISO)))) ||
		!Number.isSafeInteger(value.lastParentAcknowledgedRevision) ||
		(value.lastParentAcknowledgedRevision as number) < 0 ||
		!Number.isSafeInteger(value.parentSyncCount) ||
		(value.parentSyncCount as number) < 0 ||
		!Array.isArray(value.captureErrors) ||
		value.captureErrors.length > MAX_CAPTURE_ERRORS
	) {
		return false;
	}

	const ids = new Set<string>();
	const validMessages = value.messages.every((message) => {
		if (!isRecord(message)) return false;
		const valid = (
			Object.keys(message).every((key) => MESSAGE_KEYS.has(key)) &&
			typeof message.id === "string" &&
			UUID_PATTERN.test(message.id) &&
			(message.role === "user" || message.role === "assistant") &&
			typeof message.content === "string" &&
			typeof message.createdAtISO === "string" &&
			Number.isFinite(Date.parse(message.createdAtISO)) &&
			typeof message.isInitial === "boolean" &&
			MESSAGE_STATUSES.includes(String(message.completionStatus)) &&
			typeof message.excludedFromModel === "boolean" &&
			(message.isInitial === true ||
				(typeof message.turnId === "string" && UUID_PATTERN.test(message.turnId))) &&
			(message.failureReason === undefined ||
				(typeof message.failureReason === "string" && message.failureReason.length <= 100))
		);
		if (!valid || ids.has(message.id as string)) return false;
		ids.add(message.id as string);
		return true;
	});
	if (!validMessages) return false;
	return value.captureErrors.every((item) => {
		if (!isRecord(item)) return false;
		return (
			typeof item.atISO === "string" &&
			Number.isFinite(Date.parse(item.atISO)) &&
			["storage", "parent", "checkpoint", "transcript"].includes(String(item.stage)) &&
			typeof item.code === "string" &&
			item.code.length >= 1 &&
			item.code.length <= 100
		);
	});
}
