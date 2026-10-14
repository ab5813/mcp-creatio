import fs from 'node:fs';
import path from 'node:path';

import pkg from '../package.json';

export const NAME: string =
	(
		pkg as {
			name?: string;
		}
	).name || 'creatio-mcp';

export const VERSION: string =
	(
		pkg as {
			version?: string;
		}
	).version || '0.0.0';

/** Deployment fingerprint written by `scripts/build-info.mjs` at build time (dist/build-info.json).
 *  Absent when running from source (ts-node / tests), hence the "dev" fallback. */
export interface BuildInfo {
	commit: string;
	sourceHash: string;
	builtAt: string;
}

function readBuildInfo(): BuildInfo {
	try {
		const raw = fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8');
		const parsed = JSON.parse(raw) as Partial<BuildInfo>;
		return {
			commit: String(parsed.commit ?? 'unknown'),
			sourceHash: String(parsed.sourceHash ?? 'unknown'),
			builtAt: String(parsed.builtAt ?? 'unknown'),
		};
	} catch {
		return { commit: 'dev', sourceHash: 'dev', builtAt: 'dev' };
	}
}

export const BUILD_INFO: BuildInfo = readBuildInfo();
