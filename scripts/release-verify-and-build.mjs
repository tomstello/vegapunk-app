// Opt-in paid release gate. Run where the production API key is already available.
// Child output contains synthetic fixture reports; never print environment variables.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function verifyAndBuild(run = spawnSync) {
	let evaluationFailed = false;
	for (const model of ['primary', 'fallback']) {
		console.log(`Release verification: evaluating ${model} on synthetic fixtures.`);
		const result = run(process.execPath, ['scripts/scrubber-eval.mjs', '--model', model], {
			cwd: projectRoot,
			stdio: 'inherit'
		});
		if (result.error || result.signal || result.status !== 0) {
			evaluationFailed = true;
			console.error(`Release verification failed for ${model}; exit status ${result.status ?? 'unavailable'}.`);
		}
	}
	if (evaluationFailed) {
		console.error('Release build stopped: both model evaluations must pass.');
		return 2;
	}
	console.log('Both model evaluations passed. Building the release.');
	const build = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
		cwd: projectRoot,
		stdio: 'inherit'
	});
	return build.error || build.signal ? 1 : (build.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = verifyAndBuild();
}
