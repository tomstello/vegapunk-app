# README

Source code for the Vegapunk apps at https://www.vegapunkdoc.dev/

Not monitored for issues and updates. Use at your own risk.

## Running locally

Current app code lives on `v10-load-testing`. `main` is an older snapshot that
auto-deploys — check the branch before anything else.

**Prerequisites:** Node 22 (matches the `nodejs22.x` function runtime) and an
OpenRouter API key.

### 1. Install

```sh
git checkout v10-load-testing
npm ci
```

### 2. Configure

Copy `.env.example` to `.env` and set two values:

```sh
cp .env.example .env
```

- **`OPENROUTER_API_KEY`** — one key serves every model call (the redaction
  pass and the answer stream both use it). No per-user or per-survey keys
  exist; the v2 API rejects any credential sent from the browser.
- **`SESSION_SIGNING_KEY`** — at least 32 UTF-8 bytes, and it may not begin
  with `change`, `replace`, `example`, or `test` (the app refuses placeholder
  secrets). Generate one:

  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

Every other variable can stay at its `.env.example` default for local work.
Leave `ENABLE_V2_CHECKPOINT` and `ENABLE_LEGACY_V1` set to `false`: local runs
then write transcript checkpoints nowhere and keep the retired v1 routes closed.

**Checkpoint store.** Transcript snapshots are mirrored server-side so a
conversation survives a killed browser. `CHECKPOINT_STORE=s3` writes one
immutable object per snapshot to an S3 bucket, authenticated through Vercel
OIDC federation into an IAM role that can only `PutObject` (see
`src/lib/server/v2/s3Checkpoint.ts` for the key layout). `qualtrics`, or
unset, keeps the legacy Qualtrics checkpoint survey writer. The browser
protocol is identical for both, and the `V2_RUNTIME_POLICY` constants that
describe the legacy writer are deliberately unchanged because they are part of
every study configuration hash.

**Logging.** `LOG_LEVEL` (`fatal`…`trace`, or `silent`) sets server log
verbosity; it defaults to `debug` on the dev server and `info` on Vercel. The
value is read once per function instance, so on Vercel set it in the project
environment and redeploy. Structured events worth searching for in Vercel logs:

- `v2_turn_complete` (info): one per delivered answer, with the OpenRouter
  `generationId`, `assistantMessageId`, finish reason, and timings. Look the
  generation up at `https://openrouter.ai/api/v1/generation?id=<generationId>`
  with the study key to see the model, provider route, tokens, and cost.
- `v2_provider_start_failure` / `v2_scrub_failure` (warn): the provider call
  did not start. `network` carries the underlying error name, `code`
  (`ENOTFOUND`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, …), syscall, and
  message; `abortedBy` says whether a timeout or the client cut it short.
- `v2_stream_failure` (warn): the answer stream ended early. Includes how many
  deltas and code points had been delivered, time since first byte, whether
  the client had disconnected, and the provider-side `cause` when there is one.
- `v2_stream_cancelled` (info): the client closed the response mid-answer.

### 3. Run

```sh
npm run dev
```

Open **http://localhost:5173/demo/vaccine-chat** — the standalone demo, which
needs no survey and exercises the full chat path.

The study arms live at `/study/albertsons-2026/{flu,covid,combo}`. They render
top-level, but are built to run inside the Qualtrics survey iframe.

### 4. Verify

```sh
npm test      # 59 unit tests
npm run check # svelte-check
```

For the 12 Playwright tests, `pip install playwright && playwright install
chromium`, then run `python3 tests/v2-browser.py` against a running dev server.
They mock the API routes, so they need no OpenRouter key.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Chat replies `503 service_unavailable`; sessions mint fine | `OPENROUTER_API_KEY` is empty |
| Chat replies `503 scrub_unavailable` | `OPENROUTER_API_KEY` is set but the provider rejected it — most often the `.env.example` placeholder left in place, or an expired or over-cap key |
| `/api/v2/session/...` replies `503 service_unavailable` while pages still render | `SESSION_SIGNING_KEY` missing, under 32 bytes, or placeholder-prefixed |
| First `npm run dev` warns `Cannot find base config file "./.svelte-kit/tsconfig.json"` | Harmless on a fresh clone; `npm run check` runs `svelte-kit sync` and generates it |
| `npm run build` throws on `PUBLIC_QUALTRICS_PARENT_ORIGINS` | Required for production builds only; set it to the survey origin |
| Hand-rolled chat request gets `400 invalid_idempotency_key` | The `Idempotency-Key` header must equal `turn.id` in the body |
| Second turn gets `409 invalid_history` | Echo back the `historyTag` from `done`, and the redacted user text from `meta.scrubbedUserMessage` |
