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
  (session, signed history echo, redacted-text adoption, SSE parsing), never
  calls the checkpoint route, and refuses every host except the load-test
  project and localhost.

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
