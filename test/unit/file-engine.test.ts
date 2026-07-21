import { describe, expect, it, vi } from 'vitest';

import { FileEngine } from '../../src/creatio/engines/file-engine';

const GUID = '11111111-1111-1111-1111-111111111111';

function makeProvider() {
	return {
		kind: 'creatio-file-service',
		download: vi.fn().mockResolvedValue({
			entity: 'ActivityFile',
			id: GUID,
			sizeBytes: 3,
			base64: 'YWJj',
		}),
	};
}

describe('FileEngine', () => {
	it('exposes the provider kind and passes downloads through', async () => {
		const provider = makeProvider();
		const engine = new FileEngine(provider as never);
		expect(engine.name).toBe('file');
		expect(engine.kind).toBe('creatio-file-service');
		const result = await engine.download({ entity: 'ActivityFile', id: GUID });
		expect(provider.download).toHaveBeenCalledWith({ entity: 'ActivityFile', id: GUID });
		expect(result.base64).toBe('YWJj');
	});

	it('stays available in readonly mode and never audits (it is a read)', async () => {
		const provider = makeProvider();
		const audit = vi.fn();
		const engine = new FileEngine(provider as never, { readonly: true, audit });
		await engine.download({ entity: 'ActivityFile', id: GUID });
		expect(provider.download).toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});
});
