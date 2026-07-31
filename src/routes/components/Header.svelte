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

<header
	class="flex items-center gap-3 h-14 px-4 flex-none bg-white border-b border-slate-200"
>
	{#if $chatParams.appearance.showBotAvatar}
		<img alt="" src={medicalAvatar} class="w-8 h-8 rounded-full" />
	{/if}
	<h1 class="flex-1 min-w-0 truncate m-0 text-base font-bold text-slate-900">
		{$chatParams.appearance.headerTitle}
	</h1>
	{#if canEnd && !confirming}
		<button
			type="button"
			class="btn btn-ghost btn-sm min-h-[44px] font-medium text-slate-600"
			on:click={() => (confirming = true)}>End chat</button
		>
	{/if}
</header>

{#if confirming}
	<div
		class="flex flex-wrap items-center gap-2 px-4 py-2 text-sm bg-slate-100 border-b border-slate-200"
		role="alertdialog"
		aria-label="End this chat?"
	>
		<span>End this chat? You won't be able to ask more questions.</span>
		<div class="flex gap-2 ml-auto">
			<button
				type="button"
				class="btn btn-sm min-h-[44px] bg-white"
				on:click={() => (confirming = false)}>Keep chatting</button
			>
			<button
				type="button"
				class="btn btn-sm min-h-[44px] bg-red-800 hover:bg-red-900 text-white border-none"
				on:click={endChat}>End chat</button
			>
		</div>
	</div>
{/if}
