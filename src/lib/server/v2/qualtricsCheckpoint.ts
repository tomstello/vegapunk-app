import { env } from '$env/dynamic/private';
import { sha256Hex } from './crypto';
import {
	CHECKPOINT_CHUNK_COUNT,
	CHECKPOINT_CHUNK_SIZE,
	MAX_TRANSCRIPT_UTF16_CODE_UNITS,
	MAX_TRANSCRIPT_UTF8_BYTES,
	QUALTRICS_TIMEOUT_MS
} from './limits';
import type { SessionClaims } from './tokens';

export type CheckpointSnapshot = {
	createOperationId: string;
	snapshotSequence: number;
	state: 'active' | 'interrupted' | 'completed' | 'capture_error';
	reasonHint?: string;
	transcriptJson: string;
};

export type QualtricsCheckpointConfig = {
	token: string;
	surveyId: string;
	baseUrl: string;
};

export class QualtricsCheckpointError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code: string,
		public readonly ambiguousCreate = false,
		public readonly retryAfter?: string
	) {
		super(message);
	}
}

function dequote(value: string): string {
	return value
		.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
		.trim()
		.replace(/^["'\u2018\u2019\u201C\u201D]+|["'\u2018\u2019\u201C\u201D]+$/g, '')
		.trim();
}

export function getQualtricsCheckpointConfig(): QualtricsCheckpointConfig {
	// Production may retain legacy Qualtrics credentials during the v5→v6
	// coexistence window. Require an explicit v2 enablement flag so a new v2
	// deployment cannot silently write into that older checkpoint survey.
	if (dequote(env.ENABLE_V2_CHECKPOINT ?? '') !== 'true') {
		throw new QualtricsCheckpointError('Checkpoint service is not configured', 503, 'checkpoint_unavailable');
	}
	const token = dequote(env.QUALTRICS_API_TOKEN ?? '');
	const datacenter = dequote(env.QUALTRICS_DATACENTER ?? '')
		.replace(/^https?:\/\//i, '')
		.split('/')[0]
		.split('.')[0];
	const surveyId = dequote(env.QUALTRICS_CHECKPOINT_SURVEY_ID ?? '');
	if (!token || !datacenter || !surveyId) {
		throw new QualtricsCheckpointError('Checkpoint service is not configured', 503, 'checkpoint_unavailable');
	}
	if (token.length > 512 || /[^\x21-\x7e]/.test(token)) {
		throw new QualtricsCheckpointError('Checkpoint service is not configured', 503, 'checkpoint_unavailable');
	}
	if (!/^[A-Za-z0-9-]+$/.test(datacenter) || !/^SV_[A-Za-z0-9]+$/.test(surveyId)) {
		throw new QualtricsCheckpointError('Checkpoint service is not configured', 503, 'checkpoint_unavailable');
	}
	return { token, surveyId, baseUrl: `https://${datacenter}.qualtrics.com/API/v3` };
}

function chunksAtUtf8Boundaries(value: string): { chunks: string[]; overflow: number } {
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < value.length && chunks.length < CHECKPOINT_CHUNK_COUNT) {
		const start = cursor;
		let chunkBytes = 0;
		while (cursor < value.length) {
			const codePoint = value.codePointAt(cursor);
			if (codePoint === undefined) break;
			const codePointBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
			if (chunkBytes + codePointBytes > CHECKPOINT_CHUNK_SIZE && cursor > start) break;
			chunkBytes += codePointBytes;
			cursor += codePoint > 0xffff ? 2 : 1;
		}
		chunks.push(value.slice(start, cursor));
	}
	return { chunks, overflow: value.length - cursor };
}

export function checkpointEmbeddedData(args: {
	session: SessionClaims;
	snapshot: CheckpointSnapshot;
	nowIso?: string;
}): { fields: Record<string, string>; checksum: string; charLength: number; byteLength: number } {
	const charLength = args.snapshot.transcriptJson.length;
	const byteLength = new TextEncoder().encode(args.snapshot.transcriptJson).byteLength;
	if (charLength > MAX_TRANSCRIPT_UTF16_CODE_UNITS || byteLength > MAX_TRANSCRIPT_UTF8_BYTES) {
		throw new QualtricsCheckpointError('Transcript exceeds checkpoint capacity', 413, 'transcript_too_large');
	}
	const checksum = sha256Hex(args.snapshot.transcriptJson);
	const chunked = chunksAtUtf8Boundaries(args.snapshot.transcriptJson);
	if (chunked.overflow > 0) {
		throw new QualtricsCheckpointError('Transcript exceeds checkpoint field capacity', 413, 'transcript_too_large');
	}
	const fields: Record<string, string> = {
		sessionKey: args.session.sid,
		createOperationId: args.snapshot.createOperationId,
		snapshotSequence: String(args.snapshot.snapshotSequence),
		checksum,
		schemaVersion: '2',
		state: args.snapshot.state,
		condition: args.session.condition,
		configVersion: args.session.configVersion,
		configHash: args.session.configHash,
		charLength: String(charLength),
		byteLength: String(byteLength),
		tsLast: args.nowIso ?? new Date().toISOString(),
		nChunks: String(chunked.chunks.length),
		chunkOverflow: '',
		reasonHint: (args.snapshot.reasonHint ?? '').slice(0, 64)
	};
	for (let index = 0; index < CHECKPOINT_CHUNK_COUNT; index += 1) {
		fields[`chunk${index + 1}`] = chunked.chunks[index] ?? '';
	}
	return { fields, checksum, charLength, byteLength };
}

async function qualtricsFetch(
	url: string,
	init: RequestInit,
	operation: 'create' | 'update'
): Promise<Response> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(new Error('qualtrics_timeout')), QUALTRICS_TIMEOUT_MS);
	try {
		// Deliberately do not couple this storage write to the browser request's
		// disconnect signal. A pagehide/closed tab is precisely when the backup
		// must be allowed to finish server-side.
		return await fetch(url, { ...init, signal: timeout.signal });
	} catch {
		throw new QualtricsCheckpointError(
			operation === 'create'
				? 'The initial checkpoint result is ambiguous and must not be immediately repeated'
				: 'Checkpoint update could not reach storage',
			504,
			operation === 'create' ? 'ambiguous_create' : 'checkpoint_update_unreachable',
			operation === 'create'
		);
	} finally {
		clearTimeout(timer);
	}
}

function upstreamFailure(response: Response, operation: 'create' | 'update'): QualtricsCheckpointError {
	const status = response.status === 429 ? 429 : response.status >= 500 ? 503 : 502;
	const ambiguousCreate = operation === 'create' && response.status >= 500;
	return new QualtricsCheckpointError(
		ambiguousCreate
			? 'Checkpoint may have been created before the upstream failure'
			: operation === 'create'
				? 'Checkpoint row was not created'
				: 'Checkpoint row was not updated',
		status,
		ambiguousCreate ? 'ambiguous_create' : `checkpoint_${operation}_failed`,
		ambiguousCreate,
		response.headers.get('retry-after') ?? undefined
	);
}

export async function createQualtricsCheckpoint(args: {
	config: QualtricsCheckpointConfig;
	fields: Record<string, string>;
	idempotencyKey: string;
}): Promise<string> {
	const response = await qualtricsFetch(
		`${args.config.baseUrl}/surveys/${args.config.surveyId}/responses`,
		{
			method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-token': args.config.token,
					// Qualtrics documents this header for response creation. Treat it as
					// duplicate mitigation until Cornell-tenant replay semantics and
					// retention have been verified; recovery remains authoritative.
					'idempotency-key': args.idempotencyKey
				},
			body: JSON.stringify({
				values: { ...args.fields, tsFirst: args.fields.tsLast }
			})
		},
		'create'
	);
	if (!response.ok) throw upstreamFailure(response, 'create');
	let responseId = '';
	try {
		const data = (await response.json()) as {
			result?: { responseId?: unknown; id?: unknown };
		};
		responseId = String(data?.result?.responseId ?? data?.result?.id ?? '');
	} catch {
		throw new QualtricsCheckpointError(
			'Checkpoint may have been created but its identifier was not returned',
			502,
			'ambiguous_create',
			true
		);
	}
	if (!/^R_[A-Za-z0-9]+$/.test(responseId)) {
		throw new QualtricsCheckpointError(
			'Checkpoint may have been created but its identifier was not returned',
			502,
			'ambiguous_create',
			true
		);
	}
	return responseId;
}

export async function updateQualtricsCheckpoint(args: {
	config: QualtricsCheckpointConfig;
	checkpointResponseId: string;
	fields: Record<string, string>;
}): Promise<void> {
	const response = await qualtricsFetch(
		`${args.config.baseUrl}/responses/${args.checkpointResponseId}`,
		{
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				'x-api-token': args.config.token
			},
			body: JSON.stringify({ surveyId: args.config.surveyId, embeddedData: args.fields })
		},
		'update'
	);
	if (!response.ok) throw upstreamFailure(response, 'update');
}
