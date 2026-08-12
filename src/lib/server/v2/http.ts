import { z } from 'zod';

export class V2HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		public readonly retryable?: boolean
	) {
		super(message);
	}
}

export async function readJsonWithByteLimit(request: Request, maxBytes: number): Promise<unknown> {
	const contentLength = request.headers.get('content-length');
	if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
		throw new V2HttpError(413, 'payload_too_large', 'Request body is too large');
	}
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	const reader = request.body?.getReader();
	if (reader) {
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				totalBytes += result.value.byteLength;
				if (totalBytes > maxBytes) {
					await reader.cancel('payload_too_large').catch(() => undefined);
					throw new V2HttpError(413, 'payload_too_large', 'Request body is too large');
				}
				chunks.push(result.value);
			}
		} catch (error) {
			if (error instanceof V2HttpError) throw error;
			throw new V2HttpError(400, 'invalid_body', 'Request body could not be read');
		}
	}
	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new V2HttpError(400, 'invalid_utf8', 'Request body is not valid UTF-8');
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new V2HttpError(400, 'invalid_json', 'Request body is not valid JSON');
	}
}

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new V2HttpError(400, 'invalid_request', parsed.error.issues[0]?.message ?? 'Invalid request');
	}
	return parsed.data;
}

export function bearerToken(request: Request): string {
	const value = request.headers.get('authorization') ?? '';
	const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(value);
	if (!match || match[1].length > 8_192) {
		throw new V2HttpError(401, 'invalid_session', 'A valid session token is required');
	}
	return match[1];
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store, max-age=0',
			pragma: 'no-cache',
			...extraHeaders
		}
	});
}

export function errorResponse(error: unknown): Response {
	if (error instanceof V2HttpError) {
		return jsonResponse(
			{
				v: 2,
				error: {
					code: error.code,
					message: error.message,
					...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {})
				}
			},
			error.status
		);
	}
	return jsonResponse(
		{ v: 2, error: { code: 'internal_error', message: 'The service could not complete the request.' } },
		500
	);
}
