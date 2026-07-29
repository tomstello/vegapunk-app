<script lang="ts">
	// NEW presentational component. The "End chat" action here is byte-identical
	// to the old InputForm "Stop" handler — same store writes, same postMessage
	// flush — only relocated to the header behind a soft two-tap confirm.
	import { chatParams } from "$lib/chatParams";
	import medicalAvatar from "$lib/icons/medical2.png";
	import { messageDisplaySetting, messageInfo, messages } from "$lib/messages";
	import { isLoading } from "$lib/stores";
	import { enableSubmit, sendMessageToParent } from "../utils";

	export let nextSection: boolean;

	let confirming = false;

	const endChat = (e: Event) => {
		e.preventDefault();
		confirming = false;
		sendMessageToParent($messages, nextSection);
		isLoading.set(false);
		messageDisplaySetting.update((x) => {
			return { ...x, doneReading: true };
		});
		enableSubmit.set(false);
	};

	// same visibility rule as the old Stop button, plus hidden once the chat ended
	$: canEnd =
		$enableSubmit &&
		($messageInfo.nUserMessages >=
			$chatParams.study.allowStopAfterNUserMessages ||
			$chatParams.study.allowStopAfterNUserMessages === 0);

	$: if (!canEnd) confirming = false;
</script>

<header class="vp-header">
	{#if $chatParams.appearance.showBotAvatar}
		<span class="vp-chip vp-chip-lg"><img alt="" src={medicalAvatar} /></span>
	{/if}
	<h1 class="vp-title">{$chatParams.appearance.headerTitle}</h1>
	{#if canEnd && !confirming}
		<button
			type="button"
			class="vp-btn-quiet"
			on:click={() => (confirming = true)}>End chat</button
		>
	{/if}
</header>

{#if confirming}
	<div class="vp-confirm" role="alertdialog" aria-label="End this chat?">
		<span>End this chat? You won't be able to ask more questions.</span>
		<div class="vp-confirm-actions">
			<button
				type="button"
				class="vp-btn-keep"
				on:click={() => (confirming = false)}>Keep chatting</button
			>
			<button type="button" class="vp-btn-end" on:click={endChat}
				>End chat</button
			>
		</div>
	</div>
{/if}
