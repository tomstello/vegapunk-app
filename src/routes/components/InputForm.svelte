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

    const submit = async () => {
        if ($chatParams.study.sanitize) {
            userInput.set(DOMPurify.sanitize($userInput));
        }
        if ($userInput === "") {
            return;
        }
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

    // Instance method for suggested-question chips: routes the tapped question
    // through the exact same submit pipeline as typed input.
    export const submitText = async (text: string) => {
        userInput.set(text);
        await submit();
    };

    const preventPaste = (e: Event) => {
        if ($chatParams.ui.preventPaste) {
            e.preventDefault();
        }
    };
</script>

<!-- The old "Stop" button lives in Header.svelte as "End chat" (same handler). -->
<form
    class="flex gap-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    on:submit|preventDefault={submit}
>
    <label class="sr-only" for="vp-question-input">Type your question</label>
    <input
        id="vp-question-input"
        class={`input input-bordered w-full text-base ${$inputElementOpacity}`}
        placeholder={$chatParams.appearance.placeHolderInputText}
        disabled={$disableInputElement}
        bind:value={$userInput}
        on:paste={preventPaste}
        on:input={postActivityPing}
    />
    {#if $isAtBottom && !$isLoading}
        <button class="btn" type="submit">Send</button>
    {/if}
</form>
