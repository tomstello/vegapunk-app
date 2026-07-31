<script lang="ts">
	import { chatParams } from "$lib/chatParams";
	import {
		messageDisplaySetting,
		messageInfo,
		messages,
	} from "$lib/messages";
	import { isLoading } from "$lib/stores";
	import { afterUpdate, onMount } from "svelte";
	import Counter from "./components/Counter.svelte";
	import Header from "./components/Header.svelte";
	import InputForm from "./components/InputForm.svelte";
	import Messages from "./components/Messages.svelte";
	import ModalApiKey from "./components/ModalAPIKey.svelte";
	import ScrollProceedNextSection from "./components/ScrollProceedNextSection.svelte";
	import ScrollToBottomButton from "./components/ScrollToBottomButton.svelte";
	import SuggestedQuestions from "./components/SuggestedQuestions.svelte";
	import {
		checkAtBottom,
		countTimeElapsed,
		enableSubmit,
		followStream,
		getUserAgentInfo,
		handleScroll,
		handleTouchMove,
		handleTouchStart,
		handleWheel,
		inFrame,
		initializeChat,
		isAtBottom,
		isInFrame,
		isLoaded,
		noAPIKeyProvided,
		postCheckpoint,
		scrolledUponSubmit,
		scrollToBottom,
		sendMessageToParent,
		sendMessageUntilReceived,
		stickToBottom,
		toggleInputElementOpacity,
	} from "./utils";

	let nextSection: boolean = false;
	let scrollElement: HTMLDivElement;
	let inputForm: InputForm;
	let nMessages = $messageInfo.nTotalMessages;

	$: if ($isLoading) toggleInputElementOpacity();

	// Suggested-question chips: shown until the participant sends anything.
	$: nUserMessagesSent = $messages.filter(
		(m) => m.role === "user" && !m.isInitial,
	).length;
	$: showChips =
		$chatParams.ui.suggestedQuestions.length > 0 &&
		nUserMessagesSent === 0 &&
		!$isLoading;

	const pickSuggestion = (question: string) => {
		inputForm?.submitText(question);
		// keep focus on the transcript (aria-live log) so the answer is
		// announced and the phone keyboard doesn't pop over the stream
		document
			.getElementById("scrollElement")
			?.focus({ preventScroll: true });
	};

	// https://learn.svelte.dev/tutorial/update
	afterUpdate(() => {
		// scroll when there are new messages
		if (scrollElement && $messageInfo.nTotalMessages > nMessages) {
			nMessages = $messageInfo.nTotalMessages;
			if ($messages.length <= $messageInfo.nInitialMessages) {
				// initial render: nudge 1px purely to fire a scroll event so
				// isAtBottom gets computed — never scroll the FAQ out of view
				scrollElement.scrollBy(0, 1);
			} else if ($followStream || checkAtBottom(scrollElement)) {
				if ($chatParams.ui.stream) {
					stickToBottom(scrollElement);
				} else {
					// non-stream: partial reveal of a full answer
					scrollElement.scrollBy(0, 150);
				}
			} else {
				// reader has scrolled up: don't yank, just re-trigger the
				// scroll evaluation so the scroll-down button can appear
				scrollElement.scrollBy(0, 1);
			}
		}

		// scroll immediately upon submitting a message
		if ($scrolledUponSubmit && scrollElement) {
			scrollToBottom(scrollElement);
			scrolledUponSubmit.set(false); // reset to false after scrolling (will be set to true again upon submitting a message)
		}
	});

	$: if (!$enableSubmit) {
		// when the send/submit button for the input field has been disabled
		nextSection = true;
		sendMessageToParent($messages, nextSection);
		scrollToBottom(scrollElement);
		console.log("ENDING CHAT.");
	}

	onMount(() => {
		console.log("APP MOUNTED: =============================");
		countTimeElapsed();

		// listener function to handle messages from parent
		function handleMessage(event: MessageEvent) {
			initializeChat(scrollElement, nextSection, event);
		}

		getUserAgentInfo();
		isAtBottom.set(true);
		inFrame.set(isInFrame(window));

		if ($inFrame) {
			window.addEventListener("message", handleMessage);
			console.log("Running as iframe and requesting data from parent...");
			sendMessageUntilReceived(window);
		} else {
			console.log("Running as a standalone app (not iframe)");
			initializeChat(scrollElement, nextSection);
		}

		// Flush the transcript to the parent when the participant leaves or the
		// phone screen locks / app is backgrounded (visibilitychange covers the
		// mobile cases pagehide misses). postMessage to the same-tab parent is
		// delivered synchronously enough to survive teardown, so any partially
		// streamed assistant text is captured too.
		function flushToParent() {
			if ($inFrame && $messages.length > 0) {
				sendMessageToParent($messages, false);
				postCheckpoint("exit_flush", true); // keepalive: survives page teardown
			}
		}
		function handleVisibilityChange() {
			if (document.visibilityState === "hidden") flushToParent();
		}
		window.addEventListener("pagehide", flushToParent);
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			window.removeEventListener("message", handleMessage);
			window.removeEventListener("pagehide", flushToParent);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	});
</script>

{#if $noAPIKeyProvided}
	<ModalApiKey />
{/if}

{#if $isLoaded}
	<main class="h-svh flex flex-col">
		<Header {nextSection} />
		{#if $chatParams.appearance.privacyNote}
			<p
				class="flex-none m-0 px-4 py-2 text-[13px] leading-snug text-slate-500 bg-slate-50 border-b border-slate-200"
			>
				{$chatParams.appearance.privacyNote}
			</p>
		{/if}
		<Counter />

		<div
			id="scrollElement"
			bind:this={scrollElement}
			on:scroll={handleScroll}
			on:wheel|passive={handleWheel}
			on:touchstart|passive={handleTouchStart}
			on:touchmove|passive={handleTouchMove}
			role="log"
			aria-live="polite"
			tabindex="-1"
			class="w-full max-w-2xl mx-auto flex-1 min-h-0 overflow-y-scroll no-scrollbar scroll-smooth px-4 pt-3 pb-1 sm:px-6"
		>
			<Messages />
		</div>

		<div
			class={`relative w-full max-w-2xl px-3 sm:px-6 mx-auto grid grid-rows-[max-content_1fr]`}
		>
			{#if !$isAtBottom && !($isLoading && $followStream)}
				<ScrollToBottomButton {scrollElement} />
			{/if}

			{#if $chatParams.appearance.showInputElement}
				{#if $enableSubmit}
					{#if showChips}
						<SuggestedQuestions onPick={pickSuggestion} />
					{/if}
					<InputForm bind:this={inputForm} {scrollElement} {nextSection} />
				{:else if !$enableSubmit && nextSection && $messageDisplaySetting.doneReading}
					<ScrollProceedNextSection />
				{/if}
			{/if}
		</div>
	</main>
{/if}
