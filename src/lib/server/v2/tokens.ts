import { z } from 'zod';
import {
	assertStrongSigningKey,
	openOpaqueJson,
	sealOpaqueJson,
	sha256Hex,
	signCompactJson,
	verifyCompactJson
} from './crypto';
import {
	CHECKPOINT_HANDLE_TTL_SECONDS,
	MAX_CLOCK_SKEW_SECONDS,
	MAX_TURNS,
	SESSION_TTL_SECONDS,
	V2_PROTOCOL_VERSION
} from './limits';

export const CONDITIONS = ['flu', 'covid', 'combo', 'demo'] as const;
export type StudyCondition = (typeof CONDITIONS)[number];

export type HistoryMessage = {
	id: string;
	role: 'user' | 'assistant';
	content: string;
};

const SessionPayloadSchema = z
	.object({
		typ: z.literal('vp-session'),
		v: z.literal(V2_PROTOCOL_VERSION),
		sid: z.string().uuid(),
		attempt: z.string().regex(/^[a-f0-9]{64}$/),
		condition: z.enum(CONDITIONS),
		configVersion: z.string().min(1).max(96),
		configHash: z.string().regex(/^[a-f0-9]{64}$/),
		iat: z.number().int().nonnegative(),
		exp: z.number().int().positive()
	})
	.strict();

const HistoryPayloadSchema = z
	.object({
		typ: z.literal('vp-history'),
		v: z.literal(V2_PROTOCOL_VERSION),
		sid: z.string().uuid(),
		attempt: z.string().regex(/^[a-f0-9]{64}$/),
		condition: z.enum(CONDITIONS),
		configVersion: z.string().min(1).max(96),
		configHash: z.string().regex(/^[a-f0-9]{64}$/),
		sequence: z.number().int().min(0).max(MAX_TURNS),
		digest: z.string().regex(/^[a-f0-9]{64}$/)
	})
	.strict();

const CheckpointHandlePayloadSchema = z
	.object({
		typ: z.literal('vp-checkpoint'),
		v: z.literal(V2_PROTOCOL_VERSION),
		sid: z.string().uuid(),
		attempt: z.string().regex(/^[a-f0-9]{64}$/),
		// Store reference sealed into the handle: a Qualtrics response ID
		// (legacy writer) or the S3 object prefix shared by one create operation.
		// Both shapes stay valid so sessions in flight during a store cutover,
		// in either direction, keep checkpointing. The field name is kept so
		// handles issued before the S3 writer existed still parse.
		checkpointResponseId: z
			.string()
			.regex(/^(?:R_[A-Za-z0-9]+|v2\/[A-Za-z0-9._/-]{1,240})$/),
		createOperationId: z.string().uuid(),
		acknowledgedSequence: z.number().int().min(0).max(1_000_000),
		acknowledgedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
		condition: z.enum(CONDITIONS),
		configVersion: z.string().min(1).max(96),
		configHash: z.string().regex(/^[a-f0-9]{64}$/),
		iat: z.number().int().nonnegative(),
		exp: z.number().int().positive()
	})
	.strict();

export type SessionClaims = z.infer<typeof SessionPayloadSchema>;
export type HistoryClaims = z.infer<typeof HistoryPayloadSchema>;
export type CheckpointHandleClaims = z.infer<typeof CheckpointHandlePayloadSchema>;

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

export function signingKey(raw: string | undefined): string {
	return assertStrongSigningKey(raw);
}

export function issueSessionToken(args: {
	secret: string;
	chatSessionKey: string;
	attemptNonce: string;
	condition: StudyCondition;
	configVersion: string;
	configHash: string;
	now?: number;
}): { token: string; claims: SessionClaims } {
	const now = args.now ?? nowSeconds();
	const claims: SessionClaims = {
		typ: 'vp-session',
		v: V2_PROTOCOL_VERSION,
		sid: args.chatSessionKey,
		attempt: sha256Hex(args.attemptNonce),
		condition: args.condition,
		configVersion: args.configVersion,
		configHash: args.configHash,
		iat: now,
		exp: now + SESSION_TTL_SECONDS
	};
	return { token: signCompactJson('v2s', claims, args.secret), claims };
}

export function verifySessionToken(token: string, secret: string, now = nowSeconds()): SessionClaims {
	const claims = SessionPayloadSchema.parse(verifyCompactJson(token, 'v2s', secret));
	if (claims.iat > now + MAX_CLOCK_SKEW_SECONDS || claims.exp < now - MAX_CLOCK_SKEW_SECONDS) {
		throw new Error('Session token expired or not yet valid');
	}
	if (claims.exp - claims.iat !== SESSION_TTL_SECONDS) throw new Error('Invalid session lifetime');
	return claims;
}

export function canonicalHistory(history: readonly HistoryMessage[]): string {
	return JSON.stringify(
		history.map(({ id, role, content }) => ({ id, role, content }))
	);
}

export function historyDigest(history: readonly HistoryMessage[]): string {
	return sha256Hex(canonicalHistory(history));
}

export function issueHistoryTag(args: {
	secret: string;
	session: SessionClaims;
	sequence: number;
	history: readonly HistoryMessage[];
}): string {
	const claims: HistoryClaims = {
		typ: 'vp-history',
		v: V2_PROTOCOL_VERSION,
		sid: args.session.sid,
		attempt: args.session.attempt,
		condition: args.session.condition,
		configVersion: args.session.configVersion,
		configHash: args.session.configHash,
		sequence: args.sequence,
		digest: historyDigest(args.history)
	};
	return signCompactJson('v2t', claims, args.secret);
}

export function verifyHistoryTag(args: {
	token: string;
	secret: string;
	session: SessionClaims;
	sequence: number;
	history: readonly HistoryMessage[];
}): HistoryClaims {
	const claims = HistoryPayloadSchema.parse(verifyCompactJson(args.token, 'v2t', args.secret));
	const expectedDigest = historyDigest(args.history);
	if (
		claims.sid !== args.session.sid ||
		claims.attempt !== args.session.attempt ||
		claims.condition !== args.session.condition ||
		claims.configVersion !== args.session.configVersion ||
		claims.configHash !== args.session.configHash ||
		claims.sequence !== args.sequence ||
		claims.digest !== expectedDigest
	) {
		throw new Error('History state does not match its signed tag');
	}
	return claims;
}

export function issueCheckpointHandle(args: {
	secret: string;
	session: SessionClaims;
	checkpointResponseId: string;
	createOperationId: string;
	acknowledgedSequence: number;
	acknowledgedChecksum: string;
	now?: number;
}): string {
	const now = args.now ?? nowSeconds();
	const claims: CheckpointHandleClaims = {
		typ: 'vp-checkpoint',
		v: V2_PROTOCOL_VERSION,
		sid: args.session.sid,
		attempt: args.session.attempt,
		checkpointResponseId: args.checkpointResponseId,
		createOperationId: args.createOperationId,
		acknowledgedSequence: args.acknowledgedSequence,
		acknowledgedChecksum: args.acknowledgedChecksum,
		condition: args.session.condition,
		configVersion: args.session.configVersion,
		configHash: args.session.configHash,
		iat: now,
		exp: now + CHECKPOINT_HANDLE_TTL_SECONDS
	};
	return sealOpaqueJson('v2h', claims, args.secret, 'checkpoint-handle');
}

export function verifyCheckpointHandle(args: {
	token: string;
	secret: string;
	session: SessionClaims;
	now?: number;
}): CheckpointHandleClaims {
	const now = args.now ?? nowSeconds();
	const claims = CheckpointHandlePayloadSchema.parse(
		openOpaqueJson(args.token, 'v2h', args.secret, 'checkpoint-handle')
	);
	if (claims.exp < now - MAX_CLOCK_SKEW_SECONDS || claims.iat > now + MAX_CLOCK_SKEW_SECONDS) {
		throw new Error('Checkpoint handle expired or not yet valid');
	}
	if (claims.exp - claims.iat !== CHECKPOINT_HANDLE_TTL_SECONDS) {
		throw new Error('Invalid checkpoint handle lifetime');
	}
	if (
		claims.sid !== args.session.sid ||
		claims.attempt !== args.session.attempt ||
		claims.condition !== args.session.condition ||
		claims.configVersion !== args.session.configVersion ||
		claims.configHash !== args.session.configHash
	) {
		throw new Error('Checkpoint handle is bound to a different session');
	}
	return claims;
}
