// The load generator builds checkpoint transcripts by hand, outside the app's
// TypeScript. These tests run its output through the real server validator, so
// a schema or counter change breaks here rather than mid-run against the
// load-test project.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

import {
	assistantMessage,
	newCheckpointContext,
	serializeSnapshot,
	snapshotRejection,
	userMessage,
	utf8Length
} from '../loadtest/snapshot.mjs';

let schemas;
let configs;

async function loadServerModule(relativePath, privateEnv = {}) {
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
						contents: `export const env = ${JSON.stringify(privateEnv)};`,
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

before(async () => {
	[schemas, configs] = await Promise.all([
		loadServerModule('src/lib/server/v2/schemas.ts'),
		loadServerModule('src/lib/server/v2/studyConfig.ts')
	]);
});

const SESSION_KEY = '11111111-1111-4111-8111-111111111111';

/** The session response shape the harness sees, from a real study config. */
function sessionResponse(arm = 'flu') {
	const config = configs.getPublicStudyConfig(configs.getStudyConfigForNewSession(arm));
	return {
		sessionKey: SESSION_KEY,
		condition: config.condition,
		configVersion: config.configVersion,
		configHash: config.configHash,
		initialMessages: config.initialMessages
	};
}

function expectationsFor(session, serialized) {
	return {
		sessionKey: session.sessionKey,
		condition: session.condition,
		configVersion: session.configVersion,
		configHash: session.configHash,
		snapshotSequence: serialized.snapshot.snapshotSequence,
		state: serialized.snapshot.state
	};
}

function contextWithTurns(session, turns) {
	const nowISO = new Date().toISOString();
	const context = newCheckpointContext(session, '22222222-2222-4222-8222-222222222222', nowISO);
	for (let index = 0; index < turns; index += 1) {
		const turnId = `33333333-3333-4333-8333-00000000000${index}`;
		context.messages.push(
			userMessage({
				id: turnId,
				turnId,
				content: `Question ${index}: is the flu shot safe?`,
				createdAtISO: nowISO
			}),
			assistantMessage({
				id: `44444444-4444-4444-8444-00000000000${index}`,
				turnId,
				content: `Answer ${index}. `.repeat(40),
				createdAtISO: nowISO
			})
		);
	}
	return context;
}

function serialize(context, overrides = {}) {
	context.snapshotSequence += 1;
	return serializeSnapshot(context, {
		state: 'active',
		chatEndISO: null,
		updatedAtISO: new Date().toISOString(),
		...overrides
	});
}

test('the opening-only snapshot validates against the server schema', () => {
	const session = sessionResponse();
	const context = contextWithTurns(session, 0);
	const serialized = serialize(context);
	schemas.validateTranscriptSnapshot(serialized.json, expectationsFor(session, serialized));
});

test('snapshots validate after each turn, for every arm', () => {
	for (const arm of ['flu', 'covid', 'combo']) {
		const session = sessionResponse(arm);
		const context = contextWithTurns(session, 0);
		for (let turn = 0; turn < 3; turn += 1) {
			const turnId = `55555555-5555-4555-8555-00000000000${turn}`;
			const atISO = new Date().toISOString();
			context.messages.push(
				userMessage({ id: turnId, turnId, content: `Turn ${turn} question`, createdAtISO: atISO }),
				assistantMessage({
					id: `66666666-6666-4666-8666-00000000000${turn}`,
					turnId,
					content: 'An answer with an emoji 🩺 and a non-ASCII dash – to move the byte counters.',
					createdAtISO: atISO
				})
			);
			const serialized = serialize(context);
			schemas.validateTranscriptSnapshot(serialized.json, expectationsFor(session, serialized));
		}
	}
});

test('the terminal snapshot validates', () => {
	const session = sessionResponse();
	const context = contextWithTurns(session, 2);
	const serialized = serialize(context, {
		state: 'completed',
		chatEndISO: new Date().toISOString()
	});
	schemas.validateTranscriptSnapshot(serialized.json, expectationsFor(session, serialized));
});

test('length counters describe the exact serialized JSON', () => {
	const session = sessionResponse();
	// Multi-byte and multi-code-unit content: the two counters diverge, and
	// writing either one changes the length it is describing.
	const context = contextWithTurns(session, 0);
	const turnId = '77777777-7777-4777-8777-777777777777';
	context.messages.push(
		userMessage({ id: turnId, turnId, content: '🩺'.repeat(50), createdAtISO: new Date().toISOString() }),
		assistantMessage({
			id: '88888888-8888-4888-8888-888888888888',
			turnId,
			content: 'até logo – 🧬'.repeat(30),
			createdAtISO: new Date().toISOString()
		})
	);
	const serialized = serialize(context);
	assert.equal(serialized.snapshot.counters.serializedUtf16CodeUnits, serialized.json.length);
	assert.equal(serialized.snapshot.counters.serializedUtf8Bytes, utf8Length(serialized.json));
	assert.notEqual(serialized.json.length, utf8Length(serialized.json));
	schemas.validateTranscriptSnapshot(serialized.json, expectationsFor(session, serialized));
});

test('identity fields are asserted against the signed session', () => {
	const session = sessionResponse();
	const context = contextWithTurns(session, 1);
	const serialized = serialize(context);
	for (const field of ['sessionKey', 'condition', 'configVersion', 'configHash']) {
		const wrong = {
			...expectationsFor(session, serialized),
			[field]: field === 'condition' ? 'covid' : 'x'.repeat(64)
		};
		assert.throws(() => schemas.validateTranscriptSnapshot(serialized.json, wrong), /does not match/);
	}
});

test('initial messages are rebuilt, not spread from the session response', () => {
	// The session response ships a v1-era hideInitialMessage on each initial
	// message. The browser never sees it -- parseSessionResponse rebuilds them as
	// {id, role, content} -- but the harness reads the response raw, and the
	// snapshot schema is strict, so spreading it would fail every checkpoint.
	const session = sessionResponse();
	assert.ok(
		Object.hasOwn(session.initialMessages[0], 'hideInitialMessage'),
		'session response no longer carries hideInitialMessage; this guard can go'
	);
	const context = contextWithTurns(session, 0);
	assert.deepEqual(Object.keys(context.messages[0]).sort(), [
		'completionStatus',
		'content',
		'createdAtISO',
		'excludedFromModel',
		'id',
		'isInitial',
		'role'
	]);

	// Re-converge the counters after adding the key, so the only thing wrong
	// with this snapshot is the extra key itself.
	const leaked = serialize(contextWithTurns(session, 0));
	leaked.snapshot.messages[0].hideInitialMessage = false;
	let json = '';
	for (let pass = 0; pass < 12; pass += 1) {
		json = JSON.stringify(leaked.snapshot);
		if (
			leaked.snapshot.counters.serializedUtf16CodeUnits === json.length &&
			leaked.snapshot.counters.serializedUtf8Bytes === utf8Length(json)
		) {
			break;
		}
		leaked.snapshot.counters.serializedUtf16CodeUnits = json.length;
		leaked.snapshot.counters.serializedUtf8Bytes = utf8Length(json);
	}
	assert.throws(
		() => schemas.validateTranscriptSnapshot(json, expectationsFor(session, leaked)),
		/Unrecognized key/
	);
});

test('oversized transcripts are refused before a request is spent', () => {
	const session = sessionResponse();
	const context = contextWithTurns(session, 0);
	const turnId = '99999999-9999-4999-8999-999999999999';
	context.messages.push(
		userMessage({ id: turnId, turnId, content: 'q', createdAtISO: new Date().toISOString() }),
		assistantMessage({
			id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			turnId,
			content: 'x'.repeat(300_000),
			createdAtISO: new Date().toISOString()
		})
	);
	const serialized = serialize(context);
	assert.equal(snapshotRejection(serialized, utf8Length(serialized.json) + 200), 'transcript_utf16_too_large');
});

test('a well-sized transcript is not refused', () => {
	const session = sessionResponse();
	const serialized = serialize(contextWithTurns(session, 3));
	assert.equal(snapshotRejection(serialized, utf8Length(serialized.json) + 200), null);
});
