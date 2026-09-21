#!/usr/bin/env node
// Read-side companion to src/lib/server/v2/s3Checkpoint.ts. Never deployed.
//
// Lists every checkpoint object under a prefix, keeps the highest snapshot
// sequence per create operation, downloads those, verifies the transcript
// checksum the browser was acknowledged with, and writes one JSON file per
// stream plus a manifest CSV. Runs with the research team's *reader* role via
// the ordinary AWS credential chain (AWS_PROFILE, SSO, etc.); the Vercel
// writer role cannot list or read and is not usable here by design.
//
//   node scripts/checkpoint-export.mjs \
//     --bucket wharton-vaccine-chat-checkpoint-loadtest \
//     --prefix v2/albertsons-2026-flu-v10/ \
//     --out ./exports/flu [--region us-east-1] [--manifest-only]
//
// Object layout (see s3Checkpoint.ts):
//   v2/<configVersion>/<condition>/<sessionKey>/<createOperationId>/<sequence>.json

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
	const args = { region: process.env.AWS_REGION || 'us-east-1', prefix: 'v2/', out: null, manifestOnly: false };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const next = () => {
			index += 1;
			if (index >= argv.length) throw new Error(`${flag} needs a value`);
			return argv[index];
		};
		if (flag === '--bucket') args.bucket = next();
		else if (flag === '--prefix') args.prefix = next();
		else if (flag === '--region') args.region = next();
		else if (flag === '--out') args.out = next();
		else if (flag === '--manifest-only') args.manifestOnly = true;
		else if (flag === '--help' || flag === '-h') {
			console.log('usage: checkpoint-export.mjs --bucket <name> [--prefix v2/...] [--out <dir>] [--region us-east-1] [--manifest-only]');
			process.exit(0);
		} else throw new Error(`unknown argument ${flag}`);
	}
	if (!args.bucket) throw new Error('--bucket is required');
	if (!args.prefix.startsWith('v2/')) throw new Error('--prefix must start with v2/');
	if (!args.manifestOnly && !args.out) throw new Error('--out is required unless --manifest-only');
	return args;
}

const KEY_PATTERN = /^(v2\/[^/]+\/[^/]+\/[^/]+\/[^/]+)\/(\d{6})\.json$/;

async function listLatestPerStream(client, bucket, prefix) {
	const latest = new Map(); // streamRef -> { key, sequence, count }
	let continuationToken;
	do {
		const page = await client.send(
			new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
		);
		for (const item of page.Contents ?? []) {
			const match = KEY_PATTERN.exec(item.Key ?? '');
			if (!match) continue;
			const streamRef = match[1];
			const sequence = Number(match[2]);
			const current = latest.get(streamRef);
			if (!current) latest.set(streamRef, { key: item.Key, sequence, count: 1 });
			else {
				current.count += 1;
				if (sequence > current.sequence) {
					current.key = item.Key;
					current.sequence = sequence;
				}
			}
		}
		continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (continuationToken);
	return latest;
}

async function readEnvelope(client, bucket, key) {
	const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
	const bytes = Buffer.from(await response.Body.transformToByteArray());
	const bodySha256Base64 = createHash('sha256').update(bytes).digest('base64');
	const envelope = JSON.parse(bytes.toString('utf8'));
	const transcriptChecksumOk =
		typeof envelope.transcriptJson === 'string' &&
		createHash('sha256').update(envelope.transcriptJson).digest('hex') === envelope.checksum;
	const objectChecksumOk = response.ChecksumSHA256 ? response.ChecksumSHA256 === bodySha256Base64 : null;
	return { envelope, transcriptChecksumOk, objectChecksumOk, metadata: response.Metadata ?? {} };
}

const csvCell = (value) => {
	const text = value === null || value === undefined ? '' : String(value);
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const client = new S3Client({ region: args.region });
	const latest = await listLatestPerStream(client, args.bucket, args.prefix);
	console.error(`${latest.size} checkpoint stream(s) under s3://${args.bucket}/${args.prefix}`);

	const rows = [];
	let failures = 0;
	for (const [streamRef, entry] of [...latest.entries()].sort()) {
		const { envelope, transcriptChecksumOk, objectChecksumOk } = await readEnvelope(client, args.bucket, entry.key);
		if (!transcriptChecksumOk || objectChecksumOk === false) failures += 1;
		let transcript = null;
		try {
			transcript = JSON.parse(envelope.transcriptJson);
		} catch {
			failures += 1;
		}
		rows.push({
			sessionKey: envelope.sessionKey,
			createOperationId: envelope.createOperationId,
			condition: envelope.condition,
			configVersion: envelope.configVersion,
			latestSequence: envelope.snapshotSequence,
			snapshotObjects: entry.count,
			state: envelope.state,
			reasonHint: envelope.reasonHint,
			storedAtISO: envelope.storedAtISO,
			messages: Array.isArray(transcript?.messages) ? transcript.messages.length : '',
			transcriptChecksumOk,
			objectChecksumOk,
			key: entry.key
		});
		if (!args.manifestOnly) {
			await mkdir(args.out, { recursive: true });
			const file = path.join(args.out, `${envelope.sessionKey}--${envelope.createOperationId}.json`);
			const rest = { ...envelope };
			delete rest.transcriptJson; // the parsed transcript replaces the raw string
			await writeFile(
				file,
				JSON.stringify({ ...rest, transcriptChecksumOk, objectChecksumOk, streamRef, transcript }, null, 2)
			);
		}
	}

	const header = Object.keys(rows[0] ?? { sessionKey: '' });
	const csv = [header.join(','), ...rows.map((row) => header.map((name) => csvCell(row[name])).join(','))].join('\n');
	if (args.manifestOnly) {
		process.stdout.write(`${csv}\n`);
	} else {
		await mkdir(args.out, { recursive: true });
		await writeFile(path.join(args.out, 'manifest.csv'), `${csv}\n`);
		console.error(`wrote ${rows.length} transcript file(s) and manifest.csv to ${args.out}`);
	}
	if (failures > 0) {
		console.error(`${failures} stream(s) failed checksum or parse verification; see manifest`);
		process.exitCode = 2;
	}
}

main().catch((error) => {
	console.error(error?.message ?? error);
	process.exitCode = 1;
});
