<script lang="ts">
	import { chatParams } from "$lib/chatParams";
	import { messages } from "$lib/messages";

	// Builds a plain-text copy of the visible transcript and saves it to the
	// participant's device. Purely client-side: a Blob + <a download> — no
	// network, no popups, nothing leaves the phone. [NEEDS PI SIGN-OFF]
	const downloadTranscript = () => {
		const lines = [
			`${$chatParams.appearance.headerTitle} — conversation transcript`,
			`Saved ${new Date().toLocaleString()}`,
			"",
		];
		for (const m of $messages) {
			if (m.role === "system" || m.hideInitialMessage) continue;
			lines.push((m.role === "user" ? "You: " : "Assistant: ") + m.content);
			lines.push("");
		}
		const blob = new Blob([lines.join("\n")], {
			type: "text/plain;charset=utf-8",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "vaccine-questions-transcript.txt";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
</script>

<div
	class="flex flex-col items-center gap-2 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] text-center"
>
	<p class="flex justify-center pt-2 text-lg font-bold text-pink-700">
		{$chatParams.appearance.endChatText}
	</p>
	{#if $chatParams.appearance.showDownloadButton}
		<button type="button" class="btn min-h-[44px]" on:click={downloadTranscript}>
			<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"
				><rect x="7" y="1.5" width="2" height="9" rx="1" fill="currentColor"
				></rect><path
					d="M4 7.5 L8 11.5 L12 7.5"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					fill="none"
				></path><rect
					x="2.5"
					y="13"
					width="11"
					height="2"
					rx="1"
					fill="currentColor"
				></rect></svg
			>
			Download this conversation
		</button>
		<span class="text-xs text-slate-500"
			>Saves a text copy to your device — nothing is shared.</span
		>
	{/if}
</div>
