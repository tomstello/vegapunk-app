# Redaction policy v13

This revision implements [Jan Voelkel's redaction document](https://docs.google.com/document/d/1jLy4vM_0A3P_psEcjxM5iW4iX9TYpjX1Do7OA--WWik/edit), read on October 2, 2026, for the flu, COVID and combined study arms. It appends immutable `albertsons-2026-{condition}-v13` configurations. Earlier revisions and the standalone demo remain unchanged; answering policy, model routes, UI and operational limits carry forward from v12.

## Policy and interpretation

The detector and its output validator now use all 18 labels in the document: `NAME`, `ADDRESS`, `DATES`, `PHONE`, `FAX`, `EMAIL`, `SSN`, `MRN`, `HPBN`, `ACCOUNT`, `LICENSE`, `VEHICLE`, `DEVICE`, `URL`, `IP`, `BIOMETRIC`, `PHOTO`, and `ID`. The output schema is generated from the same list, resolving the document's older, shorter example enum. `DATES` replaces the old `DOB` label and `ADDRESS` includes the old `CITY` label.

- For dates directly related to an individual, remove the non-year elements while preserving an ordinary year. In “born May 14, 1980,” remove “May 14”; in “DOB 1980-05-14,” remove “05-14.” Public historical dates and vaccine-season years remain.
- Remove ages over 89 and date elements, including years, that indicate those ages. The prompt uses the 2026 study year. Under its conservative uncertainty rule, a lone 1936 birth year is removed unless the message establishes that the person is still under 90. This implementation substitutes exact-span placeholders rather than generating an inferred “90 or older” value.
- Remove the full supplied ZIP code and geographic subdivisions smaller than a state. State and country names alone remain.
- Remove URLs and IP addresses. Existing exemptions for vaccine/medicine names, pharmacy brands, organizations, health conditions, relationship words without names and existing placeholders remain.
- The input is text. `BIOMETRIC` and `PHOTO` cover identifying material represented in that text; they do not add image/audio processing or attachment support. Merely mentioning a photograph or fingerprint is not an identifier.

The server still validates the category and verbatim source substring before applying a replacement. Invalid detector output and exhausted technical failures stop the turn. A syntactically valid model response can still omit an identifier; the fallback is used for technical failures, not as a second review of every successful primary response.

## Verification and release

Server tests exercise the 18 categories through mocked primary and fallback responses, retained-year behavior, age/ZIP examples, placeholder reuse, invalid output, and historical configuration hashes. These tests verify the extraction contract and application behavior; they do not measure model accuracy. The evaluation fixture contains synthetic material only. The previous prompt's synthetic benchmark must not be reported as a result for v13.

Validate the 59 synthetic fixtures without credentials, network access or model calls:

```sh
node scripts/scrubber-eval.mjs --validate-fixtures
node --test tests/scrubber-eval.test.mjs
```

The evaluator defaults to `tests/fixtures/pii-jan-v13.json`; override with `--fixtures PATH`. Results identify the current checkout's configuration version/hash, prompt hash, fixture hash and selected model. Complete sensitive-span coverage is required, and retained text is checked at its original location. Redaction of additional letters/digits fails unless the fixture explicitly permits that context. Ambiguous output alignment fails conservatively. These checks validate the evaluation machinery, not model accuracy.

Only after provider testing is authorized and `OPENROUTER_API_KEY` is available in the environment, evaluate each configured route independently:

```sh
node scripts/scrubber-eval.mjs --model primary > /tmp/v13-primary-eval.json
node scripts/scrubber-eval.mjs --model fallback > /tmp/v13-fallback-eval.json
```

Neither command automatically switches to the other model. The fallback evaluation uses the configured fallback route with one attempt, while the primary retains its configured retry limit. Reports include per-case provider failures; any missed identifier, unexpected redaction, retention failure or model error exits unsuccessfully. The optional transcript sweep reports residual detector findings, not an estimate of recall without labeled ground truth.

The checked-in [configuration manifest](releases/v13-config-manifest.json) records the three versions, configuration hashes and prompt hash. Reproduce it from this checkout using:

```sh
npm run --silent v2:config-manifest > /tmp/v13-config-manifest.json
diff -u docs/releases/v13-config-manifest.json /tmp/v13-config-manifest.json
```

Before releasing, evaluate the new synthetic cases separately against the approved primary and fallback routes with the authorized study account. Review complete identifier coverage, false positives, retained years and failure rates. Then follow the [manual production release procedure](production-release.md), including coordinated Qualtrics version pins and verification of the returned configuration hashes. This code change and its Git push do not publish the new policy to participants.

Retained legacy session configurations and checkpoint-content provenance require separate security review before making a system-wide screening assurance. This prompt-policy revision does not change those API contracts.
