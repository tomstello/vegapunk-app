<script lang="ts">
    import { chatParams } from "$lib/chatParams";
    import {
        messageDisplaySetting,
        messages,
        userInput,
    } from "$lib/messages";
    import { isLoading } from "$lib/stores";
    import DOMPurify from "isomorphic-dompurify";
    import {
        checkAtBottom,
        continueScroll,
        countMessagesAndTime,
        disableInputElement,
        getScrollElement,
        inputElementOpacity,
        isAtBottom,
        receivedParentMessage,
        scrolledUponSubmit,
        handleChatInteraction,
        postActivityPing,
        sendMessageToParent,
        timeStart,
        userSentMessage,
    } from "../utils";

    export let scrollElement: HTMLDivElement;
    export let nextSection: boolean;

    const submit = async (e: Event) => {
        if ($chatParams.study.sanitize) {
            userInput.set(DOMPurify.sanitize($userInput));
        }
        if ($userInput === "") {
            return;
        }
        e.preventDefault();
        scrolledUponSubmit.set(true); // to trigger scroll to bottom upon submit

        // determine if the user has sent at least one message and record the time
        if (!$userSentMessage) {
            userSentMessage.set(true);
            timeStart.set(new Date().getTime());
        }

        scrollElement = getScrollElement(scrollElement);
        receivedParentMessage.set(true);
        isAtBottom.set(checkAtBottom(scrollElement));
        isLoading.set(true);
        continueScroll.set(true);

        messageDisplaySetting.update((x) => {
            return { ...x, nWords: 0 };
        });

        if ($chatParams.ui.stream) {
            let messageDisplayStartTime: number = new Date().getTime();
            messageDisplaySetting.update((x) => {
                return { ...x, messageDisplayStartTime };
            });
        }

        console.log(
            `\n\nSTART: =============================\n${new Date().toISOString()}\nSend API request`,
        );
        sendMessageToParent($messages, nextSection);
        countMessagesAndTime($messages);
        handleChatInteraction(false, $userInput, scrollElement, nextSection);
        $userInput = "";

        isAtBottom.set(checkAtBottom(scrollElement));
    };

    const preventPaste = (e: Event) => {
        if ($chatParams.ui.preventPaste) {
            e.preventDefault();
        }
    };
</script>

<!-- The old "Stop" button moved to Header.svelte as "End chat" (same handler). -->
<form class="vp-inputbar" on:submit|preventDefault={submit}>
    <label class="sr-only" for="vp-question-input">Type your question</label>
    <input
        id="vp-question-input"
        class={`vp-input ${$inputElementOpacity}`}
        placeholder={$chatParams.appearance.placeHolderInputText}
        disabled={$disableInputElement}
        bind:value={$userInput}
        on:paste={preventPaste}
        on:input={postActivityPing}
    />
    {#if $isAtBottom && !$isLoading}
        <button class="vp-send" type="submit">Send</button>
    {/if}
</form>
