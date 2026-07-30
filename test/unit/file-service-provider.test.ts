import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_MAX_FILE_BYTES,
	FileServiceProvider,
	MAX_FILE_DOWNLOAD_BYTES,
} from '../../src/creatio/services/file-service-provider';
import { makeHttpClientHarness } from '../support/http-client';
import { buildDocx } from '../support/zip-builder';

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
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
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

	it('round-trips arbitrary binary bytes losslessly in base64 format', async () => {
		// All 256 byte values — the exact case a text-based body reader would corrupt.
		const bytes = new Uint8Array(256).map((_, i) => i);
		const { provider } = makeProvider(() => binaryResponse(bytes));
		const result = await provider.download({
			entity: 'ContactFile',
			id: GUID,
			format: 'base64',
		});
		expect(Buffer.from(result.base64!, 'base64')).toEqual(Buffer.from(bytes));
		expect(result.sizeBytes).toBe(256);
		// No Content-Disposition / Content-Type headers → optional fields stay absent.
		expect(result.fileName).toBeUndefined();
	});

	it('defaults to text format: extracts a docx payload server-side', async () => {
		const docx = buildDocx(['Noteikumu mērķis ir noteikt kārtību.']);
		const { provider } = makeProvider(() => binaryResponse(new Uint8Array(docx)));
		const result = await provider.download({ entity: 'ActivityFile', id: GUID });
		expect(result.base64).toBeUndefined();
		expect(result.text).toBe('Noteikumu mērķis ir noteikt kārtību.');
		expect(result.extraction).toEqual({ format: 'docx' });
	});

	it('truncates extracted text at maxChars and flags it', async () => {
		const docx = buildDocx(['A'.repeat(500)]);
		const { provider } = makeProvider(() => binaryResponse(new Uint8Array(docx)));
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			maxChars: 100,
		});
		expect(result.text).toHaveLength(100);
		expect(result.extraction?.truncated).toBe(true);
	});

	it('maps UnsupportedFormatError to the typed creatio_file_text_unsupported error', async () => {
		// High-entropy binary with no magic signature → no text path.
		const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01, 0x9c, 0xfe, 0x80]);
		const { provider } = makeProvider(() => binaryResponse(junk));
		await expect(provider.download({ entity: 'ActivityFile', id: GUID })).rejects.toThrow(
			/creatio_file_text_unsupported:.*base64/,
		);
	});

	it('decodes an RFC 5987 UTF-8 filename', async () => {
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array([1]), {
				'content-disposition': "attachment; filename*=UTF-8''dokuments%20nr.1.docx",
			}),
		);
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
		expect(result.fileName).toBe('dokuments nr.1.docx');
	});

	it('prefers the RFC 5987 name over a plain ASCII fallback regardless of parameter order', async () => {
		// The standard compatibility ordering (RFC 6266 App. D): plain fallback FIRST.
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array([1]), {
				'content-disposition':
					'attachment; filename="l?gums.docx"; filename*=UTF-8\'\'l%C4%ABgums.docx',
			}),
		);
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
		expect(result.fileName).toBe('līgums.docx');
	});

	it('keeps semicolons inside a quoted plain filename', async () => {
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array([1]), {
				'content-disposition': 'attachment; filename="a;b.pdf"',
			}),
		);
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
		expect(result.fileName).toBe('a;b.pdf');
	});

	it('returns the raw plain filename when it is not valid percent-encoding', async () => {
		// A literal % in a PLAIN name must not be percent-decoded (and must not throw).
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array([1]), {
				'content-disposition': 'attachment; filename="100%.pdf"',
			}),
		);
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
		expect(result.fileName).toBe('100%.pdf');
	});

	it('returns the raw extended filename when its percent-encoding is malformed', async () => {
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array([1]), {
				'content-disposition': "attachment; filename*=UTF-8''bad%ZZname.pdf",
			}),
		);
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
		expect(result.fileName).toBe('bad%ZZname.pdf');
	});

	it('leaves fileName undefined for a bare Content-Disposition without a filename', async () => {
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array([1]), { 'content-disposition': 'attachment' }),
		);
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
		expect(result.fileName).toBeUndefined();
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

	it('an explicit maxBytes admits a file the default would refuse (the raise-the-limit window)', async () => {
		const size = DEFAULT_MAX_FILE_BYTES + 1;
		const body = new Uint8Array(size);
		const { provider } = makeProvider(() =>
			binaryResponse(body, { 'content-length': String(size) }),
		);
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			maxBytes: 20_000_000,
			format: 'base64',
		});
		expect(result.sizeBytes).toBe(size);
	});

	it('clamps an explicit maxBytes above the hard ceiling', async () => {
		// Direct engine callers must not be able to exceed MAX_FILE_DOWNLOAD_BYTES either.
		const declared = MAX_FILE_DOWNLOAD_BYTES + 1;
		const { provider } = makeProvider(() =>
			binaryResponse(new Uint8Array(1), { 'content-length': String(declared) }),
		);
		await expect(
			provider.download({
				entity: 'ActivityFile',
				id: GUID,
				maxBytes: MAX_FILE_DOWNLOAD_BYTES * 10,
			}),
		).rejects.toThrow(/creatio_file_too_large/);
	});

	it('retries once through fetchWithAuth on a 401 and then succeeds', async () => {
		const bytes = new TextEncoder().encode('ok');
		let attempt = 0;
		const { provider, calls } = makeProvider(() => {
			attempt += 1;
			return attempt === 1
				? new Response('unauthorized', { status: 401 })
				: binaryResponse(bytes, { 'content-type': 'application/octet-stream' });
		});
		const result = await provider.download({
			entity: 'ActivityFile',
			id: GUID,
			format: 'base64',
		});
		expect(calls).toHaveLength(2);
		expect(result.base64).toBe(Buffer.from('ok').toString('base64'));
	});

	it('rejects an exhausted login bounce instead of returning the login page as file bytes', async () => {
		const html = new TextEncoder().encode('<html><body>Please log in</body></html>');
		const { provider } = makeProvider(() => {
			const response = binaryResponse(html, { 'content-type': 'text/html; charset=utf-8' });
			// A followed redirect to the login page: fetch reports redirected=true, status 200.
			Object.defineProperty(response, 'redirected', { value: true });
			return response;
		});
		await expect(provider.download({ entity: 'ActivityFile', id: GUID })).rejects.toThrow(
			/auth_bounce/,
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
