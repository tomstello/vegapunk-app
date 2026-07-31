<script lang="ts">
	import down from "$lib/icons/down.svg";
	import { scrollToBottom } from "../utils";

	export let scrollElement: HTMLDivElement;
</script>

<div class="toast toast-center absolute top-0 -translate-y-12 z-10 p-0">
	<button
		on:click={() => scrollToBottom(scrollElement)}
		class="btn btn-circle shadow"
		aria-label="Scroll to the newest messages"
	>
		<img src={down} alt="" class="w-7 h-7" />
	</button>
</div>
