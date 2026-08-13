import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

let tokens;
let schemas;
let configs;
let checkpoint;
let openrouter;
let crypto;
let http;
let scrubber;

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
	[tokens, schemas, configs, checkpoint, openrouter, crypto, http, scrubber] = await Promise.all([
		loadServerModule('src/lib/server/v2/tokens.ts'),
		loadServerModule('src/lib/server/v2/schemas.ts'),
		loadServerModule('src/lib/server/v2/studyConfig.ts'),
		loadServerModule('src/lib/server/v2/qualtricsCheckpoint.ts'),
		loadServerModule('src/lib/server/v2/openrouter.ts'),
		loadServerModule('src/lib/server/v2/crypto.ts'),
		loadServerModule('src/lib/server/v2/http.ts'),
		loadServerModule('src/lib/server/v2/scrubber.ts')
	]);
});

const SECRET = 'unit-test-secret-that-is-more-than-thirty-two-bytes';
const SESSION_ID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const ATTEMPT_ID = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
const OPERATION_ID = '6ba7b812-9dad-41d1-80b4-00c04fd430c8';
const V2_CONFIG_HASHES = Object.freeze({
	flu: 'd71414df416abfde621f64cb82530c76e002f93eb836434bc334baa4f8750b97',
	covid: 'f1a1ebc691a9262affdb33827542e39bf216b8499fe3738793d44f08db6ddac9',
	combo: '156f5ca09e1a191f19b367415547d63b53e33e418283c5af3c21d7f68b2d97ed'
});
const V3_CONFIG_HASHES = Object.freeze({
	flu: 'a91966088f11c489253addf58c0742e518384c448e7a6e7a8e178b6ea6102e7e',
	covid: '57902b6de625d2b9eac62cc7d6e11fbb71dad1736e793e9f2beedfcca5fe66b8',
	combo: '2733f6ed901ab358547c8f7aca01ba11f323c55ae10116e4e63c3e0ceab747c7'
});
const V4_CONFIG_HASHES = Object.freeze({
	flu: 'b51071bba514d7f5bd20a732c72e4e4cd8c89e1f4138907546ece8d9c4246467',
	covid: 'befeb74badfd8c571acf0c1f73d59a6d5f98526068dde0d5879fbd201a8e402a',
	combo: '85af34f5ac7c5e67e46cc6a5f4c469e479841a8f79b0cdfed07e64aacbacb61f'
});
const V5_CONFIG_HASHES = Object.freeze({
	flu: '2c998c91b5e41f4c3be06b21eb2f1f2eb2246eed9e5c43e7313c0f4ac7236bb5',
	covid: '57058fa7329e806d979c2dcfe9602f7b195f4ff1ebd7a35fbf843ba7cbafea5a',
	combo: '63dafab12890e1f0f3dee3af18332e98a3f5dd6085fb7e449085b68d3a6459ee'
});
const V6_CONFIG_HASHES = Object.freeze({
	flu: '39312f29dfa6f7f126b3a4b6100f1afc5d78e5c6541f86f7ddbc117634844949',
	covid: '40b6fcb003b40a884a3cd8be028d332d3ce3c88b3afa46bd216aad40e61cbf7e',
	combo: 'a489f4f8f33a017a1263d96aeeceb9afb4880f4ea423e6e86adede2910d75d3f'
});
const V8_CONFIG_HASHES = Object.freeze({
	flu: 'aa876242c0809ae397258b7f55e54f7eaf4786cc004b051126bc6ed16543a86c',
	covid: '4fd15d0fad1540e47135f1cad40f752354871d40a4af6ca61f2715b38e00ab0a',
	combo: 'de19844b309d93f46b6439fbdfd656611e70e45ada4581ab9283116976135802'
});
const V7_CONFIG_HASHES = Object.freeze({
	flu: '0da70cec1ff637fa73b9108b678c6a18503e56abeb57f5d04cf0a184c76e9bda',
	covid: '5444d5f3d12a91384ba427d3e84baf0c5361c631dd09d0eb713a17f373a5c5b7',
	combo: '2702389e1a89a32a697753f22c51f0600ecf91c187b5b82d5df88437ce58c327'
});
const V4_SUGGESTED_QUESTIONS = Object.freeze({
	flu: ['Is the flu shot safe for people over 65?', 'What are common side effects of the flu shot?'],
	covid: ['Are COVID-19 vaccines safe?', 'What are common side effects of the COVID-19 vaccine?'],
	combo: ['Is the flu shot safe for people over 65?', 'What are common side effects?']
});
const V5_SUGGESTED_QUESTIONS = Object.freeze({
	flu: ['What are the side effects of the flu shot?', 'Do I really need a flu shot every year?'],
	covid: ['What are the side effects of the COVID vaccine?', "Do I need the vaccine if I've already had COVID?"],
	combo: ['What are the side effects of these vaccines?', 'Can I get the flu and COVID shots at the same time?']
});

test('cryptographic primitives reject weak keys and detect tampering', () => {
	assert.throws(() => crypto.assertStrongSigningKey('short'));
	assert.throws(() => crypto.assertStrongSigningKey('test-key-that-is-definitely-at-least-32-bytes'));
	assert.equal(crypto.assertStrongSigningKey(SECRET), SECRET);
	const signed = crypto.signCompactJson('v2s', { sid: 'abc', exp: 123 }, SECRET);
	assert.deepEqual(crypto.verifyCompactJson(signed, 'v2s', SECRET), { sid: 'abc', exp: 123 });
	assert.throws(() => crypto.verifyCompactJson(signed, 'v2s', `${SECRET}-wrong`));
	const providerSession = crypto.openRouterSessionId(SECRET, SESSION_ID);
	assert.equal(providerSession, crypto.openRouterSessionId(SECRET, SESSION_ID));
	assert.notEqual(providerSession, SESSION_ID);
	assert.equal(providerSession.includes(SESSION_ID), false);
	assert.equal(providerSession.length, 43);

	const payload = { sid: 'session', checkpointResponseId: 'R_secret123', sequence: 7 };
	const handle = crypto.sealOpaqueJson('v2h', payload, SECRET, 'checkpoint-handle');
	assert.equal(handle.includes('R_secret123'), false);
	assert.deepEqual(crypto.openOpaqueJson(handle, 'v2h', SECRET, 'checkpoint-handle'), payload);
	assert.throws(() =>
		crypto.openOpaqueJson(handle, 'v2h', `${SECRET}-wrong`, 'checkpoint-handle')
	);
});

test('JSON body limit stops reading a chunked request as soon as the cap is crossed', async () => {
	let pulls = 0;
	let cancelled = false;
	const body = new ReadableStream({
		pull(controller) {
			pulls += 1;
			controller.enqueue(new TextEncoder().encode('12345678'));
			if (pulls >= 100) controller.close();
		},
		cancel() {
			cancelled = true;
		}
	});
	const request = new Request('https://example.test/api', {
		method: 'POST',
		body,
		duplex: 'half'
	});
	await assert.rejects(
		http.readJsonWithByteLimit(request, 15),
		(error) => error.status === 413 && error.code === 'payload_too_large'
	);
	assert.equal(cancelled, true);
	assert.ok(pulls < 100);
});

test('typed HTTP errors expose retryability without exposing server diagnostics', async () => {
	const response = http.errorResponse(
		new http.V2HttpError(
			503,
			'provider_route_unavailable',
			'The vaccine information service could not answer just now.',
			false
		)
	);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		v: 2,
		error: {
			code: 'provider_route_unavailable',
			message: 'The vaccine information service could not answer just now.',
			retryable: false
		}
	});

	const ordinary = http.errorResponse(new http.V2HttpError(400, 'invalid_request', 'Invalid request'));
	assert.deepEqual(await ordinary.json(), {
		v: 2,
		error: { code: 'invalid_request', message: 'Invalid request' }
	});
});

test('structured production log calls do not include secrets, content, or join keys', async () => {
	// scrubber.ts is deliberately logger-free (the route logs counts on its
	// behalf); it is scanned so a future logger import cannot leak turn text.
	const routeFiles = [
		'src/routes/api/v2/session/[condition]/+server.ts',
		'src/routes/api/v2/chat/+server.ts',
		'src/routes/api/v2/checkpoint/+server.ts',
		'src/lib/server/v2/scrubber.ts'
	];
	const filesAllowedZeroEvents = new Set(['src/lib/server/v2/scrubber.ts']);
	const forbidden = [
		'sessionToken',
		'attemptNonce',
		'transcriptJson',
		'userMessage',
		'checkpointResponseId',
		'createOperationId',
		'session.sid',
		'apiKey'
	];
	for (const relativePath of routeFiles) {
		const source = await readFile(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
		const logCalls = source.match(/logger\.(?:info|warn|error)\([\s\S]{0,700}?\);/g) ?? [];
		if (!filesAllowedZeroEvents.has(relativePath)) {
			assert.ok(logCalls.length > 0, `${relativePath} has no observable events`);
		}
		for (const call of logCalls) {
			for (const name of forbidden) {
				assert.equal(call.includes(name), false, `${relativePath} logs forbidden field ${name}`);
			}
		}
	}
});

function canonicalSnapshot(overrides = {}) {
	const snapshot = {
		schemaVersion: 2,
		chatSessionKey: SESSION_ID,
		condition: 'covid',
		configVersion: '',
		configHash: '',
		snapshotSequence: 4,
		state: 'active',
		createdAtISO: '2026-08-03T12:00:00.000Z',
		updatedAtISO: '2026-08-03T12:00:01.000Z',
		chatEndISO: null,
		messages: [],
		counters: {
			totalMessages: 0,
			initialMessages: 0,
			userMessages: 0,
			assistantMessages: 0,
			completeAssistantMessages: 0,
			incompleteAssistantMessages: 0,
			totalContentCodePoints: 0,
			serializedUtf16CodeUnits: 0,
			serializedUtf8Bytes: 0
		},
		parent: { lastAcknowledgedRevision: 0, syncCount: 0 },
		checkpoint: { hasHandle: false, lastAcknowledgedRevision: 0 },
		captureErrors: [],
		...overrides
	};
	let json = '';
	for (let iteration = 0; iteration < 8; iteration += 1) {
		json = JSON.stringify(snapshot);
		const utf16 = json.length;
		const utf8 = Buffer.byteLength(json, 'utf8');
		if (
			snapshot.counters.serializedUtf16CodeUnits === utf16 &&
			snapshot.counters.serializedUtf8Bytes === utf8
		) break;
		snapshot.counters.serializedUtf16CodeUnits = utf16;
		snapshot.counters.serializedUtf8Bytes = utf8;
	}
	return { snapshot, json: JSON.stringify(snapshot) };
}

test('fixed registry exposes public UI but not the prompt or provider configuration', () => {
	const hashes = new Set();
	for (const arm of ['flu', 'covid', 'combo']) {
		const config = configs.getStudyConfig(arm);
		const publicConfig = configs.getPublicStudyConfig(config);
		assert.equal(config.condition, arm);
		assert.equal(config.configVersion, `albertsons-2026-${arm}-v8`);
		assert.equal(config.configHash, V8_CONFIG_HASHES[arm]);
		assert.deepEqual(publicConfig.ui.appointmentCta, {
			label: 'Schedule a vaccine appointment',
			url: 'https://www.albertsons.com/health/appointments/home'
		});
		assert.match(publicConfig.initialMessages[0].id, /^[a-f0-9-]{36}$/);
		assert.equal(publicConfig.ui.themeId, 'albertsons-v1');
		assert.equal(publicConfig.ui.headerSubtitle, 'Ask a question or browse common topics');
		assert.match(publicConfig.ui.headerTitle, /vaccine information$/);
		assert.match(publicConfig.ui.privacyNote, /AI tool can make mistakes/);
		assert.equal(publicConfig.ui.endChatText, 'End chat');
		assert.deepEqual(publicConfig.ui.suggestedQuestions, V5_SUGGESTED_QUESTIONS[arm]);
		assert.equal('systemPrompt' in publicConfig, false);
		assert.equal('model' in publicConfig, false);
		assert.equal('scrubber' in publicConfig, false);
		assert.equal(
			configs.getStudyConfigRevision(arm, config.configVersion, config.configHash),
			config
		);
		hashes.add(config.configHash);
	}
	assert.equal(hashes.size, 3);
	assert.equal(
		configs.getStudyConfigRevision('flu', 'albertsons-2026-flu-v1', '0'.repeat(64)),
		undefined
	);
});

test('all arms share one prompt: v5 intervention text plus exactly the scrub addendum', () => {
	const prompts = ['flu', 'covid', 'combo'].map(
		(arm) => configs.getStudyConfig(arm).systemPrompt
	);
	assert.equal(new Set(prompts).size, 1, 'fixed survey routes must not silently tailor the prompt');
	const normalize = (text) =>
		text
			.split('\n')
			.map((line) => line.trimEnd())
			.join('\n');
	const normalized = normalize(prompts[0]);
	assert.equal(
		createHash('sha256').update(normalized, 'utf8').digest('hex'),
		'6c0706c2c3ee0bb41c3b3ad2df3899c94b49c9cc3d8c1d1ba9f253df87fd6407'
	);
	assert.equal(normalized.includes('# INSTRUCTION AND SAFETY BOUNDARY'), false);

	// The active prompt must be the retained v6 prompt (whose normalized text
	// is the approved v5 intervention, sha dbac1718...) plus exactly the two
	// v8 addenda (privacy handling, scheduling) — nothing else edited.
	for (const arm of ['flu', 'covid', 'combo']) {
		const v6 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v6`,
			V6_CONFIG_HASHES[arm]
		);
		assert.ok(v6, `${arm} v6 revision must remain retained`);
		assert.equal(
			createHash('sha256').update(normalize(v6.systemPrompt), 'utf8').digest('hex'),
			'dbac171816c6004507b67a199cb5a2c53b6486798b6961ac1c259e63b95ea626'
		);
		const active = configs.getStudyConfig(arm).systemPrompt;
		assert.ok(active.startsWith(v6.systemPrompt), 'v8 prompt must extend, not edit, the intervention body');
		const addenda = active.slice(v6.systemPrompt.length);
		assert.match(addenda, /^\n\n# PRIVACY REDACTION HANDLING\n[\s\S]*\n\n# SCHEDULING APPOINTMENTS\n/);
		assert.equal(addenda.includes('never repeat placeholders back'), true);
		assert.equal(addenda.includes('https://www.albertsons.com/health/appointments/home'), true);
		assert.equal(addenda.includes('Do not attempt to book anything yourself'), true);
	}
});

test('configuration hash covers runtime limits, retries, and deadlines', () => {
	const config = configs.getStudyConfig('flu');
	const { configHash, ...material } = config;
	assert.equal(configHash, configs.hashStudyConfigMaterial(material));
	for (const policyKey of [
		'maxTurns',
		'maxSnapshotMessages',
		'maxCaptureErrors',
		'providerFirstByteTimeoutMs',
		'providerStreamIdleTimeoutMs',
		'providerHardTimeoutMs',
		'providerMaxAttempts',
		'providerMaxRetryAfterMs',
		'providerDefaultRetryDelayMs',
		'maxProviderSseEventChars',
		'checkpointUpstreamTimeoutMs',
		'checkpointUpstreamMaxAttempts'
	]) {
		const changedPolicy = {
			...material,
			runtimePolicy: {
				...material.runtimePolicy,
				[policyKey]: material.runtimePolicy[policyKey] + 1
			}
		};
		assert.notEqual(
			configHash,
			configs.hashStudyConfigMaterial(changedPolicy),
			`${policyKey} must affect configHash`
		);
	}
	const changedRetryStatuses = {
		...material,
		runtimePolicy: {
			...material.runtimePolicy,
			providerRetryableStatusCodes: [...material.runtimePolicy.providerRetryableStatusCodes, 408]
		}
	};
	assert.notEqual(configHash, configs.hashStudyConfigMaterial(changedRetryStatuses));
	assert.notEqual(
		configHash,
		configs.hashStudyConfigMaterial({
			...material,
			model: { ...material.model, reasoning: undefined }
		}),
		'reasoning effort must affect configHash'
	);
});

test('Opus 5 load-balances only across the two US ZDR routes while every shipped revision remains resumable', () => {
	const previousCapacityHashes = {
		flu: '603db4e2ad1c0f917ba6275cff1d3a01e5d62aadf603b3197ad52fff00fcb89f',
		covid: 'eb32ff433c6444e2fee6e6ba6c1329b64d726290dcf809bc746fe51f769f1d6a',
		combo: '97f385c05b0d8cfe405af4da851bbb0d95b34e487e3e0c822fc57b9e5642af6a'
	};
	const previousActiveHashes = {
		flu: 'fec05c53be6f3d6e78025fa8e80c48ba3945055287e3d2fb5023fa01f507536d',
		covid: 'b536ba259c8f8653395291a8027e50cdd918adedb192eeca81a9678d6fde4b90',
		combo: 'd4a7b9719f8257b88fbfb1f6012051beac9f673911be78557d54b91a41ad82ee'
	};
	for (const arm of ['flu', 'covid', 'combo']) {
		const active = configs.getStudyConfig(arm);
		assert.deepEqual(active.model.provider, {
			only: ['google-vertex/us', 'amazon-bedrock/us-east-1'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: true,
			require_parameters: true
		});
		assert.equal(active.configVersion, `albertsons-2026-${arm}-v8`);
		assert.equal(active.configHash, V8_CONFIG_HASHES[arm]);
		assert.equal(active.model.name, 'anthropic/claude-opus-5');
		assert.deepEqual(active.model.reasoning, { effort: 'low', exclude: true });
		assert.equal(active.runtimePolicy.providerMaxAttempts, 1);
		assert.equal(active.ui.themeId, 'albertsons-v1');
		assert.deepEqual(active.ui.suggestedQuestions, V5_SUGGESTED_QUESTIONS[arm]);
		// v7 adds the redaction screen. Primary = Gemini 3.1 Flash Lite
		// (research-team decision 2026-08-12, latency-first: eval 1.00/1.00,
		// p95 1.1s), the only Flash-family model with a US ZDR route.
		assert.ok(active.scrubber, `${arm} active revision must configure the scrubber`);
		assert.equal(active.scrubber.model.name, 'google/gemini-3.1-flash-lite');
		assert.deepEqual([...active.scrubber.model.provider.only], ['google-vertex/us']);
		assert.equal(active.scrubber.model.provider.zdr, true);
		assert.equal(active.scrubber.model.temperature, 0);
		assert.equal('reasoning' in active.scrubber.model, false);
		// CITY/region deliberately absent: research-team decision 2026-08-12
		// keeps city-level text for conversational quality and analytic signal.
		assert.deepEqual(
			[...active.scrubber.categories],
			['NAME', 'PHONE', 'EMAIL', 'ADDRESS', 'ID', 'DOB', 'CITY']
		);
		assert.equal(active.scrubber.prompt.includes('- CITY: city, town, county'), true);

		const previousV7 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v7`,
			V7_CONFIG_HASHES[arm]
		);
		assert.ok(previousV7, `${arm} prior scrub revision must remain resumable`);
		assert.equal([...previousV7.scrubber.categories].includes('CITY'), false);
		assert.equal('appointmentCta' in previousV7.ui, false);
		// Cross-vendor secondary rides the same two US ZDR routes as Opus 5,
		// so one endpoint-inventory ritual still covers every model in use.
		assert.ok(active.scrubber.fallbackModel, `${arm} scrubber must configure a fallback model`);
		assert.equal(active.scrubber.fallbackModel.name, 'anthropic/claude-sonnet-5');
		assert.deepEqual(active.scrubber.fallbackModel.provider, {
			only: ['google-vertex/us', 'amazon-bedrock/us-east-1'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: true,
			require_parameters: true
		});
		assert.deepEqual(active.scrubber.fallbackModel.reasoning, { effort: 'low', exclude: true });
		assert.equal('temperature' in active.scrubber.fallbackModel, false);

		const previousV6 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v6`,
			V6_CONFIG_HASHES[arm]
		);
		assert.ok(previousV6, `${arm} prior load-balanced revision must remain resumable`);
		assert.equal('scrubber' in previousV6, false, 'retained v6 must not gain a scrubber field');
		assert.deepEqual(previousV6.model.provider, active.model.provider);
		assert.deepEqual(previousV6.ui.suggestedQuestions, V5_SUGGESTED_QUESTIONS[arm]);

		const previousV5 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v5`,
			V5_CONFIG_HASHES[arm]
		);
		assert.ok(previousV5, `${arm} prior Set B ordered-provider revision must remain resumable`);
		assert.deepEqual(previousV5.model.provider, {
			order: ['google-vertex/us', 'amazon-bedrock/us-east-1'],
			only: ['google-vertex/us', 'amazon-bedrock/us-east-1'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: true,
			require_parameters: true
		});
		assert.deepEqual(previousV5.ui.suggestedQuestions, V5_SUGGESTED_QUESTIONS[arm]);

		const previousV4 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v4`,
			V4_CONFIG_HASHES[arm]
		);
		assert.ok(previousV4, `${arm} prior low-effort Opus 5 revision must remain resumable`);
		assert.equal(previousV4.model.name, 'anthropic/claude-opus-5');
		assert.deepEqual(previousV4.model.reasoning, { effort: 'low', exclude: true });
		assert.equal(previousV4.runtimePolicy.providerMaxAttempts, 1);
		assert.deepEqual(previousV4.model.provider, previousV5.model.provider);
		assert.deepEqual(previousV4.ui.suggestedQuestions, V4_SUGGESTED_QUESTIONS[arm]);

		const previousV3 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v3`,
			V3_CONFIG_HASHES[arm]
		);
		assert.ok(previousV3, `${arm} prior default-effort Opus 5 revision must remain resumable`);
		assert.equal(previousV3.model.name, 'anthropic/claude-opus-5');
		assert.equal(previousV3.model.reasoning, undefined);
		assert.equal(previousV3.runtimePolicy.providerMaxAttempts, 1);
		assert.deepEqual(previousV3.model.provider, previousV5.model.provider);

		const previousV2 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v2`,
			V2_CONFIG_HASHES[arm]
		);
		assert.ok(previousV2, `${arm} prior v2 revision must remain resumable`);
		assert.equal(previousV2.model.name, 'anthropic/claude-opus-4.7');
		assert.equal(previousV2.runtimePolicy.providerMaxAttempts, 2);
		assert.deepEqual(previousV2.model.provider, {
			only: ['google-vertex/us'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: false,
			require_parameters: true
		});

		const previousCapacity = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v1`,
			previousCapacityHashes[arm]
		);
		assert.ok(previousCapacity, `${arm} prior 320k revision must remain resumable`);
		assert.equal(previousCapacity.runtimePolicy.maxTranscriptUtf8Bytes, 320_000);
		assert.deepEqual(previousCapacity.model.provider, {
			only: ['amazon-bedrock/us'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: false,
			require_parameters: true
		});

		const previousActive = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v1`,
			previousActiveHashes[arm]
		);
		assert.ok(previousActive, `${arm} prior 280k revision must remain resumable`);
		assert.equal(previousActive.runtimePolicy.maxTranscriptUtf8Bytes, 280_000);
		assert.deepEqual(previousActive.model.provider, previousCapacity.model.provider);
		assert.equal(previousActive.ui.themeId, undefined);

		const previousStrictMaterial = { ...previousCapacity };
		delete previousStrictMaterial.configHash;
		const legacyMaterial = {
			...previousStrictMaterial,
			model: {
				...previousStrictMaterial.model,
				provider: { only: ['amazon-bedrock/us'], zdr: true }
			}
		};
		const legacyHash = configs.hashStudyConfigMaterial(legacyMaterial);
		assert.notEqual(active.configHash, legacyHash);
		const legacy = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v1`,
			legacyHash
		);
		assert.ok(legacy, `${arm} legacy provider revision must remain resumable`);
		assert.deepEqual(legacy.model.provider, { only: ['amazon-bedrock/us'], zdr: true });
	}
});

test('session and history signatures bind arm, session, sequence, and exact history', () => {
	const config = configs.getStudyConfig('flu');
	const issued = tokens.issueSessionToken({
		secret: SECRET,
		chatSessionKey: SESSION_ID,
		attemptNonce: ATTEMPT_ID,
		condition: 'flu',
		configVersion: config.configVersion,
		configHash: config.configHash,
		now: 1_000
	});
	const session = tokens.verifySessionToken(issued.token, SECRET, 1_100);
	const history = [
		{ id: ATTEMPT_ID, role: 'user', content: 'Is it safe?' },
		{ id: OPERATION_ID, role: 'assistant', content: 'General information follows.' }
	];
	const tag = tokens.issueHistoryTag({ secret: SECRET, session, sequence: 1, history });
	assert.equal(
		tokens.verifyHistoryTag({ token: tag, secret: SECRET, session, sequence: 1, history }).sequence,
		1
	);
	assert.throws(() =>
		tokens.verifyHistoryTag({
			token: tag,
			secret: SECRET,
			session,
			sequence: 1,
			history: [{ ...history[0], content: 'changed' }, history[1]]
		})
	);
	const otherAttempt = tokens.issueSessionToken({
		secret: SECRET,
		chatSessionKey: SESSION_ID,
		attemptNonce: OPERATION_ID,
		condition: 'flu',
		configVersion: config.configVersion,
		configHash: config.configHash,
		now: 1_000
	}).claims;
	assert.throws(() =>
		tokens.verifyHistoryTag({ token: tag, secret: SECRET, session: otherAttempt, sequence: 1, history })
	);
});

test('rotating checkpoint handle is opaque and binds operation, revision, and checksum', () => {
	const config = configs.getStudyConfig('combo');
	const session = tokens.issueSessionToken({
		secret: SECRET,
		chatSessionKey: SESSION_ID,
		attemptNonce: ATTEMPT_ID,
		condition: 'combo',
		configVersion: config.configVersion,
		configHash: config.configHash,
		now: 2_000
	}).claims;
	const checksum = 'a'.repeat(64);
	const handle = tokens.issueCheckpointHandle({
		secret: SECRET,
		session,
		checkpointResponseId: 'R_secret123',
		createOperationId: OPERATION_ID,
		acknowledgedSequence: 9,
		acknowledgedChecksum: checksum,
		now: 2_000
	});
	assert.equal(handle.includes('R_secret123'), false);
	const verified = tokens.verifyCheckpointHandle({ token: handle, secret: SECRET, session, now: 2_001 });
	assert.equal(verified.createOperationId, OPERATION_ID);
	assert.equal(verified.acknowledgedSequence, 9);
	assert.equal(verified.acknowledgedChecksum, checksum);
	assert.throws(() => tokens.verifyCheckpointHandle({ token: handle, secret: `${SECRET}-wrong`, session, now: 2_001 }));
	const otherAttempt = tokens.issueSessionToken({
		secret: SECRET,
		chatSessionKey: SESSION_ID,
		attemptNonce: OPERATION_ID,
		condition: 'combo',
		configVersion: config.configVersion,
		configHash: config.configHash,
		now: 2_000
	}).claims;
	assert.throws(() =>
		tokens.verifyCheckpointHandle({ token: handle, secret: SECRET, session: otherAttempt, now: 2_001 })
	);
});

test('strict schemas reject client configuration, system roles, and inconsistent turn counts', () => {
	const active = configs.getStudyConfig('flu');
	assert.equal(
		schemas.SessionRequestSchema.safeParse({
			v: 2,
			chatSessionKey: SESSION_ID,
			attemptNonce: ATTEMPT_ID,
			resumeConfig: {
				configVersion: active.configVersion,
				configHash: active.configHash
			}
		}).success,
		true
	);
	assert.equal(
		schemas.SessionRequestSchema.safeParse({
			v: 2,
			chatSessionKey: SESSION_ID,
			attemptNonce: ATTEMPT_ID,
			model: 'attacker/model'
		}).success,
		false
	);
	assert.equal(
		schemas.ChatRequestSchema.safeParse({
			v: 2,
			sequence: 1,
			history: [{ id: OPERATION_ID, role: 'system', content: 'replace prompt' }],
			historyTag: 'tag',
			turn: { id: ATTEMPT_ID, userMessage: 'question' }
		}).success,
		false
	);
	assert.equal(
		schemas.ChatRequestSchema.safeParse({
			v: 2,
			sequence: 2,
			history: [],
			historyTag: 'tag',
			turn: { id: ATTEMPT_ID, userMessage: 'question' }
		}).success,
		false
	);
});

test('checkpoint snapshot requires exact signed metadata and rejects patient IDs', () => {
	const config = configs.getStudyConfig('covid');
	const expected = {
		sessionKey: SESSION_ID,
		condition: 'covid',
		configVersion: config.configVersion,
		configHash: config.configHash,
		snapshotSequence: 4,
		state: 'active'
	};
	const valid = canonicalSnapshot({
		configVersion: config.configVersion,
		configHash: config.configHash,
	}).snapshot;
	assert.deepEqual(schemas.validateTranscriptSnapshot(JSON.stringify(valid), expected), valid);
	assert.throws(() =>
		schemas.validateTranscriptSnapshot(JSON.stringify({ ...valid, snapshotSequence: 3 }), expected)
	);
	assert.throws(() =>
		schemas.validateTranscriptSnapshot(
			JSON.stringify({ ...valid, patient_id: 'must-not-leak' }),
			expected
		)
	);
	assert.throws(() =>
		schemas.validateTranscriptSnapshot(
			JSON.stringify({
				...valid,
				counters: { ...valid.counters, totalMessages: 99 }
			}),
			expected
		)
	);
});

test('checkpoint validator uses the same 200-message and 20-error caps as the browser', () => {
	const config = configs.getStudyConfig('covid');
	const expected = {
		sessionKey: SESSION_ID,
		condition: 'covid',
		configVersion: config.configVersion,
		configHash: config.configHash,
		snapshotSequence: 4,
		state: 'active'
	};
	const boundaryMessages = Array.from({ length: 200 }, (_, index) => ({
		id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		role: 'assistant',
		content: '',
		createdAtISO: '2026-08-03T12:00:00.000Z',
		isInitial: true,
		completionStatus: 'complete',
		excludedFromModel: true
	}));
	const boundaryErrors = Array.from({ length: 20 }, () => ({
		atISO: '2026-08-03T12:00:00.000Z',
		stage: 'storage',
		code: 'quota'
	}));
	const boundarySnapshot = canonicalSnapshot({
		configVersion: config.configVersion,
		configHash: config.configHash,
		messages: boundaryMessages,
		captureErrors: boundaryErrors,
		counters: {
			totalMessages: boundaryMessages.length,
			initialMessages: boundaryMessages.length,
			userMessages: 0,
			assistantMessages: 0,
			completeAssistantMessages: boundaryMessages.length,
			incompleteAssistantMessages: 0,
			totalContentCodePoints: 0,
			serializedUtf16CodeUnits: 0,
			serializedUtf8Bytes: 0
		}
	}).json;
	assert.doesNotThrow(() => schemas.validateTranscriptSnapshot(boundarySnapshot, expected));

	const messages = [
		...boundaryMessages,
		{
			...boundaryMessages[0],
			id: '00000000-0000-4000-8000-000000000200'
		}
	];
	const tooManyMessages = canonicalSnapshot({
		configVersion: config.configVersion,
		configHash: config.configHash,
		messages,
		counters: {
			totalMessages: messages.length,
			initialMessages: messages.length,
			userMessages: 0,
			assistantMessages: 0,
			completeAssistantMessages: 0,
			incompleteAssistantMessages: 0,
			totalContentCodePoints: 0,
			serializedUtf16CodeUnits: 0,
			serializedUtf8Bytes: 0
		}
	}).json;
	assert.throws(() => schemas.validateTranscriptSnapshot(tooManyMessages, expected));

	const captureErrors = [
		...boundaryErrors,
		{ atISO: '2026-08-03T12:00:00.000Z', stage: 'storage', code: 'one-too-many' }
	];
	const tooManyErrors = canonicalSnapshot({
		configVersion: config.configVersion,
		configHash: config.configHash,
		captureErrors
	}).json;
	assert.throws(() => schemas.validateTranscriptSnapshot(tooManyErrors, expected));
});

test('checkpoint chunking preserves Unicode and clears all unused fields', () => {
	const config = configs.getStudyConfig('flu');
	const session = tokens.issueSessionToken({
		secret: SECRET,
		chatSessionKey: SESSION_ID,
		attemptNonce: ATTEMPT_ID,
		condition: 'flu',
		configVersion: config.configVersion,
		configHash: config.configHash,
		now: 3_000
	}).claims;
	const transcriptJson = JSON.stringify({
		schemaVersion: 2,
		chatSessionKey: SESSION_ID,
		condition: 'flu',
		configVersion: config.configVersion,
		configHash: config.configHash,
		snapshotSequence: 1,
		messages: [{ content: `${'x'.repeat(11_900)}${'😀'.repeat(3_000)}${'界'.repeat(3_000)}` }]
	});
	const result = checkpoint.checkpointEmbeddedData({
		session,
		snapshot: {
			createOperationId: OPERATION_ID,
			snapshotSequence: 1,
			state: 'active',
			transcriptJson
		},
		nowIso: '2026-08-03T00:00:00.000Z'
	});
	const rebuilt = Array.from({ length: 24 }, (_, index) => result.fields[`chunk${index + 1}`]).join('');
	assert.equal(rebuilt, transcriptJson);
	assert.equal(result.fields.chunk24, '');
	assert.equal(result.fields.chunkOverflow, '');
	assert.equal(result.fields.checksum, result.checksum);
	for (let index = 1; index < 24; index += 1) {
		const left = result.fields[`chunk${index}`];
		const right = result.fields[`chunk${index + 1}`];
		assert.ok(Buffer.byteLength(left, 'utf8') <= 12_000);
		if (!left || !right) continue;
		assert.equal(/[\uD800-\uDBFF]$/.test(left), false);
		assert.equal(/^[\uDC00-\uDFFF]/.test(right), false);
	}
});

test('Qualtrics checkpoint writes never retry or turn a failed update into a create', async () => {
	const originalFetch = globalThis.fetch;
	const config = {
		token: 'qualtrics-test-token',
		surveyId: 'SV_Test123',
		baseUrl: 'https://test.qualtrics.com/API/v3'
	};
	let calls = 0;
	const requests = [];
	globalThis.fetch = async (url, init) => {
		calls += 1;
		requests.push({ url: String(url), init });
		return new Response('upstream failure', { status: 503 });
	};
	try {
		await assert.rejects(
			checkpoint.createQualtricsCheckpoint({
				config,
				fields: { tsLast: 'now', chunk1: '{}' },
				idempotencyKey: OPERATION_ID
			}),
			(error) => error.code === 'ambiguous_create' && error.ambiguousCreate === true
		);
		assert.equal(calls, 1);
		assert.equal(new Headers(requests[0].init.headers).get('idempotency-key'), OPERATION_ID);
		calls = 0;
		await assert.rejects(
			checkpoint.updateQualtricsCheckpoint({
				config,
				checkpointResponseId: 'R_Test123',
				fields: { tsLast: 'later', chunk1: '{"new":true}' }
			}),
			(error) => error.code === 'checkpoint_update_failed' && error.ambiguousCreate === false
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('provider retries at most once before output and preserves coalesced SSE events', async () => {
	const originalFetch = globalThis.fetch;
	const requests = [];
	let calls = 0;
	const providerSse = [
		'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
		'',
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
		'',
		'data: [DONE]',
		'',
	].join('\r\n');
	globalThis.fetch = async (_url, init) => {
		calls += 1;
		requests.push(JSON.parse(String(init.body)));
		if (calls === 1) {
			return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
		}
		return new Response(providerSse, {
			status: 200,
			headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen_test' }
		});
	};
	try {
		const retainedV2 = configs.getStudyConfigRevision(
			'combo',
			'albertsons-2026-combo-v2',
			V2_CONFIG_HASHES.combo
		);
		assert.ok(retainedV2);
		const stream = await openrouter.startOpenRouterStream({
			config: retainedV2,
			history: [],
			userMessage: 'Is it safe?',
			providerSessionId: SESSION_ID,
			apiKey: 'sk-or-test',
			clientSignal: new AbortController().signal
		});
		const events = [];
		for await (const event of stream.events()) events.push(event);
		assert.equal(calls, 2);
		assert.deepEqual(events, [
			{ kind: 'delta', text: 'Hello' },
			{ kind: 'done', finishReason: 'stop' }
		]);
		assert.deepEqual(requests[1].provider, {
			only: ['google-vertex/us'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: false,
			require_parameters: true
		});
		assert.equal(requests[1].model, 'anthropic/claude-opus-4.7');
		assert.equal(requests[1].session_id, SESSION_ID);
		assert.equal(requests[1].stream, true);
		assert.equal('max_tokens' in requests[1], false);
		assert.equal('temperature' in requests[1], false);
		assert.deepEqual(requests[1].messages[0].content[0].cache_control, { type: 'ephemeral' });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('active Opus 5 policy delegates two-provider failover to one OpenRouter request', async () => {
	const originalFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (_url, init) => {
		requests.push(JSON.parse(String(init.body)));
		return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
	};
	try {
		await assert.rejects(
			openrouter.startOpenRouterStream({
				config: configs.getStudyConfig('combo'),
				history: [],
				userMessage: 'Is it safe?',
				providerSessionId: SESSION_ID,
				apiKey: 'sk-or-test',
				clientSignal: new AbortController().signal
			}),
			(error) => error instanceof openrouter.OpenRouterStartError && error.code === 'provider_unavailable'
		);
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0].provider, {
			only: ['google-vertex/us', 'amazon-bedrock/us-east-1'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: true,
			require_parameters: true
		});
		assert.equal(requests[0].model, 'anthropic/claude-opus-5');
		assert.equal(requests[0].session_id, SESSION_ID);
		assert.deepEqual(requests[0].reasoning, { effort: 'low', exclude: true });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('missing allowed provider is typed non-retryable with bounded sanitized diagnostics', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return new Response(JSON.stringify({
			error: {
				message: 'No allowed providers are available for the selected model.',
				code: 404,
				metadata: {
					available_providers: ['amazon-bedrock', 'google-vertex', 'unsafe provider\nsecret'],
						requested_providers: ['google-vertex/us']
				}
			}
		}), {
			status: 404,
			headers: { 'content-type': 'application/json' }
		});
	};
	try {
		await assert.rejects(
			openrouter.startOpenRouterStream({
				config: configs.getStudyConfig('flu'),
				history: [],
				userMessage: 'Question content must never enter diagnostics',
				providerSessionId: SESSION_ID,
				apiKey: 'sk-or-test',
				clientSignal: new AbortController().signal
			}),
			(error) => {
				assert.equal(error instanceof openrouter.OpenRouterStartError, true);
				assert.equal(error.status, 503);
				assert.equal(error.code, 'provider_route_unavailable');
				assert.equal(error.retryable, false);
				assert.deepEqual(error.diagnostic, {
					upstreamStatus: 404,
					upstreamCode: '404',
					routingFailure: 'no_allowed_providers',
						requestedProviders: ['google-vertex/us'],
					availableProviders: ['amazon-bedrock', 'google-vertex']
				});
				assert.equal(JSON.stringify(error.diagnostic).includes('Question content'), false);
				return true;
			}
		);
		assert.equal(calls, 1, 'a known provider-selection failure must not be retried');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('bare provider DONE after text is incomplete and never fabricates stop', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return new Response(
			'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
			{ status: 200, headers: { 'content-type': 'text/event-stream' } }
		);
	};
	try {
		const stream = await openrouter.startOpenRouterStream({
			config: configs.getStudyConfig('flu'),
			history: [],
			userMessage: 'Question',
			providerSessionId: SESSION_ID,
			apiKey: 'sk-or-test',
			clientSignal: new AbortController().signal
		});
		const events = [];
		for await (const event of stream.events()) events.push(event);
		assert.equal(calls, 1);
		assert.deepEqual(events, [
			{ kind: 'delta', text: 'Partial' },
			{ kind: 'error', code: 'missing_finish_reason' }
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('oversized delimiter-free provider SSE is bounded and returns a typed start error', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return new Response('x'.repeat(65_537), {
			status: 200,
			headers: { 'content-type': 'text/event-stream' }
		});
	};
	try {
		await assert.rejects(
			openrouter.startOpenRouterStream({
				config: configs.getStudyConfig('flu'),
				history: [],
				userMessage: 'Question',
				providerSessionId: SESSION_ID,
				apiKey: 'sk-or-test',
				clientSignal: new AbortController().signal
			}),
			(error) =>
				error instanceof openrouter.OpenRouterStartError &&
				error.code === 'provider_event_too_large' &&
				error.status === 503
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

const TEST_SCRUB_CATEGORIES = Object.freeze(['NAME', 'PHONE', 'EMAIL', 'ADDRESS', 'ID', 'DOB', 'CITY']);
const TEST_SCRUBBER = Object.freeze({
	model: {
		name: 'anthropic/claude-sonnet-5',
		baseUrl: 'https://openrouter.invalid/api/v1/chat/completions',
		provider: {
			only: ['google-vertex/us', 'amazon-bedrock/us-east-1'],
			zdr: true,
			data_collection: 'deny',
			allow_fallbacks: true,
			require_parameters: true
		},
		maxTokens: 1_200,
		reasoning: { effort: 'low', exclude: true }
	},
	prompt: 'unit-test scrubber prompt',
	categories: TEST_SCRUB_CATEGORIES,
	timeoutMs: 2_000,
	maxAttempts: 2
});

function scrubProviderResponse(spans) {
	return new Response(
		JSON.stringify({ choices: [{ message: { content: JSON.stringify({ spans }) }, finish_reason: 'stop' }] }),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

test('applySpans replaces verbatim spans deterministically and continues numbering', () => {
	const applied = scrubber.applySpans(
		'My name is Jane Doe and Jane asked about Boise',
		[
			{ text: 'Jane Doe', category: 'NAME' },
			{ text: 'Jane', category: 'NAME' },
			{ text: 'Boise', category: 'CITY' }
		],
		TEST_SCRUB_CATEGORIES,
		{ NAME: 1 }
	);
	assert.equal(applied.text, 'My name is [NAME_2] and [NAME_3] asked about [CITY_1]');
	assert.equal(applied.spanCount, 3);

	const repeated = scrubber.applySpans(
		'call 5551234 or 5551234 today',
		[{ text: '5551234', category: 'PHONE' }],
		TEST_SCRUB_CATEGORIES,
		{}
	);
	assert.equal(repeated.text, 'call [PHONE_1] or [PHONE_1] today');
	assert.equal(repeated.spanCount, 2);
});

test('applySpans honors valid reuse indices and drops placeholder-shaped spans', () => {
	const reused = scrubber.applySpans(
		'anything else in Boise?',
		[{ text: 'Boise', category: 'CITY', reuse: 1 }],
		TEST_SCRUB_CATEGORIES,
		{ CITY: 2 }
	);
	assert.equal(reused.text, 'anything else in [CITY_1]?');

	const invalidReuse = scrubber.applySpans(
		'anything else in Boise?',
		[{ text: 'Boise', category: 'CITY', reuse: 9 }],
		TEST_SCRUB_CATEGORIES,
		{ CITY: 2 }
	);
	assert.equal(invalidReuse.text, 'anything else in [CITY_3]?');

	const placeholderShaped = scrubber.applySpans(
		'you noted [NAME_1] earlier',
		[{ text: '[NAME_1]', category: 'NAME' }],
		TEST_SCRUB_CATEGORIES,
		{ NAME: 1 }
	);
	assert.equal(placeholderShaped.text, 'you noted [NAME_1] earlier');
	assert.equal(placeholderShaped.spanCount, 0);
});

test('applySpans rejects unfaithful or unsafe reports fail-closed', () => {
	assert.throws(
		() => scrubber.applySpans('no such text here', [{ text: 'Jane', category: 'NAME' }], TEST_SCRUB_CATEGORIES, {}),
		(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_invalid_output' && error.retryable === true
	);
	assert.throws(
		() => scrubber.applySpans(
			'Jane asked',
			[{ text: 'Jane', category: 'NAME' }, { text: 'Jane', category: 'CITY' }],
			TEST_SCRUB_CATEGORIES,
			{}
		),
		(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_invalid_output'
	);
	assert.throws(
		() => scrubber.applySpans('Jane asked', [{ text: 'Jane', category: 'SECRET' }], TEST_SCRUB_CATEGORIES, {}),
		(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_invalid_output'
	);
	const nearLimit = 'q' + 'x'.repeat(1_498);
	assert.throws(
		() => scrubber.applySpans(nearLimit, [{ text: 'q', category: 'NAME' }], TEST_SCRUB_CATEGORIES, {}),
		(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_length' && error.retryable === false
	);
});

test('placeholderInventory reads only known categories from redacted history', () => {
	const inventory = scrubber.placeholderInventory(
		[
			{ id: '1', role: 'user', content: 'I am [NAME_2] near [CITY_1]' },
			{ id: '2', role: 'assistant', content: 'Thanks [NAME_2]; also [UNKNOWN_9] and [NAME_1]' }
		],
		TEST_SCRUB_CATEGORIES
	);
	assert.deepEqual(inventory, { NAME: 2, CITY: 1 });
});

test('scrubUserMessage sends the strict scrub request and applies the report', async () => {
	const originalFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (_url, init) => {
		requests.push(JSON.parse(String(init.body)));
		return scrubProviderResponse([{ text: 'Jane Doe', category: 'NAME' }]);
	};
	try {
		const result = await scrubber.scrubUserMessage({
			scrubber: TEST_SCRUBBER,
			history: [
				{ id: 'u1', role: 'user', content: 'my friend is [NAME_1]' },
				{ id: 'a1', role: 'assistant', content: 'Understood.' }
			],
			userMessage: 'My name is Jane Doe.',
			apiKey: 'unit-test-key',
			clientSignal: new AbortController().signal
		});
		assert.equal(result.text, 'My name is [NAME_2].');
		assert.equal(result.spanCount, 1);
		assert.equal(result.attempts, 1);
		assert.equal(requests.length, 1);
		const body = requests[0];
		assert.equal(body.model, 'anthropic/claude-sonnet-5');
		assert.equal(body.stream, false);
		assert.equal(body.max_tokens, 1_200);
		assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
		assert.deepEqual(body.provider, TEST_SCRUBBER.model.provider);
		assert.equal('temperature' in body, false);
		assert.equal('session_id' in body, false);
		assert.equal(body.messages[0].role, 'system');
		assert.equal(body.messages[0].content, 'unit-test scrubber prompt');
		assert.equal(body.messages[1].role, 'user');
		const input = JSON.parse(body.messages[1].content);
		assert.deepEqual(Object.keys(input).sort(), ['newUserMessage', 'recentUserTurns', 'usedPlaceholders']);
		assert.deepEqual(input.usedPlaceholders, { NAME: 1 });
		assert.deepEqual(input.recentUserTurns, ['my friend is [NAME_1]']);
		assert.equal(input.newUserMessage, 'My name is Jane Doe.');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('scrubUserMessage passes clean messages through unchanged', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => scrubProviderResponse([]);
	try {
		const result = await scrubber.scrubUserMessage({
			scrubber: TEST_SCRUBBER,
			history: [],
			userMessage: 'Is the flu shot safe for people over 65?',
			apiKey: 'unit-test-key',
			clientSignal: new AbortController().signal
		});
		assert.equal(result.text, 'Is the flu shot safe for people over 65?');
		assert.equal(result.spanCount, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('scrubUserMessage retries malformed output once and accepts fenced JSON', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls === 1) {
			return new Response(
				JSON.stringify({ choices: [{ message: { content: 'sorry, no JSON today' }, finish_reason: 'stop' }] }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: '```json\n{"spans":[]}\n```' }, finish_reason: 'stop' }]
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	};
	try {
		const result = await scrubber.scrubUserMessage({
			scrubber: TEST_SCRUBBER,
			history: [],
			userMessage: 'plain question',
			apiKey: 'unit-test-key',
			clientSignal: new AbortController().signal
		});
		assert.equal(result.attempts, 2);
		assert.equal(result.text, 'plain question');
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('scrubUserMessage fails closed after exhausted retries and on non-retryable HTTP status', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	};
	try {
		await assert.rejects(
			scrubber.scrubUserMessage({
				scrubber: TEST_SCRUBBER,
				history: [],
				userMessage: 'question',
				apiKey: 'unit-test-key',
				clientSignal: new AbortController().signal
			}),
			(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_invalid_output' && error.retryable === true
		);
		assert.equal(calls, 2);

		calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			return new Response('denied', { status: 403 });
		};
		await assert.rejects(
			scrubber.scrubUserMessage({
				scrubber: TEST_SCRUBBER,
				history: [],
				userMessage: 'question',
				apiKey: 'unit-test-key',
				clientSignal: new AbortController().signal
			}),
			(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_unavailable' && error.retryable === false
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('scrubUserMessage recovers from a retryable HTTP failure and times out fail-closed', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls === 1) return new Response('busy', { status: 503 });
		return scrubProviderResponse([]);
	};
	try {
		const result = await scrubber.scrubUserMessage({
			scrubber: TEST_SCRUBBER,
			history: [],
			userMessage: 'question',
			apiKey: 'unit-test-key',
			clientSignal: new AbortController().signal
		});
		assert.equal(result.attempts, 2);
		assert.equal(calls, 2);

		globalThis.fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			});
		await assert.rejects(
			scrubber.scrubUserMessage({
				scrubber: { ...TEST_SCRUBBER, timeoutMs: 25, maxAttempts: 1 },
				history: [],
				userMessage: 'question',
				apiKey: 'unit-test-key',
				clientSignal: new AbortController().signal
			}),
			(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_timeout' && error.retryable === true
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('chat route redacts before the relay and signs only the canonical text', async () => {
	const source = await readFile(
		fileURLToPath(new URL('../src/routes/api/v2/chat/+server.ts', import.meta.url)),
		'utf8'
	);
	const contextGuardAt = source.indexOf('MAX_CONTEXT_UTF8_BYTES)');
	const scrubCallAt = source.indexOf('await scrubUserMessage({');
	const relayAt = source.indexOf('await startOpenRouterStream({');
	assert.ok(contextGuardAt > 0 && scrubCallAt > 0 && relayAt > 0, 'expected route landmarks');
	assert.ok(contextGuardAt < scrubCallAt, 'scrub must run after request validation');
	assert.ok(scrubCallAt < relayAt, 'scrub must complete before the provider relay');
	assert.ok(source.includes('userMessage: canonicalUserMessage'), 'relay must send the canonical text');
	assert.equal(
		(source.match(/content: canonicalUserMessage/g) ?? []).length,
		2,
		'both completedHistory sites must sign the canonical text'
	);
	assert.equal(
		source.includes("role: 'user', content: body.turn.userMessage"),
		false,
		'no history entry may sign the raw turn'
	);
	assert.ok(
		source.includes('scrubbedUserMessage: canonicalUserMessage'),
		'meta must deliver the canonical turn text to the client'
	);
});

test('scrubber falls over to the cross-vendor secondary only after primary exhaustion', async () => {
	// Production ordering: Flash Lite primary (temperature 0, no reasoning),
	// Sonnet secondary (reasoning low/exclude, no temperature).
	const withFallback = {
		...TEST_SCRUBBER,
		model: {
			name: 'google/gemini-3.1-flash-lite',
			baseUrl: 'https://openrouter.invalid/api/v1/chat/completions',
			provider: {
				only: ['google-vertex/us'],
				zdr: true,
				data_collection: 'deny',
				allow_fallbacks: false,
				require_parameters: true
			},
			maxTokens: 1_200,
			temperature: 0
		},
		fallbackModel: TEST_SCRUBBER.model
	};
	const originalFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(String(init.body));
		requests.push(body);
		if (body.model === 'google/gemini-3.1-flash-lite') return new Response('busy', { status: 503 });
		return scrubProviderResponse([{ text: 'Jane Doe', category: 'NAME' }]);
	};
	try {
		const result = await scrubber.scrubUserMessage({
			scrubber: withFallback,
			history: [],
			userMessage: 'My name is Jane Doe.',
			apiKey: 'unit-test-key',
			clientSignal: new AbortController().signal
		});
		assert.equal(result.text, 'My name is [NAME_1].');
		assert.equal(result.usedFallback, true);
		assert.equal(result.attempts, 3);
		assert.equal(requests.length, 3);
		assert.equal(requests[0].model, 'google/gemini-3.1-flash-lite');
		assert.equal(requests[0].temperature, 0);
		assert.equal('reasoning' in requests[0], false);
		assert.equal(requests[1].model, 'google/gemini-3.1-flash-lite');
		const fallbackBody = requests[2];
		assert.equal(fallbackBody.model, 'anthropic/claude-sonnet-5');
		assert.deepEqual(fallbackBody.reasoning, { effort: 'low', exclude: true });
		assert.equal('temperature' in fallbackBody, false);
		assert.deepEqual(fallbackBody.provider.only, ['google-vertex/us', 'amazon-bedrock/us-east-1']);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('scrubber fallback is skipped for content-deterministic failures and absent config', async () => {
	const withFallback = {
		...TEST_SCRUBBER,
		maxAttempts: 1,
		fallbackModel: {
			name: 'anthropic/claude-sonnet-5',
			baseUrl: 'https://openrouter.invalid/api/v1/chat/completions',
			provider: {
				only: ['google-vertex/us', 'amazon-bedrock/us-east-1'],
				zdr: true,
				data_collection: 'deny',
				allow_fallbacks: true,
				require_parameters: true
			},
			maxTokens: 1_200,
			reasoning: { effort: 'low', exclude: true }
		}
	};
	const originalFetch = globalThis.fetch;
	let calls = 0;
	// Primary succeeds but the report pushes the message over the protocol
	// bound: that is the participant's content, not a vendor outage, so the
	// secondary must NOT be consulted.
	globalThis.fetch = async () => {
		calls += 1;
		return scrubProviderResponse([{ text: 'q', category: 'NAME' }]);
	};
	try {
		await assert.rejects(
			scrubber.scrubUserMessage({
				scrubber: withFallback,
				history: [],
				userMessage: 'q' + 'x'.repeat(1_498),
				apiKey: 'unit-test-key',
				clientSignal: new AbortController().signal
			}),
			(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_length'
		);
		assert.equal(calls, 1, 'no fallback call after a scrub_length failure');

		calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			return new Response('busy', { status: 503 });
		};
		await assert.rejects(
			scrubber.scrubUserMessage({
				scrubber: { ...TEST_SCRUBBER, maxAttempts: 1 },
				history: [],
				userMessage: 'question',
				apiKey: 'unit-test-key',
				clientSignal: new AbortController().signal
			}),
			(error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_unavailable'
		);
		assert.equal(calls, 1, 'no fallback without fallbackModel configured');
	} finally {
		globalThis.fetch = originalFetch;
	}
});
