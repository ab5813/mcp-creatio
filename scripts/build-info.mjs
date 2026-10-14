// Writes dist/build-info.json — the deployment fingerprint served on GET /healthz.
//
//   commit      GIT_SHA env (CI / `docker build --build-arg GIT_SHA=…`), else `git rev-parse HEAD`,
//               else "unknown" (a docker build has no .git in its context).
//   sourceHash  sha256 over the files that make up the server (src/**, package.json,
//               package-lock.json), line endings normalized. Needs no git and no build args, so it
//               identifies the running code even when the builder passes nothing: compare it with
//               `node scripts/build-info.mjs --print` on the commit you expect.
//   builtAt     ISO timestamp of the build.
//
// Runs as the npm `postbuild` hook.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir) {
	return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
		const rel = path.posix.join(dir, entry.name);
		return entry.isDirectory() ? listFiles(rel) : [rel];
	});
}

export function computeSourceHash() {
	const files = [...listFiles('src'), 'package.json', 'package-lock.json']
		.filter((rel) => fs.existsSync(path.join(ROOT, rel)))
		.sort();
	const hash = crypto.createHash('sha256');
	for (const rel of files) {
		const content = fs
			.readFileSync(path.join(ROOT, rel))
			.toString('utf8')
			.replace(/\r\n/g, '\n');
		hash.update(`${rel}\0${content}\0`);
	}
	return hash.digest('hex');
}

function resolveCommit() {
	if (process.env.GIT_SHA) {
		return process.env.GIT_SHA;
	}
	try {
		return execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return 'unknown';
	}
}

const info = {
	commit: resolveCommit(),
	sourceHash: computeSourceHash(),
	builtAt: new Date().toISOString(),
};

if (process.argv.includes('--print')) {
	console.log(JSON.stringify(info, null, 2));
} else {
	fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
	fs.writeFileSync(
		path.join(ROOT, 'dist', 'build-info.json'),
		JSON.stringify(info, null, 2) + '\n',
	);
	console.log(
		`build-info: commit=${info.commit.slice(0, 12)} sourceHash=${info.sourceHash.slice(0, 12)}`,
	);
}
