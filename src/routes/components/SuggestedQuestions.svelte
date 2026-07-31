<script lang="ts">
	import { chatParams } from "$lib/chatParams";

	export let onPick: (question: string) => void;
</script>

<!-- Tappable starter questions, shown until the first user message is sent.
     Label + question wording come from the study config and are flagged for
     PI sign-off (they change what participants ask). -->
<div class="pb-1" role="group" aria-label="Examples of questions you can ask">
	<p class="text-sm text-slate-500 mb-1.5 mt-0">
		Examples of questions you can ask
	</p>
	<div class="flex flex-wrap gap-2 justify-start">
		{#each $chatParams.ui.suggestedQuestions as question}
			<button
				type="button"
				class="btn btn-sm min-h-[44px] h-auto py-2 px-4 rounded-full bg-white hover:bg-slate-100 border-slate-300 text-slate-800 font-normal normal-case text-left whitespace-normal"
				on:click={() => onPick(question)}>{question}</button
			>
		{/each}
	</div>
</div>
