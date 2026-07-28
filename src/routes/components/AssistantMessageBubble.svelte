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

    let assistantClass = `prose chat-bubble max-w-[90%] ${$chatParams.appearance.showBotAvatar ? "ml-10" : "ml-0"} ${$chatParams.appearance.bubbleAssistantTextColor} ${$chatParams.appearance.bubbleAssistantBackground}`;
    let thumbsUpClass = `btn btn-xs ${$chatParams.appearance.voteButtonOpacity}`;
    let thumbsDownClass = `btn btn-xs  ${$chatParams.appearance.voteButtonOpacity}`;
    let highlightClass = "border-2 border-sky-500 hover:border-sky-500";
    let thumb: string = "";

    function handleClick(thumb: string) {
        if (thumb === "up") {
            handleClickThumbsup(message);
            thumbsDownClass = thumbsDownClass.replace(highlightClass, "");
            thumbsUpClass = `${thumbsUpClass} ${highlightClass}`;
        } else if (thumb === "down") {
            handleClickThumbsdown(message);
            thumbsUpClass = thumbsUpClass.replace(highlightClass, "");
            thumbsDownClass = `${thumbsDownClass} ${highlightClass}`;
        }
    }
    $: handleClick(thumb);
</script>

<div class="chat chat-start relative">
    {#if $chatParams.appearance.showBotAvatar}
        <div class="chat-image avatar indicator absolute top-2">
            {#if ($isLoading && index === nMessages - 1) || message.content === ""}
                {#if $chatParams.ui.stream}
                    <span
                        class="loading loading-dots loading-sm indicator-item badge badge-warning text-white mr-1 mt-2 bg-[#6766db]"
                    >
                    </span>
                {:else}
                    <span
                        class="loading loading-dots loading-sm indicator-item badge badge-warning text-white mr-1 mt-2 bg-[#a9e415]"
                    >
                    </span>
                {/if}
            {/if}
            <div class="w-12 mt-2 rounded-full">
                <img alt="Assistant avatar" src={medicalAvatar} />
            </div>
        </div>
    {/if}

    {#if $chatParams.ui.stream || !$isLoading || index < nMessages - 1}
        <div class={assistantClass}>
            {@html marked(message.content)}
        </div>
    {:else if !$chatParams.ui.stream && $isLoading && index === nMessages - 1}
        <div class={`chat-bubble ml-10 text-black bg-white`}></div>
    {/if}

    {#if $chatParams.study.showVoteButtons}
        {#if index < nMessages - 1 || (index === nMessages - 1 && !$isLoading)}
            <div class="chat-footer ml-14">
                <button
                    on:click|preventDefault={() => {
                        thumb = "up";
                    }}
                    class={thumbsUpClass}
                >
                    <img class="w-5 h-5" alt="thumbsup" src={thumbsup} />
                </button>
                <button
                    on:click|preventDefault={() => {
                        thumb = "down";
                    }}
                    class={thumbsDownClass}
                >
                    <img class="w-5 h-5" alt="thumbsdown" src={thumbsdown} />
                </button>
            </div>
        {/if}
    {/if}
</div>
