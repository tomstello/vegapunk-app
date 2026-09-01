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
then write to no Qualtrics tenant and keep the retired v1 routes closed.

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
