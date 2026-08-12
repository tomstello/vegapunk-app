import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function loadClientModule(relativePath) {
	const entryPoint = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
	const result = await build({
		entryPoints: [entryPoint],
		bundle: true,
		format: 'esm',
		platform: 'node',
		write: false,
		logLevel: 'silent'
	});
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

function fixtureFactory() {
	const now = new Date().toISOString();
	const state = () => ({
		schemaVersion: 2,
		condition: 'flu',
		chatSessionKey: crypto.randomUUID(),
		attemptNonce: crypto.randomUUID(),
		configVersion: 'albertsons-2026-flu-v1',
		configHash: 'a'.repeat(64),
		createOperationId: crypto.randomUUID(),
		messages: [],
		sequence: 0,
		historyTag: 'history-tag-for-client-unit-test-1234567890',
		draft: '',
		checkpointHandle: null,
		lastAcknowledgedCheckpointRevision: 0,
		checkpointInFlightSequence: null,
		checkpointInFlightStartedAtISO: null,
		lastParentAcknowledgedRevision: 0,
		parentSyncCount: 0,
		snapshotSequence: 100,
		lifecycle: 'ready',
		createdAtISO: now,
		updatedAtISO: now,
		chatEndISO: null,
		captureErrors: []
	});
	const initial = (content = 'x') => ({
		id: crypto.randomUUID(),
		role: 'assistant',
		content,
		createdAtISO: now,
		isInitial: true,
		completionStatus: 'complete',
		excludedFromModel: true
	});
	return { now, state, initial };
}

test('persisted drafts are bounded by Unicode code points, not UTF-16 units', async () => {
	const storage = await loadClientModule('src/lib/v2/storage.ts');
	const atLimit = `${'a'.repeat(750)}${'🧪'.repeat(750)}`;
	assert.equal(Array.from(atLimit).length, 1_500);
	assert.equal(atLimit.length, 2_250);
	assert.equal(storage.draftFitsStorage(atLimit), true);
	assert.equal(storage.draftFitsStorage(`${atLimit}🧪`), false);
});

test('Qualtrics parent origins are explicit, canonicalized, and reject URLs', async () => {
	const origins = await loadClientModule('src/lib/qualtricsOrigins.js');
	assert.deepEqual(
		origins.parseQualtricsParentOrigins(
			'https://mit.example.qualtrics.com/, https://mit.example.qualtrics.com,https://cornell.example.qualtrics.com'
		),
		['https://mit.example.qualtrics.com', 'https://cornell.example.qualtrics.com']
	);
	assert.deepEqual(origins.parseQualtricsParentOrigins(''), []);
	for (const invalid of [
		'http://mit.example.qualtrics.com',
		'https://mit.example.qualtrics.com/jfe/form/SV_test',
		'https://mit.example.qualtrics.com?tenant=other',
		'https://user@mit.example.qualtrics.com'
	]) {
		assert.throws(() => origins.parseQualtricsParentOrigins(invalid));
	}
});

test('a typed provider-route failure stays non-retryable and hides server diagnostics', async () => {
	const api = await loadClientModule('src/lib/v2/api.ts');
	const originalWindow = globalThis.window;
	const originalFetch = globalThis.fetch;
	globalThis.window = {
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: (timer) => clearTimeout(timer)
	};
	globalThis.fetch = async () => new Response(JSON.stringify({
		v: 2,
		error: {
			code: 'provider_route_unavailable',
			message: 'Internal provider amazon-bedrock/us was not found',
			retryable: false
		}
	}), {
		status: 503,
		headers: { 'content-type': 'application/json' }
	});
	try {
		await assert.rejects(
			api.streamChat({
				token: 'signed-session-token-for-client-test',
				sequence: 1,
				history: [],
				historyTag: 'signed-history-tag-for-client-test',
				turn: {
					id: '11111111-1111-4111-8111-111111111111',
					userMessage: 'Question'
				},
				onMeta: () => {},
				onDelta: () => {}
			}),
			(error) => {
				assert.equal(error instanceof api.ParticipantSafeError, true);
				assert.equal(error.code, 'chat_provider_route_unavailable');
				assert.equal(error.retryable, false);
				assert.equal(error.message.includes('amazon-bedrock'), false);
				assert.match(error.message, /question is saved/i);
				return true;
			}
		);
	} finally {
		globalThis.window = originalWindow;
		globalThis.fetch = originalFetch;
	}
});

test('session UI accepts only closed themes and retained v1 resumes remain parseable', async () => {
	const api = await loadClientModule('src/lib/v2/api.ts');
	const originalFetch = globalThis.fetch;
	const sessionKey = '11111111-1111-4111-8111-111111111111';
	const attemptNonce = '22222222-2222-4222-8222-222222222222';
	const response = {
		v: 2,
		sessionToken: 'signed-session-token-for-theme-test-1234567890',
		sessionKey,
		condition: 'flu',
		configVersion: 'albertsons-2026-flu-v6',
		configHash: 'a'.repeat(64),
		initialMessages: [],
		ui: {
			themeId: 'albertsons-v1',
			headerTitle: 'Flu vaccine information',
			headerSubtitle: 'Ask a question or browse common topics'
		},
		historyTag: 'signed-history-tag-for-theme-test-1234567890'
	};
	globalThis.fetch = async () => new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
	try {
		const active = await api.createPublicSession('flu', sessionKey, attemptNonce);
		assert.equal(active.ui.themeId, 'albertsons-v1');
		assert.equal(active.ui.headerSubtitle, 'Ask a question or browse common topics');

		response.ui.themeId = 'participant-supplied-css';
		await assert.rejects(
			api.createPublicSession('flu', sessionKey, attemptNonce),
			(error) => error.code === 'session_invalid_schema' && error.retryable === false
		);

		response.configVersion = 'albertsons-2026-flu-v1';
		response.ui = { headerTitle: 'Vaccine Questions' };
		const retained = await api.createPublicSession(
			'flu',
			sessionKey,
			attemptNonce,
			undefined,
			{ configVersion: response.configVersion, configHash: response.configHash }
		);
		assert.equal(retained.configVersion, 'albertsons-2026-flu-v1');
		assert.equal(retained.ui.themeId, undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('client preflight shares the Qualtrics 200-message boundary', async () => {
	const snapshot = await loadClientModule('src/lib/v2/snapshot.ts');
	const { state, initial, now } = fixtureFactory();
	const at198 = state();
	at198.messages = Array.from({ length: 198 }, () => initial());
	assert.equal(snapshot.canStartUserTurn(at198, 'q').ok, true);

	const at199 = { ...at198, messages: [...at198.messages, initial()] };
	assert.equal(snapshot.canStartUserTurn(at199, 'q').ok, false);
	const at200 = { ...at199, messages: [...at199.messages, initial()] };
	assert.equal(snapshot.canStartUserTurn(at200, 'q').ok, false);

	const turnId = crypto.randomUUID();
	const retry199 = state();
	retry199.lifecycle = 'interrupted';
	retry199.messages = [
		...Array.from({ length: 197 }, () => initial()),
		{
			id: turnId,
			turnId,
			role: 'user',
			content: 'q',
			createdAtISO: now,
			isInitial: false,
			completionStatus: 'complete',
			excludedFromModel: false
		},
		{
			id: crypto.randomUUID(),
			turnId,
			role: 'assistant',
			content: 'partial',
			createdAtISO: now,
			isInitial: false,
			completionStatus: 'incomplete',
			excludedFromModel: true
		}
	];
	assert.equal(snapshot.canRetryAssistant(retry199, turnId).ok, true);
	retry199.messages.push(initial());
	assert.equal(snapshot.canRetryAssistant(retry199, turnId).ok, false);
});

test('a preflight-approved maximum answer still admits terminal metadata at 240k', async () => {
	const [snapshot, constants] = await Promise.all([
		loadClientModule('src/lib/v2/snapshot.ts'),
		loadClientModule('src/lib/v2/constants.ts')
	]);
	const { state, initial, now } = fixtureFactory();
	const candidate = state();
	candidate.captureErrors = Array.from({ length: 20 }, (_, index) => ({
		atISO: now,
		stage: 'storage',
		code: `e${index}`
	}));
	const fixedMessages = Array.from({ length: 5 }, () => initial('\0'.repeat(4000)));
	const question = 'q'.repeat(constants.MAX_USER_CODE_POINTS);
	let low = 0;
	let high = 4000;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		candidate.messages = [...fixedMessages, initial('\0'.repeat(middle))];
		if (snapshot.canStartUserTurn(candidate, question).ok) low = middle;
		else high = middle - 1;
	}
	candidate.messages = [...fixedMessages, initial('\0'.repeat(low))];
	assert.equal(snapshot.canStartUserTurn(candidate, question).ok, true);
	if (low < 4000) {
		candidate.messages[candidate.messages.length - 1].content = '\0'.repeat(low + 1);
		assert.equal(snapshot.canStartUserTurn(candidate, question).ok, false);
		candidate.messages[candidate.messages.length - 1].content = '\0'.repeat(low);
	}

	const turnId = crypto.randomUUID();
	const terminal = {
		...candidate,
		lifecycle: 'completed',
		chatEndISO: now,
		snapshotSequence: candidate.snapshotSequence + 10,
		captureErrors: [
			...candidate.captureErrors,
			...Array.from({ length: 4 }, (_, index) => ({
				atISO: now,
				stage: 'transcript',
				code: `capacity_reserve_${index}_`.padEnd(100, 'x')
			}))
		].slice(-20),
		messages: [
			...candidate.messages,
			{
				id: turnId,
				turnId,
				role: 'user',
				content: question,
				createdAtISO: now,
				isInitial: false,
				completionStatus: 'complete',
				excludedFromModel: false
			},
			{
				id: crypto.randomUUID(),
				turnId,
				role: 'assistant',
				content: '\0'.repeat(constants.MAX_ASSISTANT_CODE_POINTS),
				createdAtISO: now,
				isInitial: false,
				completionStatus: 'complete',
				excludedFromModel: false
			}
		]
	};
	const serialized = snapshot.serializeSnapshot(terminal);
	assert.equal(snapshot.transcriptFits(serialized), true);
	assert.ok(serialized.utf16CodeUnits > 230_000);
});

test('stream delta hot path does not serialize the full transcript', async () => {
	const source = await readFile(
		fileURLToPath(new URL('../src/lib/v2/V2Chat.svelte', import.meta.url)),
		'utf8'
	);
	const body = source.slice(
		source.indexOf('function appendDeltaWithinLimits'),
		source.indexOf('function recoverAssistantAfterCaptureFailure')
	);
	assert.equal(body.includes('serializeSnapshot'), false);
	assert.ok(source.indexOf('queueStreamPresentation(assistantLocalId, accepted)') > source.indexOf('appendDeltaWithinLimits(assistantLocalId, delta)'));
	assert.equal(source.includes('await drainStreamPresentation();'), true);
	const exitBody = source.slice(
		source.indexOf('function flushOnExit'),
		source.indexOf('function countSignedHistoryPairs')
	);
	assert.equal(exitBody.includes('flushStreamPresentation();'), true);
});

test('stream presentation smoothing is Unicode-safe, bounded, and lossless', async () => {
	const presentation = await loadClientModule('src/lib/v2/streamPresentation.ts');
	const canonical = `${'Evidence and context. '.repeat(20)}${'🧪'.repeat(40)}`;
	let pending = canonical;
	let visible = '';
	for (let age = presentation.STREAM_PRESENTATION_FRAME_MS;
		age <= presentation.STREAM_PRESENTATION_MAX_LAG_MS;
		age += presentation.STREAM_PRESENTATION_FRAME_MS) {
		const frame = presentation.takePresentationFrame(pending, age);
		visible += frame.visible;
		pending = frame.pending;
		if (!pending) break;
	}
	assert.equal(visible, canonical);
	assert.equal(pending, '');
	assert.equal(Array.from(visible).length, Array.from(canonical).length);

	const small = presentation.takePresentationFrame('Short answer.', 0);
	assert.deepEqual(small, { visible: 'Short answer.', pending: '' });
	const forced = presentation.takePresentationFrame(canonical, presentation.STREAM_PRESENTATION_MAX_LAG_MS);
	assert.deepEqual(forced, { visible: canonical, pending: '' });
});

test('parent-only active recovery makes an orphaned saved user turn retryable', async () => {
	const recovery = await loadClientModule('src/lib/v2/recovery.ts');
	const { state, now } = fixtureFactory();
	const turnId = crypto.randomUUID();
	const parentRecovered = state();
	parentRecovered.lifecycle = 'ready';
	parentRecovered.messages = [{
		id: turnId,
		turnId,
		role: 'user',
		content: 'Saved in the parent before the iframe reloaded',
		createdAtISO: now,
		isInitial: false,
		completionStatus: 'complete',
		excludedFromModel: false
	}];

	const restored = recovery.restoreInterruptedTurn(
		parentRecovered,
		() => '99999999-9999-4999-8999-999999999999',
		() => now
	);
	assert.equal(restored.lifecycle, 'interrupted');
	assert.equal(restored.messages.length, 2);
	assert.deepEqual(restored.messages[1], {
		id: '99999999-9999-4999-8999-999999999999',
		turnId,
		role: 'assistant',
		content: '',
		createdAtISO: now,
		isInitial: false,
		completionStatus: 'incomplete',
		excludedFromModel: true,
		failureReason: 'client_reload_before_stream'
	});
});

test('a newer parent checkpoint lease survives when equal-revision local state wins', async () => {
	const recovery = await loadClientModule('src/lib/v2/recovery.ts');
	const { state } = fixtureFactory();
	const local = state();
	local.snapshotSequence = 12;
	local.lastAcknowledgedCheckpointRevision = 4;
	local.checkpointInFlightSequence = 5;
	local.checkpointInFlightStartedAtISO = '2026-08-03T15:00:00.000Z';
	const merged = recovery.mergeRecoveredCheckpointLease(local, {
		checkpointInFlightSequence: 9,
		checkpointInFlightStartedAtISO: '2026-08-03T15:01:00.000Z'
	});
	assert.equal(merged.checkpointInFlightSequence, 9);
	assert.equal(merged.checkpointInFlightStartedAtISO, '2026-08-03T15:01:00.000Z');
	assert.equal(merged.snapshotSequence, 12);
});

test('a newer local checkpoint handle beats an older parent copy without disabling backups', async () => {
	const recovery = await loadClientModule('src/lib/v2/recovery.ts');
	const { state } = fixtureFactory();
	const local = state();
	local.snapshotSequence = 20;
	local.checkpointHandle = 'new-local-handle-after-ack-1234567890';
	local.lastAcknowledgedCheckpointRevision = 18;
	const resolved = recovery.reconcileRecoveredCheckpointHandle(
		local,
		{
			handle: local.checkpointHandle,
			acknowledgedRevision: 18
		},
		{
			handle: 'old-parent-handle-before-ack-1234567890',
			acknowledgedRevision: 17
		}
	);
	assert.equal(resolved.conflict, false);
	assert.equal(resolved.state.checkpointHandle, local.checkpointHandle);
	assert.equal(resolved.state.lastAcknowledgedCheckpointRevision, 18);

	const divergentTie = recovery.reconcileRecoveredCheckpointHandle(
		local,
		{ handle: local.checkpointHandle, acknowledgedRevision: 18 },
		{ handle: 'different-handle-at-same-revision-1234567890', acknowledgedRevision: 18 }
	);
	assert.equal(divergentTie.conflict, true);
});

test('a recent recovered checkpoint lease waits only for its remaining guard window', async () => {
	const checkpoint = await loadClientModule('src/lib/v2/checkpointWorker.ts');
	const now = Date.parse('2026-08-03T16:00:00.000Z');
	assert.equal(
		checkpoint.checkpointRecoveryDelayMs('2026-08-03T15:59:30.000Z', now),
		checkpoint.CHECKPOINT_LEASE_GUARD_WINDOW_MS - 30_000
	);
	assert.equal(
		checkpoint.checkpointRecoveryDelayMs('2026-08-03T15:58:01.000Z', now),
		1_000
	);
	assert.equal(checkpoint.checkpointRecoveryDelayMs('2026-08-03T15:58:00.000Z', now), 0);
	assert.equal(checkpoint.checkpointRecoveryDelayMs('2026-08-03T15:50:00.000Z', now), 0);
	assert.equal(checkpoint.checkpointRecoveryDelayMs(null, now), 0);
});

test('an expired initial guard is not restarted by a delayed first enqueue', async () => {
	const checkpoint = await loadClientModule('src/lib/v2/checkpointWorker.ts');
	const { state } = fixtureFactory();
	const current = state();
	const originalWindow = globalThis.window;
	const originalFetch = globalThis.fetch;
	globalThis.window = {
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: (timer) => clearTimeout(timer)
	};
	globalThis.fetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		const checksum = crypto.createHash('sha256').update(body.transcriptJson).digest('hex');
		return new Response(JSON.stringify({
			v: 2,
			checkpointHandle: 'signed-handle-after-expired-guard-1234567890',
			acknowledgedSequence: body.snapshotSequence,
			checksum
		}), { status: 200 });
	};
	try {
		let sawSettlement;
		const settled = new Promise((resolve) => { sawSettlement = resolve; });
		const worker = new checkpoint.CheckpointWorker({
			getState: () => current,
			getToken: () => 'session-integrity-token-for-test',
			initialRecoveryDelayMs: 100,
			onLeaseStarted: () => {},
			onLeaseSettled: () => sawSettlement(),
			onAcknowledged: () => {},
			onFailure: (code) => assert.fail(code)
		});
		await new Promise((resolve) => setTimeout(resolve, 125));
		worker.enqueue({ snapshot: { snapshotSequence: 100, state: 'active' }, json: '{"revision":100}' }, 'late');
		await Promise.race([
			settled,
			new Promise((_, reject) => setTimeout(() => reject(new Error('expired guard restarted')), 60))
		]);
		worker.stop();
	} finally {
		globalThis.window = originalWindow;
		globalThis.fetch = originalFetch;
	}
});

test('the reload guard coalesces pending checkpoint work into the newest cumulative revision', async () => {
	const checkpoint = await loadClientModule('src/lib/v2/checkpointWorker.ts');
	const { state } = fixtureFactory();
	const current = state();
	current.checkpointHandle = 'opaque-signed-handle-for-reload-guard-test';
	const requests = [];
	const leases = [];
	const originalWindow = globalThis.window;
	const originalFetch = globalThis.fetch;
	globalThis.window = {
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: (timer) => clearTimeout(timer)
	};
	globalThis.fetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		requests.push(body);
		const checksum = crypto.createHash('sha256').update(body.transcriptJson).digest('hex');
		return new Response(JSON.stringify({
			v: 2,
			checkpointHandle: 'rotated-signed-handle-for-reload-guard-test',
			acknowledgedSequence: body.snapshotSequence,
			checksum
		}), { status: 200, headers: { 'content-type': 'application/json' } });
	};
	try {
		const worker = new checkpoint.CheckpointWorker({
			getState: () => current,
			getToken: () => 'session-integrity-token-for-test',
			initialRecoveryDelayMs: 25,
			onLeaseStarted: (sequence) => leases.push(['start', sequence]),
			onLeaseSettled: (sequence) => leases.push(['settled', sequence]),
			onAcknowledged: () => {},
			onFailure: (code) => assert.fail(code)
		});
		worker.enqueue({ snapshot: { snapshotSequence: 101, state: 'active' }, json: '{"revision":101}' }, 'old');
		worker.enqueue({ snapshot: { snapshotSequence: 102, state: 'active' }, json: '{"revision":102}' }, 'new');
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.deepEqual(requests.map((request) => request.snapshotSequence), [102]);
		assert.deepEqual(leases, [['start', 102], ['settled', 102]]);
		worker.stop();
	} finally {
		globalThis.window = originalWindow;
		globalThis.fetch = originalFetch;
	}
});

test('an ambiguous checkpoint keeps its lease and guards the next cumulative write', async () => {
	const checkpoint = await loadClientModule('src/lib/v2/checkpointWorker.ts');
	const { state } = fixtureFactory();
	const current = state();
	current.checkpointHandle = 'opaque-signed-handle-for-ambiguous-test';
	const requests = [];
	const leases = [];
	const failures = [];
	const originalWindow = globalThis.window;
	const originalFetch = globalThis.fetch;
	globalThis.window = {
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: (timer) => clearTimeout(timer)
	};
	globalThis.fetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		requests.push(body.snapshotSequence);
		if (requests.length === 1) throw new Error('ambiguous network loss');
		const checksum = crypto.createHash('sha256').update(body.transcriptJson).digest('hex');
		return new Response(JSON.stringify({
			v: 2,
			checkpointHandle: 'rotated-signed-handle-for-ambiguous-test',
			acknowledgedSequence: body.snapshotSequence,
			checksum
		}), { status: 200 });
	};
	try {
		const worker = new checkpoint.CheckpointWorker({
			getState: () => current,
			getToken: () => 'session-integrity-token-for-test',
			// Keep enough separation that assertion/runtime overhead cannot consume
			// the entire synthetic guard before the two synchronous enqueues below.
			ambiguousRecoveryDelayMs: 100,
			onLeaseStarted: (sequence) => leases.push(['start', sequence]),
			onLeaseSettled: (sequence) => leases.push(['settled', sequence]),
			onAcknowledged: () => {},
			onFailure: (code) => failures.push(code)
		});
		worker.enqueue({ snapshot: { snapshotSequence: 201, state: 'active' }, json: '{"revision":201}' }, 'ambiguous');
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(requests, [201]);
		assert.deepEqual(leases, [['start', 201]]);
		assert.deepEqual(failures, ['checkpoint_update_ambiguous']);
		worker.enqueue({ snapshot: { snapshotSequence: 202, state: 'active' }, json: '{"revision":202}' }, 'stale');
		worker.enqueue({ snapshot: { snapshotSequence: 203, state: 'active' }, json: '{"revision":203}' }, 'newest');
		await new Promise((resolve) => setTimeout(resolve, 180));
		assert.deepEqual(requests, [201, 203]);
		assert.deepEqual(leases, [
			['start', 201],
			['start', 203],
			['settled', 203]
		]);
		worker.stop();
	} finally {
		globalThis.window = originalWindow;
		globalThis.fetch = originalFetch;
	}
});

test('ambiguous HTTP and malformed success responses retain checkpoint leases', async (t) => {
	const checkpoint = await loadClientModule('src/lib/v2/checkpointWorker.ts');
	const cases = [
		{
			name: 'create 504 flag',
			handle: null,
			response: () => new Response(JSON.stringify({ v: 2, error: { code: 'ambiguous_create', ambiguousCreate: true } }), { status: 504 }),
			failure: 'checkpoint_create_ambiguous'
		},
		{
			name: 'update 504 timeout',
			handle: 'opaque-signed-handle-for-timeout-test',
			response: () => new Response(JSON.stringify({ v: 2, error: { code: 'checkpoint_update_unreachable', ambiguousCreate: false } }), { status: 504 }),
			failure: 'checkpoint_update_ambiguous'
		},
		{
			name: 'create invalid JSON 200',
			handle: null,
			response: () => new Response('{not-json', { status: 200 }),
			failure: 'checkpoint_invalid_json'
		},
		{
			name: 'create invalid schema 200',
			handle: null,
			response: () => new Response(JSON.stringify({ v: 2, checkpointHandle: 'missing-ack-and-checksum' }), { status: 200 }),
			failure: 'checkpoint_invalid_schema'
		},
		{
			name: 'create checksum mismatch 200',
			handle: null,
			response: (sequence) => new Response(JSON.stringify({
				v: 2,
				checkpointHandle: 'opaque-signed-handle-for-checksum-test',
				acknowledgedSequence: sequence,
				checksum: '0'.repeat(64)
			}), { status: 200 }),
			failure: 'checkpoint_checksum_mismatch'
		}
	];
	for (const [index, item] of cases.entries()) {
		await t.test(item.name, async () => {
			const { state } = fixtureFactory();
			const current = state();
			current.checkpointHandle = item.handle;
			const leases = [];
			const failures = [];
			let sawFailure;
			const failed = new Promise((resolve) => { sawFailure = resolve; });
			const originalWindow = globalThis.window;
			const originalFetch = globalThis.fetch;
			let worker;
			globalThis.window = {
				setTimeout: (callback, delay) => setTimeout(callback, delay),
				clearTimeout: (timer) => clearTimeout(timer)
			};
			globalThis.fetch = async (_url, options) => {
				const body = JSON.parse(options.body);
				return item.response(body.snapshotSequence);
			};
			try {
				worker = new checkpoint.CheckpointWorker({
					getState: () => current,
					getToken: () => 'session-integrity-token-for-test',
					ambiguousRecoveryDelayMs: 10,
					onLeaseStarted: (sequence) => leases.push(['start', sequence]),
					onLeaseSettled: (sequence) => leases.push(['settled', sequence]),
					onAcknowledged: () => assert.fail('ambiguous response acknowledged'),
					onFailure: (code) => {
						failures.push(code);
						sawFailure();
					}
				});
				const sequence = 300 + index;
				worker.enqueue({ snapshot: { snapshotSequence: sequence, state: 'active' }, json: JSON.stringify({ revision: sequence }) }, 'ambiguous');
				await Promise.race([
					failed,
					new Promise((_, reject) => setTimeout(() => reject(new Error('checkpoint failure callback timed out')), 1_000))
				]);
				await new Promise((resolve) => setTimeout(resolve, 0));
				assert.deepEqual(leases, [['start', sequence]]);
				assert.deepEqual(failures, [item.failure]);
			} finally {
				worker?.stop();
				globalThis.window = originalWindow;
				globalThis.fetch = originalFetch;
			}
		});
	}
});

test('a definitive failure drops stale pending work but permits a later lifecycle enqueue', async () => {
	const checkpoint = await loadClientModule('src/lib/v2/checkpointWorker.ts');
	const { state } = fixtureFactory();
	const current = state();
	const requests = [];
	const leases = [];
	const failures = [];
	const originalWindow = globalThis.window;
	const originalFetch = globalThis.fetch;
	globalThis.window = {
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: (timer) => clearTimeout(timer)
	};
	let releaseFirst;
	const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
	globalThis.fetch = async (_url, options) => {
		const body = JSON.parse(options.body);
		requests.push(body.snapshotSequence);
		if (requests.length === 1) {
			await firstMayFinish;
			return new Response(JSON.stringify({ v: 2, error: { code: 'checkpoint_rate_limited' } }), { status: 429 });
		}
		const checksum = crypto.createHash('sha256').update(body.transcriptJson).digest('hex');
		return new Response(JSON.stringify({
			v: 2,
			checkpointHandle: 'signed-handle-after-lifecycle-enqueue-1234567890',
			acknowledgedSequence: body.snapshotSequence,
			checksum
		}), { status: 200 });
	};
	try {
		const worker = new checkpoint.CheckpointWorker({
			getState: () => current,
			getToken: () => 'session-integrity-token-for-test',
			onLeaseStarted: (sequence) => leases.push(['start', sequence]),
			onLeaseSettled: (sequence) => leases.push(['settled', sequence]),
			onAcknowledged: () => {},
			onFailure: (code) => failures.push(code)
		});
		worker.enqueue({ snapshot: { snapshotSequence: 401, state: 'active' }, json: '{"revision":401}' }, 'question');
		await new Promise((resolve) => setTimeout(resolve, 5));
		worker.enqueue({ snapshot: { snapshotSequence: 402, state: 'active' }, json: '{"revision":402}' }, 'answer');
		releaseFirst();
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.deepEqual(requests, [401]);
		assert.deepEqual(failures, ['checkpoint_rate_limited']);
		worker.enqueue({ snapshot: { snapshotSequence: 403, state: 'active' }, json: '{"revision":403}' }, 'pagehide');
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.deepEqual(requests, [401, 403]);
		assert.deepEqual(leases, [
			['start', 401], ['settled', 401],
			['start', 403], ['settled', 403]
		]);
		worker.stop();
	} finally {
		globalThis.window = originalWindow;
		globalThis.fetch = originalFetch;
	}
});
