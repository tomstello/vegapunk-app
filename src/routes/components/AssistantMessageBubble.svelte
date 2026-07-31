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
    // animated avatar badge while an answer is pending for this bubble
    $: waiting = message.content === "" || ($isLoading && isLast);
    $: assistantClass = `prose chat-bubble max-w-[90%] ${$chatParams.appearance.showBotAvatar ? "ml-10" : "ml-0"} ${$chatParams.appearance.bubbleAssistantTextColor} ${$chatParams.appearance.bubbleAssistantBackground}`;
</script>

<div class="chat chat-start relative">
    {#if $chatParams.appearance.showBotAvatar}
        <div class="chat-image avatar indicator absolute top-2">
            {#if waiting}
                <span
                    class={`loading loading-dots loading-sm indicator-item badge badge-warning text-white mr-1 mt-2 ${$chatParams.ui.stream ? "bg-[#6766db]" : "bg-[#a9e415]"}`}
                    role="status"
                    aria-label="The assistant is answering"
                ></span>
            {/if}
            <div class="w-12 mt-2 rounded-full">
                <img alt="" src={medicalAvatar} />
            </div>
        </div>
    {/if}

    {#if message.content !== ""}
        <div class={assistantClass}>
            {@html marked(message.content)}
        </div>
    {:else}
        <div class={assistantClass}>&nbsp;</div>
    {/if}

    {#if $chatParams.study.showVoteButtons}
        {#if index < nMessages - 1 || (index === nMessages - 1 && !$isLoading)}
            <div class="chat-footer ml-14 flex gap-1 pt-1">
                <button
                    on:click|preventDefault={() => {
                        thumb = "up";
                    }}
                    aria-label="This answer was helpful"
                    aria-pressed={votedUp}
                    class={`btn btn-xs ${votedUp ? "border-2 border-sky-500" : ""} ${$chatParams.appearance.voteButtonOpacity}`}
                >
                    <img alt="" src={thumbsup} class="w-4 h-4" />
                </button>
                <button
                    on:click|preventDefault={() => {
                        thumb = "down";
                    }}
                    aria-label="This answer was not helpful"
                    aria-pressed={votedDown}
                    class={`btn btn-xs ${votedDown ? "border-2 border-sky-500" : ""} ${$chatParams.appearance.voteButtonOpacity}`}
                >
                    <img alt="" src={thumbsdown} class="w-4 h-4" />
                </button>
            </div>
        {/if}
    {/if}
</div>
