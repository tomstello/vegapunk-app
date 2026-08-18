export const CONDITIONS = ["flu", "covid", "combo", "demo"] as const;

// "clinical-blue-v1" is a partner-neutral alias of the albertsons-v1 token set
// (identical CSS) for surfaces that must not name the partner (public demo).
export const PARTNER_THEME_IDS = ["neutral-v1", "albertsons-v1", "clinical-blue-v1"] as const;

export type StudyCondition = (typeof CONDITIONS)[number];
export type PartnerThemeId = (typeof PARTNER_THEME_IDS)[number];
export type TerminalReason =
	| "completed"
	| "participant_end"
	| "inactivity"
	| "never_engaged"
	| "hard_cap"
	| "init_failure";
export type ChatLifecycle =
	| "ready"
	| "waiting"
	| "streaming"
	| "interrupted"
	| "completed"
	| "capture_error";

export type MessageCompletionStatus =
	| "complete"
	| "streaming"
	| "incomplete"
	| "superseded"
	| "skipped"
	| "capped";

export interface V2Message {
	id: string;
	turnId?: string;
	role: "user" | "assistant";
	content: string;
	createdAtISO: string;
	isInitial: boolean;
	completionStatus: MessageCompletionStatus;
	excludedFromModel: boolean;
	failureReason?: string;
}

export interface CaptureError {
	atISO: string;
	stage: "storage" | "parent" | "checkpoint" | "transcript";
	code: string;
}

export interface V2PersistedState {
	schemaVersion: 2;
	condition: StudyCondition;
	chatSessionKey: string;
	attemptNonce: string;
	configVersion: string;
	configHash: string;
	createOperationId: string;
	messages: V2Message[];
	sequence: number;
	historyTag: string;
	draft: string;
	checkpointHandle: string | null;
	lastAcknowledgedCheckpointRevision: number;
	checkpointInFlightSequence: number | null;
	checkpointInFlightStartedAtISO: string | null;
	lastParentAcknowledgedRevision: number;
	parentSyncCount: number;
	snapshotSequence: number;
	lifecycle: ChatLifecycle;
	createdAtISO: string;
	updatedAtISO: string;
	chatEndISO: string | null;
	// Kept in local/parent recovery metadata, not in canonical transcript JSON.
	terminalReason: TerminalReason | null;
	captureErrors: CaptureError[];
}

export interface SnapshotCounters {
	totalMessages: number;
	initialMessages: number;
	userMessages: number;
	assistantMessages: number;
	completeAssistantMessages: number;
	incompleteAssistantMessages: number;
	totalContentCodePoints: number;
	serializedUtf16CodeUnits: number;
	serializedUtf8Bytes: number;
}

export interface V2Snapshot {
	schemaVersion: 2;
	snapshotSequence: number;
	condition: StudyCondition;
	chatSessionKey: string;
	configVersion: string;
	configHash: string;
	state: "active" | "interrupted" | "completed" | "capture_error";
	createdAtISO: string;
	updatedAtISO: string;
	chatEndISO: string | null;
	messages: V2Message[];
	counters: SnapshotCounters;
	checkpoint: {
		hasHandle: boolean;
		lastAcknowledgedRevision: number;
	};
	parent: {
		lastAcknowledgedRevision: number;
		syncCount: number;
	};
	captureErrors: CaptureError[];
}

export interface AppointmentCta {
	label: string;
	url: string;
}

export interface PublicUiConfig {
	// Persistent partner scheduling button (v8+); absent on older revisions.
	appointmentCta?: AppointmentCta;
	themeId: PartnerThemeId;
	headerTitle: string;
	headerSubtitle: string;
	privacyNote: string;
	placeholderInputText: string;
	suggestedQuestions: string[];
	endChatText: string;
	maxUserMessages: number;
}

export interface SessionResponse {
	v: 2;
	sessionToken: string;
	sessionKey: string;
	condition: StudyCondition;
	configVersion: string;
	configHash: string;
	initialMessages: Array<{
		id: string;
		role: "assistant";
		content: string;
	}>;
	ui: Partial<PublicUiConfig>;
	historyTag: string;
	// Standalone demo configuration (funder preview); absent for study arms.
	demo?: { maxTurns: number; standalone: true };
}

export interface ParentInitMessage {
	v: 2;
	type: "qualtrics:init";
	condition: StudyCondition;
	helloNonce: string;
	nonce: string;
	sessionKey: string;
	attemptNonce: string;
	expectedConfigVersion: string;
	parentOrigin: string;
	sequence: 0;
	checkpointHandle?: string;
	checkpointInFlightSequence?: number;
	checkpointInFlightStartedAtISO?: string;
	createOperationId?: string;
	historyTag?: string;
	historySequence?: number;
	terminalReason?: TerminalReason;
	lastSnapshot?: V2Snapshot;
}

export type ParentMessage =
	| (ParentEnvelope & {
			type: "qualtrics:ack" | "qualtrics:end-ack";
			acknowledgedSnapshotSequence: number;
	  })
	| (ParentEnvelope & {
			type: "qualtrics:flush" | "qualtrics:persist";
			reason: string;
	  });

export interface ParentEnvelope {
	v: 2;
	type: string;
	condition: StudyCondition;
	sessionKey: string;
	nonce: string;
	sequence: number;
}

export interface ChatHistoryItem {
	id: string;
	role: "user" | "assistant";
	content: string;
}

export interface ChatMetaEvent {
	// Server-canonical (redacted) text for the just-sent user turn. Present
	// exactly when the active revision runs the redaction screen; absent on
	// older revisions, whose servers sign the raw text unchanged.
	scrubbedUserMessage?: string;
}

export interface ChatDoneEvent {
	v: 2;
	sequence: number;
	historyTag: string;
	assistantMessageId: string;
	finishReason: string;
	completionStatus: "complete" | "capped";
}

export interface CheckpointRequest {
	v: 2;
	createOperationId: string;
	snapshotSequence: number;
	state: "active" | "interrupted" | "completed" | "capture_error";
	reasonHint?: string;
	transcriptJson: string;
	checkpointHandle?: string;
}

export interface CheckpointResponse {
	v: 2;
	checkpointHandle: string;
	acknowledgedSequence: number;
	checksum: string;
}
