<script lang="ts">
    import type { ChatMessageType } from "$lib/chatParams";
    import { chatParams } from "$lib/chatParams";
    import medicalAvatar from "$lib/icons/medical2.png";
    import thumbsdown from "$lib/icons/thumbsdown.svg";
    import thumbsup from "$lib/icons/thumbsup.svg";
    import { isLoading } from "$lib/stores";
    import { marked } from "marked";

    export let message: ChatMessageType;
    export let index: number;
    export let handleClickThumbsup: (message: any) => void;
    export let handleClickThumbsdown: (message: any) => void;
    export let nMessages: number;

    let thumb: string = "";
    let votedUp = false;
    let votedDown = false;

    function handleClick(t: string) {
        if (t === "up") {
            handleClickThumbsup(message);
            votedUp = true;
            votedDown = false;
        } else if (t === "down") {
            handleClickThumbsdown(message);
            votedDown = true;
            votedUp = false;
        }
    }
    $: handleClick(thumb);

    $: isLast = index === nMessages - 1;
    // dots before the first token arrives (streaming), and for the whole wait
    // when not streaming (the empty placeholder message added by Messages.svelte)
    $: waiting =
        message.content === "" ||
        (!$chatParams.ui.stream && $isLoading && isLast);
    // caret at the end of the growing text while streaming
    $: streaming =
        $chatParams.ui.stream && $isLoading && isLast && message.content !== "";
    $: bodyClass = `vp-md ${message.isInitial ? "vp-md-initial" : ""} ${streaming ? "vp-streaming" : ""} ${$chatParams.appearance.bubbleAssistantTextColor} ${$chatParams.appearance.bubbleAssistantBackground}`;
</script>

<div class="vp-msg vp-msg-assistant">
    {#if $chatParams.appearance.showBotAvatar}
        <div class="vp-label">
            <span class="vp-chip"><img alt="" src={medicalAvatar} /></span>
            <span class="vp-label-text">Assistant</span>
        </div>
    {/if}

    {#if waiting}
        <div class="vp-typing" role="status" aria-label="The assistant is answering">
            <span></span><span></span><span></span>
            <em>Answering…</em>
        </div>
    {:else}
        <div class={bodyClass}>
            {@html marked(message.content)}
        </div>
    {/if}

    {#if $chatParams.study.showVoteButtons}
        {#if index < nMessages - 1 || (index === nMessages - 1 && !$isLoading)}
            <div class="vp-votes">
                <button
                    on:click|preventDefault={() => {
                        thumb = "up";
                    }}
                    aria-label="This answer was helpful"
                    aria-pressed={votedUp}
                    class={`vp-vote ${votedUp ? "vp-vote-active" : ""} ${$chatParams.appearance.voteButtonOpacity}`}
                >
                    <img alt="" src={thumbsup} />
                </button>
                <button
                    on:click|preventDefault={() => {
                        thumb = "down";
                    }}
                    aria-label="This answer was not helpful"
                    aria-pressed={votedDown}
                    class={`vp-vote ${votedDown ? "vp-vote-active" : ""} ${$chatParams.appearance.voteButtonOpacity}`}
                >
                    <img alt="" src={thumbsdown} />
                </button>
            </div>
        {/if}
    {/if}
</div>
