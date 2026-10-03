#!/usr/bin/env node
// Scrubber evaluation harness. Synthetic Jan v13 policy fixtures are the default.
//
// Loads the scrubber module and active configuration from this checkout
// via esbuild (same technique as the unit tests), so the eval exercises the
// exact prompt, provider policy, span verification, and substitution code
// that serves participants. Two modes:
//
//   node scripts/scrubber-eval.mjs --validate-fixtures     # offline, no key/network
//   node scripts/scrubber-eval.mjs --model primary         # paid primary-only eval
//   node scripts/scrubber-eval.mjs --model fallback        # paid fallback-only eval
//   node scripts/scrubber-eval.mjs --fixtures path.json    # explicit labeled suite
//   node scripts/scrubber-eval.mjs --sweep conversations.jsonl
//                                                          # report-only sweep
//
// The sweep mode reads parse_transcripts_v6.py JSONL output and reports any
// PII the detector still finds in stored (already-redacted) transcripts —
// residual detector findings, not a recall estimate without labeled ground
// truth. It never modifies anything.
//
// Credentials: OPENROUTER_API_KEY from the environment, else read directly
// from ../.env (never printed, never logged). Calls run under the same
// US/ZDR provider policy as production.

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const CONCURRENCY = 4;

async function loadServerModule(relativePath) {
	const entryPoint = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
	const result = await build({
		entryPoints: [entryPoint],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		logLevel: 'silent',
		plugins: [
			{
				name: 'eval-private-env',
				setup(esbuild) {
					esbuild.onResolve({ filter: /^\$env\/dynamic\/private$/ }, () => ({
						path: 'eval-private-env',
						namespace: 'eval-env'
					}));
					esbuild.onLoad({ filter: /.*/, namespace: 'eval-env' }, () => ({
						contents: 'export const env = {};',
						loader: 'js'
					}));
				}
			}
		]
	});
	return import(
		`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
	);
}

async function apiKey() {
	if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
	try {
		const envFile = await readFile(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
		for (const line of envFile.split('\n')) {
			const match = /^\s*OPENROUTER_API_KEY\s*=\s*(.+)\s*$/.exec(line);
			if (match) return match[1].replace(/^["']|["']$/g, '').trim();
		}
	} catch {
		// fall through
	}
	throw new Error('OPENROUTER_API_KEY not found in the environment or ../.env');
}

function percentile(values, fraction) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function locations(text, assertion) {
	const value = typeof assertion === 'string' ? assertion : assertion.text;
	const matches = [];
	let from = 0;
	while (from <= text.length - value.length) {
		const start = text.indexOf(value, from);
		if (start === -1) break;
		matches.push({ start, end: start + value.length });
		from = start + value.length;
	}
	return typeof assertion === 'object' && assertion.occurrence !== undefined
		? matches.slice(assertion.occurrence, assertion.occurrence + 1)
		: matches;
}

export function validateFixtures(suite, allowedCategories) {
	if (!Array.isArray(suite.cases) || suite.cases.length === 0) throw new Error('fixtures require nonempty cases');
	const allowed = new Set(allowedCategories ?? suite.categories);
	const ids = new Set();
	for (const fixture of suite.cases) {
		if (!fixture.id || ids.has(fixture.id)) throw new Error(`missing/duplicate fixture id: ${fixture.id}`);
		ids.add(fixture.id);
		if (typeof fixture.text !== 'string' || !fixture.text || !Array.isArray(fixture.expected)) {
			throw new Error(`${fixture.id}: require text and expected array`);
		}
		for (const assertion of [...fixture.expected, ...(fixture.retain ?? []), ...(fixture.allowRedact ?? [])]) {
			const value = typeof assertion === 'string' ? assertion : assertion.text;
			if (typeof value !== 'string' || !value || !locations(fixture.text, assertion).length) {
				throw new Error(`${fixture.id}: assertion is not a nonempty verbatim substring`);
			}
			if (typeof assertion === 'object' && assertion.occurrence !== undefined &&
				(!Number.isInteger(assertion.occurrence) || assertion.occurrence < 0)) {
				throw new Error(`${fixture.id}: invalid occurrence`);
			}
		}
		for (const expected of fixture.expected) {
			if (!allowed.has(expected.category)) throw new Error(`${fixture.id}: unsupported category ${expected.category}`);
			for (const sensitive of locations(fixture.text, expected)) {
				for (const retained of (fixture.retain ?? []).flatMap((a) => locations(fixture.text, a))) {
					if (sensitive.start < retained.end && sensitive.end > retained.start) {
						throw new Error(`${fixture.id}: sensitive and retained assertions overlap`);
					}
				}
			}
		}
		for (const optional of fixture.allowRedact ?? []) {
			for (const allowed of locations(fixture.text, optional)) {
				for (const retained of (fixture.retain ?? []).flatMap((a) => locations(fixture.text, a))) {
					if (allowed.start < retained.end && allowed.end > retained.start) throw new Error(`${fixture.id}: optional redaction and retained assertions overlap`);
				}
			}
		}
	}
	return { cases: suite.cases.length, categories: [...new Set(suite.cases.flatMap((c) => c.expected.map((e) => e.category)))] };
}

async function mapLimit(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next;
				next += 1;
				results[index] = await worker(items[index], index);
			}
		})
	);
	return results;
}

// Detection-only wrapper: run the production scrub and diff the output
// against the input to recover which spans were redacted.
export function reportedSpans(rawText, scrubbedText) {
	const matches = [...scrubbedText.matchAll(/\[([A-Z]{2,16})_(\d{1,3})\]/g)];
	const solutions = [];
	let steps = 0;
	// Reconstruct exact raw offsets, never guess the first occurrence of a
	// repeated anchor. More than one alignment is conservatively unscorable.
	function walk(index, rawIndex, outputIndex, spans) {
		steps += 1;
		if (steps > 10000 || solutions.length > 1) return;
		if (index === matches.length) {
			if (rawText.slice(rawIndex) === scrubbedText.slice(outputIndex)) solutions.push(spans);
			return;
		}
		const match = matches[index];
		const literal = scrubbedText.slice(outputIndex, match.index);
		if (!rawText.startsWith(literal, rawIndex)) return;
		const start = rawIndex + literal.length;
		const nextOutput = match.index + match[0].length;
		const anchor = scrubbedText.slice(nextOutput, matches[index + 1]?.index ?? scrubbedText.length);
		for (let end = start + 1; end <= rawText.length; end += 1) {
			if (!rawText.startsWith(anchor, end)) continue;
			const text = rawText.slice(start, end);
			// Existing placeholders must survive as literal tokens, not be
			// swallowed into a newly inferred sensitive span.
			const unchanged = text === match[0];
			if (!unchanged && /\[[A-Z]{2,16}_\d{1,3}\]/.test(text)) continue;
			walk(index + 1, end, nextOutput,
				unchanged ? spans : [...spans, { start, end, text, category: match[1], token: match[0] }]);
			if (solutions.length > 1 || steps > 10000) return;
		}
	}
	walk(0, 0, 0, []);
	if (solutions.length !== 1 || steps > 10000) return null;
	return { spans: solutions[0], faithful: true, redactedChars: solutions[0].reduce((n, s) => n + s.text.length, 0) };
}

export function evaluateFixture(fixture, scrubbedText) {
	const result = reportedSpans(fixture.text, scrubbedText);
	const expected = fixture.expected.flatMap((assertion) => locations(fixture.text, assertion)
		.map((range) => ({ ...assertion, ...range })));
	if (!result) return { expected, found: [], reported: [], failures: [{ error: 'alignment_failed_or_ambiguous' }] };
	const failures = [];
	const found = expected.filter((span) => {
		// Cover every non-whitespace character in every intended occurrence.
		// Full names/IDs cannot pass on a matching prefix or suffix. Separate
		// month/day reports may collectively satisfy a complete date span.
		for (let i = span.start; i < span.end; i += 1) {
			if (/\s/.test(fixture.text[i])) continue;
			if (!result.spans.some((r) => r.category === span.category && r.start <= i && r.end > i)) {
				failures.push({ missed: span });
				return false;
			}
		}
		return true;
	});
	for (const span of expected) {
		if (span.expectPlaceholder && !result.spans.some((r) => r.token === span.expectPlaceholder && r.start < span.end && r.end > span.start)) {
			failures.push({ missedPlaceholder: span.expectPlaceholder });
		}
	}
	for (const assertion of fixture.retain ?? []) {
		for (const retained of locations(fixture.text, assertion)) {
			if (result.spans.some((r) => r.start < retained.end && r.end > retained.start)) {
				failures.push({ mustRetain: assertion, ...retained });
			}
		}
	}
	const reported = result.spans.map((span) => ({ ...span, truePositive: found.some((e) =>
		e.category === span.category && e.start < span.end && e.end > span.start) }));
	const permitted = [...expected, ...(fixture.allowRedact ?? []).flatMap((a) => locations(fixture.text, a))];
	// A detector cannot pass by erasing the surrounding sentence. Only
	// whitespace/punctuation or fixture-explicit optional context may extend
	// beyond the labeled sensitive spans. No proportional length allowance.
	for (const span of reported) {
		const unexpectedOffsets = [];
		for (let i = span.start; i < span.end; i += 1) {
			if (/[\s\p{P}]/u.test(fixture.text[i])) continue;
			if (!permitted.some((p) => p.start <= i && p.end > i)) unexpectedOffsets.push(i);
		}
		if (unexpectedOffsets.length) {
			span.truePositive = false;
			failures.push({ overRedaction: { span, unexpectedOffsets } });
		}
	}
	for (const extra of reported.filter((r) => !r.truePositive)) failures.push({ falsePositive: extra });
	return { expected, found, reported, failures };
}

function historyFromStrings(redactedTurns) {
	return (redactedTurns ?? []).map((content, index) => ({
		id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		role: 'user',
		content
	}));
}

async function main() {
	const args = process.argv.slice(2);
	const sweepAt = args.indexOf('--sweep');
	const modelChoice = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'primary';
	const fixturesAt = args.indexOf('--fixtures');
	const fixturesArg = fixturesAt !== -1 ? args[fixturesAt + 1] : null;
	if (fixturesAt !== -1 && (!fixturesArg || fixturesArg.startsWith('--'))) throw new Error('--fixtures requires a JSON path');
	if (!['primary', 'fallback', 'sonnet', 'haiku'].includes(modelChoice)) throw new Error('--model must be primary, fallback, sonnet (legacy alias), or haiku');
	const offline = args.includes('--validate-fixtures');
	if (offline && sweepAt !== -1) throw new Error('--validate-fixtures cannot be combined with --sweep');

	const [configs, scrubberModule] = await Promise.all([
		loadServerModule('src/lib/server/v2/studyConfig.ts'),
		loadServerModule('src/lib/server/v2/scrubber.ts')
	]);
	const studyConfig = configs.getStudyConfig('flu');
	const activeScrubber = studyConfig.scrubber;
	if (!activeScrubber) throw new Error('active registry has no scrubber configuration');
	// Evaluate exactly one model at a time: the fallback is stripped so a
	// primary failure surfaces instead of silently switching vendors.
	// 'fallback' evaluates the configured cross-vendor fallback in isolation;
	// the legacy name 'sonnet' is retained as an alias, not a hardcoded model.
	const isolated = { ...activeScrubber };
	delete isolated.fallbackModel;
	let scrubberConfig = isolated;
	if (modelChoice === 'haiku') {
		scrubberConfig = {
			...isolated,
			model: {
				name: 'anthropic/claude-haiku-4.5',
				baseUrl: activeScrubber.model.baseUrl,
				// Single US-resident ZDR route today (2026-08 inventory).
				provider: {
					only: ['google-vertex/us-east5'],
					zdr: true,
					data_collection: 'deny',
					allow_fallbacks: false,
					require_parameters: true
				},
				maxTokens: activeScrubber.model.maxTokens,
				reasoning: { effort: 'low', exclude: true }
			}
		};
	} else if (modelChoice === 'sonnet' || modelChoice === 'fallback') {
		if (!activeScrubber.fallbackModel) throw new Error('active scrubber has no fallback model');
		// Production fallback is attempted only once. Do not give its isolated
		// evaluation extra retries that could inflate its apparent reliability.
		scrubberConfig = { ...isolated, model: activeScrubber.fallbackModel, maxAttempts: 1 };
	}
	const metadata = {
		configVersion: studyConfig.configVersion,
		configHash: studyConfig.configHash,
		promptSha256: createHash('sha256').update(scrubberConfig.prompt).digest('hex'),
		categories: scrubberConfig.categories,
		modelChoice,
		model: scrubberConfig.model.name,
		provider: scrubberConfig.model.provider,
		maxAttempts: scrubberConfig.maxAttempts,
		fallbackEnabled: false,
		semanticValidation: scrubberConfig.semanticValidation ?? null,
		codeSource: 'current checkout; not a production inspection'
	};

	if (sweepAt !== -1) {
		const key = await apiKey();
		const file = args[sweepAt + 1];
		if (!file) throw new Error('--sweep requires a conversations JSONL path');
		const findings = [];
		let scanned = 0;
		const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
		const pending = [];
		for await (const line of lines) {
			if (!line.trim()) continue;
			const conversation = JSON.parse(line);
			for (const message of conversation.messages ?? []) {
				if (message.isInitial || typeof message.content !== 'string' || !message.content) continue;
				pending.push({ conversation, message });
			}
		}
		await mapLimit(pending, CONCURRENCY, async ({ conversation, message }) => {
			scanned += 1;
			try {
				const result = await scrubberModule.scrubUserMessage({
					scrubber: scrubberConfig,
					history: [],
					userMessage: message.content.slice(0, 1_400),
					apiKey: key,
					clientSignal: new AbortController().signal
				});
				if (result.spanCount > 0) {
					findings.push({
						chatSessionKey: conversation.chatSessionKey,
						messageId: message.id,
						role: message.role,
						spanCount: result.spanCount
					});
				}
			} catch (error) {
				findings.push({
					chatSessionKey: conversation.chatSessionKey,
					messageId: message.id,
					role: message.role,
					error: error?.code ?? 'sweep_error'
				});
			}
		});
		console.log(JSON.stringify({ ...metadata, scannedMessages: scanned, findings }, null, 2));
		process.exitCode = findings.length > 0 ? 2 : 0;
		return;
	}

	const fixturePath = fixturesArg
		? fixturesArg
		: fileURLToPath(new URL('../tests/fixtures/pii-jan-v13.json', import.meta.url));
	const fixtureSource = await readFile(fixturePath, 'utf8');
	const suite = JSON.parse(fixtureSource);
	const { cases } = suite;
	const validation = validateFixtures(suite, scrubberConfig.categories);
	const evaluationMetadata = {
		...metadata,
		fixturePath: resolve(fixturePath),
		fixtureSha256: createHash('sha256').update(fixtureSource).digest('hex'),
		fixturePolicy: suite.policy ?? null,
		synthetic: suite.synthetic === true
	};
	if (offline) {
		console.log(JSON.stringify({ ...evaluationMetadata, mode: 'offline-fixture-validation', ...validation, modelCalls: 0 }, null, 2));
		return;
	}
	const key = await apiKey();
	console.log(`scrubber eval: model=${scrubberConfig.model.name} routes=${scrubberConfig.model.provider.only.join(',')}`);
	const latencies = [];
	const perCategory = new Map();
	const bump = (category, field) => {
		const entry = perCategory.get(category) ?? { expected: 0, found: 0, reported: 0, truePositives: 0 };
		entry[field] += 1;
		perCategory.set(category, entry);
	};
	const failures = [];
	let outputValidationFailures = 0;
	let semanticValidationFailures = 0;
	let modelFailureCases = 0;
	const completedAttempts = [];

	await mapLimit(cases, CONCURRENCY, async (fixture) => {
		const startedAt = Date.now();
		let scrubbed;
		try {
			scrubbed = await scrubberModule.scrubUserMessage({
				scrubber: scrubberConfig,
				history: historyFromStrings(fixture.history),
				userMessage: fixture.text,
				apiKey: key,
				clientSignal: new AbortController().signal
			});
		} catch (error) {
			modelFailureCases += 1;
			if (error?.code === 'scrub_invalid_output') outputValidationFailures += 1;
			const validation = error?.diagnostic?.validation;
			if (validation === 'age_retention') semanticValidationFailures += 1;
			failures.push({ id: fixture.id, error: error?.code ?? String(error), ...(validation ? { validation } : {}) });
			for (const expected of fixture.expected) {
				for (const _ of locations(fixture.text, expected)) bump(expected.category, 'expected');
			}
			return;
		}
		completedAttempts.push({ id: fixture.id, attempts: scrubbed.attempts, usedFallback: scrubbed.usedFallback });
		latencies.push(Date.now() - startedAt);
		const evaluated = evaluateFixture(fixture, scrubbed.text);
		for (const expected of evaluated.expected) bump(expected.category, 'expected');
		for (const found of evaluated.found) bump(found.category, 'found');
		for (const reported of evaluated.reported) {
			bump(reported.category, 'reported');
			if (reported.truePositive) bump(reported.category, 'truePositives');
		}
		for (const failure of evaluated.failures) failures.push({ id: fixture.id, ...failure, scrubbed: scrubbed.text });
	});

	const rows = [...perCategory.entries()].map(([category, entry]) => ({
		category,
		expected: entry.expected,
		recall: entry.expected ? (entry.found / entry.expected).toFixed(3) : 'n/a',
		reported: entry.reported,
		precision: entry.reported ? (entry.truePositives / entry.reported).toFixed(3) : 'n/a'
	}));
	const totals = [...perCategory.values()].reduce(
		(sum, entry) => ({
			expected: sum.expected + entry.expected,
			found: sum.found + entry.found,
			reported: sum.reported + entry.reported,
			truePositives: sum.truePositives + entry.truePositives
		}),
		{ expected: 0, found: 0, reported: 0, truePositives: 0 }
	);
	console.table(rows);
	console.log(
		JSON.stringify(
			{
				...evaluationMetadata,
				mode: 'live-isolated-model-evaluation',
				scoring: 'complete non-whitespace coverage per intended occurrence; retained spans must not overlap replacements',
				cases: cases.length,
				modelFailureCases,
				successfulModelCases: cases.length - modelFailureCases,
				completedAttempts,
				overallRecall: totals.expected ? Number((totals.found / totals.expected).toFixed(3)) : null,
				overallPrecision: totals.reported
					? Number((totals.truePositives / totals.reported).toFixed(3))
					: null,
				outputValidationFailures,
				semanticValidationFailures,
				latencyMs: {
					p50: percentile(latencies, 0.5),
					p95: percentile(latencies, 0.95),
					max: Math.max(0, ...latencies)
				},
				failures
			},
			null,
			2
		)
	);
	// Retention errors and false positives are failures too, not an exit-zero
	// report that could be mistaken for a successful acceptance run.
	process.exitCode = failures.length > 0 ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error?.message ?? error);
		process.exitCode = 1;
	});
}
