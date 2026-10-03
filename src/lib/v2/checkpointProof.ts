import type { V2PersistedState, V2Snapshot } from "./types";
export const MESSAGE_RECEIPT_PATTERN = /^v2m\.[A-Za-z0-9_-]{43}$/;
// Capture alongside a queued snapshot: later stream deltas must not replace
// the proof for an earlier prefix while an earlier backup is still in flight.
export function checkpointProofFields(state: V2PersistedState, snapshot: V2Snapshot): {
	historyTag: string; messageReceipts: Record<string, string>;
} {
	const messageReceipts: Record<string, string> = {};
	for (const message of snapshot.messages) {
		const current = state.messages.find((candidate) => candidate.id === message.id);
		const receipt = state.messageReceipts?.[message.id];
		if (receipt && current?.content === message.content && current.role === message.role && current.turnId === message.turnId) {
			messageReceipts[message.id] = receipt;
		}
	}
	return { historyTag: state.historyTag, messageReceipts };
}

// Reuse browser-local proofs after a parent snapshot wins recovery only where
// both copies contain precisely the same message. Never attest parent text.
export function recoveredMessageReceipts(restored: V2PersistedState, local: V2PersistedState | null): Record<string, string> {
	const receipts = { ...(restored.messageReceipts ?? {}) };
	if (!local?.messageReceipts) return receipts;
	for (const message of restored.messages) {
		const previous = local.messages.find((item) => item.id === message.id);
		const receipt = local.messageReceipts[message.id];
		if (receipt && previous?.content === message.content && previous.role === message.role && previous.turnId === message.turnId) receipts[message.id] = receipt;
	}
	return receipts;
}
