import { describe, expect, it, vi } from 'vitest';

import {
	CreatioEngineManager,
	CrudEngine,
	EntityAccessError,
	EntityAccessPolicy,
	FileEngine,
} from '../../src/creatio';
import { Server } from '../../src/server/mcp';
import { makeFakeContext } from '../support/fake-context';

const policy = () => EntityAccessPolicy.fromList('Report, NormativeDocuments');

function fakeCrudProvider() {
	return {
		kind: 'crud',
		capabilities: { rawFilter: true, expand: true },
		listEntitySets: vi
			.fn()
			.mockResolvedValue([
				'Contact',
				'Report',
				'ReportFile',
				'NormativeDocuments',
				'Account',
			]),
		describeEntity: vi.fn().mockResolvedValue({}),
		read: vi.fn().mockResolvedValue({ items: [] }),
		create: vi.fn().mockResolvedValue({ id: 'x' }),
		update: vi.fn().mockResolvedValue('ok'),
		delete: vi.fn().mockResolvedValue('ok'),
	};
}

function crudEngine(entityAccess = policy()) {
	const provider = fakeCrudProvider();
	const engine = new CrudEngine(provider as never, {
		readonly: false,
		audit: vi.fn(),
		entityAccess,
	});
	return { provider, engine };
}

describe('EntityAccessPolicy', () => {
	it('is unrestricted when the allowlist is unset or blank', () => {
		for (const value of [undefined, '', ' , ']) {
			const p = EntityAccessPolicy.fromList(value);
			expect(p.restricted).toBe(false);
			expect(p.isAllowed('Contact')).toBe(true);
			expect(() =>
				p.assertRead({ entity: 'Contact', columns: ['Owner.Name'] }),
			).not.toThrow();
		}
	});

	it('allows the listed entities and their attachment companions, case-insensitively', () => {
		const p = policy();
		for (const entity of [
			'Report',
			'report',
			'ReportFile',
			'NormativeDocuments',
			'NormativeDocumentsFile',
		]) {
			expect(p.isAllowed(entity)).toBe(true);
		}
		for (const entity of ['Contact', 'SysFile', 'ReportX', 'Reports']) {
			expect(p.isAllowed(entity)).toBe(false);
		}
	});

	it('permits own columns and foreign-key ids, rejects lookup traversal', () => {
		const p = policy();
		expect(() =>
			p.assertRead({
				entity: 'ReportFile',
				columns: ['Name', 'ReportId', 'Report.Id', 'Report/Id'],
				filter: { kind: 'condition', field: 'Report.Id', op: 'eq', value: 'x' },
				order: [{ field: 'CreatedOn', dir: 'desc' }],
			}),
		).not.toThrow();
		expect(() => p.assertRead({ entity: 'Report', columns: ['Owner.Name'] })).toThrow(
			EntityAccessError,
		);
		expect(() =>
			p.assertRead({ entity: 'Report', order: [{ field: 'Owner/Name', dir: 'asc' }] }),
		).toThrow(/path:Owner\/Name/);
		expect(() =>
			p.assertRead({
				entity: 'Report',
				filter: {
					kind: 'group',
					logic: 'and',
					items: [
						{ kind: 'condition', field: 'Name', op: 'eq', value: 'a' },
						{ kind: 'in', field: 'Owner.Account.Id', values: ['x'] },
					],
				},
			}),
		).toThrow(/path:Owner\.Account\.Id/);
	});

	it('rejects the uninspectable OData escape hatches', () => {
		const p = policy();
		expect(() =>
			p.assertRead({ entity: 'Report', odata: { rawFilter: "Name eq 'a'" } }),
		).toThrow(/raw_filter/);
		expect(() => p.assertRead({ entity: 'Report', odata: { expand: ['Owner'] } })).toThrow(
			/expand/,
		);
	});
});

describe('engine enforcement of the entity allowlist', () => {
	it('filters list-entities down to the allowed set', async () => {
		const { engine } = crudEngine();
		expect(await engine.listEntitySets()).toEqual([
			'Report',
			'ReportFile',
			'NormativeDocuments',
		]);
	});

	it('blocks describe/read/write on other entities without reaching the provider', async () => {
		const { engine, provider } = crudEngine();
		await expect(engine.describeEntity('Contact')).rejects.toThrow(
			/entity_access_denied:entity:Contact/,
		);
		await expect(engine.read({ entity: 'Contact' })).rejects.toThrow(EntityAccessError);
		await expect(engine.create({ entity: 'Contact', data: {} })).rejects.toThrow(
			EntityAccessError,
		);
		await expect(engine.update({ entity: 'Account', id: '1', data: {} })).rejects.toThrow(
			EntityAccessError,
		);
		await expect(engine.delete({ entity: 'Account', id: '1' })).rejects.toThrow(
			EntityAccessError,
		);
		expect(provider.describeEntity).not.toHaveBeenCalled();
		expect(provider.read).not.toHaveBeenCalled();
		expect(provider.create).not.toHaveBeenCalled();
		expect(provider.update).not.toHaveBeenCalled();
		expect(provider.delete).not.toHaveBeenCalled();
	});

	it('passes allowed reads through', async () => {
		const { engine, provider } = crudEngine();
		await engine.read({ entity: 'Report', columns: ['Name'] });
		expect(provider.read).toHaveBeenCalledTimes(1);
	});

	it('limits read-file to allowed (attachment) entities', async () => {
		const provider = { kind: 'file', download: vi.fn().mockResolvedValue({}) };
		const engine = new FileEngine(provider as never, {
			readonly: false,
			audit: vi.fn(),
			entityAccess: policy(),
		});
		await expect(engine.download({ entity: 'ActivityFile', id: '1' })).rejects.toThrow(
			EntityAccessError,
		);
		await engine.download({ entity: 'ReportFile', id: '1' });
		expect(provider.download).toHaveBeenCalledTimes(1);
	});
});

describe('Server tool surface with an entity allowlist', () => {
	function handlerNames(readonlyMode: boolean) {
		const engines = new CreatioEngineManager(makeFakeContext() as never, {
			readonly: readonlyMode,
			entityAccess: policy(),
		});
		const server = new Server(engines, { readonlyMode });
		const internals = server as unknown as {
			_handlers: Map<string, unknown>;
			_preparers: unknown[];
		};
		return { names: [...internals._handlers.keys()].sort(), preparers: internals._preparers };
	}

	it('exposes only the data tools and no capability preparers', () => {
		const { names, preparers } = handlerNames(true);
		expect(names).toEqual(['describe-entity', 'list-entities', 'read', 'read-file']);
		expect(preparers).toEqual([]);
	});

	it('keeps CRUD writes (still policed) when not readonly, but nothing else', () => {
		const { names } = handlerNames(false);
		expect(names).toEqual([
			'create',
			'delete',
			'describe-entity',
			'list-entities',
			'read',
			'read-file',
			'update',
		]);
	});
});
