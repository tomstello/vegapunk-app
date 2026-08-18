<script lang="ts">
	import V2Chat from "$lib/v2/V2Chat.svelte";
</script>

<svelte:head>
	<title>Vaccine Questions</title>
	<meta name="description" content="Ask general questions about flu and COVID-19 vaccines." />
	<meta name="robots" content="noindex" />
</svelte:head>

<V2Chat condition="demo" initialThemeId="albertsons-v1" standaloneDemo={true} />
