import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
	);

	if (event.url.pathname.startsWith('/api/v2/')) {
		response.headers.set('Cache-Control', 'no-store, max-age=0');
	}

	if (event.url.protocol === 'https:') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}

	// Deliberately do not set X-Frame-Options: the study app must be framed by
	// the exact Qualtrics origins enforced through CSP frame-ancestors.
	return response;
};
