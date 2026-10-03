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
let s3;
let provenance;
const V1_CONFIG_HASHES = {
	flu: 'fec05c53be6f3d6e78025fa8e80c48ba3945055287e3d2fb5023fa01f507536d',
	covid: 'b536ba259c8f8653395291a8027e50cdd918adedb192eeca81a9678d6fde4b90',
	combo: 'd4a7b9719f8257b88fbfb1f6012051beac9f673911be78557d54b91a41ad82ee'
};

async function loadServerModule(relativePath, privateEnv = {}, mocks = {}) {
	const entryPoint = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
	const result = await build({
		entryPoints: [entryPoint],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		logLevel: 'silent',
		// The AWS SDK's CommonJS build requires node built-ins at runtime; give
		// the ESM bundle a real `require` anchored at this test file so those
		// calls resolve inside the data: URL module.
		banner: {
			js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(import.meta.url)});`
		},
		plugins: [
			{
				name: 'unit-test-private-env',
				setup(esbuild) {
					esbuild.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'route-mock' } : undefined);
					esbuild.onLoad({ filter: /.*/, namespace: 'route-mock' }, (args) => ({ contents: mocks[args.path], loader: 'js' }));
					esbuild.onResolve({ filter: /^\$env\/dynamic\/private$/ }, () => ({
						path: 'unit-test-private-env',
						namespace: 'unit-test'
					}));
					esbuild.onLoad({ filter: /.*/, namespace: 'unit-test' }, () => ({
						contents: `export const env = ${JSON.stringify(privateEnv)};`,
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
	[tokens, schemas, configs, checkpoint, openrouter, crypto, http, scrubber, s3, provenance] = await Promise.all([
		loadServerModule('src/lib/server/v2/tokens.ts'),
		loadServerModule('src/lib/server/v2/schemas.ts'),
		loadServerModule('src/lib/server/v2/studyConfig.ts'),
		loadServerModule('src/lib/server/v2/qualtricsCheckpoint.ts'),
		loadServerModule('src/lib/server/v2/openrouter.ts'),
		loadServerModule('src/lib/server/v2/crypto.ts'),
		loadServerModule('src/lib/server/v2/http.ts'),
		loadServerModule('src/lib/server/v2/scrubber.ts'),
		loadServerModule('src/lib/server/v2/s3Checkpoint.ts'),
		loadServerModule('src/lib/server/v2/provenance.ts')
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
	flu: 'c11f8a9600bfdef50e9455af1442f4a76191378ac65a9c2724f07aa439c4e9b8',
	covid: '20c698da19a6c72c98d3809b592a393c3afe6b9607a1ca2bf59ed18651126ab1',
	combo: '42d2a47ccdcff423f1e252f66bdc6bb1d312ca3b7d08059015c4ba959e65b74b'
});
const V9_CONFIG_HASHES = Object.freeze({
	flu: '92489bb87dcf4e90735df23c8ed9c060b97aca0c0deffc30459ef7fc681ee8c8',
	covid: '40a1b7772f12fce08568715a8d35c028e94cec69b469983c33d689a16a3d4da6',
	combo: 'a2d8e44c87100bfbc3c7a9ff8fe1d5c8479bdd4829ae86a71166efbd2c096c82'
});
const V10_CONFIG_HASHES = Object.freeze({
	flu: 'ef6f12aa7946c2cc9d6979d9554ce769ffeec84c435e8014617c9c44af005340',
	covid: 'c691c84e4886cd8b6c47bfd1385fe264e4e7e1130623b85556487538a7cc3fad',
	combo: 'df7244c5a1b6f7382db2302feb38aeede674496ef01819bd901abdc8fa3ef6af'
});
// v11 = v10 + max_tokens 6000 on the answer call (ADO 12588, 2026-09-09).
const V11_CONFIG_HASHES = Object.freeze({
	flu: 'c2dfef4e5b4200b2dd6673abb9c6767ba3ad2e90afebbe1d0e820d39a00e9b3d',
	covid: '813b423e037ea0be53113c8da263a2acb4f87be2bab6fb0601e227513e17245d',
	combo: '6dec375840c54f3a0dea90d32aab3ffde6cdcf64d17b9297df211bdf67689bfa'
});
// v12 = v11 with max_tokens cut 6000 -> 4000 (ADO 12588, 2026-09-22).
const V12_CONFIG_HASHES = Object.freeze({
	flu: 'f37bcbdcda7aa29e06beb405b528328dc20a7f1a661dcb106010ae4ab8b6a3fb',
	covid: 'aa8ded3194a2dcc3eccc0a746f67d28e236a3b3412df3d6e29861fdf81791c94',
	combo: 'fe2ef5e361c0c3bc72fa1673536b820bbb0310e1cb16dae54f3981d3e429f020'
});
const V13_CONFIG_HASHES = Object.freeze({
	flu: '7dd1e0f532847f13c7c22bccad2ebbce861baea00c423aa16f71a1b8307a0827',
	covid: '509b61268566f4c7846922c8372e879838ace02b4680f0bb8477973c07568bb3',
	combo: '606eefe6af83121633487e38f5fa6a7beaa79a87b2ddf1a6b2153646182f0d93'
});
const V13_SCRUB_CATEGORIES = Object.freeze([
	'NAME', 'ADDRESS', 'DATES', 'PHONE', 'FAX', 'EMAIL', 'SSN', 'MRN', 'HPBN',
	'ACCOUNT', 'LICENSE', 'VEHICLE', 'DEVICE', 'URL', 'IP', 'BIOMETRIC', 'PHOTO', 'ID'
]);
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
		assert.equal(config.configVersion, `albertsons-2026-${arm}-v13`);
		assert.equal(config.configHash, V13_CONFIG_HASHES[arm]);
		assert.deepEqual(publicConfig.ui.appointmentCta, {
			label: 'Schedule now',
			url: 'https://www.albertsons.com/health/appointments/home'
		});
		assert.equal(
			publicConfig.ui.privacyNote,
			'For your privacy, don’t share identifying details such as your name or address. This AI tool can make mistakes; ask a doctor or pharmacist about personal health concerns.'
		);
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

test('v10 prompts: shared trunk, arm-specific facts and scope', () => {
	const prompts = Object.fromEntries(['flu', 'covid', 'combo'].map((arm) => [arm, configs.getStudyConfig(arm).systemPrompt]));
	assert.equal(new Set(Object.values(prompts)).size, 3, 'each arm now has its own prompt');
	const section = (text, heading, nextHeadings) => {
		const start = text.indexOf(heading);
		assert.ok(start >= 0, );
		const ends = nextHeadings.map((h) => text.indexOf(h, start + 1)).filter((i) => i > start);
		return text.slice(start, ends.length ? Math.min(...ends) : undefined);
	};
	// Trunk sections identical across arms except for the two documented
	// vaccine-name substitutions in the mission paragraph and rule 6.
	for (const arm of ['flu', 'covid', 'combo']) {
		const p = prompts[arm];
		assert.equal(section(p, '# PRIVACY REDACTION HANDLING', ['# SCHEDULING APPOINTMENTS']), section(prompts.combo, '# PRIVACY REDACTION HANDLING', ['# SCHEDULING APPOINTMENTS']));
		assert.equal(section(p, '# SCHEDULING APPOINTMENTS', []), section(prompts.combo, '# SCHEDULING APPOINTMENTS', []));
		const rules = section(p, '# CORE RULES ABOUT FUNCTIONALITY', ['# SCOPE', '# PRIVACY REDACTION HANDLING']);
		assert.equal(rules.split('\n').length, section(prompts.combo, '# CORE RULES ABOUT FUNCTIONALITY', ['# PRIVACY REDACTION HANDLING']).split('\n').length, );
	}
	// Facts are arm-specific.
	const facts = (arm) => section(prompts[arm], '# KEY FACTS TO DRAW ON', ['# CORE RULES ABOUT FUNCTIONALITY']);
	const heads = (arm) => facts(arm).split('\n').filter((l) => l.startsWith('## '));
	assert.equal(heads('flu').filter((h) => /covid/i.test(h)).length, 0, 'flu arm carries no COVID facts');
	assert.equal(heads('covid').filter((h) => /flu/i.test(h)).length, 0, 'COVID arm carries no flu facts');
	assert.equal(heads('combo').length, heads('flu').length + heads('covid').length, 'combined carries both sets');
	assert.deepEqual(heads('combo'), [...heads('covid'), ...heads('flu')]);
	// Mission wording names the arm's vaccine(s); single arms carry SCOPE.
	assert.match(prompts.flu, /^Your task is to be a knowledgeable and neutral source of accurate, factual information about the seasonal 2026\/2027 influenza \(flu\) vaccine\./);
	assert.match(prompts.covid, /^Your task is to be a knowledgeable and neutral source of accurate, factual information about the 2026\/2027 COVID-19 vaccine\./);
	assert.match(prompts.combo, /^Your task is to be a knowledgeable and neutral source of accurate, factual information about the seasonal 2026\/2027 influenza and COVID-19 vaccines\./);
	assert.ok(prompts.flu.includes('# SCOPE') && prompts.covid.includes('# SCOPE') && !prompts.combo.includes('# SCOPE'));
	// Cleanliness: no Outlook safelinks or export escaping survived.
	for (const p of Object.values(prompts)) {
		assert.equal(p.includes('safelinks'), false);
		assert.equal(/\\[#\-*\[\]]/.test(p), false);
	}
	// The team's 2026-27 season link is present wherever flu facts are.
	assert.ok(prompts.flu.includes('https://www.cdc.gov/flu/season/2026-2027.html'));
	assert.ok(prompts.combo.includes('https://www.cdc.gov/flu/season/2026-2027.html'));
	assert.equal(prompts.covid.includes('/flu/season/'), false, 'COVID arm carries no flu links');
	// The retained v9 prompt is still the shared v5+addenda text.
	const v9 = configs.getStudyConfigRevision('flu', 'albertsons-2026-flu-v9', V9_CONFIG_HASHES.flu);
	assert.ok(v9.systemPrompt.startsWith('"Your task is to be'), 'v9 retained verbatim');
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
	assert.notEqual(
		configHash,
		configs.hashStudyConfigMaterial({
			...material,
			model: { ...material.model, maxTokens: material.model.maxTokens + 1 }
		}),
		'max_tokens must affect configHash'
	);
});

test('402 and 429 bodies keep a bounded upstream message; other statuses keep none', async () => {
	const originalFetch = globalThis.fetch;
	const start = () =>
		openrouter.startOpenRouterStream({
			config: configs.getStudyConfig('flu'),
			history: [],
			userMessage: 'Is it safe?',
			providerSessionId: SESSION_ID,
			apiKey: 'sk-or-test',
			clientSignal: new AbortController().signal
		});
	const errorFor = async (status, message, extraHeaders = {}) => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: { code: status, message } }), {
				status,
				headers: { 'content-type': 'application/json', 'retry-after': '0', ...extraHeaders }
			});
		let caught;
		await start().catch((error) => {
			caught = error;
		});
		assert.ok(caught instanceof openrouter.OpenRouterStartError);
		return caught;
	};
	try {
		const insufficient = await errorFor(
			402,
			'This request requires more credits, or fewer max_tokens. You requested up to 6000 tokens, but can only afford 4113. Bearer sk-or-v1-secret'
		);
		assert.equal(insufficient.code, 'provider_unavailable');
		assert.equal(insufficient.diagnostic.upstreamStatus, 402);
		assert.equal(
			insufficient.diagnostic.upstreamMessage,
			'This request requires more credits, or fewer max_tokens. You requested up to 6000 tokens, but can only afford 4113. [redacted]'
		);

		const limited = await errorFor(429, 'Rate limit exceeded: free-models-per-min');
		assert.equal(limited.code, 'provider_busy');
		assert.equal(limited.diagnostic.upstreamMessage, 'Rate limit exceeded: free-models-per-min');

		// A validation-style error could in principle quote the request, so its
		// text is never retained.
		const rejected = await errorFor(400, 'Invalid request: messages[3].content contains something');
		assert.equal(rejected.diagnostic.upstreamStatus, 400);
		assert.equal('upstreamMessage' in rejected.diagnostic, false);

		const long = await errorFor(402, 'x'.repeat(1_000));
		assert.equal(long.diagnostic.upstreamMessage.length, 301);

		// Rate-limit headers are kept on 402/429 (values validated), never on
		// other statuses, and absent when the response carries none.
		assert.deepEqual(insufficient.diagnostic.upstreamHeaders, { 'retry-after': '0' });
		const withLimits = await errorFor(429, 'Rate limited', {
			'x-ratelimit-limit': '200',
			'x-ratelimit-remaining': '0',
			'x-ratelimit-reset': '1789069400',
			'x-ratelimit-bogus': 'ignored',
			'retry-after': 'Thu, 10 Sep 2026 19:42:00 GMT'
		});
		assert.deepEqual(withLimits.diagnostic.upstreamHeaders, {
			'retry-after': 'Thu, 10 Sep 2026 19:42:00 GMT',
			'x-ratelimit-limit': '200',
			'x-ratelimit-remaining': '0',
			'x-ratelimit-reset': '1789069400'
		});
		const odd = await errorFor(402, 'no credits', { 'x-ratelimit-limit': '<script>alert(1)</script>' });
		assert.deepEqual(odd.diagnostic.upstreamHeaders, { 'retry-after': '0' });
		assert.equal('upstreamHeaders' in rejected.diagnostic, false);
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: { code: 402, message: 'no credits' } }), {
				status: 402,
				headers: { 'content-type': 'application/json' }
			});
		let bareHeaders;
		await start().catch((error) => {
			bareHeaders = error;
		});
		assert.equal('upstreamHeaders' in bareHeaders.diagnostic, false);
		// A 402 with no JSON body still records status and headers.
		globalThis.fetch = async () => new Response('Payment Required', { status: 402, headers: { 'retry-after': '2' } });
		let noBody;
		await start().catch((error) => {
			noBody = error;
		});
		assert.equal(noBody.diagnostic.upstreamStatus, 402);
		assert.deepEqual(noBody.diagnostic.upstreamHeaders, { 'retry-after': '2' });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('v12 sends max_tokens 4000 on the answer call; v11 sent 6000; v10 and earlier send none', async () => {
	const originalFetch = globalThis.fetch;
	const bodies = [];
	const providerSse =
		'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
		'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	globalThis.fetch = async (_url, init) => {
		bodies.push(JSON.parse(String(init.body)));
		return new Response(providerSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};
	try {
		for (const config of [
			configs.getStudyConfig('flu'),
			configs.getStudyConfig('demo'),
			configs.getStudyConfigRevision('flu', 'albertsons-2026-flu-v10', V10_CONFIG_HASHES.flu),
			configs.getStudyConfigRevision('flu', 'albertsons-2026-flu-v11', V11_CONFIG_HASHES.flu)
		]) {
			assert.ok(config);
			const stream = await openrouter.startOpenRouterStream({
				config,
				history: [],
				userMessage: 'Is it safe?',
				providerSessionId: SESSION_ID,
				apiKey: 'sk-or-test',
				clientSignal: new AbortController().signal
			});
			stream.cancel();
		}
		assert.equal(bodies[0].max_tokens, 4_000, 'active flu revision sends the v12 ceiling');
		assert.equal(bodies[1].max_tokens, 4_000, 'active demo revision sends the v12 ceiling');
		assert.equal('max_tokens' in bodies[2], false, 'retained v10 sends no max_tokens');
		assert.equal(bodies[3].max_tokens, 6_000, 'retained v11 keeps its own ceiling');
		// max_tokens is the only thing that differs across v10, v11 and v12.
		const { max_tokens: _v12Omitted, ...v12Rest } = bodies[0];
		const { max_tokens: _v11Omitted, ...v11Rest } = bodies[3];
		assert.deepEqual(v12Rest, bodies[2]);
		assert.deepEqual(v12Rest, v11Rest);
	} finally {
		globalThis.fetch = originalFetch;
	}
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
		assert.equal(active.configVersion, `albertsons-2026-${arm}-v13`);
		assert.equal(active.configHash, V13_CONFIG_HASHES[arm]);
		assert.equal(active.model.name, 'anthropic/claude-opus-5');
		assert.deepEqual(active.model.reasoning, { effort: 'low', exclude: true });
		// max_tokens bounds OpenRouter's pre-flight credit hold, which is what
		// refuses admission with a 402 under load. v11 kept it above the app's own
		// 16,000 code-point capture cap so the provider could never truncate
		// first; v12 deliberately drops below that, making the provider cap the
		// binding one, because the hold was ~11x what a turn actually generates.
		// The floor that matters now is measured output: across 20 sampled
		// generations completion averaged 546 native tokens and peaked at 823
		// (reasoning, excluded from output but inside max_tokens, averaged 24).
		assert.equal(active.model.maxTokens, 4_000);
		assert.ok(
			active.model.maxTokens >= 4 * 823,
			'max_tokens must stay several times the largest completion ever measured'
		);
		assert.equal(active.runtimePolicy.providerMaxAttempts, 1);

		// v10 (no max_tokens) stays resumable and hash-stable for in-flight sessions.
		const previousV10 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v10`,
			V10_CONFIG_HASHES[arm]
		);
		assert.ok(previousV10, `${arm} prior v10 revision must remain resumable`);
		assert.equal('maxTokens' in previousV10.model, false);
		assert.equal(previousV10.systemPrompt, active.systemPrompt);

		// v11 likewise: sessions issued before the v12 deploy keep their 6,000.
		const previousV11 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v11`,
			V11_CONFIG_HASHES[arm]
		);
		assert.ok(previousV11, `${arm} prior v11 revision must remain resumable`);
		assert.equal(previousV11.model.maxTokens, 6_000);
		assert.equal(previousV11.systemPrompt, active.systemPrompt);
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
		// v13 replaces CITY/DOB with the expanded ADDRESS/DATES policy.
		assert.deepEqual([...active.scrubber.categories], V13_SCRUB_CATEGORIES);
		const previousV12 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v12`,
			V12_CONFIG_HASHES[arm]
		);
		assert.ok(previousV12, `${arm} prior v12 revision must remain resumable`);
		assert.deepEqual([...previousV12.scrubber.categories], ['NAME', 'PHONE', 'EMAIL', 'ADDRESS', 'ID', 'DOB', 'CITY']);
		assert.deepEqual(previousV12.model, active.model);
		assert.deepEqual(previousV12.ui, active.ui);
		assert.deepEqual(previousV12.runtimePolicy, active.runtimePolicy);
		assert.equal(previousV12.systemPrompt, active.systemPrompt);
		assert.deepEqual(previousV12.scrubber.model, active.scrubber.model);
		assert.deepEqual(previousV12.scrubber.fallbackModel, active.scrubber.fallbackModel);

		const previousV9 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v9`,
			V9_CONFIG_HASHES[arm]
		);
		assert.ok(previousV9, `${arm} prior v9 revision must remain resumable`);
		assert.equal(previousV9.ui.appointmentCta.label, 'Schedule now');

		const previousV8 = configs.getStudyConfigRevision(
			arm,
			`albertsons-2026-${arm}-v8`,
			V8_CONFIG_HASHES[arm]
		);
		assert.ok(previousV8, `${arm} prior v8 revision must remain resumable`);
		assert.match(previousV8.ui.privacyNote, /and provides general information/);

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

const S3_TEST_CONFIG = Object.freeze({
	region: 'us-east-1',
	roleArn: 'arn:aws:iam::123456789012:role/vercel-vegapunk-checkpoint-writer-loadtest',
	bucket: 'wharton-vaccine-chat-checkpoint-loadtest'
});

function s3TestObject(overrides = {}) {
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
	const transcriptJson = JSON.stringify({ schemaVersion: 2, messages: [{ content: 'héllo 😀 界' }] });
	return {
		session,
		transcriptJson,
		object: s3.checkpointObject({
			session,
			snapshot: {
				createOperationId: OPERATION_ID,
				snapshotSequence: 7,
				state: 'active',
				reasonHint: 'assistant_completed ✓',
				transcriptJson,
				...overrides
			},
			nowIso: '2026-09-11T00:00:00.000Z'
		})
	};
}

const s3Failure = (name, httpStatusCode) =>
	Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

test('S3 checkpoint objects use a deterministic key, carry the transcript checksum, and keep metadata ASCII', () => {
	const { session, transcriptJson, object } = s3TestObject();
	const config = configs.getStudyConfig('flu');
	assert.equal(object.streamRef, `v2/${config.configVersion}/flu/${SESSION_ID}/${OPERATION_ID}`);
	assert.equal(object.key, `${object.streamRef}/000007.json`);
	assert.equal(s3.isS3StreamRef(object.streamRef), true);
	assert.equal(object.checksum, createHash('sha256').update(transcriptJson).digest('hex'));
	assert.equal(object.bodySha256Base64, createHash('sha256').update(object.body).digest('base64'));
	assert.equal(object.charLength, transcriptJson.length);
	assert.equal(object.byteLength, Buffer.byteLength(transcriptJson, 'utf8'));

	const envelope = JSON.parse(Buffer.from(object.body).toString('utf8'));
	assert.equal(envelope.schemaVersion, 2);
	assert.equal(envelope.transcriptJson, transcriptJson);
	assert.equal(envelope.checksum, object.checksum);
	assert.equal(envelope.snapshotSequence, 7);
	assert.equal(envelope.sessionKey, SESSION_ID);
	assert.equal(envelope.configHash, session.configHash);
	assert.equal(envelope.storedAtISO, '2026-09-11T00:00:00.000Z');

	assert.equal(object.metadata.reasonhint, 'assistant_completed ');
	assert.equal(object.metadata.sessionkey, SESSION_ID);
	assert.equal(object.metadata.checksum, object.checksum);
	assert.equal(object.metadata.snapshotsequence, '7');
	for (const value of Object.values(object.metadata)) {
		assert.equal(/^[\x20-\x7e]*$/.test(value), true);
		assert.equal(value.includes('llo'), false);
	}

	// Same session and request produce identical bytes on the same key, which
	// is what makes a repeated PutObject idempotent.
	const again = s3TestObject().object;
	assert.equal(again.key, object.key);
	assert.equal(again.bodySha256Base64, object.bodySha256Base64);

	assert.throws(
		() => s3TestObject({ transcriptJson: 'x'.repeat(240_001) }),
		(error) => error.code === 'transcript_too_large' && error.status === 413
	);

	const input = s3.putObjectInput(S3_TEST_CONFIG, object);
	assert.equal(input.Bucket, S3_TEST_CONFIG.bucket);
	assert.equal(input.Key, object.key);
	assert.equal(input.ChecksumSHA256, object.bodySha256Base64);
	assert.equal(input.ContentType, 'application/json; charset=utf-8');
	assert.equal(input.ContentLength, object.body.byteLength);
	assert.equal(input.ServerSideEncryption, undefined);
	assert.equal(input.Metadata.transcriptjson, undefined);
});

test('S3 checkpoint writes retry once on transient failures and never on configuration failures', async () => {
	const { object } = s3TestObject();
	const config = S3_TEST_CONFIG;
	const noDelay = () => 0;

	let calls = 0;
	const inputs = [];
	const unavailable = {
		send: async (command) => {
			calls += 1;
			inputs.push(command.input);
			throw s3Failure('ServiceUnavailable', 503);
		}
	};
	await assert.rejects(
		s3.putCheckpointObject({ config, object, client: unavailable, retryDelayMs: noDelay }),
		(error) =>
			error.code === 'checkpoint_write_failed' &&
			error.status === 503 &&
			error.attempts === 2 &&
			error.ambiguousCreate === false &&
			error.upstreamName === 'ServiceUnavailable' &&
			!error.message.includes(object.key)
	);
	assert.equal(calls, 2);
	assert.equal(inputs[0].Key, object.key);
	assert.equal(inputs[1].Key, object.key);
	assert.equal(inputs[1].ChecksumSHA256, object.bodySha256Base64);

	calls = 0;
	const flaky = {
		send: async () => {
			calls += 1;
			if (calls === 1) throw s3Failure('SlowDown', 503);
			return {};
		}
	};
	assert.deepEqual(
		await s3.putCheckpointObject({ config, object, client: flaky, retryDelayMs: noDelay }),
		{ attempts: 2 }
	);

	calls = 0;
	const throttled = {
		send: async () => {
			calls += 1;
			throw s3Failure('SlowDown', 503);
		}
	};
	await assert.rejects(
		s3.putCheckpointObject({ config, object, client: throttled, retryDelayMs: noDelay }),
		(error) => error.code === 'checkpoint_store_throttled' && error.status === 429 && error.retryAfter === '1'
	);
	assert.equal(calls, 2);

	calls = 0;
	const denied = {
		send: async () => {
			calls += 1;
			throw s3Failure('AccessDenied', 403);
		}
	};
	await assert.rejects(
		s3.putCheckpointObject({ config, object, client: denied, retryDelayMs: noDelay }),
		(error) => error.code === 'checkpoint_unavailable' && error.status === 503 && error.upstreamName === 'AccessDenied'
	);
	assert.equal(calls, 1);

	// A denied STS assumption that only surfaces after the abort timer fired is
	// still a configuration failure: one attempt, AWS's own message kept.
	calls = 0;
	const slowDenial = {
		send: (_command, options) =>
			new Promise((_resolve, reject) => {
				calls += 1;
				options.abortSignal.addEventListener('abort', () =>
					reject(
						Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x is not authorized to perform: sts:AssumeRoleWithWebIdentity'), {
							name: 'AccessDenied',
							$metadata: { httpStatusCode: 403 }
						})
					)
				);
			})
	};
	await assert.rejects(
		s3.putCheckpointObject({ config, object, client: slowDenial, timeoutMs: 10, retryDelayMs: noDelay }),
		(error) =>
			error.code === 'checkpoint_unavailable' &&
			error.attempts === 1 &&
			error.upstreamName === 'AccessDenied' &&
			error.upstreamMessage.includes('sts:AssumeRoleWithWebIdentity')
	);
	assert.equal(calls, 1);

	calls = 0;
	const noCredentials = {
		send: async () => {
			calls += 1;
			throw Object.assign(new Error('no token'), { name: 'CredentialsProviderError' });
		}
	};
	await assert.rejects(
		s3.putCheckpointObject({ config, object, client: noCredentials, retryDelayMs: noDelay }),
		(error) => error.code === 'checkpoint_unavailable' && error.attempts === 1
	);
	assert.equal(calls, 1);

	calls = 0;
	const hanging = {
		send: (_command, options) =>
			new Promise((_resolve, reject) => {
				calls += 1;
				options.abortSignal.addEventListener('abort', () =>
					reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
				);
			})
	};
	await assert.rejects(
		s3.putCheckpointObject({ config, object, client: hanging, timeoutMs: 10, retryDelayMs: noDelay }),
		(error) => error.code === 'checkpoint_store_unreachable' && error.status === 504 && error.attempts === 2
	);
	assert.equal(calls, 2);

	calls = 0;
	const rejected = {
		send: async () => {
			calls += 1;
			throw s3Failure('InvalidRequest', 400);
		}
	};
	await assert.rejects(
		s3.putCheckpointObject({ config, object, client: rejected, retryDelayMs: noDelay }),
		(error) => error.code === 'checkpoint_write_failed' && error.status === 502
	);
	assert.equal(calls, 1);
});

test('demo transcripts get one immutable S3 object per turn under the writer prefix', async () => {
	const body = JSON.stringify({ schemaVersion: 1, kind: 'demo-transcript', messages: [{ role: 'user', content: 'hi' }] });
	const object = s3.demoTranscriptObject({
		configVersion: 'vaccine-chat-demo-v2',
		sessionKey: SESSION_ID,
		sequence: 3,
		body
	});
	assert.equal(object.key, `v2/vaccine-chat-demo-v2/demo/${SESSION_ID}/000003.json`);
	assert.equal(Buffer.from(object.body).toString('utf8'), body);
	assert.deepEqual(object.metadata, {
		kind: 'demo-transcript',
		schemaversion: '1',
		sessionkey: SESSION_ID,
		configversion: 'vaccine-chat-demo-v2',
		sequence: '3'
	});
	const input = s3.s3PutInput(S3_TEST_CONFIG, object);
	assert.equal(input.Key, object.key);
	assert.equal(input.ChecksumSHA256, createHash('sha256').update(object.body).digest('base64'));
	assert.equal(input.ContentType, 'application/json; charset=utf-8');
	for (const bad of [
		{ configVersion: '../escape', sessionKey: SESSION_ID, sequence: 1, body },
		{ configVersion: 'vaccine-chat-demo-v2', sessionKey: 'not/a/uuid', sequence: 1, body },
		{ configVersion: 'vaccine-chat-demo-v2', sessionKey: SESSION_ID, sequence: -1, body }
	]) {
		assert.throws(() => s3.demoTranscriptObject(bad), (error) => error.code === 'checkpoint_key_invalid');
	}

	let calls = 0;
	const client = {
		send: async (command) => {
			calls += 1;
			assert.equal(command.input.Key, object.key);
			return {};
		}
	};
	assert.deepEqual(
		await s3.putS3Object({ config: S3_TEST_CONFIG, input, client, retryDelayMs: () => 0 }),
		{ attempts: 1 }
	);
	assert.equal(calls, 1);
});

test('checkpoint store selection and S3 configuration fail closed', async () => {
	const storePath = 'src/lib/server/v2/checkpointStore.ts';
	const disabled = await loadServerModule(storePath, { CHECKPOINT_STORE: 's3' });
	assert.throws(() => disabled.selectCheckpointStore(), (error) => error.code === 'checkpoint_unavailable');
	const legacy = await loadServerModule(storePath, { ENABLE_V2_CHECKPOINT: 'true' });
	assert.equal(legacy.selectCheckpointStore(), 'qualtrics');
	const explicitLegacy = await loadServerModule(storePath, { ENABLE_V2_CHECKPOINT: 'true', CHECKPOINT_STORE: 'qualtrics' });
	assert.equal(explicitLegacy.selectCheckpointStore(), 'qualtrics');
	const selected = await loadServerModule(storePath, { ENABLE_V2_CHECKPOINT: '"true"', CHECKPOINT_STORE: ' “S3” ' });
	assert.equal(selected.selectCheckpointStore(), 's3');
	const unknown = await loadServerModule(storePath, { ENABLE_V2_CHECKPOINT: 'true', CHECKPOINT_STORE: 'dynamo' });
	assert.throws(() => unknown.selectCheckpointStore(), (error) => error.code === 'checkpoint_unavailable');

	// The shared module was loaded with an empty environment.
	assert.throws(() => s3.getS3CheckpointConfig(), (error) => error.code === 'checkpoint_unavailable' && error.status === 503);

	const s3Path = 'src/lib/server/v2/s3Checkpoint.ts';
	const goodEnv = {
		CHECKPOINT_AWS_REGION: ' us-east-1 ',
		CHECKPOINT_AWS_ROLE_ARN: `"${S3_TEST_CONFIG.roleArn}"`,
		CHECKPOINT_S3_BUCKET: S3_TEST_CONFIG.bucket
	};
	const configured = await loadServerModule(s3Path, goodEnv);
	assert.deepEqual(configured.getS3CheckpointConfig(), S3_TEST_CONFIG);
	const badBucket = await loadServerModule(s3Path, { ...goodEnv, CHECKPOINT_S3_BUCKET: 'Bad_Bucket' });
	assert.throws(() => badBucket.getS3CheckpointConfig(), (error) => error.code === 'checkpoint_unavailable');
	const badRole = await loadServerModule(s3Path, { ...goodEnv, CHECKPOINT_AWS_ROLE_ARN: 'AKIAIOSFODNN7EXAMPLE' });
	assert.throws(() => badRole.getS3CheckpointConfig(), (error) => error.code === 'checkpoint_unavailable');
});

test('checkpoint handles seal either a Qualtrics response ID or an S3 stream reference', () => {
	const config = configs.getStudyConfig('covid');
	const session = tokens.issueSessionToken({
		secret: SECRET,
		chatSessionKey: SESSION_ID,
		attemptNonce: ATTEMPT_ID,
		condition: 'covid',
		configVersion: config.configVersion,
		configHash: config.configHash,
		now: 2_000
	}).claims;
	const streamRef = `v2/${config.configVersion}/covid/${SESSION_ID}/${OPERATION_ID}`;
	for (const ref of ['R_legacy123', streamRef]) {
		const handle = tokens.issueCheckpointHandle({
			secret: SECRET,
			session,
			checkpointResponseId: ref,
			createOperationId: OPERATION_ID,
			acknowledgedSequence: 3,
			acknowledgedChecksum: 'b'.repeat(64),
			now: 2_000
		});
		assert.equal(handle.includes(SESSION_ID), false);
		const verified = tokens.verifyCheckpointHandle({ token: handle, secret: SECRET, session, now: 2_001 });
		assert.equal(verified.checkpointResponseId, ref);
	}
	const bogus = tokens.issueCheckpointHandle({
		secret: SECRET,
		session,
		checkpointResponseId: '../../etc/passwd',
		createOperationId: OPERATION_ID,
		acknowledgedSequence: 3,
		acknowledgedChecksum: 'b'.repeat(64),
		now: 2_000
	});
	assert.throws(() => tokens.verifyCheckpointHandle({ token: bogus, secret: SECRET, session, now: 2_001 }));
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

test('client default revisions match the active server registry for every arm', async () => {
	const constants = await loadServerModule('src/lib/v2/constants.ts');
	for (const arm of ['flu', 'covid', 'combo', 'demo']) {
		assert.equal(constants.CONFIG_VERSIONS[arm], configs.getStudyConfig(arm).configVersion);
	}
});

test('v13 category definitions, JSON enum, and validator agree; demo keeps its prior policy', () => {
	for (const arm of ['flu', 'covid', 'combo']) {
		const policy = configs.getStudyConfig(arm).scrubber;
		const definitions = [...policy.prompt.matchAll(/^- ([A-Z]+):/gm)].map((match) => match[1]);
		const outputEnum = /"category":"<([^>]+)>"/.exec(policy.prompt)?.[1].split('|');
		assert.deepEqual(definitions, V13_SCRUB_CATEGORIES);
		assert.deepEqual(outputEnum, V13_SCRUB_CATEGORIES);
		assert.deepEqual([...policy.categories], V13_SCRUB_CATEGORIES);
		assert.ok(Object.isFrozen(policy));
		assert.ok(Object.isFrozen(policy.categories));
	}
	const demo = configs.getStudyConfig('demo');
	assert.equal(demo.configVersion, 'vaccine-chat-demo-v3');
	assert.equal(demo.configHash, 'e8509a2f731b4d0f20884b1a81ca5e878236781cc02c3a1e3644435b31cc6b60');
	assert.deepEqual([...demo.scrubber.categories], TEST_SCRUB_CATEGORIES);
});

// The provider replies in these tests are MOCKED. They check the exact-span
// contract and both routing paths, not an empirical redaction-accuracy score.
test('v13 accepts all 18 categories through primary and cross-vendor fallback', async () => {
	const examples = {
		NAME: 'Jane Example', ADDRESS: 'Ithaca', DATES: 'May 14', PHONE: '202-555-0100',
		FAX: '202-555-0101', EMAIL: 'jane@example.invalid', SSN: '000-12-3456',
		MRN: 'MRN-X12', HPBN: 'PLAN-X12', ACCOUNT: 'ACCT-X12', LICENSE: 'LIC-X12',
		VEHICLE: 'TEST-PLATE-1', DEVICE: 'DEVICE-X12', URL: 'https://example.invalid/photo',
		IP: '192.0.2.10', BIOMETRIC: 'fingerprint template FP-X12',
		PHOTO: 'face encoding FACE-X12', ID: 'participant code CODE-X12'
	};
	assert.deepEqual(Object.keys(examples), V13_SCRUB_CATEGORIES);
	const originalFetch = globalThis.fetch;
	const policy = { ...configs.getStudyConfig('flu').scrubber, maxAttempts: 1 };
	try {
		for (const viaFallback of [false, true]) {
			for (const [category, text] of Object.entries(examples)) {
				const requests = [];
				globalThis.fetch = async (_url, init) => {
					const body = JSON.parse(String(init.body));
					requests.push(body);
					if (viaFallback && requests.length === 1) return new Response('', { status: 503 });
					return scrubProviderResponse([{ text, category }]);
				};
				const result = await scrubber.scrubUserMessage({
					scrubber: policy, history: [], userMessage: `My detail: ${text}.`,
					apiKey: 'unit-test-key', clientSignal: new AbortController().signal
				});
				assert.equal(result.text, `My detail: [${category}_1].`);
				assert.equal(result.spanCount, 1);
				assert.equal(result.usedFallback, viaFallback);
				assert.equal(requests.length, viaFallback ? 2 : 1);
				assert.equal(requests[0].model, policy.model.name);
				assert.equal(requests.at(-1).model, viaFallback ? policy.fallbackModel.name : policy.model.name);
				for (const request of requests) assert.equal(request.messages[0].content, policy.prompt);
			}
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('v13 mocked date, age, geography, and reuse reports preserve surrounding text', async () => {
	const cases = [
		{ raw: 'I was born May 14, 1980.', spans: [{ text: 'May 14', category: 'DATES' }], expected: 'I was born [DATES_1], 1980.' },
		{ raw: 'DOB 1980-05-14', spans: [{ text: '05-14', category: 'DATES' }], expected: 'DOB 1980-[DATES_1]' },
		{ raw: 'My appointment is 03/18/2026.', spans: [{ text: '03/18', category: 'DATES' }], expected: 'My appointment is [DATES_1]/2026.' },
		{ raw: 'I was born in 1980 and am 46.', spans: [], expected: 'I was born in 1980 and am 46.' },
		{ raw: 'I am 89 and my grandson is 9.', spans: [], expected: 'I am 89 and my grandson is 9.' },
		{ raw: 'I am 90 years old and paid 90 dollars.', spans: [{ text: '90 years old', category: 'DATES' }], expected: 'I am [DATES_1] and paid 90 dollars.' },
		{ raw: 'My mother is ninety-one.', spans: [{ text: 'ninety-one', category: 'DATES' }], expected: 'My mother is [DATES_1].' },
		{ raw: 'I was born in 1920.', spans: [{ text: '1920', category: 'DATES' }], expected: 'I was born in [DATES_1].' },
		{ raw: 'I was born in 1936.', spans: [{ text: '1936', category: 'DATES' }], expected: 'I was born in [DATES_1].' },
		{ raw: 'I was born in 1936 and am still 89.', spans: [], expected: 'I was born in 1936 and am still 89.' },
		{ raw: 'I was born in 1937.', spans: [], expected: 'I was born in 1937.' },
		{ raw: 'I was born May 14, 1920.', spans: [{ text: 'May 14, 1920', category: 'DATES' }], expected: 'I was born [DATES_1].' },
		{ raw: 'I live in Ithaca, New York 14850.', spans: [{ text: 'Ithaca', category: 'ADDRESS' }, { text: '14850', category: 'ADDRESS' }], expected: 'I live in [ADDRESS_1], New York [ADDRESS_2].' },
		{ raw: 'For the 2026/2027 vaccine, can a 65-year-old with asthma go to Safeway?', spans: [], expected: 'For the 2026/2027 vaccine, can a 65-year-old with asthma go to Safeway?' },
		{ raw: 'Anything else in Ithaca? I saw [NAME_1].', spans: [{ text: 'Ithaca', category: 'ADDRESS', reuse: 2 }, { text: '[NAME_1]', category: 'NAME' }], expected: 'Anything else in [ADDRESS_2]? I saw [NAME_1].', history: [{ id: 'u1', role: 'user', content: '[NAME_1] lives in [ADDRESS_2]' }, { id: 'a1', role: 'assistant', content: 'Can I help?' }] }
	];
	const originalFetch = globalThis.fetch;
	const policy = configs.getStudyConfig('flu').scrubber;
	try {
		for (const fixture of cases) {
			let input;
			globalThis.fetch = async (_url, init) => {
				input = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
				return scrubProviderResponse(fixture.spans);
			};
			const result = await scrubber.scrubUserMessage({
				scrubber: policy, history: fixture.history ?? [], userMessage: fixture.raw,
				apiKey: 'unit-test-key', clientSignal: new AbortController().signal
			});
			assert.equal(result.text, fixture.expected);
			assert.equal(input.newUserMessage, fixture.raw);
			assert.deepEqual(input.recentUserTurns, (fixture.history ?? []).filter((turn) => turn.role === 'user').map((turn) => turn.content));
			if (fixture.history) assert.deepEqual(input.usedPlaceholders, { NAME: 1, ADDRESS: 2 });
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('v13 malformed, obsolete-category, and non-verbatim reports fail closed after both models', async () => {
	const reports = [
		'not JSON', JSON.stringify({ spans: null }),
		JSON.stringify({ spans: [{ text: '', category: 'DATES' }] }),
		JSON.stringify({ spans: [{ text: 'Jane', category: 'UNKNOWN' }] }),
		JSON.stringify({ spans: [{ text: 'Jane', category: 'DOB' }] }),
		JSON.stringify({ spans: [{ text: 'Jane', category: 'CITY' }] }),
		JSON.stringify({ spans: [{ text: '90 or older', category: 'DATES' }] }),
		JSON.stringify({ spans: [{ text: 'Jane', category: 'NAME' }, { text: 'Jane', category: 'ID' }] })
	];
	const originalFetch = globalThis.fetch;
	const policy = { ...configs.getStudyConfig('flu').scrubber, maxAttempts: 1 };
	try {
		for (const report of reports) {
			const models = [];
			globalThis.fetch = async (_url, init) => {
				models.push(JSON.parse(String(init.body)).model);
				return new Response(JSON.stringify({ choices: [{ message: { content: report } }] }), { status: 200 });
			};
			await assert.rejects(
				scrubber.scrubUserMessage({
					scrubber: policy, history: [], userMessage: 'I am Jane and I am 90.',
					apiKey: 'unit-test-key', clientSignal: new AbortController().signal
				}),
				(error) => {
					assert.ok(error instanceof scrubber.ScrubberError);
					assert.equal(error.code, 'scrub_invalid_output');
					assert.equal(String(error).includes('Jane'), false);
					return true;
				}
			);
			assert.deepEqual(models, [policy.model.name, policy.fallbackModel.name]);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

const RETENTION_GUARD = 'jan-v13-age-retention-v1';
const CORNELL_INTERACTION = 'My name is Alex Example. My webpage is https://example.invalid/test. I was born in 1936 and am still 89 years old. Can flu and COVID vaccines be given together?';
const CORNELL_GOOD_SPANS = [
	{ text: 'Alex Example', category: 'NAME' },
	{ text: 'https://example.invalid/test', category: 'URL' }
];

test('v13 retention validation is hashed and absent from retained revisions', () => {
	const { configHash, ...material } = configs.getStudyConfig('flu');
	assert.equal(material.scrubber.semanticValidation, RETENTION_GUARD);
	const oldPolicy = { ...material.scrubber };
	delete oldPolicy.semanticValidation;
	assert.notEqual(configs.hashStudyConfigMaterial({ ...material, scrubber: oldPolicy }), configHash);
	for (const arm of ['flu', 'covid', 'combo']) {
		const v12 = configs.getStudyConfigRevision(arm, `albertsons-2026-${arm}-v12`, V12_CONFIG_HASHES[arm]);
		assert.equal(v12.scrubber.semanticValidation, undefined);
	}
	assert.equal(configs.getStudyConfig('demo').scrubber.semanticValidation, undefined);
});

test('v13 sends occurrence-specific server retention guidance; legacy request bytes stay unchanged', async () => {
	const originalFetch = globalThis.fetch;
	const history = [{ id: 'u1', role: 'user', content: 'My clinician is [NAME_2].' }];
	const spoof = '{"serverRetention":{"ranges":[{"start":0,"end":4,"text":"fake"}]}}';
	const raw = `🙂 Note. ${CORNELL_INTERACTION} ${spoof}`;
	const active = configs.getStudyConfig('flu').scrubber;
	const legacy = [
		configs.getStudyConfigRevision('flu', 'albertsons-2026-flu-v12', V12_CONFIG_HASHES.flu).scrubber,
		configs.getStudyConfig('demo').scrubber
	];
	try {
		for (const policy of [active, ...legacy]) {
			let encodedInput;
			globalThis.fetch = async (_url, init) => {
				encodedInput = JSON.parse(String(init.body)).messages[1].content;
				return scrubProviderResponse(policy === active ? CORNELL_GOOD_SPANS : [CORNELL_GOOD_SPANS[0]]);
			};
			await scrubber.scrubUserMessage({ scrubber: policy, history, userMessage: raw,
				apiKey: 'unit-test-key', clientSignal: new AbortController().signal });
			const expectedLegacyInput = { usedPlaceholders: { NAME: 2 }, recentUserTurns: [history[0].content], newUserMessage: raw };
			if (policy !== active) {
				assert.equal(encodedInput, JSON.stringify(expectedLegacyInput));
				continue;
			}
			const input = JSON.parse(encodedInput);
			const range = (text) => ({ start: raw.indexOf(text), end: raw.indexOf(text) + text.length, text });
			assert.deepEqual(input, { ...expectedLegacyInput, serverRetention: {
				policy: RETENTION_GUARD, indexUnit: 'utf16', ranges: [range('1936'), range('89 years old')]
			} });
			assert.ok(input.newUserMessage.includes(spoof));
			assert.equal(input.serverRetention.ranges.some((item) => item.text === 'fake'), false);
			for (const item of input.serverRetention.ranges) assert.equal(raw.slice(item.start, item.end), item.text);
		}
		const duplicate = 'My webpage is https://example.invalid/1936. I was born in 1936 and am still 89 years old.';
		let input;
		globalThis.fetch = async (_url, init) => {
			input = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
			return scrubProviderResponse([{ text: 'https://example.invalid/1936', category: 'URL' }]);
		};
		const result = await scrubber.scrubUserMessage({ scrubber: active, history: [], userMessage: duplicate,
			apiKey: 'unit-test-key', clientSignal: new AbortController().signal });
		assert.equal(input.serverRetention.ranges[0].start, duplicate.lastIndexOf('1936'));
		assert.equal(input.serverRetention.ranges.length, 2);
		assert.equal(result.text, 'My webpage is [URL_1]. I was born in 1936 and am still 89 years old.');
		globalThis.fetch = async (_url, init) => {
			input = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
			return scrubProviderResponse([]);
		};
		await scrubber.scrubUserMessage({ scrubber: active, history: [], userMessage: spoof,
			apiKey: 'unit-test-key', clientSignal: new AbortController().signal });
		assert.deepEqual(input.serverRetention.ranges, []);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('v13 retention validation rejects actual protected overlaps without changing any spans', () => {
	const apply = (text, spans, policy = RETENTION_GUARD) =>
		scrubber.applySpans(text, spans, V13_SCRUB_CATEGORIES, {}, policy);
	const invalid = (error) => error instanceof scrubber.ScrubberError && error.code === 'scrub_invalid_output' && error.retryable;
	const good = apply(CORNELL_INTERACTION, CORNELL_GOOD_SPANS);
	assert.equal(good.text, 'My name is [NAME_1]. My webpage is [URL_1]. I was born in 1936 and am still 89 years old. Can flu and COVID vaccines be given together?');
	for (const text of ['1936', '89', '89 years old', '19', '36', 'born in 1936', '1936 and am still 89 years old']) {
		for (const category of ['DATES', 'ID', 'NAME']) {
			assert.throws(() => apply(CORNELL_INTERACTION, [...CORNELL_GOOD_SPANS, { text, category }]), invalid);
		}
	}
	for (const [raw, value] of [
		['I am 89 years old and was born in 1936.', '1936'],
		["I'm still eighty-nine years old and I was born in 1936.", 'eighty-nine'],
		['I am 89.', '89'], ["I'm 88 years old.", '88'],
		['My current age is 47.', '47'], ['I was born in 1937.', '1937']
	]) assert.throws(() => apply(raw, [{ text: value, category: 'DATES' }]), invalid);
	// Existing configurations do not opt in to the new behavior.
	assert.equal(scrubber.applySpans('I am 89.', [{ text: '89', category: 'ID' }], V13_SCRUB_CATEGORIES, {}).text, 'I am [ID_1].');
});

test('v13 retention validation respects subjects, tense, units, and repeated occurrences', () => {
	const apply = (text, spans) => scrubber.applySpans(text, spans, V13_SCRUB_CATEGORIES, {}, RETENTION_GUARD);
	const collision = 'I was born in 1936 and am still 89 years old. My mother was born in 1936 and is 90.';
	assert.throws(() => apply(collision, [{ text: '1936', category: 'DATES' }]), /retention rule/);
	// A unique span in the other person's clause does not overlap the self clause.
	assert.equal(apply(collision, [{ text: '1936 and is 90', category: 'DATES' }]).text,
		'I was born in 1936 and am still 89 years old. My mother was born in [DATES_1].');
	for (const raw of [
		'I am 89. My mother was born in 1936 and is 90.',
		'I was born in 1936 and my mother is 89.',
		'I was born in 1936; I am 89.',
		'I was born in 1936 and am still 89 years old, but actually I turned 90.'
	]) assert.ok(apply(raw, [{ text: '1936', category: 'DATES' }]).text.includes('[DATES_1]'));
	assert.equal(apply('I was born in 1920 and am 89.', [{ text: '1920', category: 'DATES' }]).text, 'I was born in [DATES_1] and am 89.');
	for (const raw of ['I was 89 years old.', 'I will be 89 years old.', 'I am 89 percent sure.', 'I am 89 kg.', 'She said "I am 89 years old".']) {
		assert.ok(apply(raw, [{ text: '89', category: 'ID' }]).text.includes('[ID_1]'));
	}
	const identifierCollision = 'I am 89. My account is ACC-89.';
	assert.equal(apply(identifierCollision, [{ text: 'ACC-89', category: 'ACCOUNT' }]).text, 'I am 89. My account is [ACCOUNT_1].');
	assert.throws(() => apply(identifierCollision, [{ text: '89', category: 'ACCOUNT' }]), /retention rule/);
});

test('v13 semantic rejection retries, falls back, and fails closed without restoring text', async () => {
	const originalFetch = globalThis.fetch;
	const policy = configs.getStudyConfig('flu').scrubber;
	try {
		for (const succeedsOn of [2, 3, Infinity]) {
			const models = [];
			globalThis.fetch = async (_url, init) => {
				models.push(JSON.parse(String(init.body)).model);
				return scrubProviderResponse(models.length === succeedsOn
					? CORNELL_GOOD_SPANS
					: [...CORNELL_GOOD_SPANS, { text: '1936', category: 'DATES' }]);
			};
			const run = scrubber.scrubUserMessage({
				scrubber: policy, history: [], userMessage: CORNELL_INTERACTION,
				apiKey: 'unit-test-key', clientSignal: new AbortController().signal
			});
			if (Number.isFinite(succeedsOn)) {
				const result = await run;
				assert.equal(result.attempts, succeedsOn);
				assert.equal(result.usedFallback, succeedsOn === 3);
				assert.ok(result.text.includes('1936 and am still 89 years old'));
				assert.equal(result.text.includes('Alex Example'), false);
				assert.equal(result.text.includes('https://example.invalid/test'), false);
			} else {
				await assert.rejects(run, (error) => {
					assert.equal(error.code, 'scrub_invalid_output');
					assert.equal(error.retryable, true);
					assert.deepEqual(error.diagnostic, { validation: 'age_retention' });
					assert.equal(String(error).includes('1936'), false);
					assert.equal(String(error).includes('Alex'), false);
					return true;
				});
			}
			assert.deepEqual(models, succeedsOn === 2
				? [policy.model.name, policy.model.name]
				: [policy.model.name, policy.model.name, policy.fallbackModel.name]);
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
});

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
		3,
		'both completedHistory sites and the immediate user receipt sign canonical text'
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

test('v9 previews and published v12 surveys retain their revisions while v13 becomes active', () => {
	for (const arm of ['flu', 'covid', 'combo']) {
		const active = configs.getStudyConfig(arm);
		// No preference → active.
		assert.equal(active.configVersion, `albertsons-2026-${arm}-v13`);
		assert.equal(configs.getStudyConfigForNewSession(arm).configVersion, active.configVersion);
		// Allowlisted preview revision (Albertsons r8/v9 links) → honored.
		const preserved = configs.getStudyConfigForNewSession(arm, `albertsons-2026-${arm}-v9`);
		assert.equal(preserved.configVersion, `albertsons-2026-${arm}-v9`);
		assert.equal(preserved.configHash, V9_CONFIG_HASHES[arm]);
		// Deploying the app first must not break the still-published v12 survey.
		// It keeps the old immutable policy until its QSF explicitly requests v13.
		const publishedV12 = configs.getStudyConfigForNewSession(arm, `albertsons-2026-${arm}-v12`);
		assert.equal(publishedV12, configs.getStudyConfigRevision(arm, `albertsons-2026-${arm}-v12`, V12_CONFIG_HASHES[arm]));
		assert.equal(publishedV12.configHash, V12_CONFIG_HASHES[arm]);
		assert.deepEqual([...publishedV12.scrubber.categories], ['NAME', 'PHONE', 'EMAIL', 'ADDRESS', 'ID', 'DOB', 'CITY']);
		assert.equal(configs.getStudyConfigForNewSession(arm, `albertsons-2026-${arm}-v13`), active);
		assert.equal(active.configHash, V13_CONFIG_HASHES[arm]);
		// Any other historical revision → NOT honored (survey-side gate must fail visibly).
		for (const stale of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v10', 'v11']) {
			assert.equal(
				configs.getStudyConfigForNewSession(arm, `albertsons-2026-${arm}-${stale}`).configVersion,
				active.configVersion,
				`${arm} ${stale} must not be served to new sessions`
			);
		}
		// Unknown/garbage preference → active.
		assert.equal(configs.getStudyConfigForNewSession(arm, 'albertsons-2026-flu-v999').configVersion, active.configVersion);
		// A binding for a different arm cannot select that arm's legacy policy.
		const otherArm = arm === 'flu' ? 'covid' : 'flu';
		assert.equal(configs.getStudyConfigForNewSession(arm, `albertsons-2026-${otherArm}-v12`), active);
	}
	assert.equal(configs.getStudyConfigForNewSession('demo', 'albertsons-2026-flu-v12'), configs.getStudyConfig('demo'));
	// Schema accepts the optional field and still rejects unknown keys.
	assert.equal(schemas.SessionRequestSchema.safeParse({ v: 2, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID, preferredConfigVersion: 'albertsons-2026-flu-v9' }).success, true);
	assert.equal(schemas.SessionRequestSchema.safeParse({ v: 2, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID, preferredConfigVersion: '' }).success, false);
	assert.equal(schemas.SessionRequestSchema.safeParse({ v: 2, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID, bogus: 1 }).success, false);
});

// --- Observability (ADO 12573, 12575, 12576, 12579) ---------------------------

function fetchFailure(message, cause) {
	// Shape of an undici fetch() rejection: a bare TypeError whose `cause` is
	// the Node system error carrying the code that actually matters.
	return Object.assign(new TypeError('fetch failed'), {
		cause: Object.assign(new Error(message), cause)
	});
}

test('LOG_LEVEL overrides the default level and unknown values fall back loudly', async () => {
	const { resolveLogLevel } = await loadServerModule('src/lib/logLevel.ts');
	assert.deepEqual(resolveLogLevel({}), { level: 'info' });
	assert.deepEqual(resolveLogLevel({ NODE_ENV: 'development' }), { level: 'debug' });
	assert.deepEqual(resolveLogLevel({ NODE_ENV: 'production', LOG_LEVEL: 'debug' }), { level: 'debug' });
	assert.deepEqual(resolveLogLevel({ NODE_ENV: 'development', LOG_LEVEL: ' WARN ' }), { level: 'warn' });
	assert.deepEqual(resolveLogLevel({ LOG_LEVEL: 'silent' }), { level: 'silent' });
	assert.deepEqual(resolveLogLevel({ LOG_LEVEL: 'verbose' }), { level: 'info', rejected: 'verbose' });
	assert.deepEqual(resolveLogLevel({ LOG_LEVEL: '' }), { level: 'info' });
});

test('network diagnostics flatten the cause chain and never carry a credential', async () => {
	const { networkErrorDiagnostic } = await loadServerModule('src/lib/server/v2/providerDiagnostics.ts');
	const reset = networkErrorDiagnostic(
		fetchFailure('connect ECONNRESET 104.18.2.115:443', { code: 'ECONNRESET', syscall: 'connect', errno: -54 })
	);
	assert.deepEqual(reset, {
		name: 'TypeError',
		code: 'ECONNRESET',
		syscall: 'connect',
		errno: -54,
		message: 'fetch failed',
		causeName: 'Error',
		causeMessage: 'connect ECONNRESET 104.18.2.115:443'
	});
	// undici's own errors: code but no syscall.
	const undici = networkErrorDiagnostic(
		fetchFailure('Connect Timeout Error', { code: 'UND_ERR_CONNECT_TIMEOUT', name: 'ConnectTimeoutError' })
	);
	assert.equal(undici.code, 'UND_ERR_CONNECT_TIMEOUT');
	assert.equal(undici.causeName, 'ConnectTimeoutError');
	// Abort reasons are plain errors: their message identifies the deadline.
	assert.deepEqual(networkErrorDiagnostic(new Error('stream_idle_timeout')), {
		name: 'Error',
		message: 'stream_idle_timeout'
	});
	// Names-and-codes mode (scrubber) drops every free-form message.
	const quiet = networkErrorDiagnostic(fetchFailure('getaddrinfo ENOTFOUND openrouter.ai', { code: 'ENOTFOUND', syscall: 'getaddrinfo' }), {
		includeMessage: false
	});
	assert.deepEqual(quiet, { name: 'TypeError', code: 'ENOTFOUND', syscall: 'getaddrinfo', causeName: 'Error' });
	// Defensive redaction of anything key-shaped, and bounded length.
	const leaky = networkErrorDiagnostic(new Error(`rejected Bearer sk-or-v1-abcdef header ${'x'.repeat(400)}`));
	assert.equal(leaky.message.includes('sk-or-'), false);
	assert.equal(leaky.message.includes('abcdef'), false);
	assert.ok(leaky.message.length <= 201);
	// Non-error throwables do not crash the diagnostic path.
	assert.deepEqual(networkErrorDiagnostic('boom'), { name: 'string' });
	assert.deepEqual(networkErrorDiagnostic(undefined), { name: 'undefined' });
});

test('provider connect failure is typed as before but carries the network specifics and attempt count', async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		throw fetchFailure('connect ECONNRESET 104.18.2.115:443', { code: 'ECONNRESET', syscall: 'connect', errno: -54 });
	};
	try {
		// The retained combo v2 revision still permits a second attempt; the
		// active Opus 5 policy delegates retries to OpenRouter and allows one.
		const retryingConfig = configs.getStudyConfigRevision(
			'combo',
			'albertsons-2026-combo-v2',
			V2_CONFIG_HASHES.combo
		);
		assert.ok(retryingConfig);
		await assert.rejects(
			openrouter.startOpenRouterStream({
				config: retryingConfig,
				history: [],
				userMessage: 'Is it safe?',
				providerSessionId: SESSION_ID,
				apiKey: 'sk-or-test',
				clientSignal: new AbortController().signal
			}),
			(error) => {
				assert.equal(error instanceof openrouter.OpenRouterStartError, true);
				// Participant-facing classification is unchanged by this change.
				assert.equal(error.code, 'provider_start_timeout');
				assert.equal(error.status, 503);
				assert.equal(error.retryable, true);
				// Operator-facing detail is new.
				assert.equal(error.attempts, 2);
				assert.equal(error.diagnostic.phase, 'connect');
				assert.equal(error.diagnostic.abortedBy, 'none');
				assert.equal(error.diagnostic.network.code, 'ECONNRESET');
				assert.equal(error.diagnostic.network.syscall, 'connect');
				assert.equal(error.diagnostic.network.causeMessage, 'connect ECONNRESET 104.18.2.115:443');
				assert.equal(JSON.stringify(error.diagnostic).includes('sk-or-test'), false);
				return true;
			}
		);
		assert.equal(calls, 2, 'a retryable connect failure is attempted twice');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('provider first-byte abort records which deadline or party stopped the attempt', async () => {
	const originalFetch = globalThis.fetch;
	const client = new AbortController();
	globalThis.fetch = async (_url, init) =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\n'));
					init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
					// Abort from the client side once the provider has connected.
					setTimeout(() => client.abort(new DOMException('participant left', 'AbortError')), 5);
				}
			}),
			{ status: 200, headers: { 'content-type': 'text/event-stream' } }
		);
	try {
		await assert.rejects(
			openrouter.startOpenRouterStream({
				config: configs.getStudyConfig('flu'),
				history: [],
				userMessage: 'Is it safe?',
				providerSessionId: SESSION_ID,
				apiKey: 'sk-or-test',
				clientSignal: client.signal
			}),
			(error) => {
				assert.equal(error.code, 'provider_unavailable');
				assert.equal(error.retryable, false);
				assert.equal(error.attempts, 1);
				assert.equal(error.diagnostic.phase, 'first_byte');
				assert.equal(error.diagnostic.abortedBy, 'client');
				assert.equal(error.diagnostic.network.name, 'AbortError');
				return true;
			}
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('generation ID comes from the response header, else the first streamed chunk', async () => {
	const originalFetch = globalThis.fetch;
	const providerSse = [
		'data: {"id":"gen-chunk-0123","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
		'',
		'data: {"id":"gen-chunk-0123","choices":[{"delta":{},"finish_reason":"stop"}]}',
		'',
		'data: [DONE]',
		''
	].join('\n');
	const start = () =>
		openrouter.startOpenRouterStream({
			config: configs.getStudyConfig('flu'),
			history: [],
			userMessage: 'Is it safe?',
			providerSessionId: SESSION_ID,
			apiKey: 'sk-or-test',
			clientSignal: new AbortController().signal
		});
	try {
		globalThis.fetch = async () =>
			new Response(providerSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
		const fromChunk = await start();
		assert.equal(fromChunk.generationId, 'gen-chunk-0123');
		fromChunk.cancel();

		globalThis.fetch = async () =>
			new Response(providerSse, {
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-header-9' }
			});
		const fromHeader = await start();
		assert.equal(fromHeader.generationId, 'gen-header-9');
		fromHeader.cancel();

		// A header that is not a plain token is ignored rather than logged.
		globalThis.fetch = async () =>
			new Response(providerSse, {
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen <script>' }
			});
		const sanitized = await start();
		assert.equal(sanitized.generationId, 'gen-chunk-0123');
		sanitized.cancel();
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('mid-stream transport failure keeps its coarse code and attaches a diagnostic cause', async () => {
	const originalFetch = globalThis.fetch;
	const encoder = new TextEncoder();
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(
						encoder.encode('data: {"id":"gen-mid","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n')
					);
					setTimeout(
						() =>
							controller.error(
								Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' })
							),
						5
					);
				}
			}),
			{ status: 200, headers: { 'content-type': 'text/event-stream' } }
		);
	try {
		const stream = await openrouter.startOpenRouterStream({
			config: configs.getStudyConfig('flu'),
			history: [],
			userMessage: 'Is it safe?',
			providerSessionId: SESSION_ID,
			apiKey: 'sk-or-test',
			clientSignal: new AbortController().signal
		});
		const events = [];
		for await (const event of stream.events()) events.push(event);
		assert.deepEqual(events[0], { kind: 'delta', text: 'Hello' });
		const last = events.at(-1);
		assert.equal(last.kind, 'error');
		assert.equal(last.code, 'stream_interrupted');
		assert.equal(last.cause.code, 'ECONNRESET');
		assert.equal(last.cause.syscall, 'read');
		assert.equal(last.cause.message, 'read ECONNRESET');
		// Provider-emitted error payloads are not transport failures: no cause.
		globalThis.fetch = async () =>
			new Response(
				'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n' +
					'data: {"error":{"code":"overloaded","message":"upstream overloaded"}}\n\n',
				{ status: 200, headers: { 'content-type': 'text/event-stream' } }
			);
		const providerErrored = await openrouter.startOpenRouterStream({
			config: configs.getStudyConfig('flu'),
			history: [],
			userMessage: 'Is it safe?',
			providerSessionId: SESSION_ID,
			apiKey: 'sk-or-test',
			clientSignal: new AbortController().signal
		});
		const providerEvents = [];
		for await (const event of providerErrored.events()) providerEvents.push(event);
		assert.deepEqual(providerEvents.at(-1), { kind: 'error', code: 'overloaded' });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('scrubber transport failure exposes error names and codes but no free-form text', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw fetchFailure('getaddrinfo ENOTFOUND openrouter.ai', { code: 'ENOTFOUND', syscall: 'getaddrinfo' });
	};
	try {
		await assert.rejects(
			scrubber.scrubUserMessage({
				scrubber: TEST_SCRUBBER,
				history: [],
				userMessage: 'My name is Pat and I live in Springfield.',
				apiKey: 'sk-or-test',
				clientSignal: new AbortController().signal
			}),
			(error) => {
				assert.equal(error instanceof scrubber.ScrubberError, true);
				assert.equal(error.code, 'scrub_unavailable');
				assert.deepEqual(error.diagnostic.network, {
					name: 'TypeError',
					code: 'ENOTFOUND',
					syscall: 'getaddrinfo',
					causeName: 'Error'
				});
				const serialized = JSON.stringify(error.diagnostic);
				assert.equal(serialized.includes('Springfield'), false);
				assert.equal(serialized.includes('message'), false);
				return true;
			}
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('chat route emits one outcome event per turn carrying the generation ID', async () => {
	const source = await readFile(
		fileURLToPath(new URL('../src/routes/api/v2/chat/+server.ts', import.meta.url)),
		'utf8'
	);
	for (const event of ['v2_turn_complete', 'v2_stream_failure', 'v2_stream_cancelled', 'v2_provider_start_failure']) {
		assert.ok(source.includes(`'${event}'`), `${event} is emitted`);
	}
	// The shared turn context joins every stream-phase event to OpenRouter and
	// to the transcript without carrying the turn text.
	const context = source.slice(source.indexOf('const turnContext = ()'), source.indexOf('const logStreamFailure'));
	for (const field of ['generationId', 'assistantMessageId', 'turnId', 'deltasDelivered', 'clientAborted', 'firstDeltaMs']) {
		assert.ok(context.includes(field), `turn context includes ${field}`);
	}
	assert.equal(context.includes('assistantText'), false);
	assert.equal(context.includes('canonicalUserMessage'), false);
});


const RECEIPT_USER_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_ASSISTANT_ID = '22222222-2222-4222-8222-222222222222';
function provenanceFixture(config = configs.getStudyConfig('flu')) {
	const issued = tokens.issueSessionToken({ secret: SECRET, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID,
		condition: config.condition, configVersion: config.configVersion, configHash: config.configHash });
	const snapshot = canonicalSnapshot({ condition: config.condition, configVersion: config.configVersion, configHash: config.configHash }).snapshot;
	snapshot.messages = config.initialMessages.map(({ id, role, content }) => ({ id, role, content, createdAtISO: snapshot.createdAtISO,
		isInitial: true, completionStatus: 'complete', excludedFromModel: true }));
	const user = { id: RECEIPT_USER_ID, turnId: RECEIPT_USER_ID, role: 'user', content: 'My name is [NAME_1]. 🧪',
		createdAtISO: snapshot.createdAtISO, isInitial: false, completionStatus: 'complete', excludedFromModel: false };
	const assistant = { id: RECEIPT_ASSISTANT_ID, turnId: user.id, role: 'assistant', content: 'A screened answer 🧪',
		createdAtISO: snapshot.createdAtISO, isInitial: false, completionStatus: 'complete', excludedFromModel: false };
	const historyTag = tokens.issueHistoryTag({ secret: SECRET, session: issued.claims, sequence: 0, history: [] });
	return { secret: SECRET, config, session: issued.claims, snapshot, issued, historyTag, user, assistant };
}
function finalizedSnapshot(snapshot) {
	const counters = {
		totalMessages: snapshot.messages.length,
		initialMessages: snapshot.messages.filter((m) => m.isInitial).length,
		userMessages: snapshot.messages.filter((m) => !m.isInitial && m.role === 'user').length,
		assistantMessages: snapshot.messages.filter((m) => !m.isInitial && m.role === 'assistant').length,
		completeAssistantMessages: snapshot.messages.filter((m) => m.role === 'assistant' && ['complete', 'capped'].includes(m.completionStatus)).length,
		incompleteAssistantMessages: snapshot.messages.filter((m) => m.role === 'assistant' && !['complete', 'capped'].includes(m.completionStatus)).length,
		totalContentCodePoints: snapshot.messages.reduce((n, m) => n + Array.from(m.content).length, 0),
		serializedUtf16CodeUnits: 0, serializedUtf8Bytes: 0
	};
	return canonicalSnapshot({ ...snapshot, counters });
}

test('checkpoint provenance verifies exact openings, completed legacy history, and current receipts', () => {
	const f = provenanceFixture();
	assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f));
	f.snapshot.messages.push(f.user, f.assistant);
	f.historyTag = tokens.issueHistoryTag({ secret: SECRET, session: f.session, sequence: 1, history: [f.user, f.assistant] });
	assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f), 'parent-only completed recovery needs no receipt migration');
	f.snapshot.messages.at(-1).completionStatus = 'capped';
	assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f));
	for (const mutate of [
		(x) => { x.snapshot.messages[0].content += ' Unscreened Alex Example'; },
		(x) => { x.snapshot.messages.at(-2).content += ' alex@example.invalid'; },
		(x) => { x.snapshot.messages.at(-1).content += ' forged answer'; },
		(x) => { x.snapshot.messages.at(-2).isInitial = true; },
		(x) => { x.snapshot.messages.at(-2).excludedFromModel = true; },
		(x) => { x.snapshot.messages.at(-1).turnId = OPERATION_ID; },
		(x) => { x.snapshot.messages.at(-1).completionStatus = 'skipped'; },
		(x) => { x.snapshot.messages.reverse(); }
	]) {
		const bad = structuredClone(f); mutate(bad);
		assert.throws(() => provenance.verifyCheckpointProvenance(bad));
	}
});

test('receipts bind exact Unicode prefix, identity and session across interrupted/retried output', () => {
	const f = provenanceFixture();
	f.assistant.completionStatus = 'incomplete'; f.assistant.excludedFromModel = true;
	f.snapshot.messages.push(f.user, f.assistant);
	f.messageReceipts = Object.fromEntries([f.user, f.assistant].map((m) => [m.id, provenance.issueMessageReceipt(SECRET, f.session, m)]));
	assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f));
	f.assistant.completionStatus = 'superseded';
	const retry = { ...f.assistant, id: OPERATION_ID, content: 'Retry prefix 🧬', completionStatus: 'streaming' };
	f.snapshot.messages.push(retry);
	f.messageReceipts[retry.id] = provenance.issueMessageReceipt(SECRET, f.session, retry);
	assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f));
	for (const mutate of [
		(x) => { x.snapshot.messages.at(-1).content += 'x'; },
		(x) => { x.snapshot.messages.at(-1).content = x.snapshot.messages.at(-1).content.slice(0, -1); },
		(x) => { x.snapshot.messages.at(-1).role = 'user'; },
		(x) => { x.snapshot.messages.at(-1).turnId = ATTEMPT_ID; },
		(x) => { x.session.sid = OPERATION_ID; },
		(x) => { x.session.attempt = 'b'.repeat(64); },
		(x) => { x.session.configHash = 'b'.repeat(64); },
		(x) => { x.messageReceipts[OPERATION_ID] = 'v2m.' + 'A'.repeat(43); },
		(x) => { delete x.messageReceipts; }
	]) {
		const bad = structuredClone(f); mutate(bad);
		assert.throws(() => provenance.verifyCheckpointProvenance(bad));
	}
	const empty = { ...retry, content: '' };
	f.snapshot.messages[f.snapshot.messages.length - 1] = empty;
	delete f.messageReceipts[empty.id];
	assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f), 'empty UI placeholder contains no unproven text');
});

test('checkpoint metadata cannot smuggle arbitrary narrative alongside proven content', () => {
	const f = provenanceFixture();
	for (const mutate of [
		(x) => { x.reasonHint = 'My email is alex@example.invalid'; },
		(x) => { x.snapshot.captureErrors.push({ atISO: x.snapshot.createdAtISO, stage: 'checkpoint', code: 'Alex Example' }); },
		(x) => { x.snapshot.messages[0].failureReason = '555-010-1234'; }
	]) {
		const bad = structuredClone(f); mutate(bad);
		assert.throws(() => provenance.verifyCheckpointProvenance(bad), (error) => !error.message.includes('Alex') && !error.message.includes('@'));
	}
});

const ROUTE_LOGGER_MOCK = `export const logger = { info(){}, debug(){}, warn(){}, error(){} };`;
const ROUTE_ENV = { SESSION_SIGNING_KEY: SECRET, OPENROUTER_API_KEY: 'synthetic-key', ENABLE_V2_CHECKPOINT: 'true', CHECKPOINT_STORE: 's3' };
const ROUTE_MOCKS = {
	'$lib/logger': ROUTE_LOGGER_MOCK,
	'@vercel/functions': 'export function waitUntil(p) { globalThis.__provenanceWaits.push(p); }',
	'$lib/server/v2/s3Checkpoint': `
		export function getS3CheckpointConfig() { return {}; }
		export function checkpointObject({ snapshot }) { return { streamRef: 'v2/test/reference', checksum: 'a'.repeat(64) }; }
		export async function putCheckpointObject() { globalThis.__provenanceWrites++; return { attempts: 1 }; }
	`
};
function requestFor(path, body, headers = {}) {
	return new Request('https://study.example' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('session route demands bound prior proof for resume and rejects every unscreened revision', async () => {
	const route = await loadServerModule('src/routes/api/v2/session/[condition]/+server.ts', ROUTE_ENV, ROUTE_MOCKS);
	for (const condition of ['flu', 'covid', 'combo', 'demo']) {
		const config = configs.getStudyConfig(condition);
		const body = { v: 2, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID };
		const fresh = await route.POST({ params: { condition }, request: requestFor('/session', body) });
		assert.equal(fresh.status, 200);
		const data = await fresh.json();
		const resumedBody = { ...body, resumeConfig: { configVersion: data.configVersion, configHash: data.configHash } };
		for (const badProof of ['', data.historyTag + 'x']) {
			const denied = await route.POST({ params: { condition }, request: requestFor('/session', resumedBody, { 'x-session-resume-proof': badProof }) });
			assert.equal(denied.status, 403);
		}
		const valid = await route.POST({ params: { condition }, request: requestFor('/session', resumedBody, { 'x-session-resume-proof': data.historyTag }) });
		assert.equal(valid.status, 200);
		for (const changed of [{ chatSessionKey: OPERATION_ID }, { attemptNonce: OPERATION_ID }]) {
			const denied = await route.POST({ params: { condition }, request: requestFor('/session', { ...resumedBody, ...changed }, { 'x-session-resume-proof': data.historyTag }) });
			assert.equal(denied.status, 403);
		}
		if (condition !== 'demo') {
			for (const version of [9, 12]) {
				const older = await route.POST({ params: { condition }, request: requestFor('/session', {
					...body, preferredConfigVersion: `albertsons-2026-${condition}-v${version}`
				}) });
				assert.equal(older.status, 200);
				const olderData = await older.json();
				assert.equal(olderData.configVersion, `albertsons-2026-${condition}-v${version}`);
				const wrongConfig = await route.POST({ params: { condition }, request: requestFor('/session', resumedBody,
					{ 'x-session-resume-proof': olderData.historyTag }) });
				assert.equal(wrongConfig.status, 403);
			}
		}
		const historical = tokens.issueSessionToken({ secret: SECRET, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID,
			condition, configVersion: config.configVersion, configHash: config.configHash, now: 1 });
		assert.throws(() => tokens.verifySessionToken(historical.token, SECRET));
		const priorHistory = tokens.issueHistoryTag({ secret: SECRET, session: historical.claims, sequence: 0, history: [] });
		assert.equal((await route.POST({ params: { condition }, request: requestFor('/session', resumedBody, { 'x-session-resume-proof': priorHistory }) })).status, 200,
			'renewal uses persistent signed history, not an expired one-hour token');
	}
	for (const condition of ['flu', 'covid', 'combo']) {
		for (const version of [1, 2, 3, 4, 5, 6]) {
			// Obtain retained config hash from the registered list through the
			// fixed historical hashes already exercised elsewhere in this file.
			const hashes = { 1: V1_CONFIG_HASHES, 2: V2_CONFIG_HASHES, 3: V3_CONFIG_HASHES, 4: V4_CONFIG_HASHES, 5: V5_CONFIG_HASHES, 6: V6_CONFIG_HASHES };
			const versionName = `albertsons-2026-${condition}-v${version}`;
			const old = tokens.issueSessionToken({ secret: SECRET, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID,
				condition, configVersion: versionName, configHash: hashes[version][condition] });
			const proof = tokens.issueHistoryTag({ secret: SECRET, session: old.claims, sequence: 0, history: [] });
			const denied = await route.POST({ params: { condition }, request: requestFor('/session', {
				v: 2, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID, resumeConfig: { configVersion: versionName, configHash: old.claims.configHash }
			}, { 'x-session-resume-proof': proof }) });
			assert.equal(denied.status, 409);
		}
	}
});

test('checkpoint route rejects unproven data and metadata before any storage call', async () => {
	const route = await loadServerModule('src/routes/api/v2/checkpoint/+server.ts', ROUTE_ENV, ROUTE_MOCKS);
	const f = provenanceFixture();
	globalThis.__provenanceWrites = 0;
	const submit = async (fixture, extras = {}) => {
		const { json } = finalizedSnapshot(fixture.snapshot);
		return route.POST({ request: requestFor('/checkpoint', { v: 2, createOperationId: OPERATION_ID,
			snapshotSequence: fixture.snapshot.snapshotSequence, state: fixture.snapshot.state, transcriptJson: json,
			historyTag: fixture.historyTag, ...extras }, { authorization: `Bearer ${fixture.issued.token}` }) });
	};
	const initialResponse = await submit(f);
	assert.equal(initialResponse.status, 200, await initialResponse.text());
	assert.equal(globalThis.__provenanceWrites, 1);
	f.snapshot.messages.push(f.user, { ...f.assistant, completionStatus: 'incomplete', excludedFromModel: true });
	assert.equal((await submit(f)).status, 409);
	const receipts = Object.fromEntries(f.snapshot.messages.filter((m) => !m.isInitial).map((m) => [m.id, provenance.issueMessageReceipt(SECRET, f.session, m)]));
	assert.equal((await submit(f, { messageReceipts: receipts })).status, 200);
	const before = globalThis.__provenanceWrites;
	for (const extras of [{ messageReceipts: receipts, reasonHint: 'alex@example.invalid' }, { messageReceipts: {} }]) {
		const denied = await submit(f, extras);
		assert.equal(denied.status, 409);
		assert.equal(globalThis.__provenanceWrites, before);
		assert.equal((await denied.text()).includes('alex@example.invalid'), false);
	}
	const forged = structuredClone(f); forged.snapshot.messages.at(-1).content += ' raw';
	assert.equal((await submit(forged, { messageReceipts: receipts })).status, 409);
	assert.equal(globalThis.__provenanceWrites, before);
	const oversized = requestFor('/checkpoint', { padding: 'x'.repeat(400_001) }, { authorization: `Bearer ${f.issued.token}` });
	assert.equal((await route.POST({ request: oversized })).status, 413);
	assert.equal(globalThis.__provenanceWrites, before);
});


test('predeployment v12 completed history remains proven but unreceipted interrupted text does not', () => {
	const old = configs.getStudyConfigRevision('flu', 'albertsons-2026-flu-v12', V12_CONFIG_HASHES.flu);
	const f = provenanceFixture(old);
	f.snapshot.messages.push(f.user, f.assistant);
	f.historyTag = tokens.issueHistoryTag({ secret: SECRET, session: f.session, sequence: 1, history: [f.user, f.assistant] });
	assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f));
	f.snapshot.messages.push({ ...f.assistant, id: OPERATION_ID, content: 'Unproven interrupted text', completionStatus: 'incomplete', excludedFromModel: true });
	assert.throws(() => provenance.verifyCheckpointProvenance(f));
});

test('checkpoint route rejects duplicate-key raw bytes even with correct counters and valid receipts', async () => {
	const route = await loadServerModule('src/routes/api/v2/checkpoint/+server.ts', ROUTE_ENV, ROUTE_MOCKS);
	const f = provenanceFixture(); f.snapshot.messages.push(f.user);
	const finalized = finalizedSnapshot(f.snapshot).snapshot;
	let transcriptJson = '';
	for (let i = 0; i < 10; i++) {
		transcriptJson = JSON.stringify(finalized).replace(JSON.stringify(f.user.content),
			JSON.stringify('Alex Hidden alex@example.invalid') + ',"content":' + JSON.stringify(f.user.content));
		if (finalized.counters.serializedUtf16CodeUnits === transcriptJson.length && finalized.counters.serializedUtf8Bytes === Buffer.byteLength(transcriptJson)) break;
		finalized.counters.serializedUtf16CodeUnits = transcriptJson.length;
		finalized.counters.serializedUtf8Bytes = Buffer.byteLength(transcriptJson);
	}
	assert.equal(JSON.parse(transcriptJson).messages.at(-1).content, f.user.content);
	assert.equal(JSON.parse(transcriptJson).counters.serializedUtf16CodeUnits, transcriptJson.length);
	globalThis.__provenanceWrites = 0;
	const response = await route.POST({ request: requestFor('/checkpoint', { v: 2, createOperationId: OPERATION_ID,
		snapshotSequence: finalized.snapshotSequence, state: finalized.state, transcriptJson,
		historyTag: f.historyTag, messageReceipts: { [f.user.id]: provenance.issueMessageReceipt(SECRET, f.session, f.user) }
	}, { authorization: `Bearer ${f.issued.token}` }) });
	assert.equal(response.status, 400);
	assert.equal(globalThis.__provenanceWrites, 0);
	assert.equal((await response.text()).includes('alex@example.invalid'), false);
});

const CHAT_ROUTE_MOCKS = { ...ROUTE_MOCKS,
	'$lib/server/v2/scrubber': `
		export class ScrubberError extends Error {}
		export async function scrubUserMessage() { globalThis.__provenanceScrubs++; return { text: 'My name is [NAME_1]. 🧪', spanCount: 1, attempts: 1, usedFallback: false }; }
	`,
	'$lib/server/v2/openrouter': `
		export class OpenRouterStartError extends Error {}
		export async function startOpenRouterStream(args) {
			globalThis.__provenanceAnswers++; globalThis.__provenanceRelayed = args.userMessage;
			return { generationId: 'synthetic-generation', cancel(){}, async *events() {
				yield { kind: 'delta', text: 'A screened ' };
				yield { kind: 'delta', text: 'answer 🧪' };
				if (globalThis.__provenanceInterrupt) throw new Error('Synthetic interruption');
				yield { kind: 'done', finishReason: 'stop' };
			}};
		}
	`
};
test('actual chat route emits canonical-user and interrupted-prefix receipts that verify at checkpoint', async () => {
	const route = await loadServerModule('src/routes/api/v2/chat/+server.ts', ROUTE_ENV, CHAT_ROUTE_MOCKS);
	for (const interrupted of [false, true]) {
		const f = provenanceFixture();
		globalThis.__provenanceScrubs = 0; globalThis.__provenanceAnswers = 0; globalThis.__provenanceInterrupt = interrupted;
		const response = await route.POST({ request: requestFor('/chat', { v: 2, sequence: 1, history: [], historyTag: f.historyTag,
			turn: { id: f.user.id, userMessage: 'My name is Alex Example. 🧪' } },
			{ authorization: `Bearer ${f.issued.token}`, 'idempotency-key': f.user.id }) });
		assert.equal(response.status, 200);
		const events = (await response.text()).trim().split('\n\n').map((part) => {
			const lines = part.split('\n'); return { event: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) };
		});
		const meta = events.find((e) => e.event === 'meta').data;
		const deltas = events.filter((e) => e.event === 'delta');
		assert.equal(meta.scrubbedUserMessage, f.user.content);
		assert.equal(globalThis.__provenanceRelayed, f.user.content);
		assert.equal(globalThis.__provenanceScrubs, 1); assert.equal(globalThis.__provenanceAnswers, 1);
		f.assistant.id = meta.assistantMessageId;
		f.assistant.content = '';
		f.assistant.completionStatus = 'incomplete'; f.assistant.excludedFromModel = true;
		f.snapshot.messages.push(f.user, f.assistant);
		f.messageReceipts = { [f.user.id]: meta.userReceipt };
		assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f), 'current canonical user before answer');
		for (const delta of deltas) {
			f.assistant.content += delta.data.text;
			f.messageReceipts[f.assistant.id] = delta.data.receipt;
			assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f));
		}
		assert.equal(events.at(-1).event, interrupted ? 'error' : 'done');
		if (!interrupted) {
			f.assistant.completionStatus = 'complete'; f.assistant.excludedFromModel = false;
			f.historyTag = events.at(-1).data.historyTag;
			delete f.messageReceipts;
			assert.doesNotThrow(() => provenance.verifyCheckpointProvenance(f), 'completed parent-only recovery uses history');
		}
	}
});

test('pre-screening session credentials cannot call chat or checkpoint even if cryptographically valid', async () => {
	const chat = await loadServerModule('src/routes/api/v2/chat/+server.ts', ROUTE_ENV, CHAT_ROUTE_MOCKS);
	const checkpointRoute = await loadServerModule('src/routes/api/v2/checkpoint/+server.ts', ROUTE_ENV, ROUTE_MOCKS);
	globalThis.__provenanceScrubs = 0; globalThis.__provenanceAnswers = 0; globalThis.__provenanceWrites = 0;
	for (const [version, hashes] of Object.entries({ 1: V1_CONFIG_HASHES, 2: V2_CONFIG_HASHES, 3: V3_CONFIG_HASHES, 4: V4_CONFIG_HASHES, 5: V5_CONFIG_HASHES, 6: V6_CONFIG_HASHES })) {
		for (const condition of ['flu', 'covid', 'combo']) {
			const old = tokens.issueSessionToken({ secret: SECRET, chatSessionKey: SESSION_ID, attemptNonce: ATTEMPT_ID,
				condition, configVersion: `albertsons-2026-${condition}-v${version}`, configHash: hashes[condition] });
			for (const route of [chat, checkpointRoute]) {
				const denied = await route.POST({ request: requestFor('/api', {}, { authorization: `Bearer ${old.token}` }) });
				assert.equal(denied.status, 409);
				assert.equal((await denied.json()).error.code, 'config_revision_unsupported');
			}
		}
	}
	assert.equal(globalThis.__provenanceScrubs, 0); assert.equal(globalThis.__provenanceAnswers, 0); assert.equal(globalThis.__provenanceWrites, 0);
});
