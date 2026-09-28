// import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import adapter from '@sveltejs/adapter-vercel';
import { parseQualtricsParentOrigins } from './src/lib/qualtricsOrigins.js';

const configuredQualtricsParentOrigins = parseQualtricsParentOrigins(
	process.env.PUBLIC_QUALTRICS_PARENT_ORIGINS ?? ''
);
if (process.env.NODE_ENV === 'production' && configuredQualtricsParentOrigins.length === 0) {
	throw new Error(
		'PUBLIC_QUALTRICS_PARENT_ORIGINS is required for production builds; supply every exact Qualtrics survey origin'
	);
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// adapter-auto only supports some environments, see https://kit.svelte.dev/docs/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://kit.svelte.dev/docs/adapters for more information about adapters.
		// https://vercel.com/docs/functions/configuring-functions/duration
		adapter: adapter({ maxDuration: 300, runtime: 'nodejs22.x', regions: ['iad1'] }),
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'connect-src': ['self'],
				'img-src': ['self', 'data:'],
				'font-src': ['self'],
				'style-src': ['self'],
				// Legacy components still contain fixed inline layout styles. Model
				// output is independently sanitized and cannot supply style attributes.
				'style-src-attr': ['unsafe-inline'],
				'frame-src': ['none'],
				'media-src': ['none'],
				'object-src': ['none'],
				'base-uri': ['none'],
				'form-action': ['none'],
				'frame-ancestors': ['self', ...configuredQualtricsParentOrigins]
			}
		}
	}
};

export default config;
