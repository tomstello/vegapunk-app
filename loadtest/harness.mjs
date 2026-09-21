#!/usr/bin/env node
// Protocol-correct load generator for the v2 chat API.
//
//   node loadtest/harness.mjs --base https://vaccine-chat-loadtest.vercel.app \
//        --arm flu --conversations 200 --concurrency 50 --ramp 60 --turns 3
//
//   node loadtest/harness.mjs --base http://localhost:5173 --arm flu \
//        --conversations 500 --rate 10 --turns 3          # open loop, 10 conv/s
//
// Each conversation: GET the study page, POST /api/v2/session/{arm}, then N
// chat turns that echo the signed history and the redacted user text exactly
// as the browser does. Never calls /api/v2/checkpoint (bulk load must stay off
// Qualtrics). Refuses any host other than the load-test project or localhost.
//
// Reports per-phase latency percentiles, error codes, a time-bucketed
// timeline (for "what happens in the first 60 s"), and, when the server sets
// x-loadtest-instance, the number of distinct function instances seen and
// the latency split between an instance's first second and its steady state.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
	assistantMessage,
	newCheckpointContext,
	serializeSnapshot,
	snapshotRejection,
	userMessage,
	utf8Length
} from './snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE = 'https://vaccine-chat-loadtest.vercel.app';

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) {
			out[key] = 'true';
		} else {
			out[key] = next;
			i += 1;
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === 'true') {
	console.log(`Usage: node loadtest/harness.mjs [options]

  --base <url>            Target origin (default ${DEFAULT_BASE}; localhost allowed)
  --arm <flu|covid|combo|demo>  Study arm (default flu)
  --conversations <n>     Conversations to run (default 10)
  --concurrency <n>       Closed loop: parallel conversations (default 4)
  --ramp <seconds>        Closed loop: stagger worker start over this many seconds (default 0)
  --rate <per-second>     Open loop: start conversations at this rate, unbounded concurrency
  --turns <n>             Chat turns per conversation (default 3)
  --think <ms>            Pause between turns, +/-50% jitter (default 5000)
  --questions <short|long>  Question set: short-answer prompts that bound live-model
                          spend (default), or the open sequence 01 questions
  --no-page               Skip the study page GET
  --timeout <ms>          Per-request timeout (default 200000)
  --bucket <seconds>      Timeline bucket width (default 5)
  --label <name>          Run label; also names the results file
  --out <path>            Results JSON path (default loadtest/results/<label>.json)
  --max-failures <n>      Stop launching conversations and turns once more than n
                          conversations have failed; in-flight requests drain and
                          results are still written (default: no limit)
  --checkpoint <mode>     Also drive /api/v2/checkpoint (default off):
                            off   no checkpoint traffic, as before
                            turn  one write per completed turn, plus the terminal
                                  write: turns + 1 per conversation
                            full  the browser's cadence: user_submitted before
                                  each turn and assistant_completed after it,
                                  plus the terminal write: 2*turns + 1
                          Requires a deployment whose checkpoint store is S3;
                          the run is refused otherwise (see below).

Ctrl-C once stops the same way (drain, then write results). Ctrl-C twice
aborts immediately without results. Exit code 0 = ran to completion,
3 = stopped early with results written, 130 = aborted, 4 = the checkpoint
preflight refused the target. If OPENROUTER_API_KEY is set in the
environment, the account's credit balance is read from openrouter.ai before
and after the run and recorded under meta.credits.

Checkpoint safety: with --checkpoint on, the harness first probes
/api/v2/checkpoint with a deliberately invalid handle. That request is
rejected after the server has selected its store but before it writes
anything, and the rejection carries x-loadtest-checkpoint-store. The run
proceeds only if that header reads "s3". A deployment writing to Qualtrics,
or any host that does not set the header at all, is refused: bulk load must
never reach the study's Qualtrics account.
`);
	process.exit(0);
}

const integer = (value, fallback) => {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) ? parsed : fallback;
};
const number = (value, fallback) => {
	const parsed = Number(value);
	return value !== undefined && Number.isFinite(parsed) ? parsed : fallback;
};

const BASE = (args.base ?? DEFAULT_BASE).replace(/\/$/, '');
const ARM = args.arm ?? 'flu';
const N = integer(args.conversations, 10);
const CONCURRENCY = integer(args.concurrency, 4);
const RAMP_SECONDS = number(args.ramp, 0);
const RATE = args.rate === undefined ? null : number(args.rate, null);
const TURNS = integer(args.turns, 3);
const THINK_MS = integer(args.think, 5_000);
const PAGE = args['no-page'] !== 'true';
const TIMEOUT_MS = integer(args.timeout, 200_000);
const BUCKET_SECONDS = Math.max(1, integer(args.bucket, 5));
const LABEL = args.label ?? new Date().toISOString().replace(/[:.]/g, '-');
const OUT = args.out ?? resolve(HERE, 'results', `${LABEL}.json`);
const MAX_FAILURES = args['max-failures'] === undefined ? null : integer(args['max-failures'], NaN);
if (MAX_FAILURES !== null && !(MAX_FAILURES >= 0)) {
	console.error('--max-failures must be a non-negative integer');
	process.exit(2);
}
// Bare --checkpoint means the browser-faithful cadence.
const CHECKPOINT_MODE = args.checkpoint === 'true' ? 'full' : (args.checkpoint ?? 'off');
if (!['off', 'turn', 'full'].includes(CHECKPOINT_MODE)) {
	console.error(`Unknown checkpoint mode ${CHECKPOINT_MODE}; use off, turn, or full`);
	process.exit(2);
}

const ALLOWED_HOST =
	/^(localhost|127\.0\.0\.1|vaccine-chat-loadtest\.vercel\.app|vaccine-chat-loadtest-[a-z0-9-]+\.vercel\.app)$/;
const host = new URL(BASE).hostname;
if (!ALLOWED_HOST.test(host)) {
	console.error(`Refusing to load ${host}: only the load-test project or localhost are permitted`);
	process.exit(2);
}
if (!['flu', 'covid', 'combo', 'demo'].includes(ARM)) {
	console.error(`Unknown arm ${ARM}`);
	process.exit(2);
}
if (RATE !== null && !(RATE > 0)) {
	console.error('--rate must be a positive number');
	process.exit(2);
}
const PAGE_PATH = ARM === 'demo' ? '/demo/vaccine-chat' : `/study/albertsons-2026/${ARM}`;

// Two question sets. Against the stub the text is irrelevant. Against the
// live model it sets the answer length and therefore the spend: the system
// prompt asks for thorough answers with sources, so an open question ("what
// are the side effects?") runs 15 to 30 s and several hundred output tokens.
// SHORT_QUESTIONS are yes/no or single-fact questions with an explicit
// brevity cue so a turn stays near 100 to 200 output tokens. LONG_QUESTIONS
// is the sequence 01 list, kept for a like-for-like comparison run.
const SHORT_QUESTIONS = [
	'In one sentence: do I need a flu shot every year?',
	'Yes or no, briefly: can I get the flu and COVID shots at the same visit?',
	'In one or two sentences: how long after the shot does protection start?',
	'Briefly: is a sore arm after the shot normal?',
	'One sentence please: is the flu shot free with insurance?',
	'Yes or no, in a sentence: can the flu shot give me the flu?',
	'In two sentences at most: is it safe to get the shot while pregnant?',
	'Briefly: is it okay to get vaccinated if I have a mild cold?',
	'One sentence: does the shot still help if I already had COVID this year?',
	'Briefly: what month is best to get the flu shot?',
	'Yes or no, briefly: should I wait 24 hours before exercising after the shot?',
	'In one sentence: can I take ibuprofen after the shot?'
];
const LONG_QUESTIONS = [
	'Is the flu shot safe for people over 65?',
	'What are the side effects of the COVID vaccine?',
	'Can I get both shots at the same visit?',
	'Do I need a flu shot every year?',
	'I had COVID in June. Do I still need the vaccine?',
	'How long does it take for the vaccine to start working?',
	'Is it safe to get vaccinated while pregnant?',
	'What should I do if I feel unwell after the shot?'
];
const QUESTION_SETS = { short: SHORT_QUESTIONS, long: LONG_QUESTIONS };
const QUESTION_SET = args.questions ?? 'short';
if (!(QUESTION_SET in QUESTION_SETS)) {
	console.error(`Unknown question set ${QUESTION_SET}; use short or long`);
	process.exit(2);
}
const QUESTIONS = QUESTION_SETS[QUESTION_SET];

// --- Measurement helpers -------------------------------------------------------

const RUN_STARTED_AT = performance.now();
const RUN_STARTED_ISO = new Date().toISOString();
const elapsedMs = () => performance.now() - RUN_STARTED_AT;
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const jitter = (ms, fraction = 0.5) =>
	Math.max(0, Math.round(ms * (1 + (Math.random() * 2 - 1) * fraction)));

// Generator self-measurement. Every latency above is a timestamp taken on
// this process's event loop; if the loop is busy, timestamps are late and
// every metric inflates in the same direction as real platform slowness.
// Loop delay and CPU per progress tick make that inflation visible.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = performance.now();
const generatorSamples = [];
function sampleGenerator() {
	const now = performance.now();
	const cpu = process.cpuUsage(lastCpu);
	const elapsedMicros = Math.max(1, (now - lastCpuAt) * 1_000);
	lastCpu = process.cpuUsage();
	lastCpuAt = now;
	const sample = {
		t: Math.round(elapsedMs() / 1_000),
		loopLagP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
		loopLagMaxMs: Math.round(loopDelay.max / 1e6),
		cpuPct: Math.round((100 * (cpu.user + cpu.system)) / elapsedMicros),
		rssMb: Math.round(process.memoryUsage().rss / 1_048_576)
	};
	loopDelay.reset();
	generatorSamples.push(sample);
	return sample;
}

function percentiles(values) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	const at = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
	return {
		n: sorted.length,
		p50: at(0.5),
		p90: at(0.9),
		p95: at(0.95),
		p99: at(0.99),
		max: Math.round(sorted[sorted.length - 1])
	};
}

// Instance bookkeeping from the x-loadtest-instance header (id;age=ms;n=count).
//   cold       the first request this instance ever served (n === 1). Instance
//              age is deliberately not used: test 1 showed instances that were
//              seconds old still paying full initialization on their first hit.
//   routeFirst the first time this instance served this kind of request
//              (page / session / chat), as observed by response order. Each
//              route pays its own lazy initialization per instance.
const instances = new Map();
function noteInstance(headers, kind) {
	const raw = headers.get('x-loadtest-instance');
	if (!raw) return null;
	const [id, ...rest] = raw.split(';');
	const fields = Object.fromEntries(rest.map((part) => part.split('=')));
	const age = Number(fields.age);
	const served = Number(fields.n);
	let record = instances.get(id);
	if (!record) {
		record = { id, firstSeenMs: Math.round(elapsedMs()), requests: 0, routes: {} };
		instances.set(id, record);
	}
	record.requests += 1;
	const routeFirst = !record.routes[kind];
	record.routes[kind] = (record.routes[kind] ?? 0) + 1;
	return { id, age, n: served, cold: served === 1, routeFirst };
}

let requestsInFlight = 0;
async function timedFetch(url, init) {
	requestsInFlight += 1;
	const startedAt = performance.now();
	try {
		const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
		return { response, startedAt, ttfb: performance.now() - startedAt };
	} finally {
		requestsInFlight -= 1;
	}
}

async function readSse(response, startedAt) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const result = {
		firstByte: null,
		firstDelta: null,
		text: '',
		done: null,
		errorCode: null,
		scrubbed: null
	};
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (result.firstByte === null) result.firstByte = performance.now() - startedAt;
		buffer += decoder.decode(value, { stream: true });
		let boundary;
		while ((boundary = buffer.indexOf('\n\n')) >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const eventName = (block.match(/^event: (.+)$/m) ?? [])[1];
			const data = (block.match(/^data: (.+)$/m) ?? [])[1];
			if (!eventName || !data) continue;
			let payload;
			try {
				payload = JSON.parse(data);
			} catch {
				continue;
			}
			if (eventName === 'meta' && typeof payload.scrubbedUserMessage === 'string') {
				result.scrubbed = payload.scrubbedUserMessage;
			} else if (eventName === 'delta') {
				if (result.firstDelta === null) result.firstDelta = performance.now() - startedAt;
				result.text += payload.text ?? '';
			} else if (eventName === 'done') {
				result.done = payload;
			} else if (eventName === 'error') {
				result.errorCode = payload.code ?? 'error';
			}
		}
	}
	return result;
}

async function errorCode(response) {
	try {
		const body = await response.json();
		return body?.error?.code ?? `http_${response.status}`;
	} catch {
		return `http_${response.status}`;
	}
}

// --- Checkpoints -----------------------------------------------------------------
// The transcript checkpoint is the third server-side write in a turn, after the
// scrubber and the answer, and it is the one bulk load used to skip: it went to
// Qualtrics, which must never see synthetic traffic. With CHECKPOINT_STORE=s3 on
// the load-test project it can be exercised, and at these arrival rates it is
// the highest-volume route of the three -- the browser writes twice per turn
// plus once at the end, so a 3-turn conversation is 3 chat requests and 7
// checkpoint requests.

const CHECKPOINT_STORE_HEADER = 'x-loadtest-checkpoint-store';
const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Build, send, and validate one checkpoint. Returns a record of the attempt.
 *
 * A checkpoint failure does not end the conversation -- the browser records a
 * capture error and carries on, and truncating the conversation here would bias
 * the chat latencies this run also measures. The conversation is still marked
 * failed (once, by its first checkpoint error) so that --max-failures can stop
 * a run whose checkpoint store has fallen over.
 */
async function sendCheckpoint(context, sessionToken, reason, { terminal = false } = {}) {
	context.snapshotSequence += 1;
	const nowISO = new Date().toISOString();
	const attempt = {
		seq: context.snapshotSequence,
		reason,
		operation: context.handle ? 'update' : 'create',
		startedMs: Math.round(elapsedMs())
	};

	let serialized;
	try {
		serialized = serializeSnapshot(context, {
			state: terminal ? 'completed' : 'active',
			chatEndISO: terminal ? nowISO : null,
			updatedAtISO: nowISO
		});
	} catch (error) {
		attempt.error = String(error?.message ?? error).slice(0, 80);
		return attempt;
	}

	const body = JSON.stringify({
		v: 2,
		createOperationId: context.createOperationId,
		snapshotSequence: serialized.snapshot.snapshotSequence,
		state: serialized.snapshot.state,
		reasonHint: reason.slice(0, 100),
		transcriptJson: serialized.json,
		...(context.handle ? { checkpointHandle: context.handle } : {})
	});
	attempt.bytes = utf8Length(body);
	const rejection = snapshotRejection(serialized, attempt.bytes);
	if (rejection) {
		// The browser refuses the turn at this point rather than sending a body
		// the server will reject; record it without spending a request.
		attempt.error = rejection;
		return attempt;
	}

	let response;
	let startedAt;
	let ttfb;
	try {
		({ response, startedAt, ttfb } = await timedFetch(`${BASE}/api/v2/checkpoint`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${sessionToken}`
			},
			body
		}));
	} catch (error) {
		const cause = error?.cause;
		const code = cause?.code ?? cause?.errors?.find((e) => e?.code)?.code;
		attempt.error =
			error?.name === 'TimeoutError'
				? 'client_timeout'
				: `client_${String(code ?? error?.message ?? error).slice(0, 80)}`;
		return attempt;
	}

	attempt.status = response.status;
	attempt.ttfb = Math.round(ttfb);
	attempt.instance = noteInstance(response.headers, 'checkpoint');
	attempt.store = response.headers.get(CHECKPOINT_STORE_HEADER);
	attempt.vercelId = response.headers.get('x-vercel-id');
	if (!response.ok) {
		attempt.error = await errorCode(response);
		attempt.total = Math.round(performance.now() - startedAt);
		return attempt;
	}

	const acknowledged = await response.json().catch(() => null);
	attempt.total = Math.round(performance.now() - startedAt);
	if (
		acknowledged?.v !== 2 ||
		typeof acknowledged.checkpointHandle !== 'string' ||
		acknowledged.acknowledgedSequence !== serialized.snapshot.snapshotSequence
	) {
		attempt.error = 'invalid_ack';
		return attempt;
	}
	// The store returns the digest of the exact transcript it persisted. A
	// mismatch means the row does not hold what this conversation sent, which no
	// status code would reveal.
	if (acknowledged.checksum !== sha256Hex(serialized.json)) {
		attempt.error = 'checksum_mismatch';
		return attempt;
	}
	context.handle = acknowledged.checkpointHandle;
	context.acknowledgedSequence = acknowledged.acknowledgedSequence;
	return attempt;
}

/**
 * Prove the target writes checkpoints to S3 before sending any.
 *
 * The probe carries a valid transcript and a junk handle. The route selects its
 * store, then rejects the handle with 409 before touching the store, so this
 * costs one request and writes nothing -- including on a deployment that would
 * have written to Qualtrics, which is the case this exists to catch.
 */
async function verifyCheckpointStore() {
	const sessionResponse = await fetch(`${BASE}/api/v2/session/${ARM}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ v: 2, chatSessionKey: uuid(), attemptNonce: uuid() }),
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	if (!sessionResponse.ok) {
		return { ok: false, detail: `session returned ${await errorCode(sessionResponse)}` };
	}
	const session = await sessionResponse.json();
	const context = newCheckpointContext(session, uuid(), new Date().toISOString());
	context.snapshotSequence += 1;
	const serialized = serializeSnapshot(context, {
		state: 'active',
		chatEndISO: null,
		updatedAtISO: new Date().toISOString()
	});
	const response = await fetch(`${BASE}/api/v2/checkpoint`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${session.sessionToken}`
		},
		body: JSON.stringify({
			v: 2,
			createOperationId: context.createOperationId,
			snapshotSequence: serialized.snapshot.snapshotSequence,
			state: 'active',
			reasonHint: 'loadtest_store_probe',
			transcriptJson: serialized.json,
			checkpointHandle: 'loadtest-store-probe-not-a-real-handle'
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	const store = response.headers.get(CHECKPOINT_STORE_HEADER);
	const code = response.ok ? `http_${response.status}` : await errorCode(response);
	if (store === 's3') return { ok: true, store, code };
	if (store === null) {
		return {
			ok: false,
			code,
			detail:
				`no ${CHECKPOINT_STORE_HEADER} header, so the store cannot be confirmed. The header ` +
				'needs PROVIDER_STUB=1 or LOADTEST_INSTANCE_HEADER=1, and a host the loadtest policy ' +
				'allows (the Vite dev server, or the load-test Vercel project).'
		};
	}
	return {
		ok: false,
		code,
		detail:
			`checkpoint store is "${store}", not "s3". Bulk checkpoint load must not reach Qualtrics. ` +
			'Set CHECKPOINT_STORE=s3 on the load-test project and redeploy.'
	};
}

// --- One conversation ------------------------------------------------------------

let conversationsStarted = 0;
let conversationsFinished = 0;
let conversationsFailed = 0;

// --- Stop switch -----------------------------------------------------------------
// A run that is failing spends money for nothing, and a killed run loses its
// results file. Once a stop is requested, no new conversation starts and no
// conversation starts another turn; requests already open drain naturally
// (answer streams last seconds, bounded by --timeout), then the summary and
// results are written as usual. Triggered by --max-failures or by Ctrl-C.

let stopReason = null;
let stopAtMs = null;

function requestStop(reason) {
	if (stopReason) return;
	stopReason = reason;
	stopAtMs = Math.round(elapsedMs());
	console.error(
		`\n[t=${Math.round(stopAtMs / 1000)}s] STOP (${reason}): no new conversations or turns; ` +
			`draining ${requestsInFlight} in-flight requests, then writing results`
	);
}

process.on('SIGINT', () => {
	if (stopReason) {
		console.error('\nsecond interrupt: aborting without results');
		process.exit(130);
	}
	requestStop('interrupt');
	console.error('(press Ctrl-C again to abort without results)');
});

// --- Credits readout -------------------------------------------------------------
// Optional: with OPENROUTER_API_KEY in the environment, the account balance is
// read before and after the run so spend is recorded with the results. This is
// the one call the harness makes outside the load-test host; it is a read of
// the account, not traffic to the app or a provider.

async function readCredits() {
	const key = process.env.OPENROUTER_API_KEY?.trim();
	if (!key) return null;
	try {
		const response = await fetch('https://openrouter.ai/api/v1/credits', {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10_000)
		});
		if (!response.ok) return { error: `http_${response.status}` };
		const data = (await response.json())?.data;
		if (typeof data?.total_credits !== 'number' || typeof data?.total_usage !== 'number') {
			return { error: 'unexpected_shape' };
		}
		return {
			totalCredits: data.total_credits,
			totalUsage: data.total_usage,
			balance: Math.round((data.total_credits - data.total_usage) * 100) / 100,
			readAt: new Date().toISOString()
		};
	} catch (error) {
		return { error: String(error?.cause?.code ?? error?.name ?? error).slice(0, 80) };
	}
}

async function conversation(index) {
	const record = {
		index,
		startedMs: Math.round(elapsedMs()),
		page: null,
		session: null,
		turns: [],
		checkpoints: [],
		error: null
	};
	// A checkpoint failure is recorded and the conversation continues, as it
	// does in the browser; the first one still marks the conversation failed so
	// the stop switch sees a failing store.
	const noteCheckpoint = (attempt) => {
		record.checkpoints.push(attempt);
		if (attempt.error && !record.error) record.error = `checkpoint_${attempt.error}`;
		return attempt;
	};
	conversationsStarted += 1;
	try {
		if (PAGE) {
			const { response, startedAt, ttfb } = await timedFetch(`${BASE}${PAGE_PATH}`, { method: 'GET' });
			const bytes = (await response.arrayBuffer()).byteLength;
			record.page = {
				status: response.status,
				ttfb: Math.round(ttfb),
				total: Math.round(performance.now() - startedAt),
				bytes,
				instance: noteInstance(response.headers, 'page'),
				vercelId: response.headers.get('x-vercel-id')
			};
			if (!response.ok) {
				record.error = `page_http_${response.status}`;
				return record;
			}
		}

		const sessionRequest = await timedFetch(`${BASE}/api/v2/session/${ARM}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ v: 2, chatSessionKey: uuid(), attemptNonce: uuid() })
		});
		record.session = {
			status: sessionRequest.response.status,
			ttfb: Math.round(sessionRequest.ttfb),
			instance: noteInstance(sessionRequest.response.headers, 'session'),
			vercelId: sessionRequest.response.headers.get('x-vercel-id')
		};
		if (!sessionRequest.response.ok) {
			record.error = `session_${await errorCode(sessionRequest.response)}`;
			return record;
		}
		const session = await sessionRequest.response.json();
		record.session.total = Math.round(performance.now() - sessionRequest.startedAt);
		record.session.configVersion = session.configVersion;

		const checkpoints =
			CHECKPOINT_MODE === 'off'
				? null
				: newCheckpointContext(session, uuid(), new Date().toISOString());

		let history = [];
		let historyTag = session.historyTag;
		for (let sequence = 1; sequence <= TURNS; sequence += 1) {
			if (sequence > 1 && THINK_MS > 0) await sleep(jitter(THINK_MS));
			if (sequence > 1 && stopReason) {
				// Ends cleanly with the turns completed so far; not a failure.
				record.stopped = stopReason;
				break;
			}
			const turnId = uuid();
			const question = QUESTIONS[(index + sequence) % QUESTIONS.length];
			const turn = { seq: sequence, startedMs: Math.round(elapsedMs()) };
			record.turns.push(turn);
			// The browser checkpoints on submit, before the answer exists. The
			// snapshot excludes the in-flight turn (its raw text has not been
			// redacted yet), so this write carries the conversation as it stood.
			if (checkpoints && CHECKPOINT_MODE === 'full') {
				noteCheckpoint(await sendCheckpoint(checkpoints, session.sessionToken, 'user_submitted'));
			}
			const { response, startedAt, ttfb } = await timedFetch(`${BASE}/api/v2/chat`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${session.sessionToken}`,
					'idempotency-key': turnId
				},
				body: JSON.stringify({
					v: 2,
					sequence,
					history,
					historyTag,
					turn: { id: turnId, userMessage: question }
				})
			});
			turn.status = response.status;
			turn.headersMs = Math.round(ttfb);
			turn.instance = noteInstance(response.headers, 'chat');
			turn.vercelId = response.headers.get('x-vercel-id');
			if (!response.ok) {
				turn.error = await errorCode(response);
				turn.total = Math.round(performance.now() - startedAt);
				record.error = `chat_${turn.error}`;
				return record;
			}
			const sse = await readSse(response, startedAt);
			turn.total = Math.round(performance.now() - startedAt);
			turn.firstByte = sse.firstByte === null ? null : Math.round(sse.firstByte);
			turn.firstDelta = sse.firstDelta === null ? null : Math.round(sse.firstDelta);
			turn.chars = sse.text.length;
			if (!sse.done) {
				turn.error = sse.errorCode ?? 'no_done';
				record.error = `chat_${turn.error}`;
				return record;
			}
			// The signed history covers the exact redacted user text and the
			// exact assistant text, so both are echoed verbatim on the next turn.
			const canonical = sse.scrubbed ?? question;
			turn.scrubbed = canonical !== question;
			history = [
				...history,
				{ id: turnId, role: 'user', content: canonical },
				{ id: sse.done.assistantMessageId, role: 'assistant', content: sse.text }
			];
			historyTag = sse.done.historyTag;

			// The transcript stores the redacted user text, never the raw text.
			if (checkpoints) {
				const atISO = new Date().toISOString();
				checkpoints.messages.push(
					userMessage({ id: turnId, turnId, content: canonical, createdAtISO: atISO }),
					assistantMessage({
						id: sse.done.assistantMessageId,
						turnId,
						content: sse.text,
						createdAtISO: atISO
					})
				);
				noteCheckpoint(
					await sendCheckpoint(checkpoints, session.sessionToken, 'assistant_completed')
				);
			}
		}

		// End of chat. The browser writes a terminal snapshot whenever the
		// participant leaves, which for a completed conversation is this one.
		if (checkpoints) {
			noteCheckpoint(
				await sendCheckpoint(checkpoints, session.sessionToken, 'completed', { terminal: true })
			);
		}
		return record;
	} catch (error) {
		// Node's fetch wraps socket errors as TypeError('fetch failed') with the
		// real code on `cause`, or on `cause.errors[]` for multi-address hosts.
		const cause = error?.cause;
		const code = cause?.code ?? cause?.errors?.find((e) => e?.code)?.code;
		record.error =
			error?.name === 'TimeoutError'
				? 'client_timeout'
				: `client_${String(code ?? cause?.message ?? error?.message ?? error).slice(0, 80)}`;
		// A client-side failure during a chat request leaves the turn without a
		// status; stamp it so the turn error map counts it like an HTTP error.
		const lastTurn = record.turns.at(-1);
		if (lastTurn && lastTurn.status === undefined && lastTurn.error === undefined) {
			lastTurn.error = record.error;
			lastTurn.total = Math.round(elapsedMs()) - lastTurn.startedMs;
		}
		return record;
	} finally {
		record.endedMs = Math.round(elapsedMs());
		conversationsFinished += 1;
		if (record.error) {
			conversationsFailed += 1;
			if (MAX_FAILURES !== null && conversationsFailed > MAX_FAILURES) {
				requestStop(`max_failures (${conversationsFailed} > ${MAX_FAILURES})`);
			}
		}
	}
}

// --- Scheduling ------------------------------------------------------------------

async function runClosedLoop(results) {
	let next = 0;
	const workers = Math.max(1, Math.min(CONCURRENCY, N));
	await Promise.all(
		Array.from({ length: workers }, async (_, worker) => {
			if (RAMP_SECONDS > 0) await sleep((worker * RAMP_SECONDS * 1_000) / workers);
			while (next < N && !stopReason) {
				const index = next;
				next += 1;
				results[index] = await conversation(index);
			}
		})
	);
}

async function runOpenLoop(results) {
	const interval = 1_000 / RATE;
	const pending = [];
	const startedAt = performance.now();
	for (let index = 0; index < N; index += 1) {
		if (stopReason) break;
		pending.push(
			conversation(index).then((record) => {
				results[index] = record;
			})
		);
		const due = startedAt + (index + 1) * interval;
		const wait = due - performance.now();
		if (index < N - 1 && wait > 0) await sleep(wait);
	}
	await Promise.all(pending);
}

// --- Reporting -------------------------------------------------------------------

function summarize(results) {
	const conversations = results.filter(Boolean);
	const pages = conversations.map((c) => c.page).filter(Boolean);
	const sessions = conversations.map((c) => c.session).filter(Boolean);
	const turns = conversations.flatMap((c) => c.turns);
	const okTurns = turns.filter((t) => !t.error && t.total !== undefined);
	const checkpoints = conversations.flatMap((c) => c.checkpoints ?? []);
	const okCheckpoints = checkpoints.filter((a) => !a.error);
	const errors = {};
	for (const c of conversations) if (c.error) errors[c.error] = (errors[c.error] ?? 0) + 1;

	const instanceRequests = [
		...pages.map((p) => ({ kind: 'page', ms: p.ttfb, instance: p.instance })),
		...sessions.map((s) => ({ kind: 'session', ms: s.ttfb, instance: s.instance })),
		...okTurns.map((t) => ({ kind: 'chat', ms: t.firstByte, instance: t.instance })),
		...okCheckpoints.map((a) => ({ kind: 'checkpoint', ms: a.ttfb, instance: a.instance }))
	].filter((r) => r.instance);
	// Three buckets per phase: the instance's very first request, the first
	// request of this route on an already-used instance, and everything else.
	const bucketOf = (r) => (r.instance.cold ? 'cold' : r.instance.routeFirst ? 'routeFirst' : 'warm');
	const split = (kind) => {
		const rows = instanceRequests.filter((r) => r.kind === kind);
		return {
			cold: percentiles(rows.filter((r) => bucketOf(r) === 'cold').map((r) => r.ms)),
			routeFirst: percentiles(rows.filter((r) => bucketOf(r) === 'routeFirst').map((r) => r.ms)),
			warm: percentiles(rows.filter((r) => bucketOf(r) === 'warm').map((r) => r.ms))
		};
	};

	return {
		conversations: {
			requested: N,
			completed: conversations.length,
			ok: conversations.filter((c) => !c.error).length,
			failed: conversations.filter((c) => c.error).length,
			errors
		},
		page: {
			ttfbMs: percentiles(pages.map((p) => p.ttfb)),
			totalMs: percentiles(pages.map((p) => p.total)),
			statuses: countBy(pages.map((p) => p.status))
		},
		session: {
			ttfbMs: percentiles(sessions.map((s) => s.ttfb)),
			totalMs: percentiles(sessions.map((s) => s.total)),
			statuses: countBy(sessions.map((s) => s.status))
		},
		chat: {
			attempted: turns.length,
			ok: okTurns.length,
			failed: turns.length - okTurns.length,
			errors: countBy(turns.filter((t) => t.error).map((t) => t.error)),
			headersMs: percentiles(okTurns.map((t) => t.headersMs)),
			firstByteMs: percentiles(okTurns.map((t) => t.firstByte)),
			firstDeltaMs: percentiles(okTurns.map((t) => t.firstDelta)),
			totalMs: percentiles(okTurns.map((t) => t.total)),
			answerChars: percentiles(okTurns.map((t) => t.chars)),
			scrubbedTurns: okTurns.filter((t) => t.scrubbed).length
		},
		checkpoint:
			CHECKPOINT_MODE === 'off'
				? null
				: {
						mode: CHECKPOINT_MODE,
						attempted: checkpoints.length,
						ok: okCheckpoints.length,
						failed: checkpoints.length - okCheckpoints.length,
						errors: countBy(checkpoints.filter((a) => a.error).map((a) => a.error)),
						// One create per conversation; every later write is an update
						// against the signed handle. More creates than conversations
						// means handles were lost and rows duplicated.
						creates: okCheckpoints.filter((a) => a.operation === 'create').length,
						updates: okCheckpoints.filter((a) => a.operation === 'update').length,
						stores: countBy(checkpoints.map((a) => a.store).filter(Boolean)),
						ttfbMs: percentiles(okCheckpoints.map((a) => a.ttfb)),
						totalMs: percentiles(okCheckpoints.map((a) => a.total)),
						requestBytes: percentiles(checkpoints.map((a) => a.bytes))
					},
		instances:
			instances.size === 0
				? null
				: {
						distinct: instances.size,
						requestsWithHeader: instanceRequests.length,
						coldRequests: instanceRequests.filter((r) => r.instance.cold).length,
						routeFirstRequests: instanceRequests.filter((r) => bucketOf(r) === 'routeFirst').length,
						pageTtfb: split('page'),
						sessionTtfb: split('session'),
						chatFirstByte: split('chat'),
						checkpointTtfb: split('checkpoint')
					}
	};
}

function countBy(values) {
	const out = {};
	for (const value of values) out[value] = (out[value] ?? 0) + 1;
	return out;
}

function timeline(results) {
	const buckets = new Map();
	const width = BUCKET_SECONDS * 1_000;
	const bucketFor = (ms) => Math.floor(ms / width) * BUCKET_SECONDS;
	const get = (ms) => {
		const key = bucketFor(ms);
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = {
				t: key,
				started: 0,
				sessionsDone: 0,
				sessionTtfb: [],
				turnsDone: 0,
				chatFirstByte: [],
				chatTotal: [],
				checkpointsDone: 0,
				checkpointTotal: [],
				errors: 0,
				newInstances: 0
			};
			buckets.set(key, bucket);
		}
		return bucket;
	};
	for (const c of results.filter(Boolean)) {
		get(c.startedMs).started += 1;
		if (c.session?.total !== undefined) {
			const b = get(c.startedMs + (c.page?.total ?? 0));
			b.sessionsDone += 1;
			b.sessionTtfb.push(c.session.ttfb);
		}
		for (const t of c.turns) {
			if (t.error || t.total === undefined) continue;
			const b = get(t.startedMs + t.total);
			b.turnsDone += 1;
			b.chatFirstByte.push(t.firstByte);
			b.chatTotal.push(t.total);
		}
		for (const a of c.checkpoints ?? []) {
			if (a.error || a.total === undefined) continue;
			const b = get(a.startedMs + a.total);
			b.checkpointsDone += 1;
			b.checkpointTotal.push(a.total);
		}
		if (c.error) get(c.endedMs).errors += 1;
	}
	for (const instance of instances.values()) get(instance.firstSeenMs).newInstances += 1;
	// Fill quiet buckets so the table reads as a continuous timeline.
	const lastBucket = Math.max(0, ...buckets.keys());
	for (let t = 0; t <= lastBucket; t += BUCKET_SECONDS) get(t * 1_000);
	// Worst generator sample that falls inside each bucket.
	const generatorByBucket = new Map();
	for (const s of generatorSamples) {
		const key = bucketFor(s.t * 1_000);
		const current = generatorByBucket.get(key);
		if (!current || s.loopLagP99Ms > current.loopLagP99Ms) generatorByBucket.set(key, s);
	}
	return [...buckets.values()]
		.sort((a, b) => a.t - b.t)
		.map((b) => ({
			t: b.t,
			started: b.started,
			sessionsDone: b.sessionsDone,
			sessionTtfbP50: percentiles(b.sessionTtfb)?.p50 ?? null,
			turnsDone: b.turnsDone,
			chatFirstByteP50: percentiles(b.chatFirstByte)?.p50 ?? null,
			chatTotalP50: percentiles(b.chatTotal)?.p50 ?? null,
			checkpointsDone: b.checkpointsDone,
			checkpointTotalP50: percentiles(b.checkpointTotal)?.p50 ?? null,
			errors: b.errors,
			newInstances: b.newInstances,
			genLoopLagP99Ms: generatorByBucket.get(b.t)?.loopLagP99Ms ?? null,
			genCpuPct: generatorByBucket.get(b.t)?.cpuPct ?? null
		}));
}

function formatPct(p) {
	if (!p) return '-';
	return `n=${p.n} p50=${p.p50} p90=${p.p90} p95=${p.p95} p99=${p.p99} max=${p.max}`;
}

function printSummary(summary, rows) {
	const c = summary.conversations;
	console.log('');
	console.log(`== ${LABEL} ==  ${BASE}  arm=${ARM}  conversations=${N}  turns=${TURNS}`);
	console.log(
		(RATE
			? `mode=open-loop rate=${RATE}/s`
			: `mode=closed-loop concurrency=${CONCURRENCY} ramp=${RAMP_SECONDS}s`) +
			`  checkpoint=${CHECKPOINT_MODE}`
	);
	console.log(`conversations ok=${c.ok} failed=${c.failed} errors=${JSON.stringify(c.errors)}`);
	if (PAGE) console.log(`page ttfb (ms)      ${formatPct(summary.page.ttfbMs)}`);
	console.log(`session ttfb (ms)   ${formatPct(summary.session.ttfbMs)}`);
	console.log(`chat headers (ms)   ${formatPct(summary.chat.headersMs)}`);
	console.log(`chat first byte(ms) ${formatPct(summary.chat.firstByteMs)}`);
	console.log(`chat first delta    ${formatPct(summary.chat.firstDeltaMs)}`);
	console.log(`chat total (ms)     ${formatPct(summary.chat.totalMs)}`);
	console.log(
		`chat turns ok=${summary.chat.ok} failed=${summary.chat.failed} errors=${JSON.stringify(summary.chat.errors)}`
	);
	if (summary.checkpoint) {
		const k = summary.checkpoint;
		console.log(`ckpt ttfb (ms)      ${formatPct(k.ttfbMs)}`);
		console.log(`ckpt total (ms)     ${formatPct(k.totalMs)}`);
		console.log(`ckpt req bytes      ${formatPct(k.requestBytes)}`);
		console.log(
			`checkpoints mode=${k.mode} ok=${k.ok} failed=${k.failed} creates=${k.creates} updates=${k.updates} ` +
				`stores=${JSON.stringify(k.stores)} errors=${JSON.stringify(k.errors)}`
		);
		if (k.creates > summary.conversations.completed) {
			console.log(
				`  <-- ${k.creates} creates for ${summary.conversations.completed} conversations: ` +
					'handles were lost, so the store holds duplicate rows'
			);
		}
	}
	if (summary.instances) {
		const i = summary.instances;
		console.log(
			`instances distinct=${i.distinct} requestsWithHeader=${i.requestsWithHeader} coldRequests=${i.coldRequests} routeFirstRequests=${i.routeFirstRequests}`
		);
		console.log('  (cold = instance\'s first request; routeFirst = first of this route on an instance)');
		for (const [label, phase] of [
			['page ttfb', i.pageTtfb],
			['session ttfb', i.sessionTtfb],
			['chat first byte', i.chatFirstByte],
			['checkpoint ttfb', i.checkpointTtfb]
		]) {
			if (label === 'page ttfb' && !PAGE) continue;
			if (label === 'checkpoint ttfb' && CHECKPOINT_MODE === 'off') continue;
			console.log(`  ${label.padEnd(16)} cold        ${formatPct(phase.cold)}`);
			console.log(`  ${''.padEnd(16)} routeFirst  ${formatPct(phase.routeFirst)}`);
			console.log(`  ${''.padEnd(16)} warm        ${formatPct(phase.warm)}`);
		}
	} else {
		console.log('instances: no x-loadtest-instance header seen (enable PROVIDER_STUB or LOADTEST_INSTANCE_HEADER)');
	}
	if (generatorSamples.length > 0) {
		const lag = Math.max(...generatorSamples.map((s) => s.loopLagP99Ms));
		const lagMax = Math.max(...generatorSamples.map((s) => s.loopLagMaxMs));
		const cpu = Math.max(...generatorSamples.map((s) => s.cpuPct));
		const rss = Math.max(...generatorSamples.map((s) => s.rssMb));
		console.log(
			`generator: event-loop lag p99 max=${lag}ms (single worst=${lagMax}ms) cpu max=${cpu}% rss max=${rss}MB` +
				// An idle loop on macOS reads 15-25 ms here from timer coalescing; real
				// saturation shows as sustained tens to hundreds of milliseconds.
				(lag > 50 ? '  <-- generator lag is inflating latencies in the affected buckets' : '')
		);
	}
	console.log('');
	console.log(
		't(s)   started sessDone sessP50 turnsDone chatFBp50 chatTotP50' +
			(CHECKPOINT_MODE === 'off' ? '' : ' ckptDone ckptP50') +
			' errors newInst genLag genCPU'
	);
	for (const r of rows) {
		console.log(
			[
				String(r.t).padStart(5),
				String(r.started).padStart(8),
				String(r.sessionsDone).padStart(8),
				String(r.sessionTtfbP50 ?? '-').padStart(7),
				String(r.turnsDone).padStart(9),
				String(r.chatFirstByteP50 ?? '-').padStart(9),
				String(r.chatTotalP50 ?? '-').padStart(10),
				...(CHECKPOINT_MODE === 'off'
					? []
					: [String(r.checkpointsDone).padStart(8), String(r.checkpointTotalP50 ?? '-').padStart(7)]),
				String(r.errors).padStart(6),
				String(r.newInstances).padStart(7),
				String(r.genLoopLagP99Ms ?? '-').padStart(6),
				String(r.genCpuPct ?? '-').padStart(6)
			].join(' ')
		);
	}
}

// --- Main ------------------------------------------------------------------------

const results = new Array(N);

// Refuse the run rather than discover mid-flight that thousands of synthetic
// transcripts are landing in the study's Qualtrics account.
let checkpointProbe = null;
if (CHECKPOINT_MODE !== 'off') {
	checkpointProbe = await verifyCheckpointStore();
	if (!checkpointProbe.ok) {
		console.error(`\nrefusing to send checkpoints to ${BASE}: ${checkpointProbe.detail}`);
		if (checkpointProbe.code) console.error(`(store probe was answered with ${checkpointProbe.code})`);
		process.exit(4);
	}
	console.error(
		`checkpoint store confirmed: s3 (probe rejected as ${checkpointProbe.code}, nothing written)`
	);
}

const creditsBefore = await readCredits();
if (creditsBefore?.balance !== undefined) console.error(`credits before: $${creditsBefore.balance.toFixed(2)}`);
const progress = setInterval(() => {
	const g = sampleGenerator();
	console.error(
		`[t=${g.t}s] started=${conversationsStarted}/${N} finished=${conversationsFinished} failed=${conversationsFailed} inFlight=${requestsInFlight} instances=${instances.size} lagP99=${g.loopLagP99Ms}ms cpu=${g.cpuPct}%`
	);
}, 5_000);

try {
	if (RATE) await runOpenLoop(results);
	else await runClosedLoop(results);
} finally {
	clearInterval(progress);
	sampleGenerator();
	loopDelay.disable();
}

const summary = summarize(results);
const rows = timeline(results);
printSummary(summary, rows);

const creditsAfter = await readCredits();
const credits =
	creditsBefore || creditsAfter
		? {
				before: creditsBefore,
				after: creditsAfter,
				spent:
					creditsBefore?.balance !== undefined && creditsAfter?.balance !== undefined
						? Math.round((creditsBefore.balance - creditsAfter.balance) * 100) / 100
						: null
			}
		: null;
if (credits?.spent !== null && credits?.spent !== undefined) {
	const okTurns = summary.chat.ok || 0;
	console.log(
		`credits: $${creditsBefore.balance.toFixed(2)} -> $${creditsAfter.balance.toFixed(2)}  spent $${credits.spent.toFixed(2)}` +
			(okTurns ? `  ($${(credits.spent / okTurns).toFixed(4)} per successful turn)` : '')
	);
}
if (stopReason) {
	console.log(
		`stopped early: ${stopReason} at t=${Math.round(stopAtMs / 1000)}s; ` +
			`${conversationsStarted} of ${N} conversations started, ${results.filter((r) => r?.stopped).length} cut short`
	);
}

const report = {
	meta: {
		label: LABEL,
		base: BASE,
		arm: ARM,
		startedAt: RUN_STARTED_ISO,
		wallSeconds: Math.round(elapsedMs() / 100) / 10,
		conversations: N,
		turns: TURNS,
		questions: QUESTION_SET,
		thinkMs: THINK_MS,
		page: PAGE,
		checkpoint:
			CHECKPOINT_MODE === 'off'
				? { mode: 'off' }
				: { mode: CHECKPOINT_MODE, store: checkpointProbe.store, probeCode: checkpointProbe.code },
		mode: RATE ? { openLoop: true, ratePerSecond: RATE } : { closedLoop: true, concurrency: CONCURRENCY, rampSeconds: RAMP_SECONDS },
		maxFailures: MAX_FAILURES,
		stop: stopReason
			? { reason: stopReason, atSeconds: Math.round(stopAtMs / 100) / 10, conversationsStarted, conversationsCutShort: results.filter((r) => r?.stopped).length }
			: null,
		credits,
		node: process.version
	},
	summary,
	timeline: rows,
	generator: generatorSamples,
	instances: [...instances.values()],
	conversations: results
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2));
console.log(`\nresults written to ${OUT}`);
// 0: ran to completion. 3: stopped early by --max-failures or Ctrl-C, with
// results written. (A second Ctrl-C exits 130 without results.)
process.exitCode = stopReason ? 3 : 0;
