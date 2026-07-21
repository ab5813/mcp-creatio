import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_MAX_FILE_BYTES,
	FileServiceProvider,
} from '../../src/creatio/services/file-service-provider';
import { makeHttpClientHarness } from '../support/http-client';

const GUID = '11111111-1111-1111-1111-111111111111';

function binaryResponse(
	bytes: Uint8Array,
	headers: Record<string, string> = {},
	status = 200,
): Response {
	return new Response(bytes.buffer.slice(0) as ArrayBuffer, { status, headers });
}

function makeProvider(responder: (url: string) => Response | Promise<Response>) {
	const { client, calls } = makeHttpClientHarness((url) => responder(url));
	return { provider: new FileServiceProvider(client), calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('FileServiceProvider download', () => {
	it('fetches the OData /Data endpoint and returns base64 content with metadata', async () => {
		const bytes = new TextEncoder().encode('hello');
		const { provider, calls } = makeProvider(() =>
			binaryResponse(bytes, {
				'content-type': 'text/plain',
				'content-length': String(bytes.byteLength),
				'content-disposition': 'attachment; filename="notes.txt"',
			}),
		);
		const result = await provider.download({ entity: 'ActivityFile', id: GUID });
		expect(calls[0]!.url).toBe(
			`https://tenant.creatio.local/0/odata/ActivityFile(${GUID})/Data`,
		);
		// GET is fetch's default; the provider must not send a body.
		expect(calls[0]!.init.method).toBeUndefined();
		expect(calls[0]!.init.body).toBeUndefined();
		expect(result).toEqual({
			entity: 'ActivityFile',
			id: GUID,
			fileName: 'notes.txt',
			contentType: 'text/plain',
			sizeBytes: 5,
			base64: Buffer.from('hello').toString('base64'),
		});
	});

	it('round-trips arbitrary binary bytes losslessly', async () => {
		// All 256 byte values — the exact case a text-based body reader would corrupt.
		const bytes = new Uint8Array(256).map((_, i) => i);
		const { provider } = makeProvider(() => binaryResponse(bytes));
		const result = await provider.download({ entity: 'ContactFile', id: GUID });
		expect(Buffer.from(result.base64, 'base64')).toEqual(Buffer.from(bytes));
		expect(result.sizeBytes).toBe(256);
		// No Content-Disposition / Content-Type headers → optional fields stay absent.
		expect(result.fileName).toBeUndefined();
	});

	it('decodes an RFC 5987 UTF-8 filename', async () => {
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array([1]), {
				'content-disposition': "attachment; filename*=UTF-8''dokuments%20nr.1.docx",
			}),
		);
		const result = await provider.download({ entity: 'ActivityFile', id: GUID });
		expect(result.fileName).toBe('dokuments nr.1.docx');
	});

	it('refuses a file whose declared Content-Length exceeds maxBytes before buffering', async () => {
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array(10), { 'content-length': '99999999' }),
		);
		await expect(
			provider.download({ entity: 'ActivityFile', id: GUID, maxBytes: 1000 }),
		).rejects.toThrow(/creatio_file_too_large:99999999/);
	});

	it('refuses an oversized body even without a Content-Length header', async () => {
		const { provider } = makeProvider(() => binaryResponse(new Uint8Array(2048)));
		await expect(
			provider.download({ entity: 'ActivityFile', id: GUID, maxBytes: 1024 }),
		).rejects.toThrow(/creatio_file_too_large:2048/);
	});

	it('applies the default maxBytes when the request omits it', async () => {
		const oversized = DEFAULT_MAX_FILE_BYTES + 1;
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array(1), { 'content-length': String(oversized) }),
		);
		await expect(provider.download({ entity: 'ActivityFile', id: GUID })).rejects.toThrow(
			/creatio_file_too_large/,
		);
	});

	it('throws the prefixed error on a non-2xx response', async () => {
		const { provider } = makeProvider(
			() => new Response('not found', { status: 404, headers: {} }),
		);
		await expect(provider.download({ entity: 'ActivityFile', id: GUID })).rejects.toThrow(
			/creatio_download_file_failed:404/,
		);
	});

	it('rejects a non-identifier entity name without issuing a request', async () => {
		const { provider, calls } = makeProvider(() => binaryResponse(new Uint8Array(1)));
		await expect(
			provider.download({ entity: 'ActivityFile(1)/Data?x=', id: GUID }),
		).rejects.toThrow(/invalid_entity_name/);
		expect(calls).toHaveLength(0);
	});

	it('rejects a non-GUID id without issuing a request', async () => {
		const { provider, calls } = makeProvider(() => binaryResponse(new Uint8Array(1)));
		await expect(
			provider.download({ entity: 'ActivityFile', id: 'not-a-guid' }),
		).rejects.toThrow(/invalid_file_id:not-a-guid/);
		expect(calls).toHaveLength(0);
	});
});
