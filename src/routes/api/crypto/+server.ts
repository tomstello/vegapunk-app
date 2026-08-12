import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import type { RequestHandler } from './$types';
import { encrypt } from './utils';

export const POST: RequestHandler = (async ({ request }): Promise<Response> => {
	if (env.ENABLE_LEGACY_V1 !== 'true') {
		return new Response(JSON.stringify({ error: 'legacy_crypto_retired' }), {
			status: 410,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}
	try {
		if (!env.ENCRYPTION_KEY || !env.ENCRYPTION_IV) {
			return new Response('Legacy encryption is not configured', { status: 503 });
		}
		const response = await request.json();
		const { text } = response;
		const ciphertext = encrypt(env.ENCRYPTION_KEY, env.ENCRYPTION_IV, text);
		return new Response(JSON.stringify({
			ciphertext
		}), { status: 200, headers: { 'Content-Type': 'application/json' } });
	} catch (error) {
		logger.error(error, "Error handling request for /api/crypto");
		return new Response("Internal Server Error", { status: 500 });
	}

}) satisfies RequestHandler;
