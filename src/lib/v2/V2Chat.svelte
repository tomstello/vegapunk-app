<script lang="ts">
	import { onMount, tick } from "svelte";
	import medicalAvatar from "$lib/icons/medical2.png";
	import scrollDownIcon from "$lib/icons/down.svg";
	import ActivityIndicator from "./ActivityIndicator.svelte";
	import SafeMarkdown from "./SafeMarkdown.svelte";
	import {
		DEFAULT_UI,
		MAX_ASSISTANT_ATTEMPTS_PER_TURN,
		MAX_ASSISTANT_CODE_POINTS,
		MAX_SNAPSHOT_MESSAGES,
		MAX_TRANSCRIPT_UTF16,
		MAX_TRANSCRIPT_UTF8,
		MAX_TURNS,
		MAX_USER_CODE_POINTS,
		CONFIG_VERSIONS,
		countCodePoints,
		newUuid,
		takeCodePoints,
		utf8Length,
	} from "./constants";
	import {
		ParticipantSafeError,
		createPublicSession,
		streamChat,
	} from "./api";
	import { CheckpointWorker, checkpointRecoveryDelayMs } from "./checkpointWorker";
	import { ParentBridge } from "./parentBridge";
	import {
		mergeRecoveredCheckpointLease,
		reconcileRecoveredCheckpointHandle,
		restoreInterruptedTurn,
	} from "./recovery";
	import {
		appendCaptureError,
		persistState,
		readActiveSessionKey,
		readPersistedState,
	} from "./storage";
	import {
		canonicalView,
		canStartUserTurn,
		canRetryAssistant,
		serializeSnapshot,
		transcriptFits,
		type SerializedSnapshot,
	} from "./snapshot";
	import {
		STREAM_PRESENTATION_FRAME_MS,
		STREAM_PRESENTATION_MAX_LAG_MS,
		takePresentationFrame,
	} from "./streamPresentation";
	import type {
		CaptureError,
		ChatHistoryItem,
		ParentInitMessage,
		PartnerThemeId,
		PublicUiConfig,
		SessionResponse,
		StudyCondition,
		TerminalReason,
		V2Message,
		V2PersistedState,
		V2Snapshot,
	} from "./types";

	export let condition: StudyCondition;
	export let initialThemeId: PartnerThemeId = "neutral-v1";

	type InitStatus = "connecting" | "ready" | "failed";
	const UUID_PATTERN =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	const MESSAGE_STATUSES = new Set([
		"complete",
		"streaming",
		"incomplete",
		"superseded",
		"skipped",
		"capped",
	]);
	const SNAPSHOT_KEYS = new Set([
		"schemaVersion", "snapshotSequence", "condition", "chatSessionKey",
		"configVersion", "configHash", "state", "createdAtISO", "updatedAtISO",
		"chatEndISO", "messages", "counters", "checkpoint", "parent", "captureErrors",
	]);
	const MESSAGE_KEYS = new Set([
		"id", "turnId", "role", "content", "createdAtISO", "isInitial",
		"completionStatus", "excludedFromModel", "failureReason",
	]);
	const CHARACTER_LIMIT_WARNING_AT = Math.max(1, MAX_USER_CODE_POINTS - 200);
	const TURN_LIMIT_WARNING_AT = Math.max(1, MAX_TURNS - 5);

	let initStatus: InitStatus = "connecting";
	let initError = "";
	let state: V2PersistedState | null = null;
	let ui: PublicUiConfig = { ...DEFAULT_UI, themeId: initialThemeId };
	let sessionToken = "";
	let sessionTokenAt = 0;
	let bridge: ParentBridge | null = null;
	let checkpointWorker: CheckpointWorker | null = null;
	let activeRequest: AbortController | null = null;
	let transcriptElement: HTMLDivElement;
	let inputElement: HTMLTextAreaElement;
	let endChatButton: HTMLButtonElement;
	let endConfirmButton: HTMLButtonElement;
	let draftInput = "";
	let storageWritable = true;
	let checkpointEnabled = true;
	let continuationBlocked = false;
	let destroyed = false;
	let initializationNumber = 0;
	let draftTimer: number | undefined;
	let lastStreamPersistAt = 0;
	let lastActivityAt = 0;
	let lastPassiveActivityAt = 0;
	let transcriptRevision = 0;
	let lastCheckpointedTranscriptRevision = -1;
	let lastParticipantError = "";
	let capacityError = "";
	let retryableFailure = true;
	let endConfirmationOpen = false;
	let endConfirmationReturnFocus: HTMLElement | null = null;
	let endAcknowledged = false;
	let followStream = true;
	let transcriptAtBottom = true;
	let lastTouchY: number | null = null;
	let lastEnd: { serialized: SerializedSnapshot; reason: string } | null = null;
	let lastSafeState: V2PersistedState | null = null;
	let presentedAssistantId: string | null = null;
	let presentedAssistantContent = "";
	let pendingPresentationContent = "";
	let pendingPresentationSince = 0;
	let presentationTimer: number | undefined;
	let presentationDrainTimer: number | undefined;
	let resolvePresentationDrain: (() => void) | null = null;
	// Turns whose user text has not yet been replaced by the server-canonical
	// (redacted) version from the stream's meta event. Every serialization
	// flows through canonicalView with this set, so raw text never reaches
	// sessionStorage messages, the parent snapshot, or a checkpoint body.
	// Retired (skipped/ended) turns stay in the set permanently.
	let pendingCanonicalTurnIds: ReadonlySet<string> = new Set();
	// The participant's own typed text, keyed by turnId, for their bubble
	// only. Component memory — never on the message object, never serialized.
	// Set to false to show the redacted text after meta instead (the
	// transparent-swap variant); this constant is the entire difference.
	const KEEP_RAW_DISPLAY = true;
	let presentedUserContents: Record<string, string> = {};
	// Set when the deferred meta-time capture fails and the request is
	// aborted so the participant gets their question back in the composer.
	let abortedForCaptureFailure = false;

	$: userTurnCount =
		state?.messages.filter(
			(message) => message.role === "user" && !message.isInitial,
		).length ?? 0;
	$: inputCodePoints = countCodePoints(draftInput);
	$: failedAssistant = findLatestFailedAssistant(state?.messages ?? []);
	$: retryAttemptCount = failedAssistant?.turnId
		? countAssistantAttempts(state?.messages ?? [], failedAssistant.turnId)
		: 0;
	$: retryLimitReached =
		retryAttemptCount >= MAX_ASSISTANT_ATTEMPTS_PER_TURN ||
		(state?.messages.length ?? 0) >= MAX_SNAPSHOT_MESSAGES;
	$: canAsk =
		initStatus === "ready" &&
		state?.lifecycle === "ready" &&
		!continuationBlocked &&
		userTurnCount < MAX_TURNS;
	$: showSuggestions =
		canAsk && userTurnCount === 0 && ui.suggestedQuestions.length > 0;
	$: showQuestionLimit =
		Boolean(capacityError) ||
		inputCodePoints >= CHARACTER_LIMIT_WARNING_AT ||
		userTurnCount >= TURN_LIMIT_WARNING_AT;

	onMount(() => {
		void initialize();

		const handleVisibility = () => {
			if (document.visibilityState === "hidden") flushOnExit("visibility_hidden");
		};
		const handlePageHide = () => flushOnExit("pagehide");
		const handlePassiveActivity = () => sendPassiveActivity();
		document.addEventListener("visibilitychange", handleVisibility);
		window.addEventListener("pagehide", handlePageHide);
		window.addEventListener("pointerdown", handlePassiveActivity, { passive: true });
		window.addEventListener("wheel", handlePassiveActivity, { passive: true });
		window.addEventListener("keydown", handlePassiveActivity);

		return () => {
			flushStreamPresentation();
			resetStreamPresentation();
			destroyed = true;
			bridge?.destroy();
			checkpointWorker?.stop();
			activeRequest?.abort();
			if (draftTimer !== undefined) window.clearTimeout(draftTimer);
			document.removeEventListener("visibilitychange", handleVisibility);
			window.removeEventListener("pagehide", handlePageHide);
			window.removeEventListener("pointerdown", handlePassiveActivity);
			window.removeEventListener("wheel", handlePassiveActivity);
			window.removeEventListener("keydown", handlePassiveActivity);
		};
	});

	function isUuid(value: string): boolean {
		return UUID_PATTERN.test(value);
	}

	function isFramed(): boolean {
		return window.parent !== window;
	}

	function readActiveState(): V2PersistedState | null {
		const current = state;
		if (!current || current.lifecycle === "completed" || current.chatEndISO) return null;
		return current;
	}

	function createDevelopmentInit(): ParentInitMessage {
		let sessionKey = readActiveSessionKey(condition);
		let attemptNonce = newUuid();
		if (sessionKey && isUuid(sessionKey)) {
			const stored = readPersistedState(sessionKey);
			if (stored.status === "ok") attemptNonce = stored.state.attemptNonce;
		} else {
			sessionKey = newUuid();
		}
		return {
			v: 2,
			type: "qualtrics:init",
			condition,
			helloNonce: newUuid(),
			nonce: newUuid(),
			sessionKey,
			attemptNonce,
			expectedConfigVersion: CONFIG_VERSIONS[condition],
			parentOrigin: window.location.origin,
			sequence: 0,
		};
	}

	function savedConfigurationForResume(
		init: ParentInitMessage,
	): { configVersion: string; configHash: string } | undefined {
		const candidates: Array<{
			configVersion: string;
			configHash: string;
			snapshotSequence: number;
		}> = [];
		const stored = readPersistedState(init.sessionKey);
		if (
			stored.status === "ok" &&
			stored.state.condition === condition &&
			stored.state.chatSessionKey === init.sessionKey &&
			stored.state.attemptNonce === init.attemptNonce
		) {
			candidates.push({
				configVersion: stored.state.configVersion,
				configHash: stored.state.configHash,
				snapshotSequence: stored.state.snapshotSequence,
			});
		}
		const parent = init.lastSnapshot;
		if (
			parent?.condition === condition &&
			parent.chatSessionKey === init.sessionKey
		) {
			candidates.push({
				configVersion: parent.configVersion,
				configHash: parent.configHash,
				snapshotSequence: parent.snapshotSequence,
			});
		}
		if (candidates.length === 0) return undefined;
		candidates.sort((left, right) => right.snapshotSequence - left.snapshotSequence);
		const selected = candidates[0];
		const tiedConflict = candidates.some(
			(candidate) =>
				candidate.snapshotSequence === selected.snapshotSequence &&
				(candidate.configVersion !== selected.configVersion ||
					candidate.configHash !== selected.configHash),
		);
		if (tiedConflict) {
			throw new ParticipantSafeError(
				"saved_config_conflict",
				"Two saved copies of this chat disagree. The available conversation was preserved, but the chat cannot continue safely.",
				false,
			);
		}
		return {
			configVersion: selected.configVersion,
			configHash: selected.configHash,
		};
	}

	async function initialize(): Promise<void> {
		flushStreamPresentation();
		resetStreamPresentation();
		const thisInitialization = ++initializationNumber;
		initStatus = "connecting";
		initError = "";
		lastParticipantError = "";
		bridge?.destroy();
		checkpointWorker?.stop();
		bridge = null;
		checkpointWorker = null;
			checkpointEnabled = true;
			continuationBlocked = false;
			storageWritable = true;
			followStream = true;
			transcriptAtBottom = true;
			lastTouchY = null;
			endConfirmationOpen = false;
			endConfirmationReturnFocus = null;

		try {
			let init: ParentInitMessage;
			if (isFramed()) {
				bridge = new ParentBridge(condition);
				init = await bridge.connect();
			} else if (import.meta.env.DEV) {
				init = createDevelopmentInit();
			} else {
				throw new ParticipantSafeError(
					"parent_required",
					"Open this chat from the study survey link.",
					false,
				);
			}
			if (destroyed || thisInitialization !== initializationNumber) return;

			const sessionAbort = new AbortController();
			const sessionTimer = window.setTimeout(() => sessionAbort.abort(), 20_000);
			let session: SessionResponse;
			const resumeConfiguration = savedConfigurationForResume(init);
			try {
				session = await createPublicSession(
					condition,
					init.sessionKey,
					init.attemptNonce,
					sessionAbort.signal,
					resumeConfiguration,
				);
			} finally {
				window.clearTimeout(sessionTimer);
			}
			if (destroyed || thisInitialization !== initializationNumber) return;
			const expectedSessionVersion =
				resumeConfiguration?.configVersion ?? init.expectedConfigVersion;
			if (session.configVersion !== expectedSessionVersion) {
				throw new ParticipantSafeError(
					"survey_config_mismatch",
					"The survey and chat versions do not match. The chat was not started.",
					false,
				);
			}
			if (session.ui.themeId && session.ui.themeId !== initialThemeId) {
				throw new ParticipantSafeError(
					"survey_theme_mismatch",
					"The survey and chat presentation versions do not match. The chat was not started.",
					false,
				);
			}

			sessionToken = session.sessionToken;
			sessionTokenAt = Date.now();
			ui = { ...DEFAULT_UI, ...session.ui, maxUserMessages: MAX_TURNS };
			const restored = restoreState(init, session);
			state = restoreInterruptedTurn(restored);
			draftInput = state.draft;
			lastSafeState = cloneState(state);

			checkpointWorker = new CheckpointWorker({
				getState: () => state as V2PersistedState,
				getToken: () => sessionToken,
				initialRecoveryDelayMs: checkpointRecoveryDelayMs(
					state.checkpointInFlightStartedAtISO,
				),
				onLeaseStarted: (snapshotSequence, startedAtISO) => {
					if (!state) return;
					state = {
						...state,
						checkpointInFlightSequence: snapshotSequence,
						checkpointInFlightStartedAtISO: startedAtISO,
					};
					persistNow();
					bridge?.sendCheckpointLease(snapshotSequence, startedAtISO);
				},
				onLeaseSettled: (snapshotSequence) => {
					if (!state || state.checkpointInFlightSequence !== snapshotSequence) return;
					state = {
						...state,
						checkpointInFlightSequence: null,
						checkpointInFlightStartedAtISO: null,
					};
					persistNow();
					bridge?.sendCheckpointLease(snapshotSequence, null);
				},
				onAcknowledged: (response) => {
					if (!state) return;
					state = {
						...state,
						checkpointHandle: response.checkpointHandle,
						lastAcknowledgedCheckpointRevision: Math.max(
							state.lastAcknowledgedCheckpointRevision,
							response.acknowledgedSequence,
						),
					};
					persistNow();
					if (state.chatEndISO && !endAcknowledged) {
						commitSnapshot(lastEnd?.reason ?? state.terminalReason ?? "completed", {
							checkpoint: false,
							terminal: true,
						});
					} else if (!state.chatEndISO) {
						commitSnapshot("checkpoint_ack", {
							checkpoint: false,
							terminal: false,
						});
					}
				},
				onFailure: (code) => {
					// Enqueue is not acknowledgement. If the worker discarded a newer
					// coalesced snapshot after this failure, the next genuine lifecycle
					// event (for example pagehide) must be allowed to enqueue the current
					// cumulative transcript again; it is never retried from this callback.
					lastCheckpointedTranscriptRevision = -1;
					if (recordCaptureError("checkpoint", code)) {
						persistNow();
						if (state?.chatEndISO && !endAcknowledged) {
							commitSnapshot(lastEnd?.reason ?? state.terminalReason ?? "completed", {
								checkpoint: false,
								terminal: true,
							});
						} else if (!state?.chatEndISO) {
							commitSnapshot("checkpoint_capture_error", {
								checkpoint: false,
								terminal: false,
							});
						}
					}
				},
			});

			bridge?.onAck(handleParentAck);
			bridge?.onPersist((reason) => flushOnExit(reason || "parent_persist"));
			bridge?.onFlush((reason) => endChat(reason || "parent_flush", true));
			bridge?.sendReady(
				state.configVersion,
				state.configHash,
				state.historyTag,
				state.sequence,
				state.createOperationId,
			);

			persistNow();
			initStatus = "ready";
			// chatEndISO is the durable terminal marker. A parent-driven flush uses
			// lifecycle="interrupted" so that an in-flight answer is described
			// honestly, but a reload must still re-emit a terminal envelope.
			if (state.chatEndISO || state.lifecycle === "completed") {
				commitSnapshot(state.terminalReason ?? "completed", { terminal: true, checkpoint: true });
			} else {
				// A reload may have repaired a streaming answer or recovered a newer
				// parent-only transcript. Reconcile that cumulative state immediately;
				// a recovered lease delays the worker in the background and coalesces any
				// newer snapshot. A truly fresh opening-only session needs no row yet.
				const hasRecoverableConversation =
					state.messages.some((message) => !message.isInitial) ||
					state.captureErrors.length > 0;
				commitSnapshot("initialized", {
					terminal: false,
					checkpoint: hasRecoverableConversation,
				});
			}
			await scrollToLatest(true);
		} catch (error) {
			if (destroyed || thisInitialization !== initializationNumber) return;
			initStatus = "failed";
			initError =
				error instanceof ParticipantSafeError
					? error.message
					: error instanceof Error && error.message === "parent_handshake_timeout"
						? "The survey and chat could not connect. Please try again."
						: "The chat could not start safely. Please try again.";
		}
	}

	function restoreState(
		init: ParentInitMessage,
		session: SessionResponse,
	): V2PersistedState {
		const stored = readPersistedState(init.sessionKey);
		let restored: V2PersistedState | null = null;
		let localRestored: V2PersistedState | null = null;
		if (stored.status === "ok" && stateMatchesSession(stored.state, init, session)) {
			localRestored = { ...stored.state, messages: stored.state.messages.map((m) => ({ ...m })) };
			restored = localRestored;
		} else if (stored.status === "corrupt" || stored.status === "unavailable" || stored.status === "ok") {
			// Never overwrite a corrupt or incompatible value at the canonical key.
			storageWritable = false;
		}

		const parentSnapshot = validRecoverySnapshot(init.lastSnapshot, init, session);
		if (
			parentSnapshot &&
			(!restored || parentSnapshot.snapshotSequence > restored.snapshotSequence)
		) {
			restored = stateFromParentSnapshot(parentSnapshot, init, session);
		}

		if (!restored) restored = createFreshState(init, session);
		if (!storageWritable) {
			restored = appendCaptureError(restored, {
				atISO: new Date().toISOString(),
				stage: "storage",
				code: stored.status === "corrupt" || stored.status === "ok"
					? "stored_state_preserved_as_corrupt"
					: "session_storage_unavailable",
			});
		}

		const handleResolution = reconcileRecoveredCheckpointHandle(
			restored,
			localRestored
				? {
					handle: localRestored.checkpointHandle,
					acknowledgedRevision: localRestored.lastAcknowledgedCheckpointRevision,
				}
				: null,
			init.checkpointHandle
				? {
					handle: init.checkpointHandle,
					acknowledgedRevision:
						parentSnapshot?.checkpoint.lastAcknowledgedRevision ?? null,
				}
				: null,
		);
		restored = handleResolution.state;
		if (handleResolution.conflict) {
			checkpointEnabled = false;
			restored = appendCaptureError(restored, {
				atISO: new Date().toISOString(),
				stage: "checkpoint",
				code: "checkpoint_handle_recovery_mismatch",
			});
		}
		if (init.createOperationId && restored.createOperationId !== init.createOperationId) {
			if (restored.checkpointHandle) {
				checkpointEnabled = false;
				restored = appendCaptureError(restored, {
					atISO: new Date().toISOString(),
					stage: "checkpoint",
					code: "create_operation_recovery_mismatch",
				});
			} else {
				restored.createOperationId = init.createOperationId;
			}
		}
		if (restored.chatEndISO && init.terminalReason) {
			restored.terminalReason = init.terminalReason;
		}
		return mergeRecoveredCheckpointLease(restored, init);
	}

	function createFreshState(
		init: ParentInitMessage,
		session: SessionResponse,
	): V2PersistedState {
		const now = new Date().toISOString();
		return {
			schemaVersion: 2,
			condition,
			chatSessionKey: init.sessionKey,
			attemptNonce: init.attemptNonce,
			configVersion: session.configVersion,
			configHash: session.configHash,
			createOperationId: init.createOperationId ?? newUuid(),
			messages: session.initialMessages.map((message) => ({
				...message,
				createdAtISO: now,
				isInitial: true,
				completionStatus: "complete",
				excludedFromModel: true,
			})),
			sequence: 0,
			historyTag: session.historyTag,
			draft: "",
			checkpointHandle: init.checkpointHandle ?? null,
			lastAcknowledgedCheckpointRevision: 0,
			checkpointInFlightSequence: null,
			checkpointInFlightStartedAtISO: null,
			lastParentAcknowledgedRevision: 0,
			parentSyncCount: 0,
			snapshotSequence: 0,
			lifecycle: "ready",
			createdAtISO: now,
			updatedAtISO: now,
			chatEndISO: null,
			terminalReason: null,
			captureErrors: [],
		};
	}

	function stateFromParentSnapshot(
		snapshot: V2Snapshot,
		init: ParentInitMessage,
		session: SessionResponse,
	): V2PersistedState {
		const hasNonInitialMessages = snapshot.messages.some((message) => !message.isInitial);
		const recoveredHistoryTag = init.historyTag ?? session.historyTag;
		const recoveredSequence = init.historySequence ?? 0;
		if (hasNonInitialMessages && (init.historyTag === undefined || init.historySequence === undefined)) {
			continuationBlocked = snapshot.state !== "completed";
		}
		const countedPairs = countSignedHistoryPairs(snapshot.messages);
		if (recoveredSequence !== countedPairs && snapshot.state !== "completed") {
			continuationBlocked = true;
		}
		return {
			schemaVersion: 2,
			condition,
			chatSessionKey: init.sessionKey,
			attemptNonce: init.attemptNonce,
			configVersion: session.configVersion,
			configHash: session.configHash,
			createOperationId: init.createOperationId ?? newUuid(),
			messages: snapshot.messages.map((message) => ({ ...message })),
			sequence: recoveredSequence,
			historyTag: recoveredHistoryTag,
			draft: "",
			checkpointHandle: init.checkpointHandle ?? null,
			lastAcknowledgedCheckpointRevision: snapshot.checkpoint.lastAcknowledgedRevision,
			checkpointInFlightSequence: init.checkpointInFlightSequence ?? null,
			checkpointInFlightStartedAtISO: init.checkpointInFlightStartedAtISO ?? null,
			lastParentAcknowledgedRevision: snapshot.parent.lastAcknowledgedRevision,
			parentSyncCount: snapshot.parent.syncCount,
			snapshotSequence: snapshot.snapshotSequence,
			lifecycle:
				snapshot.state === "completed"
					? "completed"
					: snapshot.state === "capture_error"
						? "capture_error"
						: snapshot.state === "interrupted"
							? "interrupted"
							: "ready",
			createdAtISO: snapshot.createdAtISO,
			updatedAtISO: snapshot.updatedAtISO,
			chatEndISO: snapshot.chatEndISO,
			terminalReason: snapshot.chatEndISO
				? init.terminalReason ?? "completed"
				: null,
			captureErrors: snapshot.captureErrors.map((item) => ({ ...item })),
		};
	}

	function stateMatchesSession(
		candidate: V2PersistedState,
		init: ParentInitMessage,
		session: SessionResponse,
	): boolean {
		if (
			candidate.condition !== condition ||
			candidate.chatSessionKey !== init.sessionKey ||
			candidate.attemptNonce !== init.attemptNonce ||
			candidate.configVersion !== session.configVersion ||
			candidate.configHash !== session.configHash ||
			candidate.sequence < 0 ||
			candidate.sequence > MAX_TURNS ||
			candidate.snapshotSequence < 0 ||
			!isUuid(candidate.createOperationId) ||
			candidate.lastAcknowledgedCheckpointRevision < 0 ||
			!((candidate.checkpointInFlightSequence === null && candidate.checkpointInFlightStartedAtISO === null) ||
				(Number.isSafeInteger(candidate.checkpointInFlightSequence) &&
					(candidate.checkpointInFlightSequence as number) >= 0 &&
					typeof candidate.checkpointInFlightStartedAtISO === "string" &&
					Number.isFinite(Date.parse(candidate.checkpointInFlightStartedAtISO)))) ||
			candidate.lastParentAcknowledgedRevision < 0 ||
			candidate.parentSyncCount < 0 ||
			new Set(candidate.messages.map((message) => message.id)).size !== candidate.messages.length ||
			!candidate.messages.every(validMessage)
		) return false;
		try {
			return transcriptFits(serializeSnapshot(candidate));
		} catch {
			return false;
		}
	}

	function validRecoverySnapshot(
		candidate: V2Snapshot | undefined,
		init: ParentInitMessage,
		session: SessionResponse,
	): V2Snapshot | null {
		if (!candidate || typeof candidate !== "object" || !hasOnlyKeys(candidate, SNAPSHOT_KEYS)) return null;
		if (
			candidate.schemaVersion !== 2 ||
			candidate.condition !== condition ||
			candidate.chatSessionKey !== init.sessionKey ||
			candidate.configVersion !== session.configVersion ||
			candidate.configHash !== session.configHash ||
			!Number.isSafeInteger(candidate.snapshotSequence) ||
			candidate.snapshotSequence < 0 ||
			!["active", "interrupted", "completed", "capture_error"].includes(candidate.state) ||
			!Array.isArray(candidate.messages) ||
			candidate.messages.length > MAX_SNAPSHOT_MESSAGES ||
			!candidate.messages.every(validMessage) ||
			new Set(candidate.messages.map((message) => message.id)).size !== candidate.messages.length ||
			!candidate.parent ||
			!Number.isSafeInteger(candidate.parent.lastAcknowledgedRevision) ||
			candidate.parent.lastAcknowledgedRevision < 0 ||
			!Number.isSafeInteger(candidate.parent.syncCount) ||
			candidate.parent.syncCount < 0 ||
			!candidate.checkpoint ||
			!hasOnlyKeys(candidate.checkpoint, new Set(["hasHandle", "lastAcknowledgedRevision"])) ||
			typeof candidate.checkpoint.hasHandle !== "boolean" ||
			!Number.isSafeInteger(candidate.checkpoint.lastAcknowledgedRevision) ||
			candidate.checkpoint.lastAcknowledgedRevision < 0 ||
			!Array.isArray(candidate.captureErrors) ||
			candidate.captureErrors.length > 20 ||
			!candidate.captureErrors.every((item) =>
				Boolean(
					item &&
					hasOnlyKeys(item, new Set(["atISO", "stage", "code"])) &&
					typeof item.atISO === "string" &&
					Number.isFinite(Date.parse(item.atISO)) &&
					["storage", "parent", "checkpoint", "transcript"].includes(item.stage) &&
					typeof item.code === "string" && item.code.length >= 1 && item.code.length <= 100,
				),
			) ||
			!candidate.parent ||
			!hasOnlyKeys(candidate.parent, new Set(["lastAcknowledgedRevision", "syncCount"])) ||
			!candidate.counters ||
			!hasOnlyKeys(candidate.counters, new Set([
				"totalMessages", "initialMessages", "userMessages", "assistantMessages",
				"completeAssistantMessages", "incompleteAssistantMessages",
				"totalContentCodePoints", "serializedUtf16CodeUnits", "serializedUtf8Bytes",
			])) ||
			typeof candidate.createdAtISO !== "string" ||
			!Number.isFinite(Date.parse(candidate.createdAtISO)) ||
			typeof candidate.updatedAtISO !== "string" ||
			!Number.isFinite(Date.parse(candidate.updatedAtISO)) ||
			!(candidate.chatEndISO === null ||
				(typeof candidate.chatEndISO === "string" && Number.isFinite(Date.parse(candidate.chatEndISO))))
		) return null;
		const json = JSON.stringify(candidate);
		if (json.length > MAX_TRANSCRIPT_UTF16 || utf8Length(json) > MAX_TRANSCRIPT_UTF8) return null;
		const expectedCounters = {
			totalMessages: candidate.messages.length,
			initialMessages: candidate.messages.filter((message) => message.isInitial).length,
			userMessages: candidate.messages.filter((message) => message.role === "user" && !message.isInitial).length,
			assistantMessages: candidate.messages.filter((message) => message.role === "assistant" && !message.isInitial).length,
			completeAssistantMessages: candidate.messages.filter((message) => message.role === "assistant" && ["complete", "capped"].includes(message.completionStatus)).length,
			incompleteAssistantMessages: candidate.messages.filter((message) => message.role === "assistant" && !["complete", "capped"].includes(message.completionStatus)).length,
			totalContentCodePoints: candidate.messages.reduce((total, message) => total + countCodePoints(message.content), 0),
			serializedUtf16CodeUnits: json.length,
			serializedUtf8Bytes: utf8Length(json),
		};
		if (Object.entries(expectedCounters).some(([key, value]) => candidate.counters[key as keyof typeof expectedCounters] !== value)) return null;
		return candidate;
	}

	function hasOnlyKeys(value: object, allowed: Set<string>): boolean {
		return Object.keys(value).every((key) => allowed.has(key));
	}

	function validMessage(message: V2Message): boolean {
		return Boolean(
			message &&
			hasOnlyKeys(message, MESSAGE_KEYS) &&
			isUuid(message.id) &&
			(message.role === "user" || message.role === "assistant") &&
			typeof message.content === "string" &&
			typeof message.createdAtISO === "string" &&
			Number.isFinite(Date.parse(message.createdAtISO)) &&
			typeof message.isInitial === "boolean" &&
			MESSAGE_STATUSES.has(message.completionStatus) &&
			typeof message.excludedFromModel === "boolean" &&
			(!message.isInitial || message.role === "assistant") &&
			(message.isInitial || (typeof message.turnId === "string" && isUuid(message.turnId))) &&
			(message.role !== "user" || message.isInitial || countCodePoints(message.content) <= MAX_USER_CODE_POINTS) &&
			(message.role !== "user" || message.isInitial || message.content.length > 0) &&
			(message.role !== "assistant" || countCodePoints(message.content) <= MAX_ASSISTANT_CODE_POINTS) &&
			(message.failureReason === undefined ||
				(typeof message.failureReason === "string" && message.failureReason.length <= 100)),
		);
	}

	function cloneState(value: V2PersistedState): V2PersistedState {
		return JSON.parse(JSON.stringify(value)) as V2PersistedState;
	}

	function persistNow(): void {
		if (!state) return;
		// Persist and clone only the canonical view: a raw not-yet-redacted
		// turn must never reach sessionStorage as a message, and a rollback to
		// lastSafeState must never resurrect one into a committed artifact.
		const view = canonicalView(state, pendingCanonicalTurnIds);
		try {
			if (!transcriptFits(serializeSnapshot(view))) return;
			lastSafeState = cloneState(view);
		} catch {
			return;
		}
		if (!storageWritable) return;
		const failure = persistState(view);
		if (failure) {
			storageWritable = false;
			state = appendCaptureError(state, failure);
		}
	}

	function recordCaptureError(stage: CaptureError["stage"], code: string): boolean {
		if (!state) return false;
		const before = state.captureErrors.length;
		state = appendCaptureError(state, {
			atISO: new Date().toISOString(),
			stage,
			code: code.slice(0, 100),
		});
		return state.captureErrors.length !== before;
	}

	function commitSnapshot(
		reason: string,
		options: { terminal: boolean; checkpoint: boolean; preferKeepalive?: boolean },
	): SerializedSnapshot | null {
		if (!state) return null;
		const baseState = state;
		const candidateState: V2PersistedState = {
			...baseState,
			snapshotSequence: baseState.snapshotSequence + 1,
			updatedAtISO: new Date().toISOString(),
		};
		let serialized: SerializedSnapshot;
		try {
			// In-memory state keeps the full conversation (raw bubble included);
			// the parent snapshot and checkpoint body get the canonical view.
			serialized = serializeSnapshot(canonicalView(candidateState, pendingCanonicalTurnIds));
			if (!transcriptFits(serialized)) throw new Error("transcript_capacity_exceeded");
		} catch {
			state = cloneState(lastSafeState ?? baseState);
			recordCaptureError("transcript", "invalid_snapshot_preserved_previous");
			persistNow();
			lastParticipantError =
				"The latest update could not be safely packaged. Your previous saved copy was preserved.";
			return null;
		}
		state = candidateState;
		persistNow();
		try {
			if (options.terminal) {
				bridge?.sendEnd(serialized.snapshot, reason, state.checkpointHandle, state.historyTag, state.sequence, state.createOperationId);
				lastEnd = { serialized, reason };
			} else {
				bridge?.sendSnapshot(serialized.snapshot, reason, state.checkpointHandle, state.historyTag, state.sequence, state.createOperationId);
			}
		} catch {
			recordCaptureError("parent", "postmessage_failed");
		}
		if (options.checkpoint && checkpointEnabled) {
			checkpointWorker?.enqueue(serialized, reason, options.preferKeepalive ?? false);
			lastCheckpointedTranscriptRevision = transcriptRevision;
		}
		return serialized;
	}

	function handleParentAck(sequence: number, isEndAck: boolean): void {
		if (!state || sequence > state.snapshotSequence || sequence <= state.lastParentAcknowledgedRevision) return;
		state = {
			...state,
			lastParentAcknowledgedRevision: sequence,
			parentSyncCount: state.parentSyncCount + 1,
		};
		if (isEndAck) endAcknowledged = true;
		persistNow();
	}

	function resetStreamPresentation(): void {
		if (presentationTimer !== undefined) window.clearTimeout(presentationTimer);
		if (presentationDrainTimer !== undefined) window.clearTimeout(presentationDrainTimer);
		presentationTimer = undefined;
		presentationDrainTimer = undefined;
		resolvePresentationDrain?.();
		resolvePresentationDrain = null;
		presentedAssistantId = null;
		presentedAssistantContent = "";
		pendingPresentationContent = "";
		pendingPresentationSince = 0;
	}

	function beginStreamPresentation(assistantId: string): void {
		flushStreamPresentation();
		resetStreamPresentation();
		presentedAssistantId = assistantId;
	}

	function schedulePresentationFrame(): void {
		if (presentationTimer !== undefined || !pendingPresentationContent) return;
		presentationTimer = window.setTimeout(
			presentNextStreamFrame,
			STREAM_PRESENTATION_FRAME_MS,
		);
	}

	function presentNextStreamFrame(): void {
		presentationTimer = undefined;
		if (!presentedAssistantId || !pendingPresentationContent) return;
		const frame = takePresentationFrame(
			pendingPresentationContent,
			Date.now() - pendingPresentationSince,
		);
		presentedAssistantContent += frame.visible;
		pendingPresentationContent = frame.pending;
		if (!pendingPresentationContent) {
			pendingPresentationSince = 0;
			if (presentationDrainTimer !== undefined) window.clearTimeout(presentationDrainTimer);
			presentationDrainTimer = undefined;
			resolvePresentationDrain?.();
			resolvePresentationDrain = null;
		}
		if (followStream) void scrollToLatest(true);
		schedulePresentationFrame();
	}

	function queueStreamPresentation(assistantId: string, content: string): void {
		if (!content || presentedAssistantId !== assistantId) return;
		if (!pendingPresentationContent) pendingPresentationSince = Date.now();
		pendingPresentationContent += content;
		if (document.visibilityState === "hidden") {
			flushStreamPresentation();
			return;
		}
		schedulePresentationFrame();
	}

	function flushStreamPresentation(): void {
		if (presentationTimer !== undefined) window.clearTimeout(presentationTimer);
		presentationTimer = undefined;
		if (pendingPresentationContent) {
			presentedAssistantContent += pendingPresentationContent;
			pendingPresentationContent = "";
		}
		pendingPresentationSince = 0;
		if (presentationDrainTimer !== undefined) window.clearTimeout(presentationDrainTimer);
		presentationDrainTimer = undefined;
		resolvePresentationDrain?.();
		resolvePresentationDrain = null;
	}

	async function drainStreamPresentation(): Promise<void> {
		if (!pendingPresentationContent) return;
		if (document.visibilityState === "hidden") {
			flushStreamPresentation();
			return;
		}
		await new Promise<void>((resolve) => {
			resolvePresentationDrain = resolve;
			presentationDrainTimer = window.setTimeout(
				flushStreamPresentation,
				STREAM_PRESENTATION_MAX_LAG_MS + STREAM_PRESENTATION_FRAME_MS,
			);
			schedulePresentationFrame();
		});
	}

	function flushOnExit(reason: string): void {
		flushStreamPresentation();
		if (!state || state.lifecycle === "completed" || state.chatEndISO) return;
		persistNow();
		if (transcriptRevision === lastCheckpointedTranscriptRevision) return;
		commitSnapshot(reason, { terminal: false, checkpoint: true, preferKeepalive: true });
	}

	function countSignedHistoryPairs(messages: V2Message[]): number {
		const users = messages.filter((message) => message.role === "user" && !message.isInitial && !message.excludedFromModel);
		return users.filter((user) =>
			messages.some(
				(message) =>
					message.role === "assistant" &&
					message.turnId === user.turnId &&
					!message.excludedFromModel &&
					(message.completionStatus === "complete" ||
						message.completionStatus === "capped"),
			),
		).length;
	}

	function buildHistoryBefore(turnId: string): ChatHistoryItem[] {
		if (!state) return [];
		const history: ChatHistoryItem[] = [];
		for (const user of state.messages) {
			if (user.role !== "user" || user.isInitial || user.turnId === turnId || user.excludedFromModel) continue;
			const answer = [...state.messages].reverse().find((message) =>
				message.role === "assistant" &&
				message.turnId === user.turnId &&
				!message.excludedFromModel &&
				(message.completionStatus === "complete" || message.completionStatus === "capped"),
			);
			if (!answer) continue;
			history.push(
				{ id: user.id, role: "user", content: user.content },
				{ id: answer.id, role: "assistant", content: answer.content },
			);
		}
		return history;
	}

	async function ensureFreshSessionToken(): Promise<void> {
		if (!state || Date.now() - sessionTokenAt < 50 * 60_000) return;
		const refreshed = await createPublicSession(
			condition,
			state.chatSessionKey,
			state.attemptNonce,
			undefined,
			{ configVersion: state.configVersion, configHash: state.configHash },
		);
		if (refreshed.configVersion !== state.configVersion || refreshed.configHash !== state.configHash) {
			throw new ParticipantSafeError("refreshed_config_mismatch", "The chat configuration changed and could not be verified.", false);
		}
		sessionToken = refreshed.sessionToken;
		sessionTokenAt = Date.now();
	}

	async function submitQuestion(contentOverride?: string): Promise<void> {
		if (
			!state ||
			state.lifecycle !== "ready" ||
			state.chatEndISO ||
			activeRequest ||
			continuationBlocked ||
			userTurnCount >= MAX_TURNS
		) return;
		const content = (contentOverride ?? draftInput).trim();
		if (!content) return;
		const capacity = canStartUserTurn(state, content);
		if (!capacity.ok) {
			capacityError = capacity.reason;
			return;
		}
		capacityError = "";
		lastParticipantError = "";
		// Capture the exact safe pre-submit state (including an unsaved draft)
		// so a packaging failure cannot leave an uncaptured user turn behind.
		persistNow();
		const turnId = newUuid();
		const now = new Date().toISOString();
		state = {
			...state,
			draft: "",
			lifecycle: "waiting",
			messages: [...state.messages, {
				id: turnId,
				turnId,
				role: "user",
				content,
				createdAtISO: now,
				isInitial: false,
				completionStatus: "complete",
				excludedFromModel: false,
			}],
		};
		draftInput = "";
		transcriptRevision += 1;
		// The raw turn stays out of every persisted artifact until the server
		// returns its canonical (redacted) text in the stream's meta event;
		// the deferred "user_submitted" capture fires in the meta handler.
		// Until then the persisted canonical view parks the question as a
		// browser-local draft so a reload restores it to the composer.
		pendingCanonicalTurnIds = new Set([...pendingCanonicalTurnIds, turnId]);
		if (KEEP_RAW_DISPLAY) {
			presentedUserContents = { ...presentedUserContents, [turnId]: content };
		}
		bridge?.sendActivity("submit");
		followStream = true;
		persistNow();
		await scrollToLatest(true);
		await executeTurn(turnId, content, false);
	}

	async function executeTurn(turnId: string, userMessage: string, isRetry: boolean): Promise<void> {
		if (!state || activeRequest || state.chatEndISO) return;
		if (isRetry) {
			state = {
				...state,
				messages: state.messages.map((message) =>
					message.role === "assistant" && message.turnId === turnId && message.completionStatus === "incomplete"
						? { ...message, completionStatus: "superseded", excludedFromModel: true }
						: message,
					),
			};
		}
		const assistantLocalId = newUuid();
		state = {
			...state,
			lifecycle: "streaming",
			messages: [...state.messages, {
				id: assistantLocalId,
				turnId,
				role: "assistant",
				content: "",
				createdAtISO: new Date().toISOString(),
				isInitial: false,
				completionStatus: "streaming",
				excludedFromModel: true,
			}],
		};
		beginStreamPresentation(assistantLocalId);
		transcriptRevision += 1;
		if (!isRetry) persistNow();
		if (isRetry) {
			bridge?.sendActivity("retry");
			if (!commitSnapshot("retry_started", { terminal: false, checkpoint: true })) {
				lastParticipantError = "The retry could not be safely captured, so it was not sent. You can try again.";
				persistNow();
				resetStreamPresentation();
				return;
			}
		}
		activeRequest = new AbortController();
		let locallyCapped = false;
		const history = buildHistoryBefore(turnId);
		const requestedSequence = state.sequence + 1;
		if (history.length !== 2 * state.sequence) {
			continuationBlocked = true;
			lastParticipantError = "The restored conversation could not be verified. Please finish the chat.";
			activeRequest = null;
			resetStreamPresentation();
			return;
		}

		try {
			await ensureFreshSessionToken();
			const done = await streamChat({
				token: sessionToken,
				sequence: requestedSequence,
				history,
				historyTag: state.historyTag,
				turn: { id: turnId, userMessage },
				signal: activeRequest.signal,
				onMeta: (meta) => {
					if (!state || state.lifecycle === "completed" || state.chatEndISO) return;
					const canonical = meta.scrubbedUserMessage;
					if (typeof canonical === "string") {
						// The server signs exactly this text at `done`; the stored
						// turn must match it byte-for-byte — on first sends and on
						// retries (a retry re-redacts and re-signs its own output).
						const current = state.messages.find(
							(message) => message.role === "user" && message.turnId === turnId,
						);
						if (current && current.content !== canonical) {
							state = {
								...state,
								messages: state.messages.map((message) =>
									message.role === "user" && message.turnId === turnId
										? { ...message, content: canonical }
										: message,
								),
							};
							transcriptRevision += 1;
						}
					}
					if (pendingCanonicalTurnIds.has(turnId)) {
						pendingCanonicalTurnIds = new Set(
							[...pendingCanonicalTurnIds].filter((id) => id !== turnId),
						);
						transcriptRevision += 1;
						// Deferred "user_submitted" capture: the turn enters the
						// persisted record only now, in its canonical form.
						if (!commitSnapshot("user_submitted", { terminal: false, checkpoint: true })) {
							abortedForCaptureFailure = true;
							activeRequest?.abort();
						}
					}
				},
				onDelta: (delta) => {
					if (!state || state.lifecycle === "completed" || state.chatEndISO) return;
					const answer = state.messages.find((message) => message.id === assistantLocalId);
					if (!answer) return;
					const accepted = appendDeltaWithinLimits(assistantLocalId, delta);
					queueStreamPresentation(assistantLocalId, accepted);
					transcriptRevision += 1;
					if (Date.now() - lastStreamPersistAt >= 500) {
						lastStreamPersistAt = Date.now();
						persistNow();
					}
					if (accepted !== delta) {
						locallyCapped = true;
						activeRequest?.abort();
					}
					},
				});
				if (!state || state.lifecycle === "completed" || state.chatEndISO) return;
				await drainStreamPresentation();
				const settledState = readActiveState();
				if (!settledState) return;
				state = {
				...settledState,
				sequence: done.sequence,
				historyTag: done.historyTag,
				lifecycle: "ready",
				messages: settledState.messages.map((message) =>
					message.id === assistantLocalId
						? {
							...message,
							id: done.assistantMessageId,
							completionStatus: done.completionStatus,
							excludedFromModel: false,
							...(done.completionStatus === "capped" ? { failureReason: `capped/${done.finishReason}` } : {}),
						}
						: message,
				),
			};
			transcriptRevision += 1;
			lastParticipantError = "";
			retryableFailure = true;
			if (!commitSnapshot("assistant_completed", { terminal: false, checkpoint: true })) {
				recoverAssistantAfterCaptureFailure(assistantLocalId, turnId, "assistant_completion_capture_failed");
			}
		} catch (error) {
			if (abortedForCaptureFailure) {
				abortedForCaptureFailure = false;
				// The deferred meta-time capture failed; commitSnapshot already
				// rolled state back to the canonical pre-turn copy with the raw
				// question parked as the draft. Restore the composer instead of
				// surfacing an interrupted-answer card for a turn the record
				// never held.
				if (state && !state.chatEndISO) {
					state = { ...state, lifecycle: "ready" };
					draftInput = state.draft;
					lastParticipantError =
						"Your question could not be safely captured, so it was not sent to the answer service.";
					persistNow();
				}
				return;
			}
			if (!state || state.lifecycle === "completed" || state.chatEndISO) return;
			flushStreamPresentation();
			const safeError = error instanceof ParticipantSafeError
				? error
				: new ParticipantSafeError("unexpected_stream_error", "The answer was interrupted. Your question is saved, and you can try again.", true);
			state = {
				...state,
				lifecycle: "interrupted",
				messages: state.messages.map((message) =>
					message.id === assistantLocalId
						? {
							...message,
							completionStatus: "incomplete",
							excludedFromModel: true,
							failureReason: locallyCapped ? "client_output_cap_without_done" : safeError.code,
						}
						: message,
				),
			};
			transcriptRevision += 1;
			lastParticipantError = locallyCapped
				? "The answer reached the display safety limit before completion. You can try again or skip it."
				: safeError.message;
			retryableFailure = locallyCapped ? true : safeError.retryable;
			if (!commitSnapshot("assistant_incomplete", { terminal: false, checkpoint: true })) {
				recoverAssistantAfterCaptureFailure(assistantLocalId, turnId, "assistant_failure_capture_failed");
			}
		} finally {
			flushStreamPresentation();
			resetStreamPresentation();
			activeRequest = null;
			persistNow();
			if (followStream) await scrollToLatest(true);
			if (state?.lifecycle === "ready") inputElement?.focus({ preventScroll: true });
		}
	}

	function findLatestFailedAssistant(messages: V2Message[]): V2Message | undefined {
		return [...messages].reverse().find((message) =>
			message.role === "assistant" && message.completionStatus === "incomplete" && !message.isInitial,
		);
	}

	function countAssistantAttempts(messages: V2Message[], turnId: string): number {
		return messages.filter(
			(message) =>
				message.role === "assistant" &&
				!message.isInitial &&
				message.turnId === turnId,
		).length;
	}

	function appendDeltaWithinLimits(assistantId: string, delta: string): string {
		if (!state) return "";
		const answer = state.messages.find((message) => message.id === assistantId);
		if (!answer) return "";
		const remaining = MAX_ASSISTANT_CODE_POINTS - countCodePoints(answer.content);
		// Turn/retry preflight reserves the full worst-case JSON-escaped answer
		// answer plus terminal metadata. Avoid reserializing a 100–240 KB
		// transcript for every token-sized SSE delta on mid-range phones.
		const accepted = Array.from(delta)
			.slice(0, Math.max(0, remaining))
			.join("");
		state = {
			...state,
			messages: state.messages.map((message) =>
				message.id === assistantId ? { ...message, content: message.content + accepted } : message,
			),
		};
		return accepted;
	}

	function recoverAssistantAfterCaptureFailure(assistantId: string, turnId: string, code: string): void {
		if (!state) return;
		const hasAttempt = state.messages.some((message) => message.id === assistantId);
		const recoveredMessages = state.messages.map((message) =>
			message.id === assistantId ||
			(message.role === "assistant" && message.completionStatus === "streaming")
				? {
					...message,
					completionStatus: "incomplete" as const,
					excludedFromModel: true,
					failureReason: code,
				}
				: message,
		);
		state = {
			...state,
			lifecycle: "interrupted",
			messages: hasAttempt ? recoveredMessages : [...recoveredMessages, {
				id: assistantId,
				turnId,
				role: "assistant",
				content: "",
				createdAtISO: new Date().toISOString(),
				isInitial: false,
				completionStatus: "incomplete",
				excludedFromModel: true,
				failureReason: code,
			}],
		};
		transcriptRevision += 1;
		if (!commitSnapshot("assistant_incomplete", { terminal: false, checkpoint: true })) {
			continuationBlocked = true;
			lastParticipantError = "The latest answer could not be safely captured. Please finish the chat.";
			persistNow();
		}
	}

	function retryCurrentAnswer(): void {
		if (!state || state.lifecycle !== "interrupted" || !failedAssistant?.turnId || activeRequest || continuationBlocked || state.chatEndISO) return;
		if (countAssistantAttempts(state.messages, failedAssistant.turnId) >= MAX_ASSISTANT_ATTEMPTS_PER_TURN) {
			lastParticipantError = "This answer has reached its retry limit. Skip it or finish the chat.";
			return;
		}
		const retryCapacity = canRetryAssistant(state, failedAssistant.turnId);
		if (!retryCapacity.ok) {
			lastParticipantError = retryCapacity.reason;
			return;
		}
		const user = state.messages.find((message) => message.role === "user" && message.turnId === failedAssistant?.turnId);
		if (!user) return;
		lastParticipantError = "";
		void executeTurn(failedAssistant.turnId, user.content, true);
	}

	function skipCurrentAnswer(): void {
		if (!state || state.lifecycle !== "interrupted" || !failedAssistant?.turnId || activeRequest || continuationBlocked || state.chatEndISO) return;
		const turnId = failedAssistant.turnId;
		state = {
			...state,
			lifecycle: "ready",
			messages: state.messages.map((message) =>
				message.turnId === turnId
					? {
						...message,
						excludedFromModel: true,
						...(message.role === "assistant" && message.completionStatus === "incomplete"
							? { completionStatus: "skipped" as const }
							: {}),
					}
					: message,
			),
		};
		transcriptRevision += 1;
		lastParticipantError = "";
		commitSnapshot("answer_skipped", { terminal: false, checkpoint: true });
		void tick().then(() => inputElement?.focus());
	}

	function endChat(reason = "participant_end", interrupted = false): void {
		if (!state || state.lifecycle === "completed" || state.chatEndISO) {
			if (lastEnd) resendEnd();
			return;
		}
		activeRequest?.abort();
		const terminalReason = normalizeTerminalReason(reason);
		state = {
			...state,
			lifecycle: interrupted ? "interrupted" : "completed",
			chatEndISO: new Date().toISOString(),
			terminalReason,
			messages: state.messages.map((message) =>
				message.completionStatus === "streaming"
					? { ...message, completionStatus: "incomplete", excludedFromModel: true, failureReason: "chat_ended_during_stream" }
					: message,
			),
		};
		transcriptRevision += 1;
		endConfirmationOpen = false;
		bridge?.sendActivity("end");
		if (!commitSnapshot(terminalReason, { terminal: true, checkpoint: true, preferKeepalive: true })) {
			continuationBlocked = true;
			lastParticipantError =
				"The final update could not be safely packaged. Your previous saved copy was preserved; try finishing again.";
		}
	}

	function normalizeTerminalReason(reason: string): TerminalReason {
		if (
			reason === "completed" ||
			reason === "participant_end" ||
				reason === "inactivity" ||
				reason === "never_engaged" ||
				reason === "hard_cap" ||
				reason === "init_failure"
		) return reason;
		return "completed";
	}

	function resendEnd(): void {
		if (!state || !lastEnd) return;
		bridge?.sendEnd(lastEnd.serialized.snapshot, lastEnd.reason, state.checkpointHandle, state.historyTag, state.sequence, state.createOperationId);
	}

	function handleDraftInput(event: Event): void {
		if (!state) return;
		const textarea = event.currentTarget as HTMLTextAreaElement;
		draftInput = takeCodePoints(textarea.value, MAX_USER_CODE_POINTS);
		if (textarea.value !== draftInput) textarea.value = draftInput;
		state = { ...state, draft: draftInput, updatedAtISO: new Date().toISOString() };
		if (draftTimer !== undefined) window.clearTimeout(draftTimer);
		draftTimer = window.setTimeout(persistNow, 250);
		if (Date.now() - lastActivityAt > 10_000) {
			lastActivityAt = Date.now();
			bridge?.sendActivity("input");
		}
	}

	function handleComposerKeydown(event: KeyboardEvent): void {
		if (
			event.key !== "Enter" ||
			event.shiftKey ||
			event.isComposing ||
			event.keyCode === 229
		) return;
		event.preventDefault();
		void submitQuestion();
	}

	async function openEndConfirmation(): Promise<void> {
		const activeElement = document.activeElement;
		endConfirmationReturnFocus = activeElement instanceof HTMLElement ? activeElement : null;
		endConfirmationOpen = true;
		await tick();
		endConfirmButton?.focus({ preventScroll: true });
	}

	async function closeEndConfirmation(): Promise<void> {
		const returnFocus = endConfirmationReturnFocus;
		endConfirmationOpen = false;
		endConfirmationReturnFocus = null;
		await tick();
		if (returnFocus?.isConnected) {
			returnFocus.focus({ preventScroll: true });
		} else {
			endChatButton?.focus({ preventScroll: true });
		}
	}

	function handleEndConfirmationKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape") return;
		event.preventDefault();
		void closeEndConfirmation();
	}

	function sendPassiveActivity(): void {
		const now = Date.now();
		if (!bridge || now - lastPassiveActivityAt < 15_000) return;
		lastPassiveActivityAt = now;
		bridge.sendActivity("reading");
	}

	function isTranscriptAtBottom(tolerance = 10): boolean {
		if (!transcriptElement) return true;
		return transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight <= tolerance;
	}

	function handleTranscriptScroll(): void {
		transcriptAtBottom = isTranscriptAtBottom();
		if (transcriptAtBottom) {
			followStream = true;
		} else if (state?.lifecycle !== "streaming") {
			followStream = false;
		}
	}

	function handleTranscriptWheel(event: WheelEvent): void {
		if (event.deltaY < 0) followStream = false;
	}

	function handleTranscriptTouchStart(event: TouchEvent): void {
		lastTouchY = event.touches[0]?.clientY ?? null;
	}

	function handleTranscriptTouchMove(event: TouchEvent): void {
		const currentY = event.touches[0]?.clientY;
		if (currentY === undefined || lastTouchY === null) return;
		if (currentY - lastTouchY > 6) followStream = false;
		lastTouchY = currentY;
	}

	function handleTranscriptKeydown(event: KeyboardEvent): void {
		if (
			event.key === "ArrowUp" ||
			event.key === "PageUp" ||
			event.key === "Home" ||
			(event.key === " " && event.shiftKey)
		) followStream = false;
	}

	function returnToLatest(): void {
		followStream = true;
		void scrollToLatest(true);
	}

	async function scrollToLatest(force = false): Promise<void> {
		await tick();
		if (transcriptElement && (force || followStream || isTranscriptAtBottom())) {
			// Streaming updates must be instantaneous. Smooth scrolling can lag behind
			// a fast stream, making a geometry-only follow check disengage itself.
			transcriptElement.scroll({ top: transcriptElement.scrollHeight, behavior: "auto" });
			transcriptAtBottom = true;
		}
	}
</script>

<main class="v2-shell" data-vp-theme={ui.themeId}>
	{#if initStatus === "connecting"}
		<section class="state-card" role="status" aria-live="polite">
			<div class="pulse-mark" aria-hidden="true"></div>
			<h1>Connecting securely</h1>
			<p>Please wait while the chat and survey connect.</p>
		</section>
	{:else if initStatus === "failed"}
		<section class="state-card" role="alert">
			<div class="status-icon" aria-hidden="true">!</div>
			<h1>Chat could not start</h1>
			<p>{initError}</p>
			<button class="primary-button" data-testid="init-retry" type="button" on:click={() => void initialize()}>Try again</button>
		</section>
		{:else if state}
			<header class="chat-header">
				<div class="title-lockup">
					<img class="header-avatar" data-testid="header-avatar" src={medicalAvatar} alt="" />
					<div>
						<h1>{ui.headerTitle}</h1>
						<p>{ui.headerSubtitle || (condition === "combo" ? "Flu & COVID-19" : condition === "covid" ? "COVID-19" : "Flu")}</p>
					</div>
				</div>
				<div class="header-actions">
					{#if ui.appointmentCta}
						<a class="primary-button appointment-link" data-testid="appointment-cta" href={ui.appointmentCta.url} target="_blank" rel="noopener noreferrer">{ui.appointmentCta.label}<span aria-hidden="true"> ↗</span><span class="sr-only"> (opens the pharmacy site in a new tab)</span></a>
					{/if}
					{#if state.lifecycle !== "completed" && !state.chatEndISO}
						{#if !endConfirmationOpen}
							<button bind:this={endChatButton} class="quiet-button" data-testid="end-chat" type="button" on:click={() => void openEndConfirmation()}>{ui.endChatText}</button>
						{/if}
					{/if}
				</div>
			</header>

			{#if endConfirmationOpen}
				<section class="end-confirmation" data-testid="end-confirmation" role="alertdialog" aria-labelledby="end-chat-title" aria-describedby="end-chat-detail">
					<p id="end-chat-title"><strong>End this chat?</strong></p>
					<p id="end-chat-detail">Your conversation will be handed back to the survey before it continues.</p>
					<div class="end-confirmation-actions">
						<button bind:this={endConfirmButton} class="secondary-button" data-testid="keep-chatting" type="button" on:keydown={handleEndConfirmationKeydown} on:click={() => void closeEndConfirmation()}>Keep chatting</button>
						<button class="danger-button" data-testid="confirm-end" type="button" on:keydown={handleEndConfirmationKeydown} on:click={() => endChat()}>End and continue</button>
					</div>
				</section>
			{/if}

		{#if ui.privacyNote && userTurnCount === 0}
			<p class="privacy-note">{ui.privacyNote}</p>
		{/if}

			<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
			<div class="transcript" data-testid="message-list" bind:this={transcriptElement} on:scroll={handleTranscriptScroll} on:wheel|passive={handleTranscriptWheel} on:touchstart|passive={handleTranscriptTouchStart} on:touchmove|passive={handleTranscriptTouchMove} on:keydown={handleTranscriptKeydown} role="log" aria-live="polite" aria-relevant="additions text" tabindex="-1">
				<div class="message-list">
					{#each state.messages as message, index (`${message.id}-${index}`)}
						{#if message.role === "assistant"}
							<div class="assistant-turn">
								<img class="assistant-avatar" data-testid="assistant-avatar" src={medicalAvatar} alt="" />
								<article class:initial-message={message.isInitial} class:partial-message={message.completionStatus !== "complete" && message.completionStatus !== "capped"} class="assistant-message">
								<div class="assistant-content" data-testid="assistant-content">
									{#if (message.id === presentedAssistantId ? presentedAssistantContent : message.content)}
										<SafeMarkdown content={message.id === presentedAssistantId ? presentedAssistantContent : message.content} />
									{:else if message.completionStatus === "streaming"}
										<ActivityIndicator />
										{/if}
									</div>
									{#if message.completionStatus === "incomplete"}
										<p class="message-status" data-testid="incomplete-indicator">This answer was interrupted.</p>
									{:else if message.completionStatus === "superseded"}
										<p class="message-status">Incomplete answer — replaced by a retry.</p>
									{:else if message.completionStatus === "skipped"}
										<p class="message-status">Incomplete answer — skipped.</p>
									{:else if message.completionStatus === "capped"}
										<p class="message-status" data-testid="capped-indicator">Answer stopped at the response limit.</p>
									{/if}
								</article>
							</div>
					{:else}
						<article class="user-message"><p>{(KEEP_RAW_DISPLAY && message.turnId && presentedUserContents[message.turnId]) || message.content}</p></article>
					{/if}
				{/each}

			{#if state.lifecycle === "waiting"}
				<div class="waiting-row"><ActivityIndicator /></div>
				{/if}

				{#if failedAssistant && state.lifecycle === "interrupted" && !continuationBlocked && !state.chatEndISO}
					<section class="recovery-card" aria-labelledby="answer-recovery-title">
						<h2 id="answer-recovery-title">The answer did not finish</h2>
						<p>{lastParticipantError || "Your question and any partial answer are saved in this chat."}</p>
						<div class="recovery-actions">
							<button class="primary-button" data-testid="retry-answer" type="button" on:click={retryCurrentAnswer} disabled={!retryableFailure || retryLimitReached}>Try again</button>
							<button class="secondary-button" data-testid="skip-answer" type="button" on:click={skipCurrentAnswer}>Skip this answer</button>
								<button class="text-button" type="button" on:click={() => void openEndConfirmation()}>End chat</button>
						</div>
					</section>
				{/if}

				{#if continuationBlocked}
					<section class="recovery-card" role="alert">
						<h2>Conversation recovered, but cannot continue safely</h2>
						<p>Your recovered messages remain visible. Finish now so the survey can save the available copy.</p>
						<button class="primary-button" type="button" on:click={() => endChat("participant_end")}>Finish and continue</button>
					</section>
				{/if}

				{#if state.chatEndISO || state.lifecycle === "completed" || (state.lifecycle === "interrupted" && !failedAssistant)}
					<section class="completion-card" role="status">
						<h2>{endAcknowledged ? "Continuing…" : "Chat finished"}</h2>
						<p>{endAcknowledged ? "Your conversation was handed back to the survey. Keep this page open while it finishes." : "Your conversation is being handed back to the survey before it continues."}</p>
						{#if !endAcknowledged}
							<button class="primary-button" type="button" on:click={resendEnd}>Continue</button>
						{/if}
					</section>
				{/if}

				{#if userTurnCount >= MAX_TURNS && state.lifecycle === "ready"}
					<section class="completion-card">
						<h2>You’ve reached the {MAX_TURNS}-question limit</h2>
						<p>Finish the chat to save the conversation and continue.</p>
						<button class="primary-button" type="button" on:click={() => endChat("hard_cap")}>Finish and continue</button>
					</section>
				{/if}
				</div>
			</div>

			{#if !transcriptAtBottom && !followStream && !state.chatEndISO && state.lifecycle !== "completed"}
				<div class="scroll-latest-anchor">
					<button class="scroll-latest-button" data-testid="scroll-to-latest" type="button" aria-label="Scroll to the newest messages" on:click={returnToLatest}>
						<img src={scrollDownIcon} alt="" />
					</button>
				</div>
			{/if}

			{#if !state.chatEndISO && state.lifecycle !== "completed" && !(state.lifecycle === "interrupted" && !failedAssistant)}
				<footer class="composer-area">
	{#if showSuggestions}
						<p class="suggestions-label">Examples of questions you can ask</p>
						<div class="suggestions" data-testid="suggested-questions" role="group" aria-label="Examples of questions you can ask">
							{#each ui.suggestedQuestions as suggestion}
								<button data-testid="suggested-question" type="button" on:click={() => void submitQuestion(suggestion)}>{suggestion}</button>
						{/each}
					</div>
				{/if}
				{#if capacityError || lastParticipantError && !failedAssistant}
					<p class="inline-error" data-testid="chat-error" role="alert">{capacityError || lastParticipantError}</p>
				{/if}
				<form on:submit|preventDefault={() => void submitQuestion()}>
					<label for="v2-question">Your vaccine question</label>
					<div class="input-row">
							<textarea id="v2-question" data-testid="question-input" bind:this={inputElement} value={draftInput} on:input={handleDraftInput} on:keydown={handleComposerKeydown} maxlength={MAX_USER_CODE_POINTS * 2} rows="2" placeholder={ui.placeholderInputText} disabled={!canAsk} aria-describedby={showQuestionLimit ? "question-limit" : undefined}></textarea>
							<button class="send-button" data-testid="send-question" type="submit" disabled={!canAsk || !draftInput.trim() || inputCodePoints > MAX_USER_CODE_POINTS}>Send<span class="sr-only"> question</span></button>
						</div>
						{#if showQuestionLimit}
							<p id="question-limit" data-testid="question-limit" role="status" aria-live="polite">{inputCodePoints.toLocaleString()} / {MAX_USER_CODE_POINTS.toLocaleString()} characters · {userTurnCount} / {MAX_TURNS} questions</p>
						{/if}
					</form>
				</footer>
			{/if}
		{/if}
	</main>

<style>
	:global(html), :global(body) { margin: 0; min-height: 100%; background: #f7fafc; }
	:global(body) { color: #172033; }
	:global(*) { box-sizing: border-box; }
	.header-actions { align-items: center; display: flex; flex-wrap: wrap; gap: .5rem; justify-content: flex-end; }
	.appointment-link { display: inline-block; text-align: center; text-decoration: none; }
	.v2-shell { background: var(--vp-page-bg); color: var(--vp-text); display: flex; flex-direction: column; font-family: var(--vp-font-family); height: 100vh; height: 100svh; min-height: 0; }
	.chat-header { align-items: center; background: var(--vp-surface); border-bottom: 1px solid var(--vp-border); display: flex; flex: none; justify-content: space-between; min-height: 4rem; padding: max(.55rem, env(safe-area-inset-top)) 1rem .55rem; }
	.title-lockup { align-items: center; display: flex; gap: .7rem; min-width: 0; }
	.header-avatar { border-radius: 9999px; flex: none; height: 2rem; object-fit: cover; width: 2rem; }
	h1, h2, p { margin-top: 0; }
	.title-lockup h1 { color: var(--vp-header-title); font-size: 1.05rem; line-height: 1.2; margin: 0; }
	.title-lockup p { color: var(--vp-header-subtitle); font-size: .78rem; line-height: 1.2; margin: .15rem 0 0; }
	.privacy-note { background: var(--vp-banner-bg); border-bottom: 1px solid var(--vp-banner-border); color: var(--vp-banner-text); flex: none; font-size: .82rem; line-height: 1.4; margin: 0; padding: .55rem 1rem; }
	.transcript { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 1rem max(1rem, env(safe-area-inset-left)) 1.25rem; }
	.message-list { margin: 0 auto; max-width: 44rem; }
	.assistant-turn { margin: 0 0 .9rem; position: relative; }
	.assistant-avatar { border-radius: 9999px; display: block; height: 2rem; margin: 0 0 .35rem; object-fit: cover; width: 2rem; }
	.assistant-message, .user-message { border-radius: 1rem; line-height: 1.55; overflow-wrap: anywhere; padding: .8rem .9rem; }
	.assistant-message { background: var(--vp-surface); border: 1px solid var(--vp-border); border-bottom-left-radius: .3rem; box-shadow: 0 1px 2px var(--vp-card-shadow); max-width: none; width: 100%; }
	.assistant-message.partial-message { border-color: #e4c98d; }
	.user-message { background: var(--vp-user-bubble-bg); border-bottom-right-radius: .3rem; color: var(--vp-user-bubble-text); margin: 0 0 .9rem auto; max-width: 88%; width: fit-content; }
	.user-message p { margin: 0; white-space: pre-wrap; }
	.message-status { border-top: 1px solid #e1e7ed; color: #6b4d0f; font-size: .8rem; margin: .65rem 0 0; padding-top: .5rem; }
	.waiting-row { align-items: center; display: flex; margin: .5rem 0 1rem; }
	.composer-area { background: var(--vp-surface); border-top: 1px solid var(--vp-border); flex: none; padding: .65rem max(1rem, env(safe-area-inset-right)) max(.7rem, env(safe-area-inset-bottom)); }
	.composer-area form, .suggestions, .inline-error { margin-left: auto; margin-right: auto; max-width: 44rem; }
	.composer-area label { display: block; font-size: .78rem; font-weight: 700; margin-bottom: .3rem; }
	.input-row { align-items: stretch; display: flex; gap: .55rem; }
	textarea { background: var(--vp-surface); border: 1px solid var(--vp-input-border); border-radius: .7rem; color: var(--vp-text); flex: 1; font: inherit; font-size: 1rem; line-height: 1.4; min-height: 3rem; padding: .7rem .75rem; resize: none; }
	textarea:focus { border-color: var(--vp-primary-bg); box-shadow: 0 0 0 3px var(--vp-focus-soft); outline: none; }
	textarea:disabled { background: var(--vp-input-disabled); }
	.send-button, .primary-button, .secondary-button, .danger-button, .quiet-button, .text-button, .suggestions button { border-radius: .65rem; cursor: pointer; font: inherit; font-weight: 700; min-height: 44px; }
	.send-button, .primary-button { background: var(--vp-primary-bg); border: 1px solid var(--vp-primary-bg); color: var(--vp-primary-text); padding: .65rem 1rem; }
	.send-button:not(:disabled):hover, .primary-button:not(:disabled):hover { background: var(--vp-primary-hover); border-color: var(--vp-primary-hover); }
	.send-button:disabled, .primary-button:disabled { cursor: not-allowed; opacity: .48; }
	.secondary-button, .quiet-button { background: var(--vp-surface); border: 1px solid var(--vp-secondary-border); color: var(--vp-secondary-text); padding: .6rem .9rem; }
	.danger-button { background: #991b1b; border: 1px solid #991b1b; color: #fff; padding: .6rem .9rem; }
	.quiet-button { flex: none; font-size: .86rem; }
	.text-button { background: transparent; border: 0; color: #8c1d2c; padding: .6rem .8rem; text-decoration: underline; }
	#question-limit { color: #68798a; font-size: .75rem; margin: .3rem 0 0; text-align: right; }
	.inline-error { color: #9b1c2d; font-weight: 700; }
	.inline-error { font-size: .85rem; margin-bottom: .45rem; }
	.suggestions-label { color: var(--vp-muted-text); font-size: .86rem; margin: 0 auto .35rem; max-width: 44rem; }
	.suggestions { display: flex; flex-wrap: wrap; gap: .45rem; margin-bottom: .55rem; overflow: visible; padding: 1px 1px .2rem; }
	.suggestions button { background: var(--vp-surface); border: 1px solid var(--vp-chip-border); color: var(--vp-chip-text); flex: 0 1 auto; font-size: .86rem; max-width: 100%; overflow-wrap: anywhere; padding: .55rem .75rem; text-align: left; white-space: normal; }
	.suggestions button:hover { background: var(--vp-chip-hover); }
	.recovery-card, .completion-card { background: #fffaf0; border: 1px solid #dec684; border-radius: .9rem; margin: 1rem 0; padding: 1rem; }
	.completion-card { background: #eef7f1; border-color: #a8cdb4; }
	.recovery-card h2, .completion-card h2 { font-size: 1.05rem; margin-bottom: .4rem; }
	.recovery-card p, .completion-card p { color: #4e5f70; font-size: .9rem; margin-bottom: .8rem; }
	.recovery-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
	.end-confirmation { align-items: center; background: #f1f5f9; border-bottom: 1px solid var(--vp-border); display: flex; flex: none; flex-wrap: wrap; gap: .35rem .75rem; padding: .5rem 1rem; }
	.end-confirmation p { color: #334155; font-size: .86rem; margin: 0; }
	.end-confirmation-actions { display: flex; gap: .5rem; margin-left: auto; }
	.scroll-latest-anchor { height: 0; position: relative; z-index: 10; }
	.scroll-latest-button { align-items: center; background: var(--vp-surface); border: 1px solid var(--vp-scroll-border); border-radius: 9999px; bottom: .55rem; box-shadow: 0 2px 8px var(--vp-scroll-shadow); cursor: pointer; display: flex; height: 44px; justify-content: center; left: 50%; padding: 0; position: absolute; transform: translateX(-50%); width: 44px; }
	.scroll-latest-button img { height: 1.65rem; width: 1.65rem; }
	.state-card { background: var(--vp-surface); border: 1px solid var(--vp-border); border-radius: 1rem; margin: auto; max-width: 26rem; padding: 1.5rem; text-align: center; width: calc(100% - 2rem); }
	.state-card h1 { font-size: 1.15rem; margin: .75rem 0 .4rem; }
	.state-card p { color: #526274; line-height: 1.5; }
	.status-icon, .pulse-mark { align-items: center; background: var(--vp-avatar-halo); border-radius: 50%; color: var(--vp-primary-bg); display: flex; font-size: 1.4rem; font-weight: 800; height: 2.8rem; justify-content: center; margin: 0 auto; width: 2.8rem; }
	.pulse-mark { animation: pulse 1.4s ease-in-out infinite; }
	.sr-only { clip: rect(0, 0, 0, 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
	button:focus-visible, textarea:focus-visible, .transcript:focus-visible { outline: 3px solid var(--vp-focus); outline-offset: 2px; }
	@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--vp-pulse-ring); } 50% { box-shadow: 0 0 0 10px transparent; } }
	@media (min-width: 40rem) { .transcript { padding-top: 1.4rem; } .assistant-turn { padding-left: 2.75rem; } .assistant-avatar { height: 2.5rem; left: 0; margin: 0; position: absolute; top: .5rem; width: 2.5rem; } .assistant-message { max-width: 90%; width: auto; } .user-message { max-width: 78%; } }
	@media (max-width: 30rem) { .end-confirmation { align-items: stretch; } .end-confirmation-actions { margin-left: 0; width: 100%; } .end-confirmation-actions button { flex: 1; } }
	@media (prefers-reduced-motion: reduce) { .pulse-mark { animation: none; } .transcript { scroll-behavior: auto; } }
</style>
