import { newUuid } from "./constants";
import type { ParentInitMessage, V2PersistedState } from "./types";

export interface RecoveredCheckpointHandleSource {
	handle: string | null;
	acknowledgedRevision: number | null;
}

/**
 * Resolve private handle copies by the checkpoint revision each one actually
 * acknowledges, independently of which transcript snapshot is newer. A newer
 * transcript can legitimately lag a locally received checkpoint ack. Only an
 * equal/unknown-revision divergence is unsafe to choose automatically.
 */
export function reconcileRecoveredCheckpointHandle(
	candidate: V2PersistedState,
	local: RecoveredCheckpointHandleSource | null,
	parent: RecoveredCheckpointHandleSource | null,
): { state: V2PersistedState; conflict: boolean } {
	const sources = [local, parent].filter(
		(source): source is RecoveredCheckpointHandleSource => Boolean(source?.handle),
	);
	if (sources.length === 0) {
		return { state: { ...candidate, checkpointHandle: null }, conflict: false };
	}
	if (sources.length === 1) {
		const source = sources[0];
		return {
			state: {
				...candidate,
				checkpointHandle: source.handle,
				lastAcknowledgedCheckpointRevision:
					source.acknowledgedRevision === null
						? candidate.lastAcknowledgedCheckpointRevision
						: Math.max(
							candidate.lastAcknowledgedCheckpointRevision,
							source.acknowledgedRevision,
						),
			},
			conflict: false,
		};
	}

	const [localSource, parentSource] = sources;
	if (localSource.handle === parentSource.handle) {
		const acknowledged = [
			candidate.lastAcknowledgedCheckpointRevision,
			localSource.acknowledgedRevision,
			parentSource.acknowledgedRevision,
		].filter((value): value is number => value !== null);
		return {
			state: {
				...candidate,
				checkpointHandle: localSource.handle,
				lastAcknowledgedCheckpointRevision: Math.max(...acknowledged),
			},
			conflict: false,
		};
	}
	if (
		localSource.acknowledgedRevision === null ||
		parentSource.acknowledgedRevision === null ||
		localSource.acknowledgedRevision === parentSource.acknowledgedRevision
	) {
		return { state: candidate, conflict: true };
	}
	const selected = localSource.acknowledgedRevision > parentSource.acknowledgedRevision
		? localSource
		: parentSource;
	const selectedRevision = selected.acknowledgedRevision;
	if (selectedRevision === null) return { state: candidate, conflict: true };
	return {
		state: {
			...candidate,
			checkpointHandle: selected.handle,
			lastAcknowledgedCheckpointRevision: Math.max(
				candidate.lastAcknowledgedCheckpointRevision,
				selectedRevision,
			),
		},
		conflict: false,
	};
}

/**
 * Reconcile the iframe's private checkpoint lease with the parent copy. The
 * parent can be newer when an iframe storage write failed after the parent had
 * already persisted the lease. Prefer the later valid lease, and discard a
 * lease that is already covered by an acknowledged checkpoint revision.
 */
export function mergeRecoveredCheckpointLease(
	candidate: V2PersistedState,
	init: Pick<
		ParentInitMessage,
		"checkpointInFlightSequence" | "checkpointInFlightStartedAtISO"
	>,
): V2PersistedState {
	let checkpointInFlightSequence = candidate.checkpointInFlightSequence;
	let checkpointInFlightStartedAtISO = candidate.checkpointInFlightStartedAtISO;
	if (
		checkpointInFlightSequence !== null &&
		checkpointInFlightSequence <= candidate.lastAcknowledgedCheckpointRevision
	) {
		checkpointInFlightSequence = null;
		checkpointInFlightStartedAtISO = null;
	}

	const parentSequence = init.checkpointInFlightSequence;
	const parentStartedAtISO = init.checkpointInFlightStartedAtISO;
	if (
		parentSequence !== undefined &&
		parentStartedAtISO !== undefined &&
		parentSequence > candidate.lastAcknowledgedCheckpointRevision
	) {
		const localStartedAt = checkpointInFlightStartedAtISO === null
			? Number.NEGATIVE_INFINITY
			: Date.parse(checkpointInFlightStartedAtISO);
		const parentStartedAt = Date.parse(parentStartedAtISO);
		if (
			checkpointInFlightSequence === null ||
			parentStartedAt > localStartedAt ||
			(parentStartedAt === localStartedAt && parentSequence >= checkpointInFlightSequence)
		) {
			checkpointInFlightSequence = parentSequence;
			checkpointInFlightStartedAtISO = parentStartedAtISO;
		}
	}

	return {
		...candidate,
		checkpointInFlightSequence,
		checkpointInFlightStartedAtISO,
	};
}

/**
 * Convert any locally or parent-recovered in-flight turn into an explicit,
 * retryable interrupted answer. Parent snapshots intentionally expose only an
 * `active` state, so an unanswered final user message must be inferred from
 * message structure rather than from the private lifecycle alone.
 */
export function restoreInterruptedTurn(
	candidate: V2PersistedState,
	makeId: () => string = newUuid,
	nowISO: () => string = () => new Date().toISOString(),
): V2PersistedState {
	if (candidate.lifecycle === "completed") return candidate;
	let interrupted = false;
	const streamingIds = candidate.messages
		.filter((message) => message.completionStatus === "streaming")
		.map((message) => message.id);
	const newestStreamingId = streamingIds[streamingIds.length - 1];
	let messages = candidate.messages.map((message) => {
		if (message.completionStatus !== "streaming") return message;
		interrupted = true;
		return {
			...message,
			completionStatus:
				message.id === newestStreamingId ? "incomplete" as const : "superseded" as const,
			excludedFromModel: true,
			failureReason: "client_reload",
		};
	});

	const pendingUser = [...messages].reverse().find((message) =>
		message.role === "user" &&
		!message.isInitial &&
		!message.excludedFromModel &&
		Boolean(message.turnId) &&
		!messages.some(
			(candidateMessage) =>
				candidateMessage.role === "assistant" &&
				candidateMessage.turnId === message.turnId,
		),
	);
	if (pendingUser?.turnId) {
		interrupted = true;
		messages = [...messages, {
			id: makeId(),
			turnId: pendingUser.turnId,
			role: "assistant",
			content: "",
			createdAtISO: nowISO(),
			isInitial: false,
			completionStatus: "incomplete",
			excludedFromModel: true,
			failureReason: "client_reload_before_stream",
		}];
	}

	return {
		...candidate,
		messages,
		lifecycle:
			interrupted || candidate.lifecycle === "interrupted"
				? "interrupted"
				: candidate.lifecycle,
	};
}
