import { env } from '$env/dynamic/private';
import { PutObjectCommand, S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';
import { createHash } from 'node:crypto';
import {
	CheckpointStoreError,
	checkpointUnavailable,
	dequote,
	type CheckpointSnapshot
} from './checkpointStore';
import { sha256Hex } from './crypto';
import {
	CHECKPOINT_UPSTREAM_TIMEOUT_MS,
	MAX_TRANSCRIPT_UTF16_CODE_UNITS,
	MAX_TRANSCRIPT_UTF8_BYTES
} from './limits';
import type { SessionClaims } from './tokens';

// S3 checkpoint writer. One immutable object per snapshot:
//
//   v2/<configVersion>/<condition>/<sessionKey>/<createOperationId>/<sequence>.json
//
// The key is fully determined by the signed session and the request, so a
// repeated write of the same snapshot lands on the same key with the same
// bytes. That makes every PutObject idempotent and removes the "ambiguous
// create" failure class the Qualtrics writer had to guard against; a bounded
// retry is safe here. Readers pick the highest sequence per createOperationId.
//
// Credentials come from Vercel OIDC federation: the function presents its
// per-request identity token to STS and assumes a role whose only grant is
// s3:PutObject on this prefix. No access keys exist anywhere in the deployment.
// Locally, `vercel env pull` supplies a short-lived VERCEL_OIDC_TOKEN; without
// one the credential provider throws and the route answers 503.
//
// This module is deliberately logger-free (like scrubber.ts); the route logs
// the outcome. Nothing here may put an object key, which embeds the session
// key and create operation ID, into an error message.

export type S3CheckpointConfig = {
	region: string;
	roleArn: string;
	bucket: string;
};

export type CheckpointObject = {
	key: string;
	// Prefix shared by every snapshot of one create operation. It is sealed into
	// the checkpoint handle in place of the Qualtrics response ID.
	streamRef: string;
	body: Uint8Array;
	bodySha256Base64: string;
	metadata: Record<string, string>;
	checksum: string;
	charLength: number;
	byteLength: number;
};

export interface CheckpointObjectClient {
	send(command: PutObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export const S3_CHECKPOINT_MAX_ATTEMPTS = 2;
export const S3_CHECKPOINT_ROLE_SESSION_NAME = 'vegapunk-checkpoint';
const KEY_SEGMENT = /^[A-Za-z0-9._-]{1,96}$/;
const STREAM_REF_PATTERN = /^v2\/[A-Za-z0-9._/-]{1,240}$/;

export function isS3StreamRef(value: string): boolean {
	return STREAM_REF_PATTERN.test(value);
}

export function getS3CheckpointConfig(): S3CheckpointConfig {
	// App-specific names on purpose: Vercel reserves several AWS_* variables for
	// the function runtime, and the SDK must not pick up ambient credentials.
	const region = dequote(env.CHECKPOINT_AWS_REGION ?? '');
	const roleArn = dequote(env.CHECKPOINT_AWS_ROLE_ARN ?? '');
	const bucket = dequote(env.CHECKPOINT_S3_BUCKET ?? '');
	if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw checkpointUnavailable();
	if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,128}$/.test(roleArn)) throw checkpointUnavailable();
	if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw checkpointUnavailable();
	return { region, roleArn, bucket };
}

export function checkpointObject(args: {
	session: SessionClaims;
	snapshot: CheckpointSnapshot;
	nowIso?: string;
}): CheckpointObject {
	const { transcriptJson } = args.snapshot;
	const charLength = transcriptJson.length;
	const byteLength = new TextEncoder().encode(transcriptJson).byteLength;
	if (charLength > MAX_TRANSCRIPT_UTF16_CODE_UNITS || byteLength > MAX_TRANSCRIPT_UTF8_BYTES) {
		throw new CheckpointStoreError('Transcript exceeds checkpoint capacity', 413, 'transcript_too_large');
	}
	// sid and createOperationId are schema-validated UUIDs and condition is an
	// enum; configVersion is the only session claim that could carry a
	// character unsafe in an object key.
	if (!KEY_SEGMENT.test(args.session.configVersion)) {
		throw new CheckpointStoreError('Checkpoint key could not be derived', 500, 'checkpoint_key_invalid');
	}
	const checksum = sha256Hex(transcriptJson);
	const storedAtISO = args.nowIso ?? new Date().toISOString();
	// Object metadata must be ASCII; the hint is informational only.
	const reasonHint = (args.snapshot.reasonHint ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 64);
	const streamRef = `v2/${args.session.configVersion}/${args.session.condition}/${args.session.sid}/${args.snapshot.createOperationId}`;
	const key = `${streamRef}/${String(args.snapshot.snapshotSequence).padStart(6, '0')}.json`;
	const envelope = {
		schemaVersion: 2,
		storedAtISO,
		sessionKey: args.session.sid,
		createOperationId: args.snapshot.createOperationId,
		snapshotSequence: args.snapshot.snapshotSequence,
		state: args.snapshot.state,
		reasonHint,
		condition: args.session.condition,
		configVersion: args.session.configVersion,
		configHash: args.session.configHash,
		checksum,
		charLength,
		byteLength,
		// Kept as the exact string the browser sent so `checksum` verifies
		// byte-for-byte after export. Readers JSON.parse this field.
		transcriptJson
	};
	const body = new TextEncoder().encode(JSON.stringify(envelope));
	const bodySha256Base64 = createHash('sha256').update(body).digest('base64');
	const metadata: Record<string, string> = {
		schemaversion: '2',
		storedat: storedAtISO,
		sessionkey: args.session.sid,
		createoperationid: args.snapshot.createOperationId,
		snapshotsequence: String(args.snapshot.snapshotSequence),
		state: args.snapshot.state,
		condition: args.session.condition,
		configversion: args.session.configVersion,
		confighash: args.session.configHash,
		checksum,
		charlength: String(charLength),
		bytelength: String(byteLength),
		reasonhint: reasonHint
	};
	return { key, streamRef, body, bodySha256Base64, metadata, checksum, charLength, byteLength };
}

export function s3PutInput(
	config: S3CheckpointConfig,
	args: { key: string; body: Uint8Array; metadata: Record<string, string> }
): PutObjectCommandInput {
	return {
		Bucket: config.bucket,
		Key: args.key,
		Body: args.body,
		ContentLength: args.body.byteLength,
		ContentType: 'application/json; charset=utf-8',
		// S3 recomputes this on receipt and rejects a corrupted upload. The
		// bucket's default encryption (SSE-S3) applies; no encryption headers.
		ChecksumSHA256: createHash('sha256').update(args.body).digest('base64'),
		Metadata: args.metadata
	};
}

export function putObjectInput(config: S3CheckpointConfig, object: CheckpointObject): PutObjectCommandInput {
	return s3PutInput(config, { key: object.key, body: object.body, metadata: object.metadata });
}

// Standalone-demo transcript (see demoStore.ts). The demo has no browser-side
// checkpoint worker; the chat route already holds the redacted canonical
// history after each turn and records it here, one immutable object per turn,
// under the same `v2/` prefix the writer role is allowed to put to:
//
//   v2/<configVersion>/demo/<sessionKey>/<sequence>.json
//
// The body is the same envelope the Vercel Blob demo store writes, so either
// copy can be read with the same tooling.
export type DemoTranscriptObject = {
	key: string;
	body: Uint8Array;
	metadata: Record<string, string>;
};

export function demoTranscriptObject(args: {
	configVersion: string;
	sessionKey: string;
	sequence: number;
	body: string;
}): DemoTranscriptObject {
	if (!KEY_SEGMENT.test(args.configVersion) || !KEY_SEGMENT.test(args.sessionKey)) {
		throw new CheckpointStoreError('Demo transcript key could not be derived', 500, 'checkpoint_key_invalid');
	}
	if (!Number.isInteger(args.sequence) || args.sequence < 0 || args.sequence > 999_999) {
		throw new CheckpointStoreError('Demo transcript key could not be derived', 500, 'checkpoint_key_invalid');
	}
	const key = `v2/${args.configVersion}/demo/${args.sessionKey}/${String(args.sequence).padStart(6, '0')}.json`;
	return {
		key,
		body: new TextEncoder().encode(args.body),
		metadata: {
			kind: 'demo-transcript',
			schemaversion: '1',
			sessionkey: args.sessionKey,
			configversion: args.configVersion,
			sequence: String(args.sequence)
		}
	};
}

let cachedClient: { cacheKey: string; client: S3Client } | null = null;

function defaultClient(config: S3CheckpointConfig): CheckpointObjectClient {
	const cacheKey = `${config.region}\0${config.roleArn}`;
	if (!cachedClient || cachedClient.cacheKey !== cacheKey) {
		cachedClient = {
			cacheKey,
			client: new S3Client({
				region: config.region,
				credentials: awsCredentialsProvider({
					roleArn: config.roleArn,
					roleSessionName: S3_CHECKPOINT_ROLE_SESSION_NAME
				}),
				// Retry is owned by putCheckpointObject so the attempt count and
				// the upstream timeout stay observable and bounded.
				maxAttempts: 1
			})
		};
	}
	return cachedClient.client;
}

// Errors that mean the deployment is misconfigured rather than that S3 is
// having a bad moment. Never retried; the route logs them at error level.
const CONFIGURATION_ERROR_NAMES = new Set([
	'AccessDenied',
	'AccessDeniedException',
	'NoSuchBucket',
	'InvalidBucketName',
	'InvalidAccessKeyId',
	'InvalidClientTokenId',
	'InvalidIdentityToken',
	'ExpiredToken',
	'ExpiredTokenException',
	'SignatureDoesNotMatch',
	'UnrecognizedClientException',
	'CredentialsProviderError',
	'AuthorizationHeaderMalformed',
	'PermanentRedirect'
]);
const THROTTLE_ERROR_NAMES = new Set(['SlowDown', 'RequestLimitExceeded', 'TooManyRequestsException', 'Throttling']);
const NETWORK_ERROR_CODES = new Set([
	'ENOTFOUND',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'EPIPE',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET'
]);

type Classified = { error: CheckpointStoreError; retry: boolean };

// AWS error messages for configuration failures ("Not authorized to perform
// sts:AssumeRoleWithWebIdentity", "Access Denied", "The specified bucket does
// not exist") name the failing side and carry no participant content. They are
// kept, bounded, for the operator log; every other class keeps none.
function boundedUpstreamMessage(raw: unknown): string | undefined {
	const message = (raw as { message?: unknown } | null)?.message;
	if (typeof message !== 'string' || message.length === 0) return undefined;
	return message.replace(/\s+/g, ' ').slice(0, 240);
}

function classifyFailure(raw: unknown, attempt: number, timedOut: boolean): Classified {
	const error = raw as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
	const name = typeof error?.name === 'string' ? error.name : 'Error';
	const code = typeof error?.code === 'string' ? error.code : undefined;
	const status = typeof error?.$metadata?.httpStatusCode === 'number' ? error.$metadata.httpStatusCode : undefined;
	const fail = (
		message: string,
		httpStatus: number,
		errorCode: string,
		retry: boolean,
		retryAfter?: string,
		upstreamMessage?: string
	): Classified => ({
		error: new CheckpointStoreError(message, httpStatus, errorCode, false, retryAfter, attempt, name, upstreamMessage),
		retry
	});
	// A denied STS assumption or bucket write is deterministic: it stays denied
	// no matter how long the SDK spent getting there, so it is classified before
	// the timeout check and never retried.
	if (CONFIGURATION_ERROR_NAMES.has(name) || status === 403 || status === 404) {
		return fail(
			'Checkpoint service is not configured',
			503,
			'checkpoint_unavailable',
			false,
			undefined,
			boundedUpstreamMessage(raw)
		);
	}
	if (timedOut || name === 'AbortError' || name === 'TimeoutError') {
		return fail('Checkpoint write did not complete in time', 504, 'checkpoint_store_unreachable', true);
	}
	if (THROTTLE_ERROR_NAMES.has(name) || status === 429) {
		return fail('Checkpoint store is throttling writes', 429, 'checkpoint_store_throttled', true, '1');
	}
	if ((status !== undefined && status >= 500) || name === 'InternalError' || name === 'ServiceUnavailable') {
		return fail('Checkpoint object was not stored', 503, 'checkpoint_write_failed', true);
	}
	if (status === undefined && code !== undefined && NETWORK_ERROR_CODES.has(code)) {
		return fail('Checkpoint store could not be reached', 504, 'checkpoint_store_unreachable', true);
	}
	return fail('Checkpoint object was not stored', 502, 'checkpoint_write_failed', false);
}

export async function putCheckpointObject(args: {
	config: S3CheckpointConfig;
	object: CheckpointObject;
	client?: CheckpointObjectClient;
	timeoutMs?: number;
	retryDelayMs?: () => number;
}): Promise<{ attempts: number }> {
	return putS3Object({ ...args, input: putObjectInput(args.config, args.object) });
}

export async function putS3Object(args: {
	config: S3CheckpointConfig;
	input: PutObjectCommandInput;
	client?: CheckpointObjectClient;
	timeoutMs?: number;
	retryDelayMs?: () => number;
}): Promise<{ attempts: number }> {
	const client = args.client ?? defaultClient(args.config);
	const { input } = args;
	const timeoutMs = args.timeoutMs ?? CHECKPOINT_UPSTREAM_TIMEOUT_MS;
	const retryDelayMs = args.retryDelayMs ?? (() => 250 + Math.random() * 250);
	let lastFailure: Classified | null = null;
	for (let attempt = 1; attempt <= S3_CHECKPOINT_MAX_ATTEMPTS; attempt += 1) {
		if (lastFailure) {
			const delay = retryDelayMs();
			if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
		const timeout = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			timeout.abort(new Error('checkpoint_store_timeout'));
		}, timeoutMs);
		try {
			// Deliberately not coupled to the browser request's disconnect signal.
			// A pagehide/closed tab is precisely when the backup must be allowed
			// to finish server-side.
			await client.send(new PutObjectCommand(input), { abortSignal: timeout.signal });
			return { attempts: attempt };
		} catch (raw) {
			lastFailure = classifyFailure(raw, attempt, timedOut);
			if (!lastFailure.retry) throw lastFailure.error;
		} finally {
			clearTimeout(timer);
		}
	}
	throw (lastFailure as Classified).error;
}
