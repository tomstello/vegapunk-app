import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let stub;
let openrouter;
let scrubber;
let configs;

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
				name: 'unit-test-private-env',
				setup(esbuild) {
					esbuild.onResolve({ filter: /^\$env\/dynamic\/private$/ }, () => ({
						path: 'unit-test-private-env',
						namespace: 'unit-test'
					}));
					esbuild.onLoad({ filter: /.*/, namespace: 'unit-test' }, () => ({
						contents: 'export const env = {};',
						loader: 'js'
					}));
				}
			}
		]
	});
	const source = result.outputFiles[0].text;
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

before(async () => {
	[stub, openrouter, scrubber, configs] = await Promise.all([
		loadServerModule('src/lib/server/v2/loadtestStub.ts'),
		loadServerModule('src/lib/server/v2/openrouter.ts'),
		loadServerModule('src/lib/server/v2/scrubber.ts'),
		loadServerModule('src/lib/server/v2/studyConfig.ts')
	]);
});

const FAST = Object.freeze({
	scrubMs: 1,
	firstByteMs: 5,
	streamMs: 40,
	answerChars: 120,
	chunkMs: 10,
	jitter: 0,
	errorRate: 0,
	retryAfterSeconds: 0
});

const LOADTEST_HOST = 'vaccine-chat-loadtest.vercel.app';

function pick(policy) {
	return { stub: policy.stub, instanceHeader: policy.instanceHeader, refused: policy.refused };
}

function withStubFetch(settings, fn) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (_url, init) =>
		stub.createStubProviderResponse(String(init.body), settings, init.signal);
	return fn().finally(() => {
		globalThis.fetch = originalFetch;
	});
}

test('loadtest policy is off by default and off without the PROVIDER_STUB=1 literal', () => {
	assert.deepEqual(pick(stub.resolveLoadtestPolicy({})), {
		stub: false,
		instanceHeader: false,
		refused: false
	});
	assert.deepEqual(
		pick(stub.resolveLoadtestPolicy({ PROVIDER_STUB: 'true', NODE_ENV: 'development' })),
		{ stub: false, instanceHeader: false, refused: false }
	);
	assert.deepEqual(pick(stub.resolveLoadtestPolicy({ PROVIDER_STUB: '', NODE_ENV: 'development' })), {
		stub: false,
		instanceHeader: false,
		refused: false
	});
});

test('loadtest policy engages on the dev server and on the loadtest Vercel project only', () => {
	assert.deepEqual(pick(stub.resolveLoadtestPolicy({ PROVIDER_STUB: '1', NODE_ENV: 'development' })), {
		stub: true,
		instanceHeader: true,
		refused: false
	});
	assert.deepEqual(
		pick(
			stub.resolveLoadtestPolicy({
				PROVIDER_STUB: '1',
				NODE_ENV: 'production',
				VERCEL: '1',
				VERCEL_PROJECT_PRODUCTION_URL: LOADTEST_HOST
			})
		),
		{ stub: true, instanceHeader: true, refused: false }
	);
	// Production project with a drifted env: refused, real provider traffic continues.
	assert.deepEqual(
		pick(
			stub.resolveLoadtestPolicy({
				PROVIDER_STUB: '1',
				NODE_ENV: 'production',
				VERCEL: '1',
				VERCEL_PROJECT_PRODUCTION_URL: 'vegapunk-albertsons.vercel.app'
			})
		),
		{ stub: false, instanceHeader: false, refused: true }
	);
	// Vercel without the system env exposed, or a production build elsewhere: refused.
	assert.deepEqual(pick(stub.resolveLoadtestPolicy({ PROVIDER_STUB: '1', NODE_ENV: 'production' })), {
		stub: false,
		instanceHeader: false,
		refused: true
	});
	assert.deepEqual(
		pick(stub.resolveLoadtestPolicy({ PROVIDER_STUB: '1', NODE_ENV: 'production', VERCEL: '1' })),
		{ stub: false, instanceHeader: false, refused: true }
	);
});

test('instance header can be enabled without stubbing, under the same host guard', () => {
	assert.deepEqual(
		pick(stub.resolveLoadtestPolicy({ LOADTEST_INSTANCE_HEADER: '1', NODE_ENV: 'development' })),
		{ stub: false, instanceHeader: true, refused: false }
	);
	assert.deepEqual(
		pick(
			stub.resolveLoadtestPolicy({
				LOADTEST_INSTANCE_HEADER: '1',
				NODE_ENV: 'production',
				VERCEL: '1',
				VERCEL_PROJECT_PRODUCTION_URL: 'vegapunk-albertsons.vercel.app'
			})
		),
		{ stub: false, instanceHeader: false, refused: true }
	);
	assert.match(stub.instanceHeaderValue(), /^[0-9a-f]{8};age=\d+;n=\d+$/);
});

test('stub settings parse from the environment with clamping and defaults', () => {
	const defaults = stub.resolveStubSettings({});
	assert.equal(defaults.scrubMs, 750);
	assert.equal(defaults.firstByteMs, 2_000);
	assert.equal(defaults.streamMs, 6_000);
	assert.equal(defaults.answerChars, 900);
	assert.equal(defaults.errorRate, 0);
	const custom = stub.resolveStubSettings({
		STUB_FIRST_BYTE_MS: '10',
		STUB_ANSWER_CHARS: '999999',
		STUB_JITTER: 'nonsense',
		STUB_ERROR_RATE: '-1'
	});
	assert.equal(custom.firstByteMs, 10);
	assert.equal(custom.answerChars, 15_000);
	assert.equal(custom.jitter, 0.3);
	assert.equal(custom.errorRate, 0);
});

test('stub answer stream is consumed by the real OpenRouter relay as a complete answer', async () => {
	await withStubFetch(FAST, async () => {
		const config = configs.getStudyConfig('flu');
		const stream = await openrouter.startOpenRouterStream({
			config,
			history: [],
			userMessage: 'Is the flu shot safe for people over 65?',
			providerSessionId: 'session-under-test',
			apiKey: 'unit-test-key',
			clientSignal: new AbortController().signal
		});
		assert.match(stream.generationId, /^stub-/);
		const events = [];
		for await (const event of stream.events()) events.push(event);
		const deltas = events.filter((event) => event.kind === 'delta');
		assert.ok(deltas.length > 1, 'answer arrives as multiple deltas');
		assert.equal(deltas.map((event) => event.text).join('').length, FAST.answerChars);
		assert.deepEqual(events.at(-1), { kind: 'done', finishReason: 'stop' });
	});
});

test('stub scrubber response passes the redaction module through unchanged', async () => {
	const scrubberConfig = configs.getStudyConfig('flu').scrubber;
	assert.ok(scrubberConfig, 'active flu revision configures a scrubber');
	await withStubFetch(FAST, async () => {
		const result = await scrubber.scrubUserMessage({
			scrubber: scrubberConfig,
			history: [],
			userMessage: 'Do I need a flu shot every year?',
			apiKey: 'unit-test-key',
			clientSignal: new AbortController().signal
		});
		assert.equal(result.text, 'Do I need a flu shot every year?');
		assert.equal(result.spanCount, 0);
		assert.equal(result.attempts, 1);
		assert.equal(result.usedFallback, false);
	});
});

test('stub error injection surfaces as a provider_busy start failure', async () => {
	await withStubFetch({ ...FAST, errorRate: 1 }, async () => {
		await assert.rejects(
			openrouter.startOpenRouterStream({
				config: configs.getStudyConfig('flu'),
				history: [],
				userMessage: 'Hello',
				providerSessionId: 'session-under-test',
				apiKey: 'unit-test-key',
				clientSignal: new AbortController().signal
			}),
			(error) =>
				error instanceof openrouter.OpenRouterStartError &&
				error.code === 'provider_busy' &&
				error.status === 429
		);
	});
});

test('stub stream stops when the client aborts mid-answer', async () => {
	const client = new AbortController();
	await withStubFetch({ ...FAST, streamMs: 2_000, chunkMs: 20, answerChars: 2_000 }, async () => {
		const stream = await openrouter.startOpenRouterStream({
			config: configs.getStudyConfig('flu'),
			history: [],
			userMessage: 'Hello',
			providerSessionId: 'session-under-test',
			apiKey: 'unit-test-key',
			clientSignal: client.signal
		});
		const events = [];
		const startedAt = Date.now();
		for await (const event of stream.events()) {
			events.push(event);
			if (events.length === 2) client.abort();
		}
		assert.ok(Date.now() - startedAt < 1_500, 'stream ended promptly after abort');
		assert.equal(events.at(-1).kind, 'error');
	});
});
