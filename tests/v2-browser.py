"""Clean-browser protocol-v2 regression suite.

Prerequisites: Python Playwright with Chromium and a local app server. Override
the default URL with V2_TEST_BASE_URL when the server is not on port 5173.
"""

import asyncio
import hashlib
import json
import os
import sys
import uuid

from playwright.async_api import async_playwright


BASE = os.environ.get("V2_TEST_BASE_URL", "http://127.0.0.1:5173").rstrip("/")
HASH = "a" * 64
TOKEN = "session-token-for-browser-test-1234567890"
HISTORY = "history-tag-for-browser-test-1234567890"


def sse(events):
    return "".join(
        f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events
    )


async def install_api_routes(
    page,
    *,
    chat_mode="success",
    checkpoint_mode="normal",
    suggested_questions=(),
    session_requests=None,
    config_state=None,
):
    chat_requests = []
    checkpoint_requests = []

    async def session_route(route):
        request = json.loads(route.request.post_data or "{}")
        if session_requests is not None:
            session_requests.append(request)
        condition = route.request.url.rsplit("/", 1)[-1]
        requested = request.get("resumeConfig") or {}
        selected_hash = HASH
        if config_state is not None:
            requested_hash = requested.get("configHash")
            retained = config_state.get("retainedHashes", set())
            selected_hash = (
                requested_hash
                if requested_hash in retained
                else config_state["activeHash"]
            )
        opening = (
            "<details open><summary>Vaccine FAQ</summary>Safe text"
            "<script>window.__v2xss = true</script>"
            "<img src=x onerror=\"window.__v2xss = true\">"
            "<iframe srcdoc=\"<script>window.__v2xss=true</script>\"></iframe>"
            "<a href=\"javascript:window.__v2xss=true\">unsafe link</a> "
            "<a href=\"https://example.org/facts\" onclick=\"window.__v2xss=true\">safe link</a>"
            "</details>"
        )
        response = {
            "v": 2,
            "sessionToken": TOKEN,
            "sessionKey": request["chatSessionKey"],
            "condition": condition,
            "configVersion": requested.get("configVersion", f"albertsons-2026-{condition}-v9"),
            "configHash": selected_hash,
            "initialMessages": [
                {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "role": "assistant",
                    "content": opening,
                }
            ],
            "ui": {
                "themeId": "albertsons-v1",
                "headerTitle": "Flu vaccine information" if condition == "flu" else "COVID-19 vaccine information" if condition == "covid" else "Flu & COVID-19 vaccine information",
                "headerSubtitle": "Ask a question or browse common topics",
                "privacyNote": "For your privacy, don\u2019t share identifying details. This AI tool can make mistakes; ask a doctor or pharmacist about personal health concerns.",
                "placeholderInputText": "Write your vaccine question",
                "suggestedQuestions": list(suggested_questions),
                "endChatText": "End chat",
                "maxUserMessages": 35,
                "appointmentCta": {
                    "label": "Schedule a vaccine appointment",
                    "url": "https://www.albertsons.com/health/appointments/home",
                },
            },
            "historyTag": HISTORY,
        }
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(response))

    async def chat_route(route):
        request = json.loads(route.request.post_data or "{}")
        chat_requests.append(request)
        sequence = request["sequence"]
        turn_id = request["turn"]["id"]
        # The v7 server always returns the canonical (redacted) turn text in
        # meta; a clean-text scrub is the identity, so the mock echoes the
        # request. This exercises the client adoption path in every test.
        meta_event = (
            "meta",
            {"v": 2, "sequence": sequence, "scrubbedUserMessage": request["turn"]["userMessage"]},
        )
        if chat_mode == "eof":
            events = [
                meta_event,
                ("delta", {"v": 2, "text": "A partial answer."}),
            ]
        else:
            events = [
                meta_event,
                ("delta", {"v": 2, "text": "A complete **answer**."}),
                (
                    "done",
                    {
                        "v": 2,
                        "sequence": sequence,
                        "historyTag": f"{HISTORY}-{sequence}",
                        "assistantMessageId": str(uuid.uuid5(uuid.NAMESPACE_URL, turn_id)),
                        "finishReason": "stop",
                        "completionStatus": "complete",
                    },
                ),
            ]
        await route.fulfill(
            status=200,
            headers={"content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store"},
            body=sse(events),
        )

    async def checkpoint_route(route):
        request = json.loads(route.request.post_data or "{}")
        checkpoint_requests.append(request)
        call_number = len(checkpoint_requests)
        if checkpoint_mode in {"delayed_success", "delayed_failure"} and call_number == 1:
            await asyncio.sleep(0.45)
        if checkpoint_mode == "delayed_failure" and call_number == 1:
            await route.fulfill(
                status=429,
                content_type="application/json",
                body='{"v":2,"error":{"code":"checkpoint_rate_limited","ambiguousCreate":false}}',
            )
            return
        response = {
            "v": 2,
            "checkpointHandle": "signed-checkpoint-handle-for-browser-test-1234567890",
            "acknowledgedSequence": request["snapshotSequence"],
            "checksum": hashlib.sha256(request["transcriptJson"].encode("utf-8")).hexdigest(),
        }
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(response))

    await page.route("**/api/v2/session/*", session_route)
    await page.route("**/api/v2/chat", chat_route)
    await page.route("**/api/v2/checkpoint", checkpoint_route)
    return chat_requests, checkpoint_requests


async def wait_count(items, minimum, timeout=5):
    deadline = asyncio.get_running_loop().time() + timeout
    while len(items) < minimum and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert len(items) >= minimum, f"expected at least {minimum} requests, got {len(items)}"


async def wait_for_check(check, *, timeout=5, description="condition"):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if await check():
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"timed out waiting for {description}")


async def wait_for_focus(locator, timeout=5):
    await wait_for_check(
        lambda: locator.evaluate("node => document.activeElement === node"),
        timeout=timeout,
        description="expected keyboard focus",
    )


async def test_sanitizer_reload_and_terminal(browser):
    page = await browser.new_page(viewport={"width": 390, "height": 844})
    _, checkpoints = await install_api_routes(page)
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("message-list").wait_for()
    cta = page.get_by_test_id("appointment-cta")
    assert await cta.count() == 1
    assert await cta.get_attribute("href") == "https://www.albertsons.com/health/appointments/home"
    assert await cta.get_attribute("target") == "_blank"
    assert await page.locator("details").count() == 1
    assert await page.locator("summary").inner_text() == "Vaccine FAQ"
    initial_content = page.get_by_test_id("assistant-content").first
    assert await initial_content.locator("script, img, iframe").count() == 0
    assert not await page.evaluate("Boolean(window.__v2xss)")
    unsafe = page.get_by_text("unsafe link", exact=True)
    safe = page.get_by_text("safe link", exact=True)
    assert await unsafe.get_attribute("href") is None
    assert await safe.get_attribute("href") == "https://example.org/facts"
    assert await safe.get_attribute("target") == "_blank"
    assert set((await safe.get_attribute("rel") or "").split()) == {"noopener", "noreferrer"}

    # A very large Unicode paste is clipped before it can exhaust sessionStorage.
    oversized_draft = "a" * 750 + "🧪" * 751
    question_input = page.get_by_test_id("question-input")
    await question_input.fill(oversized_draft)
    clipped_draft = await question_input.input_value()
    assert len(clipped_draft) == 1500
    assert clipped_draft == "a" * 750 + "🧪" * 750
    await asyncio.sleep(0.35)
    stored_draft = await page.evaluate(
        """
        () => {
          const key = Object.keys(sessionStorage).find((k) => k.startsWith('vegapunk:v2:') && !k.includes(':active:'));
          return JSON.parse(sessionStorage.getItem(key)).draft;
        }
        """
    )
    assert stored_draft == clipped_draft
    await page.reload(wait_until="networkidle")
    await page.get_by_test_id("message-list").wait_for()
    assert await page.get_by_test_id("question-input").input_value() == clipped_draft

    await page.get_by_test_id("question-input").fill("Is this a test question?")
    await page.get_by_test_id("send-question").click()
    await page.get_by_text("A complete answer.").wait_for()
    await wait_count(checkpoints, 1)
    before_count = await page.get_by_text("Is this a test question?").count()
    assert before_count == 1
    storage_values = await page.evaluate("Object.values(sessionStorage)")
    assert TOKEN not in json.dumps(storage_values)

    await page.reload(wait_until="networkidle")
    await page.get_by_test_id("message-list").wait_for()
    assert await page.get_by_text("Is this a test question?").count() == 1
    assert await page.get_by_text("A complete answer.").count() == 1

    # Reproduce a clean full-page reload from a state captured mid-stream.
    await page.evaluate(
        """
        () => {
          const key = Object.keys(sessionStorage).find((k) => k.startsWith('vegapunk:v2:') && !k.includes(':active:'));
          const state = JSON.parse(sessionStorage.getItem(key));
          const turnId = '22222222-2222-4222-8222-222222222222';
          state.messages.push({id: turnId, turnId, role: 'user', content: 'Reload question', createdAtISO: new Date().toISOString(), isInitial: false, completionStatus: 'complete', excludedFromModel: false});
          state.messages.push({id: '33333333-3333-4333-8333-333333333333', turnId, role: 'assistant', content: 'Partial before reload', createdAtISO: new Date().toISOString(), isInitial: false, completionStatus: 'streaming', excludedFromModel: true});
          state.lifecycle = 'streaming';
          state.updatedAtISO = new Date().toISOString();
          sessionStorage.setItem(key, JSON.stringify(state));
          const originalSetItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function(storageKey, value) {
            if (this === sessionStorage && storageKey === key) return;
            return originalSetItem.call(this, storageKey, value);
          };
        }
        """
    )
    await page.reload(wait_until="networkidle")
    await page.get_by_test_id("incomplete-indicator").wait_for()
    assert await page.get_by_text("Partial before reload").count() == 1

    await page.get_by_test_id("end-chat").click()
    await page.get_by_test_id("confirm-end").click()
    await page.get_by_text("Chat finished").wait_for()
    await page.reload(wait_until="networkidle")
    await page.get_by_text("Chat finished").wait_for()
    assert await page.get_by_test_id("question-input").count() == 0
    await page.close()


async def test_retry_cap_and_sequence(browser):
    page = await browser.new_page(viewport={"width": 375, "height": 667})
    chats, _ = await install_api_routes(page, chat_mode="eof")
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("question-input").fill("Question that will fail")
    await page.get_by_test_id("send-question").click()
    await page.get_by_test_id("retry-answer").wait_for()
    for expected in (2, 3):
        await page.get_by_test_id("retry-answer").click()
        await wait_count(chats, expected)
        await page.get_by_test_id("incomplete-indicator").last.wait_for()
    assert await page.get_by_test_id("retry-answer").is_disabled()
    assert len(chats) == 3
    assert len({request["turn"]["id"] for request in chats}) == 1
    assert {request["sequence"] for request in chats} == {1}
    assert {len(request["history"]) for request in chats} == {0}
    await page.get_by_test_id("skip-answer").click()
    assert await page.get_by_test_id("question-input").is_enabled()
    stored = await page.evaluate(
        """
        () => {
          const key = Object.keys(sessionStorage).find((k) => k.startsWith('vegapunk:v2:') && !k.includes(':active:'));
          return JSON.parse(sessionStorage.getItem(key));
        }
        """
    )
    assert len(stored["messages"]) == 5
    assert len(stored["messages"]) <= 200
    await page.close()


async def test_checkpoint_queue(browser, mode):
    page = await browser.new_page()
    _, checkpoints = await install_api_routes(page, checkpoint_mode=mode)
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("question-input").fill(f"Checkpoint {mode}")
    await page.get_by_test_id("send-question").click()
    await page.get_by_text("A complete answer.").wait_for()
    if mode == "delayed_success":
        await wait_count(checkpoints, 2)
        assert "checkpointHandle" not in checkpoints[0]
        assert checkpoints[1]["checkpointHandle"].startswith("signed-checkpoint")
    else:
        await asyncio.sleep(0.8)
        assert len(checkpoints) == 1, "failed create immediately retried or drained stale pending work"
        # The failed request discarded the answer snapshot that arrived while
        # it was in flight. A later genuine lifecycle event must re-enqueue the
        # latest cumulative transcript; it is not an immediate retry callback.
        await page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        await wait_count(checkpoints, 2)
        assert checkpoints[1]["createOperationId"] == checkpoints[0]["createOperationId"]
        recovered = json.loads(checkpoints[1]["transcriptJson"])
        assert any(
            message.get("role") == "assistant" and message.get("content") == "A complete **answer**."
            for message in recovered["messages"]
        )
    await page.close()


async def test_parent_persist_is_nonterminal_and_reason_survives_reload(browser):
    page = await browser.new_page()
    await install_api_routes(page)
    session_key = "44444444-4444-4444-8444-444444444444"
    attempt_nonce = "55555555-5555-4555-8555-555555555555"
    protocol_nonce = "66666666-6666-4666-8666-666666666666"
    harness = f"""<!doctype html><html><body>
      <iframe id='chat' sandbox='allow-scripts allow-same-origin' src='{BASE}/study/albertsons-2026/flu'></iframe>
      <script>
        window.received = [];
        window.parentSequence = 0;
        window.lastTerminalReason = null;
        window.addEventListener('message', (event) => {{
          const data = event.data || {{}};
          window.received.push(data);
          if (data.type === 'vegapunk:hello') {{
            const init = {{v:2,type:'qualtrics:init',condition:'flu',helloNonce:data.helloNonce,
              nonce:'{protocol_nonce}',sessionKey:'{session_key}',attemptNonce:'{attempt_nonce}',
              expectedConfigVersion:'albertsons-2026-flu-v9',parentOrigin:location.origin,sequence:0}};
            if (window.lastTerminalReason) init.terminalReason = window.lastTerminalReason;
            event.source.postMessage(init, location.origin);
          }}
          if (data.type === 'vegapunk:end') window.lastTerminalReason = data.reason;
        }});
        window.sendCommand = (type, reason) => {{
          const frame = document.getElementById('chat');
          frame.contentWindow.postMessage({{v:2,type,condition:'flu',sessionKey:'{session_key}',
            nonce:'{protocol_nonce}',sequence:++window.parentSequence,reason}}, location.origin);
        }};
      </script></body></html>"""

    async def harness_route(route):
        await route.fulfill(status=200, content_type="text/html", body=harness)

    await page.route("**/parent-harness", harness_route)
    await page.goto(f"{BASE}/parent-harness")
    await page.wait_for_function("window.received.some((m) => m.type === 'vegapunk:ready')")
    await page.evaluate("window.sendCommand('qualtrics:persist', 'visibility_hidden')")
    await page.wait_for_function("window.received.some((m) => m.type === 'vegapunk:snapshot' && m.reason === 'visibility_hidden')")
    assert not await page.evaluate("window.received.some((m) => m.type === 'vegapunk:end')")

    await page.evaluate("window.sendCommand('qualtrics:flush', 'inactivity')")
    await page.wait_for_function("window.received.some((m) => m.type === 'vegapunk:end' && m.reason === 'inactivity')")
    await page.evaluate("document.getElementById('chat').contentWindow.location.reload()")
    await page.wait_for_function("window.received.filter((m) => m.type === 'vegapunk:end' && m.reason === 'inactivity').length >= 2")
    assert not await page.evaluate("window.received.some((m) => m.type === 'vegapunk:end' && m.reason === 'completed')")
    await page.close()


async def test_mobile_presentation_and_keyboard(browser):
    page = await browser.new_page(viewport={"width": 320, "height": 568})
    chats, _ = await install_api_routes(
        page,
        suggested_questions=(
            "What are the side effects of the flu shot?",
            "Do I really need a flu shot every year?",
        ),
    )
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("message-list").wait_for()

    assert await page.locator("main.v2-shell").get_attribute("data-vp-theme") == "albertsons-v1"
    assert await page.get_by_role("heading", name="Flu vaccine information").count() == 1
    assert await page.get_by_text("Ask a question or browse common topics", exact=True).count() == 1

    for avatar_test_id in ("header-avatar", "assistant-avatar"):
        avatar = page.get_by_test_id(avatar_test_id).first
        assert await avatar.is_visible()
        assert await avatar.evaluate("node => node.complete && node.naturalWidth > 0")
    assert await page.get_by_text("Vaccine information assistant", exact=True).count() == 0

    chip_layout = await page.get_by_test_id("suggested-questions").evaluate(
        """
        group => {
          const bounds = group.getBoundingClientRect();
          const buttons = [...group.querySelectorAll('button')].map((button) => {
            const box = button.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
          });
          return {
            left: bounds.left,
            right: bounds.right,
            buttons,
            scrollWidth: group.scrollWidth,
            clientWidth: group.clientWidth,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
          };
        }
        """
    )
    assert len(chip_layout["buttons"]) == 2
    for chip in chip_layout["buttons"]:
        assert chip["left"] >= chip_layout["left"] - 1
        assert chip["right"] <= chip_layout["right"] + 1
    assert chip_layout["buttons"][1]["top"] > chip_layout["buttons"][0]["top"]
    assert chip_layout["scrollWidth"] <= chip_layout["clientWidth"] + 1
    assert chip_layout["documentWidth"] <= chip_layout["viewportWidth"] + 1

    question_input = page.get_by_test_id("question-input")
    assert await page.get_by_test_id("question-limit").count() == 0

    await question_input.fill("Line one")
    await question_input.press("Shift+Enter")
    assert await question_input.input_value() == "Line one\n"
    assert len(chats) == 0
    assert await page.locator(".user-message").count() == 0

    await question_input.fill("Composing")
    composition_result = await question_input.evaluate(
        """
        input => {
          const event = new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
            isComposing: true,
          });
          return { notCanceled: input.dispatchEvent(event), isComposing: event.isComposing };
        }
        """
    )
    assert composition_result == {"notCanceled": True, "isComposing": True}
    assert await question_input.input_value() == "Composing"
    assert len(chats) == 0

    safari_result = await question_input.evaluate(
        """
        input => {
          const event = new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
          });
          Object.defineProperty(event, 'keyCode', { value: 229 });
          return { notCanceled: input.dispatchEvent(event), keyCode: event.keyCode };
        }
        """
    )
    assert safari_result == {"notCanceled": True, "keyCode": 229}
    assert len(chats) == 0

    await question_input.fill("x" * 1300)
    await page.get_by_test_id("question-limit").wait_for()
    assert (await page.get_by_test_id("question-limit").inner_text()).startswith("1,300 /")
    await question_input.fill("")
    assert await page.get_by_test_id("question-limit").count() == 0

    await question_input.fill("Keyboard submit")
    await question_input.press("Enter")
    await wait_count(chats, 1)
    assert chats[0]["turn"]["userMessage"] == "Keyboard submit"
    assert await question_input.input_value() == ""
    assert await page.get_by_text("Keyboard submit", exact=True).count() == 1
    await page.close()


async def test_inline_end_confirmation_focus(browser):
    page = await browser.new_page(viewport={"width": 320, "height": 568})
    await install_api_routes(page)
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    end_button = page.get_by_test_id("end-chat")
    await end_button.click()
    confirmation = page.get_by_test_id("end-confirmation")
    await confirmation.wait_for()
    assert await confirmation.get_attribute("role") == "alertdialog"
    assert not await confirmation.evaluate(
        """
        node => {
          for (let current = node; current; current = current.parentElement) {
            if (getComputedStyle(current).position === 'fixed') return true;
          }
          return false;
        }
        """
    )
    keep_button = page.get_by_test_id("keep-chatting")
    await wait_for_focus(keep_button)
    await keep_button.press("Escape")
    assert await confirmation.count() == 0
    await wait_for_focus(end_button)

    await end_button.click()
    await keep_button.click()
    assert await confirmation.count() == 0
    await wait_for_focus(end_button)
    assert await page.get_by_test_id("question-input").is_enabled()
    await page.close()


async def install_controlled_chat_stream(page, *, auto_meta=True):
    script = """
        (() => {
          const nativeFetch = window.fetch.bind(window);
          const encoder = new TextEncoder();
          const eventText = (name, data) =>
            `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
          window.fetch = async (input, init = {}) => {
            const url = new URL(typeof input === 'string' ? input : input.url, location.href);
            if (url.pathname !== '/api/v2/chat') return nativeFetch(input, init);
            const request = JSON.parse(init.body);
            let controller;
            const emitMeta = (scrubbed) => {
              controller.enqueue(encoder.encode(eventText('meta', {
                v: 2, sequence: request.sequence,
                ...(scrubbed === undefined ? {} : { scrubbedUserMessage: scrubbed }),
              })));
            };
            const body = new ReadableStream({
              start(value) {
                controller = value;
                if (__AUTO_META__) emitMeta(request.turn.userMessage);
              },
            });
            window.__v2TestStream = {
              request,
              meta: emitMeta,
              delta(text) {
                controller.enqueue(encoder.encode(eventText('delta', { v: 2, text })));
              },
              done() {
                controller.enqueue(encoder.encode(eventText('done', {
                  v: 2,
                  sequence: request.sequence,
                  historyTag: 'controlled-history-tag-after-stream-1234567890',
                  assistantMessageId: '22222222-2222-4222-8222-222222222222',
                  finishReason: 'stop',
                  completionStatus: 'complete',
                })));
                controller.close();
              },
            };
            return new Response(body, {
              status: 200,
              headers: { 'content-type': 'text/event-stream; charset=utf-8' },
            });
          };
        })();
        """
    await page.add_init_script(script.replace("__AUTO_META__", "true" if auto_meta else "false"))


async def settle_render(page):
    await page.evaluate(
        "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    )


async def transcript_gap(page):
    return await page.get_by_test_id("message-list").evaluate(
        "node => node.scrollHeight - node.scrollTop - node.clientHeight"
    )


async def transcript_is_near_bottom(page, tolerance=4):
    return await transcript_gap(page) <= tolerance


async def test_stream_follow_pause_and_resume(browser):
    page = await browser.new_page(viewport={"width": 320, "height": 568})
    await install_controlled_chat_stream(page)
    await install_api_routes(page)
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("question-input").fill("Stream a long answer")
    await page.get_by_test_id("send-question").click()
    await wait_for_check(
        lambda: page.evaluate("Boolean(window.__v2TestStream)"),
        description="controlled chat stream",
    )
    assert await page.get_by_text("Preparing an answer…", exact=True).count() == 1
    assert await page.locator(".activity-track").count() == 1

    first_delta = "\n\n".join(
        f"Paragraph {index}: vaccine information for the controlled stream."
        for index in range(42)
    ) + "\n\nFIRST_STREAM_SENTINEL"
    await page.evaluate("text => window.__v2TestStream.delta(text)", first_delta)
    await page.get_by_text("FIRST_STREAM_SENTINEL", exact=False).wait_for()
    await settle_render(page)
    assert await transcript_gap(page) <= 4

    transcript = page.get_by_test_id("message-list")
    paused_top = await transcript.evaluate(
        """
        node => {
          node.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
          node.scrollTop = Math.max(0, node.scrollTop - 300);
          node.dispatchEvent(new Event('scroll'));
          return node.scrollTop;
        }
        """
    )
    scroll_button = page.get_by_test_id("scroll-to-latest")
    await scroll_button.wait_for()

    second_delta = " More controlled stream content." * 16 + " SECOND_STREAM_SENTINEL"
    await page.evaluate("text => window.__v2TestStream.delta(text)", second_delta)
    await page.get_by_text("SECOND_STREAM_SENTINEL", exact=False).wait_for()
    await settle_render(page)
    paused_after_delta = await transcript.evaluate("node => node.scrollTop")
    assert abs(paused_after_delta - paused_top) <= 2
    assert await transcript_gap(page) > 100

    await scroll_button.click()
    await wait_for_check(
        lambda: transcript_is_near_bottom(page),
        description="transcript bottom",
    )
    assert await scroll_button.count() == 0

    third_delta = " Follow resumed. THIRD_STREAM_SENTINEL"
    await page.evaluate("text => window.__v2TestStream.delta(text)", third_delta)
    await page.get_by_text("THIRD_STREAM_SENTINEL", exact=False).wait_for()
    await settle_render(page)
    assert await transcript_gap(page) <= 4

    final_paused_top = await transcript.evaluate(
        """
        node => {
          node.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
          node.scrollTop = Math.max(0, node.scrollTop - 300);
          node.dispatchEvent(new Event('scroll'));
          return node.scrollTop;
        }
        """
    )
    await scroll_button.wait_for()
    await page.evaluate("window.__v2TestStream.done()")
    await page.get_by_test_id("question-input").wait_for(state="visible")
    await wait_for_check(
        lambda: page.get_by_test_id("question-input").is_enabled(),
        description="composer enabled after stream",
    )
    await settle_render(page)
    final_top = await transcript.evaluate("node => node.scrollTop")
    assert abs(final_top - final_paused_top) <= 2
    assert await scroll_button.is_visible()
    await page.close()


async def test_prompt_hotfix_preserves_inflight_session(browser):
    page = await browser.new_page(viewport={"width": 390, "height": 844})
    old_hash = "a" * 64
    new_hash = "b" * 64
    sessions = []
    config_state = {"activeHash": old_hash, "retainedHashes": {old_hash, new_hash}}
    chats, _ = await install_api_routes(
        page,
        session_requests=sessions,
        config_state=config_state,
    )
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    question_input = page.get_by_test_id("question-input")
    await question_input.fill("Question before prompt hotfix")
    await question_input.press("Enter")
    await wait_count(chats, 1)
    await page.get_by_text("A complete answer.", exact=False).wait_for()

    config_state["activeHash"] = new_hash
    await page.reload(wait_until="networkidle")
    await page.get_by_test_id("question-input").wait_for()
    assert sessions[-1]["resumeConfig"] == {
        "configVersion": "albertsons-2026-flu-v9",
        "configHash": old_hash,
    }
    assert await page.get_by_text("Question before prompt hotfix", exact=True).count() == 1

    await page.get_by_test_id("question-input").fill("Question after prompt hotfix")
    await page.get_by_test_id("question-input").press("Enter")
    await wait_count(chats, 2)
    persisted = await page.evaluate(
        """
        () => {
          const active = sessionStorage.getItem('vegapunk:v2:active:flu');
          return JSON.parse(sessionStorage.getItem(`vegapunk:v2:${active}`));
        }
        """
    )
    assert persisted["configHash"] == old_hash
    assert not any(
        item["code"] == "stored_state_preserved_as_corrupt"
        for item in persisted["captureErrors"]
    )

    # A later deployment can advance the active config version as well as its
    # hash. A valid retained session must keep using its saved immutable version
    # even though a clean session on this route now expects v6.
    await wait_for_check(
        lambda: page.get_by_test_id("question-input").is_enabled(),
        description="composer enabled before retained-version reload",
    )
    await page.add_init_script(
        """
        const active = sessionStorage.getItem('vegapunk:v2:active:flu');
        const key = `vegapunk:v2:${active}`;
        const saved = JSON.parse(sessionStorage.getItem(key));
        if (saved) {
          saved.configVersion = 'albertsons-2026-flu-v1';
          sessionStorage.setItem(key, JSON.stringify(saved));
        }
        """
    )
    await page.reload(wait_until="networkidle")
    await page.get_by_test_id("question-input").wait_for()
    assert sessions[-1]["resumeConfig"] == {
        "configVersion": "albertsons-2026-flu-v1",
        "configHash": old_hash,
    }
    assert await page.get_by_text("Question before prompt hotfix", exact=True).count() == 1
    assert await page.get_by_text("Question after prompt hotfix", exact=True).count() == 1
    await page.close()




RAW_PII_QUESTION = "My name is Jane Doe and my email is jane.doe@example.com"
SCRUBBED_PII_QUESTION = "My name is [NAME_1] and my email is [EMAIL_1]"


async def read_v2_state(page):
    raw = await page.evaluate(
        """() => {
          const key = Object.keys(sessionStorage).find(
            (k) => k.startsWith('vegapunk:v2:') && !k.startsWith('vegapunk:v2:active:')
          );
          return key ? sessionStorage.getItem(key) : null;
        }"""
    )
    assert raw, "expected a persisted v2 state in sessionStorage"
    return json.loads(raw)


def assert_no_raw_pii(state, checkpoint_requests):
    for message in state["messages"]:
        assert "Jane Doe" not in message["content"], "raw name leaked into a stored message"
        assert "jane.doe@example.com" not in message["content"], "raw email leaked into a stored message"
    for request in checkpoint_requests:
        assert "Jane Doe" not in request["transcriptJson"], "raw name leaked into a checkpoint body"
        assert "jane.doe@example.com" not in request["transcriptJson"], "raw email leaked into a checkpoint body"


async def test_pii_never_persisted_pre_meta(browser):
    page = await browser.new_page()
    await install_controlled_chat_stream(page, auto_meta=False)
    _, checkpoint_requests = await install_api_routes(page)
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("question-input").fill(RAW_PII_QUESTION)
    await page.get_by_test_id("send-question").click()
    await wait_for_check(
        lambda: page.evaluate("Boolean(window.__v2TestStream)"),
        description="chat request to start",
    )

    # Pre-meta: the raw turn exists only in memory and as the parked draft.
    state = await read_v2_state(page)
    assert_no_raw_pii(state, checkpoint_requests)
    assert state["draft"] == RAW_PII_QUESTION
    assert state["lifecycle"] == "ready"
    assert all(m["role"] != "user" or m["isInitial"] for m in state["messages"])

    # An exit flush inside the window must persist the same clean prefix.
    await page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
    state = await read_v2_state(page)
    assert_no_raw_pii(state, checkpoint_requests)

    # Deliver the canonical text, then the answer.
    await page.evaluate(
        "(scrubbed) => window.__v2TestStream.meta(scrubbed)", SCRUBBED_PII_QUESTION
    )
    await page.evaluate("() => window.__v2TestStream.delta('An evidence-based answer.')")
    await page.evaluate("() => window.__v2TestStream.done()")
    await wait_count(checkpoint_requests, 1)
    await wait_for_check(
        lambda: page.get_by_test_id("question-input").is_enabled(),
        description="turn to complete",
    )

    state = await read_v2_state(page)
    assert_no_raw_pii(state, checkpoint_requests)
    stored_user = [m for m in state["messages"] if m["role"] == "user" and not m["isInitial"]]
    assert len(stored_user) == 1
    assert stored_user[0]["content"] == SCRUBBED_PII_QUESTION
    assert SCRUBBED_PII_QUESTION in checkpoint_requests[-1]["transcriptJson"]

    # The participant's own bubble keeps showing what they typed.
    bubble = await page.locator(".user-message p").first.inner_text()
    assert bubble == RAW_PII_QUESTION

    # The next turn's history echo must carry the scrubbed text byte-for-byte.
    await page.get_by_test_id("question-input").fill("A second question")
    await page.get_by_test_id("send-question").click()
    await wait_for_check(
        lambda: page.evaluate(
            "Boolean(window.__v2TestStream && window.__v2TestStream.request.sequence === 2)"
        ),
        description="second chat request",
    )
    history = await page.evaluate("() => window.__v2TestStream.request.history")
    assert history[0]["role"] == "user"
    assert history[0]["content"] == SCRUBBED_PII_QUESTION
    await page.close()


async def test_pii_reload_pre_meta(browser):
    page = await browser.new_page()
    await install_controlled_chat_stream(page, auto_meta=False)
    _, checkpoint_requests = await install_api_routes(page)
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("question-input").fill(RAW_PII_QUESTION)
    await page.get_by_test_id("send-question").click()
    await wait_for_check(
        lambda: page.evaluate("Boolean(window.__v2TestStream)"),
        description="chat request to start",
    )

    await page.reload(wait_until="networkidle")
    await page.get_by_test_id("message-list").wait_for()

    # The turn is absent from the restored record; the question returns to
    # the composer from the browser-local draft.
    state = await read_v2_state(page)
    assert_no_raw_pii(state, checkpoint_requests)
    assert all(m["role"] != "user" or m["isInitial"] for m in state["messages"])
    assert await page.locator(".user-message").count() == 0
    composer = await page.get_by_test_id("question-input").input_value()
    assert composer == RAW_PII_QUESTION
    await page.close()


async def test_pii_endchat_pre_meta(browser):
    page = await browser.new_page()
    await install_controlled_chat_stream(page, auto_meta=False)
    _, checkpoint_requests = await install_api_routes(page)
    await page.goto(f"{BASE}/study/albertsons-2026/flu", wait_until="networkidle")
    await page.get_by_test_id("question-input").fill(RAW_PII_QUESTION)
    await page.get_by_test_id("send-question").click()
    await wait_for_check(
        lambda: page.evaluate("Boolean(window.__v2TestStream)"),
        description="chat request to start",
    )

    await page.get_by_test_id("end-chat").click()
    await page.get_by_test_id("confirm-end").click()
    await wait_for_check(
        lambda: page.locator(".completion-card").count(),
        description="terminal completion card",
    )

    state = await read_v2_state(page)
    assert_no_raw_pii(state, checkpoint_requests)
    assert state["chatEndISO"], "terminal capture must remain terminal"
    assert all(m["role"] != "user" or m["isInitial"] for m in state["messages"])
    await page.close()


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            await test_sanitizer_reload_and_terminal(browser)
            await test_retry_cap_and_sequence(browser)
            await test_checkpoint_queue(browser, "delayed_success")
            await test_checkpoint_queue(browser, "delayed_failure")
            await test_parent_persist_is_nonterminal_and_reason_survives_reload(browser)
            await test_mobile_presentation_and_keyboard(browser)
            await test_inline_end_confirmation_focus(browser)
            await test_stream_follow_pause_and_resume(browser)
            await test_prompt_hotfix_preserves_inflight_session(browser)
            await test_pii_never_persisted_pre_meta(browser)
            await test_pii_reload_pre_meta(browser)
            await test_pii_endchat_pre_meta(browser)
        finally:
            await browser.close()
    print("v2 browser tests passed")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"v2 browser tests failed: {exc}", file=sys.stderr)
        raise
