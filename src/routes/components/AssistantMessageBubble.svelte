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

    // Mobile: the answer spans the full width with the avatar in flow above it
    // (a side avatar column would squeeze the text — the part that matters).
    // Desktop (sm+): classic side-by-side bubble with the floating avatar.
    $: assistantClass = `prose chat-bubble max-w-none sm:max-w-[90%] ml-0 ${$chatParams.appearance.showBotAvatar ? "sm:ml-10" : ""} ${$chatParams.appearance.bubbleAssistantTextColor} ${$chatParams.appearance.bubbleAssistantBackground}`;
</script>

{#if $chatParams.appearance.showBotAvatar}
    <div class="avatar mt-2 sm:hidden">
        <div class="w-8 rounded-full">
            <img alt="" src={medicalAvatar} />
        </div>
    </div>
{/if}

<div class="chat chat-start relative">
    {#if $chatParams.appearance.showBotAvatar}
        <div class="chat-image avatar absolute top-2 hidden sm:block">
            <div class="w-10 mt-2 rounded-full">
                <img alt="" src={medicalAvatar} />
            </div>
        </div>
    {/if}

    {#if message.content !== ""}
        <div class={assistantClass}>
            {@html marked(message.content)}
        </div>
    {:else}
        <!-- Empty placeholder message (non-stream / online-search wait):
             quiet three-dot pulse where the answer will appear. -->
        <div class={assistantClass}>
            <div
                class="chat-typing"
                role="status"
                aria-label="The assistant is answering"
            >
                <span></span><span></span><span></span>
            </div>
        </div>
    {/if}

    {#if $chatParams.study.showVoteButtons}
        {#if index < nMessages - 1 || (index === nMessages - 1 && !$isLoading)}
            <div class="chat-footer ml-0 sm:ml-14 flex gap-1 pt-1">
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
