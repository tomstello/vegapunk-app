import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { CONDITIONS, type StudyCondition } from "$lib/v2/types";

export const load: PageLoad = ({ params }) => {
	if (!CONDITIONS.includes(params.condition as StudyCondition)) {
		throw error(404, "Study route not found");
	}
	return {
		condition: params.condition as StudyCondition,
		// Fixed by this application route, never accepted from a query parameter or
		// parent message. The signed session config must return the same theme.
		themeId: "albertsons-v1" as const,
	};
};
