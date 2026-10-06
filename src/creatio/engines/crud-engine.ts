import {
	CrudCapabilities,
	CrudDeleteParams,
	CrudProvider,
	CrudUpdateParams,
	CrudWriteParams,
	EntitySchemaDescription,
	ReadQuery,
	ReadResult,
} from '../contracts';

import { BaseEngine, EngineEnv } from './engine';

export class CrudEngine extends BaseEngine {
	private readonly _provider: CrudProvider;

	public readonly name = 'crud';

	public get kind(): string {
		return this._provider.kind;
	}

	/** Read features the active backend honors — drives which read params the tool registers. */
	public get capabilities(): CrudCapabilities {
		return this._provider.capabilities;
	}

	constructor(provider: CrudProvider, env?: EngineEnv) {
		super(env);
		this._provider = provider;
	}

	public async listEntitySets(): Promise<string[]> {
		return this._entityAccess.filterEntities(await this._provider.listEntitySets());
	}

	public async describeEntity(entitySet: string): Promise<EntitySchemaDescription> {
		this._entityAccess.assertEntity(entitySet);
		return this._provider.describeEntity(entitySet);
	}

	public async read(query: ReadQuery): Promise<ReadResult> {
		this._entityAccess.assertRead(query);
		return this._provider.read(query);
	}

	public create(params: CrudWriteParams): Promise<any> {
		return this._mutate('crud.create', { entity: params.entity }, async () => {
			this._entityAccess.assertEntity(params.entity);
			return this._provider.create(params);
		});
	}

	public update(params: CrudUpdateParams): Promise<any> {
		return this._mutate('crud.update', { entity: params.entity, id: params.id }, async () => {
			this._entityAccess.assertEntity(params.entity);
			return this._provider.update(params);
		});
	}

	public delete(params: CrudDeleteParams): Promise<any> {
		return this._mutate('crud.delete', { entity: params.entity, id: params.id }, async () => {
			this._entityAccess.assertEntity(params.entity);
			return this._provider.delete(params);
		});
	}
}
