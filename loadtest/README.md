# Load testing

Tooling for driving the v2 chat API under load with the LLM calls stubbed
out, so the run measures Vercel (cold starts, concurrency, streaming
duration) and not OpenRouter. Run log and results live in the Azure DevOps
wiki page "Vercel Load Testing"; branch names `loadtest/<date>-<seq>` map to
the entries there.

## Pieces

- `src/lib/server/v2/loadtestStub.ts`: in-process stand-in for OpenRouter.
  Both provider call sites (`openrouter.ts`, `scrubber.ts`) go through
  `providerFetch`, which returns a synthetic response when `PROVIDER_STUB=1`.
  The scrubber gets an empty span report after `STUB_SCRUB_MS`; the answer is
  an SSE stream that starts after `STUB_FIRST_BYTE_MS` and delivers
  `STUB_ANSWER_CHARS` over `STUB_STREAM_MS`. All delays carry `STUB_JITTER`.
  `STUB_ERROR_RATE` injects HTTP 429s to exercise the `provider_busy` path.
- Host guard: the stub engages only on the Vite dev server
  (`NODE_ENV=development`) or on a Vercel deployment whose
  `VERCEL_PROJECT_PRODUCTION_URL` is `vaccine-chat-loadtest.vercel.app`.
  Anywhere else it is refused, logs `loadtest_stub_refused`, and real
  provider traffic continues. Config hashes are untouched: the stub sits at
  the fetch seam, not in the study configuration.
- `x-loadtest-instance` response header (`<id>;age=<ms>;n=<count>`), set by
  `hooks.server.ts` whenever the stub is active or
  `LOADTEST_INSTANCE_HEADER=1` under the same guard. `id` is per module
  instantiation (one per function instance), `age` is milliseconds since
  that instance booted, `n` is requests served by it.
- `loadtest/harness.mjs`: the load generator. Speaks the real protocol
  (session, signed history echo, redacted-text adoption, SSE parsing) and
  refuses every host except the load-test project and localhost. Checkpoint
  traffic is opt-in through `--checkpoint`; see "Checkpoints" below.
- `loadtest/snapshot.mjs`: builds the transcript snapshots the checkpoint
  route validates. `tests/loadtest-snapshot.test.mjs` runs its output through
  the server's own `validateTranscriptSnapshot`, so a schema change breaks the
  test rather than a run.
- `x-loadtest-checkpoint-store` response header on `/api/v2/checkpoint`, set
  under the same host guard as `x-loadtest-instance`. It names the store the
  request would write to, and the harness refuses to run unless it reads `s3`.

## Local run

```sh
PROVIDER_STUB=1 npm run dev
node loadtest/harness.mjs --base http://localhost:5173 --arm flu \
  --conversations 20 --concurrency 5 --turns 2 --think 500
```

Faster stub timings for smoke runs:

```sh
PROVIDER_STUB=1 STUB_SCRUB_MS=50 STUB_FIRST_BYTE_MS=100 STUB_STREAM_MS=300 npm run dev
```

## Against the load-test project

The stub must be deployed there and enabled by env. From this directory
(linked to `vaccine-chat-loadtest`):

```sh
vercel env add PROVIDER_STUB production      # value: 1
vercel env add PROVIDER_STUB preview         # value: 1
vercel deploy --prod                         # or `vercel deploy` for a preview URL
```

The project's "Automatically expose System Environment Variables" setting
must be on (it is the default); the guard reads `VERCEL` and
`VERCEL_PROJECT_PRODUCTION_URL` from it. After deploying, confirm the stub
is live before spending a big run:

```sh
node loadtest/harness.mjs --conversations 2 --concurrency 1 --turns 1 --think 0
```

The summary must show `instances distinct=...` (header present) and answer
lengths equal to `STUB_ANSWER_CHARS`. If the summary says no header was seen,
the stub is not active and the run would spend real model budget.

Remove `PROVIDER_STUB` from the project env, or redeploy the base branch, to
return the load-test host to real models.

## Run shapes

Closed loop, ramped: `--concurrency 200 --ramp 60` starts 200 workers
evenly over 60 s; each runs conversations back to back. Good for finding
the steady-state ceiling.

Open loop: `--rate 20` starts 20 conversations per second regardless of how
many are still running. This is what an SMS wave looks like; use it for the
"first 60 s from zero" question. Concurrency is unbounded, so watch the
`inFlight` progress counter.

`--think` is the pause between a participant's turns (default 5 s). Real
users take longer; a lower value packs more chat streams into the same
concurrency.

`--max-failures <n>` is the stop switch. Once more than n conversations have
failed, no new conversation starts and no conversation starts another turn;
requests already open drain (seconds, bounded by `--timeout`), then the
summary and results file are written as usual, with `meta.stop` recording
why and when. Ctrl-C once does the same; Ctrl-C twice aborts without
results. Exit code 0 means the run completed, 3 means it stopped early with
results written, 130 means it was aborted. Use it on every live-model run: a run that has started failing is
spending money for nothing, and before this switch existed the only way to
stop one was to kill it and lose the per-turn data.

With `OPENROUTER_API_KEY` exported, the harness reads the account balance
from openrouter.ai before and after the run and records it under
`meta.credits` with the spend per successful turn. That is the only call
the harness makes outside the load-test host.

## Checkpoints

The transcript checkpoint is the third server-side write in a turn, after the
scrubber and the answer, and it is the highest-volume one: the browser writes
on submit and again when the answer completes, plus once when the chat ends.
A 3-turn conversation is 3 chat requests and 7 checkpoint requests, so at 10
conversations per second the checkpoint route sees 70 writes per second while
the chat route sees 30.

`--checkpoint off` (the default) keeps the historical behaviour: no checkpoint
traffic at all, so runs stay comparable with sequences 01 and 02.
`--checkpoint turn` writes once per completed turn plus the terminal write
(`turns + 1` per conversation). `--checkpoint full` reproduces the browser
cadence (`2 * turns + 1`).

Bulk load must never reach the study's Qualtrics account, which is why the
harness skipped this route until `CHECKPOINT_STORE=s3` existed. `--checkpoint`
therefore begins with a preflight: one request carrying a valid transcript and
a deliberately invalid handle. The route selects its store, rejects the handle
with 409 before writing anything, and returns `x-loadtest-checkpoint-store`.
The run starts only if that header reads `s3`; a Qualtrics-backed deployment,
or any host that does not set the header, exits 4 with nothing written. Note
that `CHECKPOINT_STORE` unset means Qualtrics, so this is not a theoretical
case -- it is the default.

A checkpoint failure is recorded but does not end the conversation, matching
the browser, so chat latencies stay measurable. It does mark the conversation
failed, so `--max-failures` still stops a run whose store has fallen over.
Watch `creates` in the summary: there should be exactly one per conversation,
and more means handles were lost and the store holds duplicate rows.

The load-test project needs `LOADTEST_INSTANCE_HEADER=1` (or `PROVIDER_STUB=1`)
for the header to be emitted at all, on top of `CHECKPOINT_STORE=s3` and the
three `CHECKPOINT_AWS_*`/`CHECKPOINT_S3_BUCKET` values the writer reads. With
the flag absent the preflight cannot read the store and refuses the run, which
is what happens by default after a live-model sequence, since those runs remove
`PROVIDER_STUB`.

First verified end to end on 2026-09-21 against the live-model load-test
deployment: one 3-turn conversation produced 7 writes, `creates=1 updates=6`,
sequences 1 to 7, every checksum matching. Checkpoint time-to-first-byte was
145 ms p50 warm, 1,410 ms on an instance's first write, against chat turns of
5.7 s -- cheap per write, but 70 writes per second at the 10 conversations per
second target, so roughly 12 concurrent checkpoint requests in steady state.
Request bodies grew 1,954 to 6,052 bytes across the conversation.

`--questions short|long` picks the user-turn text. Against the stub it
makes no difference. Against the live model it sets answer length and
therefore spend: the system prompt asks for thorough answers with sources,
so the open sequence 01 questions (`long`) run 15 to 30 s and several
hundred output tokens each. The default `short` set is yes/no and
single-fact questions with an explicit brevity cue, aimed at 100 to 200
output tokens a turn. Use `long` only for a deliberate like-for-like
comparison. The set used is recorded under `settings.questions` in the
results file.

## Reading the output

- `session ttfb`: HMAC mint, the cheapest call. Its cold vs warm split is
  the cleanest cold-start measurement.
- Instance split, per phase: `cold` is the first request an instance ever
  served (`n=1` in the header), `routeFirst` is the first time an instance
  served that route (page, session, or chat) after serving others, `warm` is
  everything else. Instance age is deliberately not used: instances that had
  been alive for seconds still paid full initialization on their first hit
  in test 1, and each route pays its own lazy initialization per instance.
- `chat headers`: time until Vercel returns response headers. The app sends
  headers only after the scrubber and the first provider delta, so under the
  stub this is roughly `STUB_SCRUB_MS + STUB_FIRST_BYTE_MS` plus platform
  overhead.
- `chat first byte` / `first delta` / `total`: from the client's view.
  `total` minus `first byte` is the streaming window during which the
  function instance is held open.
- The timeline table buckets everything by wall-clock second so ramp-up
  behaviour and the arrival of new instances can be read side by side.
- Results JSON in `loadtest/results/` (gitignored) holds every conversation
  and turn for later analysis.

## Is the generator saturated?

Every latency the harness reports is a timestamp taken on its own event
loop. A busy loop takes them late, which inflates every metric in the same
direction as real platform slowness. Two checks:

- **Built-in.** Each progress line and timeline bucket carries `genLag`
  (event-loop delay p99 for that interval) and `genCPU` (process CPU
  percent). An idle loop on macOS reads 15 to 25 ms here because of timer
  coalescing, so that is the baseline, not a warning; sustained values of
  50 ms and up mean the affected buckets carry that much generator-side
  inflation, and the summary flags it. `client_*` error codes (`ETIMEDOUT`,
  `ECONNRESET`, `EMFILE`, `EADDRNOTAVAIL`) are also generator-side.
- **Unloaded probe.** Run a second harness process at concurrency 2 in
  another terminal for the duration of the big run:

  ```sh
  node loadtest/harness.mjs --concurrency 2 --conversations 40 --turns 2 \
    --think 0 --label probe-<step>
  ```

  Its process has an idle event loop, so its numbers are the platform's
  without generator bias. If the probe's chat headers and streaming window
  match the big run's, the generator is not inflating anything; if the big
  run reads higher, the difference is the generator's contribution.

## Limits of this round

- The stub does not open outbound sockets, so per-instance connection or
  file-descriptor limits are not exercised. That needs the external mock
  variant, which can reuse the same `providerFetch` seam.
- One generator machine holds a few thousand concurrent SSE streams before
  ephemeral ports run out. Beyond that, run the harness from several hosts
  or port the flow to a distributed tool.
- Vercel's DDoS mitigation may throttle a burst from one source IP. If
  errors cluster as `client_*` or HTTP 429 with no matching function
  errors in Vercel logs, that is the likely cause.
