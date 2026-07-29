<script lang="ts">
	import type { ChatMessageType } from "$lib/chatParams";
	import { chatParams } from "$lib/chatParams";
	export let message: ChatMessageType;
</script>

<!-- Leaflet entry: the participant's message renders as the entry HEADING
     (their own words), and the assistant's answer flows beneath it.
     Same component, same DOM order — restyling only. Runtime bubbleUser*
     classes still pass through onto the heading text. -->
<div class="vp-entry">
	<div class="vp-entry-kicker">YOUR QUESTION</div>
	<div
		class={`vp-entry-q ${$chatParams.appearance.bubbleUserBackground} ${$chatParams.appearance.bubbleUserTextColor}`}
	>
		{@html message.content}
	</div>
</div>
