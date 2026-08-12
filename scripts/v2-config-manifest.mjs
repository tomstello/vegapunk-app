#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const entryPoint = fileURLToPath(
	new URL('../src/lib/server/v2/studyConfig.ts', import.meta.url)
);
const result = await build({
	entryPoints: [entryPoint],
	bundle: true,
	format: 'esm',
	platform: 'node',
	write: false,
	logLevel: 'silent'
});
const registry = await import(
	`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const sha256 = (value) =>
	createHash('sha256').update(value, 'utf8').digest('hex');

const configurations = ['flu', 'covid', 'combo'].map((condition) => {
	const config = registry.getStudyConfig(condition);
	return {
		condition,
		configVersion: config.configVersion,
		configHash: config.configHash,
		themeId: config.ui.themeId ?? null,
		headerTitle: config.ui.headerTitle,
		headerSubtitle: config.ui.headerSubtitle ?? null,
		systemPromptSha256: sha256(config.systemPrompt),
		initialMessagesSha256: sha256(JSON.stringify(config.initialMessages)),
		model: config.model.name,
		reasoning: config.model.reasoning ?? null,
		providerOrder: config.model.provider.order ? [...config.model.provider.order] : null,
		providerOnly: [...config.model.provider.only],
		zdr: config.model.provider.zdr,
		dataCollection: config.model.provider.data_collection ?? null,
		allowFallbacks: config.model.provider.allow_fallbacks ?? null,
		requireParameters: config.model.provider.require_parameters ?? null,
		runtimePolicy: config.runtimePolicy
	};
});

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, configurations }, null, 2)}\n`);
