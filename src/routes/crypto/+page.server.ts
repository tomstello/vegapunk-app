import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	if (env.ENABLE_LEGACY_V1 !== 'true') {
		error(410, 'The legacy credential-encryption tool has been retired.');
	}
	return {};
};
