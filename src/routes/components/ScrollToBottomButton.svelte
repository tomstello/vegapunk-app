<script lang="ts">
	import down from "$lib/icons/down.svg";
	import { scrollToBottom } from "../utils";
	export let scrollElement: HTMLDivElement;
</script>

<div class="absolute inset-x-0 top-0 -translate-y-14 flex justify-center z-10">
	<button
		on:click={() => scrollToBottom(scrollElement)}
		class="vp-pill"
		aria-label="Scroll to the newest messages"
		><img src={down} alt="" class="w-6 h-6" /></button
	>
</div>
