#!/usr/bin/env node
// Scrubber evaluation harness ("V7 SCRUB REVISION - design" §10).
//
// Loads the PRODUCTION scrubber module and active v7 scrubber configuration
// via esbuild (same technique as the unit tests), so the eval exercises the
// exact prompt, provider policy, span verification, and substitution code
// that serves participants. Two modes:
//
//   node scripts/scrubber-eval.mjs                         # planted-PII eval
//   node scripts/scrubber-eval.mjs --model haiku           # Haiku 4.5 variant
//   node scripts/scrubber-eval.mjs --sweep conversations.jsonl
//                                                          # report-only sweep
//
// The sweep mode reads parse_transcripts_v6.py JSONL output and reports any
// PII the detector still finds in stored (already-redacted) transcripts —
// the in-the-wild recall evidence. It never modifies anything.
//
// Credentials: OPENROUTER_API_KEY from the environment, else read directly
// from ../.env (never printed, never logged). Calls run under the same
// US/ZDR provider policy as production.

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

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

function spanMatches(expected, reported) {
	if (expected.category !== reported.category) return false;
	return (
		expected.text === reported.text ||
		reported.text.includes(expected.text) ||
		expected.text.includes(reported.text)
	);
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
function reportedSpans(rawText, scrubbedText) {
	// Reconstruct replacements by aligning around placeholders.
	const spans = [];
	const placeholder = /\[([A-Z]{2,16})_(\d{1,3})\]/g;
	// Walk both strings; when the scrubbed text hits a placeholder, find the
	// next anchor (text after the placeholder up to the following placeholder)
	// in the raw string to recover the replaced substring.
	let rawIndex = 0;
	let scrubIndex = 0;
	let match;
	const matches = [...scrubbedText.matchAll(placeholder)];
	for (let i = 0; i < matches.length; i += 1) {
		match = matches[i];
		const literalBefore = scrubbedText.slice(scrubIndex, match.index);
		rawIndex += literalBefore.length;
		scrubIndex = match.index + match[0].length;
		const nextStart = i + 1 < matches.length ? matches[i + 1].index : scrubbedText.length;
		const anchor = scrubbedText.slice(scrubIndex, nextStart);
		const rawEnd = anchor.length > 0 ? rawText.indexOf(anchor, rawIndex) : rawText.length;
		if (rawEnd === -1) return null; // alignment failed; caller flags it
		spans.push({ text: rawText.slice(rawIndex, rawEnd), category: match[1] });
		rawIndex = rawEnd;
	}
	return spans;
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
	const modelChoice = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sonnet';

	const [configs, scrubberModule] = await Promise.all([
		loadServerModule('src/lib/server/v2/studyConfig.ts'),
		loadServerModule('src/lib/server/v2/scrubber.ts')
	]);
	const activeScrubber = configs.getStudyConfig('flu').scrubber;
	if (!activeScrubber) throw new Error('active registry has no scrubber configuration');
	const scrubberConfig =
		modelChoice === 'haiku'
			? {
					...activeScrubber,
					model: {
						...activeScrubber.model,
						name: 'anthropic/claude-haiku-4.5',
						// Haiku 4.5 has exactly one US-resident ZDR route today
						// (2026-08-11 inventory); single-route fragility is why it
						// is the fallback, not the default.
						provider: { ...activeScrubber.model.provider, only: ['google-vertex/us-east5'] }
				}
			}
			: activeScrubber;
	const key = await apiKey();
	console.log(`scrubber eval: model=${scrubberConfig.model.name} routes=${scrubberConfig.model.provider.only.join(',')}`);

	if (sweepAt !== -1) {
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
		console.log(JSON.stringify({ scannedMessages: scanned, findings }, null, 2));
		process.exitCode = findings.length > 0 ? 2 : 0;
		return;
	}

	const fixturePath = fileURLToPath(new URL('../tests/fixtures/pii-planted.json', import.meta.url));
	const { cases } = JSON.parse(await readFile(fixturePath, 'utf8'));
	const latencies = [];
	const perCategory = new Map();
	const bump = (category, field) => {
		const entry = perCategory.get(category) ?? { expected: 0, found: 0, reported: 0, truePositives: 0 };
		entry[field] += 1;
		perCategory.set(category, entry);
	};
	const failures = [];
	let verbatimFailures = 0;

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
			if (error?.code === 'scrub_invalid_output') verbatimFailures += 1;
			failures.push({ id: fixture.id, error: error?.code ?? String(error) });
			for (const expected of fixture.expected) bump(expected.category, 'expected');
			return;
		}
		latencies.push(Date.now() - startedAt);
		const reported = reportedSpans(fixture.text, scrubbed.text);
		if (reported === null) {
			failures.push({ id: fixture.id, error: 'alignment_failed', scrubbed: scrubbed.text });
			for (const expected of fixture.expected) bump(expected.category, 'expected');
			return;
		}
		const unmatchedReported = [...reported];
		for (const expected of fixture.expected) {
			bump(expected.category, 'expected');
			const index = unmatchedReported.findIndex((span) => spanMatches(expected, span));
			if (index !== -1) {
				bump(expected.category, 'found');
				bump(expected.category, 'truePositives');
				unmatchedReported.splice(index, 1);
			} else {
				failures.push({ id: fixture.id, missed: expected, scrubbed: scrubbed.text });
			}
		}
		for (const span of reported) bump(span.category, 'reported');
		for (const extra of unmatchedReported) {
			failures.push({ id: fixture.id, falsePositive: extra, scrubbed: scrubbed.text });
		}
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
				cases: cases.length,
				overallRecall: totals.expected ? Number((totals.found / totals.expected).toFixed(3)) : null,
				overallPrecision: totals.reported
					? Number((totals.truePositives / totals.reported).toFixed(3))
					: null,
				verbatimFailures,
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
	// Acceptance bar from the design doc: names/contacts recall >= 0.95, p95 <= ~2s.
	process.exitCode = failures.some((failure) => failure.missed || failure.error) ? 2 : 0;
}

main().catch((error) => {
	console.error(error?.message ?? error);
	process.exitCode = 1;
});
