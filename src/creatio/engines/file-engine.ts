import { FileDownloadRequest, FileDownloadResult, FileProvider } from '../contracts';

import { BaseEngine, EngineEnv } from './engine';

export class FileEngine extends BaseEngine {
	private readonly _provider: FileProvider;

	public readonly name = 'file';

	public get kind(): string {
		return this._provider.kind;
	}

	constructor(provider: FileProvider, env?: EngineEnv) {
		super(env);
		this._provider = provider;
	}

	/** Read-only: a download bypasses the mutate guard, like every other read, so it stays
	 *  available in readonly mode. */
	public download(request: FileDownloadRequest): Promise<FileDownloadResult> {
		return this._provider.download(request);
	}
}
