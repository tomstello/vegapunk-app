<script lang="ts">
	import V2Chat from "$lib/v2/V2Chat.svelte";
	import type { PageData } from "./$types";

	export let data: PageData;
</script>

<svelte:head>
	<title>Vaccine Questions</title>
	<meta
		name="description"
		content="Ask general questions about flu and COVID-19 vaccines."
	/>
</svelte:head>

<V2Chat condition={data.condition} initialThemeId={data.themeId} />
