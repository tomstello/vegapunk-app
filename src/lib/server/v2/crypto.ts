import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';

const TEXT_ENCODER = new TextEncoder();

function base64url(input: Uint8Array | string): string {
	return Buffer.from(input).toString('base64url');
}

function decodeBase64url(input: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('Invalid base64url');
	return Buffer.from(input, 'base64url');
}

export function assertStrongSigningKey(value: string | undefined): string {
	const key = value?.trim() ?? '';
	if (TEXT_ENCODER.encode(key).byteLength < 32 || /^(change|replace|example|test)/i.test(key)) {
		throw new Error('SESSION_SIGNING_KEY must be a non-placeholder secret of at least 32 UTF-8 bytes');
	}
	return key;
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

/**
 * Derive an OpenRouter routing key that is stable for one chat but cannot be
 * joined back to the study session without the server secret. OpenRouter may
 * retain this value in generation metadata, so never send the raw Qualtrics-
 * joinable chat-session UUID as `session_id`.
 */
export function openRouterSessionId(secret: string, chatSessionKey: string): string {
	return createHmac('sha256', secret)
		.update('vegapunk:v2:openrouter-session\0')
		.update(chatSessionKey)
		.digest('base64url');
}

export function deterministicUuid(namespace: string, value: string): string {
	const bytes = createHash('sha256').update(namespace).update('\0').update(value).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function signCompactJson(
	prefix: string,
	payload: Record<string, unknown>,
	secret: string
): string {
	const encoded = base64url(JSON.stringify(payload));
	const signed = `${prefix}.${encoded}`;
	const signature = createHmac('sha256', secret).update(signed).digest();
	return `${signed}.${base64url(signature)}`;
}

export function verifyCompactJson(
	token: string,
	prefix: string,
	secret: string
): Record<string, unknown> {
	if (token.length > 8_192) throw new Error('Token is too long');
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== prefix) throw new Error('Invalid token format');
	const signed = `${parts[0]}.${parts[1]}`;
	const actual = decodeBase64url(parts[2]);
	const expected = createHmac('sha256', secret).update(signed).digest();
	if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
		throw new Error('Invalid token signature');
	}
	const decoded = decodeBase64url(parts[1]).toString('utf8');
	const parsed: unknown = JSON.parse(decoded);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Invalid token payload');
	}
	return parsed as Record<string, unknown>;
}

function opaqueKey(secret: string, purpose: string): Buffer {
	return createHash('sha256').update(`vegapunk:v2:${purpose}\0`).update(secret).digest();
}

/** AES-GCM keeps the Qualtrics response ID confidential as well as authenticated. */
export function sealOpaqueJson(
	prefix: string,
	payload: Record<string, unknown>,
	secret: string,
	purpose: string
): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', opaqueKey(secret, purpose), iv);
	cipher.setAAD(Buffer.from(prefix));
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(payload), 'utf8'),
		cipher.final()
	]);
	const tag = cipher.getAuthTag();
	return `${prefix}.${base64url(iv)}.${base64url(ciphertext)}.${base64url(tag)}`;
}

export function openOpaqueJson(
	token: string,
	prefix: string,
	secret: string,
	purpose: string
): Record<string, unknown> {
	if (token.length > 8_192) throw new Error('Handle is too long');
	const parts = token.split('.');
	if (parts.length !== 4 || parts[0] !== prefix) throw new Error('Invalid handle format');
	const iv = decodeBase64url(parts[1]);
	const ciphertext = decodeBase64url(parts[2]);
	const tag = decodeBase64url(parts[3]);
	if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error('Invalid handle');
	const decipher = createDecipheriv('aes-256-gcm', opaqueKey(secret, purpose), iv);
	decipher.setAAD(Buffer.from(prefix));
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	const parsed: unknown = JSON.parse(plaintext);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Invalid handle payload');
	}
	return parsed as Record<string, unknown>;
}
