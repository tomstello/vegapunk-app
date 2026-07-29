<script lang="ts">
	import { isLoading } from "$lib/stores";
	import { scrollToBottom } from "../utils";

	export let scrollElement: HTMLDivElement;

	// While an answer is still streaming in, the control doubles as a status:
	// "Answer continues" tells the participant nothing is stuck and there is
	// more text below. Once the answer is complete it reverts to a plain jump.
	$: label = $isLoading ? "Answer continues" : "Jump to latest";
</script>

<!-- Fade scrim: visual "text continues below" cue, independent of the pill. -->
<div class="vp-scrim" aria-hidden="true"></div>

<div class="absolute inset-x-0 top-0 -translate-y-14 flex justify-center z-10">
	<button
		on:click={() => scrollToBottom(scrollElement)}
		class="vp-jump"
		aria-label={$isLoading
			? "The answer is still arriving — scroll to the newest text"
			: "Scroll to the newest messages"}
	>
		{#if $isLoading}
			<span class="vp-jump-dots" aria-hidden="true"><i></i><i></i><i></i></span>
		{:else}
			<svg
				width="15"
				height="15"
				viewBox="0 0 16 16"
				aria-hidden="true"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"><path d="M8 2.5 v10 M3.5 8.5 L8 13 L12.5 8.5" /></svg
			>
		{/if}
		{label}
	</button>
</div>
