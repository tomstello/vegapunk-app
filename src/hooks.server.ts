import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { logger } from '$lib/logger';
import { instanceHeaderValue, loadtestPolicy } from '$lib/server/v2/loadtestStub';

// Logged once per function instance so a stubbed deployment is unmistakable
// in Vercel logs, and a refused stub (env drift on a non-loadtest host) is
// loud rather than silent.
let loadtestPolicyLogged = false;
function logLoadtestPolicyOnce(): void {
	if (loadtestPolicyLogged) return;
	loadtestPolicyLogged = true;
	const policy = loadtestPolicy();
	if (policy.refused) {
		logger.error(
			{
				event: 'loadtest_stub_refused',
				nodeEnv: env.NODE_ENV,
				vercelProjectProductionUrl: env.VERCEL_PROJECT_PRODUCTION_URL
			},
			'loadtest: PROVIDER_STUB/LOADTEST_INSTANCE_HEADER set on a non-loadtest host; ignored'
		);
	} else if (policy.stub) {
		logger.warn(
			{ event: 'loadtest_stub_active', ...policy.settings },
			'loadtest: provider calls are answered by the in-process stub'
		);
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	logLoadtestPolicyOnce();
	const response = await resolve(event);
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
	);

	// Load-test instrumentation only; absent unless the loadtest policy allows it.
	if (loadtestPolicy().instanceHeader) {
		response.headers.set('x-loadtest-instance', instanceHeaderValue());
	}

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
