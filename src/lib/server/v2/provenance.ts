import { createHmac, timingSafeEqual } from 'node:crypto';
import { captureCode, captureReason } from '../../v2/captureMetadata';
import { verifyHistoryTag, verifyHistoryTagBinding, type SessionClaims, type HistoryMessage } from './tokens';
import type { StudyConfig } from './studyConfig';
import type { TranscriptSnapshot } from './schemas';

type ReceiptMessage = HistoryMessage & { turnId: string };
// A compact, domain-separated HMAC attests exactly one canonical user turn or
// actually emitted assistant prefix. It authenticates content, not mutable UI
// lifecycle labels. It is never issued for caller-supplied checkpoint content.
export function issueMessageReceipt(secret: string, session: SessionClaims, message: ReceiptMessage): string {
	const material = JSON.stringify([
		session.sid, session.attempt, session.condition, session.configVersion, session.configHash,
		message.id, message.turnId, message.role, message.content
	]);
	return 'v2m.' + createHmac('sha256', secret)
		.update('vegapunk:v2:message-receipt\0').update(material).digest('base64url');
}
function validReceipt(secret: string, session: SessionClaims, message: ReceiptMessage, receipt?: string): boolean {
	if (!receipt || !/^v2m\.[A-Za-z0-9_-]{43}$/.test(receipt)) return false;
	const expected = issueMessageReceipt(secret, session, message);
	return timingSafeEqual(Buffer.from(expected), Buffer.from(receipt));
}
export function assertScreenedConfiguration(config: StudyConfig): void {
	// Retained revisions remain available for research reproducibility, but the
	// public APIs must never revive configurations predating privacy screening.
	if (!config.scrubber) throw new Error('Unscreened configurations are no longer supported');
}
export function verifyCheckpointProvenance(args: {
	secret: string;
	session: SessionClaims;
	config: StudyConfig;
	snapshot: TranscriptSnapshot;
	historyTag?: string;
	messageReceipts?: Record<string, string>;
	reasonHint?: string;
}): void {
	const fail = (): never => { throw new Error('Checkpoint content provenance could not be verified'); };
	assertScreenedConfiguration(args.config);
	const { snapshot, config, session, secret } = args;
	if (args.reasonHint !== undefined && captureReason(args.reasonHint) !== args.reasonHint) fail();
	if (snapshot.captureErrors.some((error) => captureCode(error.code) !== error.code)) fail();
	if (snapshot.messages.some((message) => message.failureReason !== undefined && captureCode(message.failureReason) !== message.failureReason)) fail();
	// Opening messages are not user content: require the exact configured list,
	// in order, and its fixed flags. An isInitial label cannot bypass validation.
	const openings = snapshot.messages.filter((message) => message.isInitial);
	if (openings.length !== config.initialMessages.length) fail();
	for (let i = 0; i < openings.length; i += 1) {
		const message = snapshot.messages[i];
		const expected = config.initialMessages[i];
		if (!message.isInitial || message.id !== expected.id || message.role !== 'assistant' ||
			message.content !== expected.content || message.turnId !== undefined ||
			message.completionStatus !== 'complete' || !message.excludedFromModel || message.failureReason !== undefined) fail();
	}
	// Compatibility for pre-receipt completed conversations: reconstruct only
	// the completed canonical prefix and require its existing server HMAC. A
	// checkpoint handle or client-computed checksum is never content proof.
	const proven = new Map<string, { message: HistoryMessage; turnId: string }>();
	if (args.historyTag) {
		const claims = verifyHistoryTagBinding({ token: args.historyTag, secret, session });
		const included = snapshot.messages.filter((message) => !message.isInitial && !message.excludedFromModel);
		const history = included.slice(0, claims.sequence * 2);
		if (history.length !== claims.sequence * 2) fail();
		verifyHistoryTag({ token: args.historyTag, secret, session, sequence: claims.sequence, history });
		for (let i = 0; i < history.length; i += 2) {
			const user = history[i]; const assistant = history[i + 1];
			if (user.role !== 'user' || assistant.role !== 'assistant' ||
				user.turnId !== user.id || assistant.turnId !== user.id ||
				user.completionStatus !== 'complete' || !['complete', 'capped'].includes(assistant.completionStatus)) fail();
			proven.set(user.id, { message: user, turnId: user.id });
			proven.set(assistant.id, { message: assistant, turnId: user.id });
		}
	}
	for (const message of snapshot.messages) {
		if (message.isInitial) continue;
		if (!message.turnId) fail();
		const historical = proven.get(message.id);
		if (historical && historical.turnId === message.turnId &&
			historical.message.role === message.role && historical.message.content === message.content) continue;
		// Empty local placeholders have no participant/model text to authenticate.
		if (message.role === 'assistant' && message.content === '' && message.excludedFromModel &&
			['streaming', 'incomplete', 'superseded', 'skipped'].includes(message.completionStatus)) continue;
		if (!validReceipt(secret, session, { ...message, turnId: message.turnId! }, args.messageReceipts?.[message.id])) fail();
	}
}
