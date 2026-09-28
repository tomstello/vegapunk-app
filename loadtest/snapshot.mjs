// Checkpoint snapshot construction for the load generator.
//
// /api/v2/checkpoint re-parses the transcript with a strict schema, asserts its
// identity fields against the signed session, and recomputes every counter from
// the messages. A snapshot that is off by one key or one code point is rejected
// with 400 invalid_transcript, so this file mirrors serializeSnapshot() in
// src/lib/v2/snapshot.ts and TranscriptSnapshotSchema in
// src/lib/server/v2/schemas.ts. If either changes, change this with it;
// tests/loadtest-snapshot.test.mjs validates the output against the real schema.

const encoder = new TextEncoder();

export const utf8Length = (value) => encoder.encode(value).byteLength;
export const codePointLength = (value) => Array.from(value).length;

// Mirrors src/lib/server/v2/limits.ts.
export const MAX_SNAPSHOT_MESSAGES = 200;
export const MAX_TRANSCRIPT_UTF16_CODE_UNITS = 240_000;
export const MAX_TRANSCRIPT_UTF8_BYTES = 280_000;
export const MAX_CHECKPOINT_REQUEST_BYTES = 400_000;

/**
 * One transcript message with exactly the keys the strict schema allows.
 *
 * Built field by field rather than spread from the session response: that
 * response carries a v1-era `hideInitialMessage` on each initial message, and
 * the snapshot schema rejects unknown keys. The browser is not exposed to this
 * because parseSessionResponse (src/lib/v2/api.ts) rebuilds each message as
 * {id, role, content} first; the harness reads the response raw, so it does
 * the equivalent here.
 */
function message({
	id,
	turnId,
	role,
	content,
	createdAtISO,
	isInitial,
	completionStatus,
	excludedFromModel
}) {
	return {
		id,
		...(turnId === undefined ? {} : { turnId }),
		role,
		content,
		createdAtISO,
		isInitial,
		completionStatus,
		excludedFromModel
	};
}

/** The opening assistant turn(s), seeded exactly as V2Chat.svelte seeds them. */
export function initialMessages(session, createdAtISO) {
	return (session.initialMessages ?? []).map((source) =>
		message({
			id: source.id,
			role: source.role,
			content: source.content,
			createdAtISO,
			isInitial: true,
			completionStatus: 'complete',
			// The opening message is context the participant sees, not model input.
			excludedFromModel: true
		})
	);
}

export function userMessage({ id, turnId, content, createdAtISO }) {
	return message({
		id,
		turnId,
		role: 'user',
		content,
		createdAtISO,
		isInitial: false,
		completionStatus: 'complete',
		excludedFromModel: false
	});
}

export function assistantMessage({ id, turnId, content, createdAtISO }) {
	return message({
		id,
		turnId,
		role: 'assistant',
		content,
		createdAtISO,
		isInitial: false,
		completionStatus: 'complete',
		excludedFromModel: false
	});
}

// The server recomputes each of these and rejects any mismatch. Note that
// completeAssistantMessages counts initial assistant messages too: it is not
// filtered by isInitial, unlike assistantMessages.
function countMessages(messages) {
	return {
		totalMessages: messages.length,
		initialMessages: messages.filter((m) => m.isInitial).length,
		userMessages: messages.filter((m) => m.role === 'user' && !m.isInitial).length,
		assistantMessages: messages.filter((m) => m.role === 'assistant' && !m.isInitial).length,
		completeAssistantMessages: messages.filter(
			(m) => m.role === 'assistant' && ['complete', 'capped'].includes(m.completionStatus)
		).length,
		incompleteAssistantMessages: messages.filter(
			(m) => m.role === 'assistant' && !['complete', 'capped'].includes(m.completionStatus)
		).length,
		totalContentCodePoints: messages.reduce((total, m) => total + codePointLength(m.content), 0),
		serializedUtf16CodeUnits: 0,
		serializedUtf8Bytes: 0
	};
}

/**
 * Serialize a snapshot, resolving the two self-referential length counters.
 *
 * The counters record the length of the JSON that contains them, so writing a
 * value can change the length. The browser iterates to a fixed point and so
 * does this; in practice it settles in two or three passes.
 */
export function serializeSnapshot(context, { state, chatEndISO, updatedAtISO }) {
	const snapshot = {
		schemaVersion: 2,
		snapshotSequence: context.snapshotSequence,
		condition: context.condition,
		chatSessionKey: context.chatSessionKey,
		configVersion: context.configVersion,
		configHash: context.configHash,
		state,
		createdAtISO: context.createdAtISO,
		updatedAtISO,
		chatEndISO,
		messages: context.messages.map((m) => ({ ...m })),
		counters: countMessages(context.messages),
		checkpoint: {
			hasHandle: context.handle !== null,
			lastAcknowledgedRevision: context.acknowledgedSequence
		},
		// The harness has no Qualtrics parent frame, so nothing has been synced
		// to one. Zeroes are the honest values, not placeholders.
		parent: { lastAcknowledgedRevision: 0, syncCount: 0 },
		captureErrors: []
	};

	for (let pass = 0; pass < 12; pass += 1) {
		const json = JSON.stringify(snapshot);
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
	throw new Error('snapshot_length_counters_did_not_converge');
}

/** Fresh per-conversation checkpoint state, seeded from the session response. */
export function newCheckpointContext(session, createOperationId, nowISO) {
	return {
		createOperationId,
		chatSessionKey: session.sessionKey,
		condition: session.condition,
		configVersion: session.configVersion,
		configHash: session.configHash,
		createdAtISO: nowISO,
		messages: initialMessages(session, nowISO),
		snapshotSequence: 0,
		handle: null,
		acknowledgedSequence: 0
	};
}

/** Why a snapshot cannot be sent, or null when it fits. */
export function snapshotRejection(serialized, requestBytes) {
	if (serialized.snapshot.messages.length > MAX_SNAPSHOT_MESSAGES) return 'too_many_messages';
	if (serialized.utf16CodeUnits > MAX_TRANSCRIPT_UTF16_CODE_UNITS) return 'transcript_utf16_too_large';
	if (serialized.utf8Bytes > MAX_TRANSCRIPT_UTF8_BYTES) return 'transcript_utf8_too_large';
	if (requestBytes > MAX_CHECKPOINT_REQUEST_BYTES) return 'request_too_large';
	return null;
}
