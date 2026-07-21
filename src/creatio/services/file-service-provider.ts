import { FileDownloadRequest, FileDownloadResult, FileProvider } from '../contracts';

import { assertEntityName } from './entity-name';
import { CreatioHttpClient } from './http-client';
import { GUID_RE } from './identifiers';
import { odataRoot } from './odata/odata-routes';

/**
 * Default per-download size guard. Base64 expands the payload ~4/3 before it reaches the LLM
 * client, so an unguarded multi-hundred-MB attachment would flood the transport; callers can
 * raise the limit per request when they knowingly need a bigger file.
 */
export const DEFAULT_MAX_FILE_BYTES = 10_000_000;

/**
 * Absolute ceiling for a single download: an explicit `maxBytes` above this is clamped. A
 * >50 MB base64 payload is unusable as an MCP tool result, and enforcing the ceiling here —
 * not only in the tool input schema — also covers direct engine callers.
 */
export const MAX_FILE_DOWNLOAD_BYTES = 50_000_000;

/** RFC 5987 extended form: `filename*=UTF-8''<pct-encoded>`. Authoritative when present. */
const EXTENDED_FILENAME_RE = /filename\*=UTF-8''([^;]+)/i;

/** Plain form: quoted (semicolons allowed inside quotes) or a bare token. */
const PLAIN_FILENAME_RE = /filename="([^"]*)"|filename=([^";\s]+)/i;

/**
 * Downloads the binary content of Creatio file attachments via the OData file API
 * (`GET <base>/0/odata/<FileEntity>(<id>)/Data`). Deliberately separate from the CRUD
 * providers: binary bodies don't fit the ReadResult shape, and the endpoint only needs the
 * base URL, so it works unchanged under either CRUD backend (OData or DataService).
 */
export class FileServiceProvider implements FileProvider {
	private readonly _client: CreatioHttpClient;

	public readonly kind = 'creatio-file-service';

	constructor(client: CreatioHttpClient) {
		this._client = client;
	}

	private _buildDataUrl(entity: string, id: string): string {
		// Same injection guards as the CRUD providers (CWE-20/943): the entity must be a bare
		// identifier and the key a GUID before either is interpolated into the URL path.
		const entityName = assertEntityName(entity);
		if (!GUID_RE.test(id)) {
			throw new Error(`invalid_file_id:${id}`);
		}
		return `${odataRoot(this._client.normalizedBaseUrl)}/${entityName}(${id})/Data`;
	}

	private _parseFileName(response: Response): string | undefined {
		const disposition = response.headers.get('content-disposition');
		if (!disposition) {
			return undefined;
		}
		// The extended (RFC 5987) name is authoritative wherever it appears in the header —
		// senders commonly emit the plain `filename` FIRST as an ASCII fallback (RFC 6266
		// App. D), so the two forms are matched independently, not via one alternation.
		const extended = EXTENDED_FILENAME_RE.exec(disposition)?.[1];
		if (extended) {
			try {
				return decodeURIComponent(extended);
			} catch {
				// Not valid percent-encoding — still a usable name.
				return extended;
			}
		}
		// Only the extended form is percent-encoded; a plain name like `100%.pdf` is literal.
		const plain = PLAIN_FILENAME_RE.exec(disposition);
		const name = plain?.[1] ?? plain?.[2];
		return name ? name : undefined;
	}

	/**
	 * Buffer the body while enforcing `maxBytes` DURING the read: an oversized chunked
	 * response (no Content-Length) is abandoned as soon as the running total crosses the
	 * limit, instead of being buffered whole before the check.
	 */
	private async _readBody(response: Response, maxBytes: number): Promise<Buffer> {
		const reader = response.body?.getReader();
		if (!reader) {
			// Body-less/exotic responses: fall back to full buffering with a post-read check.
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.byteLength > maxBytes) {
				throw new Error(
					`creatio_file_too_large:${bytes.byteLength} bytes exceeds maxBytes ${maxBytes}`,
				);
			}
			return bytes;
		}
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error(
					`creatio_file_too_large:${total} bytes exceeds maxBytes ${maxBytes}`,
				);
			}
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks);
	}

	public async download(request: FileDownloadRequest): Promise<FileDownloadResult> {
		const { entity, id } = request;
		// Clamp to the hard ceiling here (not only in the tool schema) so a direct engine
		// caller cannot request unbounded buffering either.
		const maxBytes = Math.min(
			request.maxBytes ?? DEFAULT_MAX_FILE_BYTES,
			MAX_FILE_DOWNLOAD_BYTES,
		);
		const url = this._buildDataUrl(entity, id);
		return this._client.request(
			'download-file',
			url,
			async () =>
				// Headers are built INSIDE the factory so the one-shot re-auth retry in
				// fetchWithAuth sends the refreshed credential, not a stale closure capture.
				this._client.fetchWithAuth(url, async () => ({
					headers: await this._client.getJsonHeaders(),
				})),
			async (response, duration) => {
				// A followed redirect to an HTML page is Creatio's login bounce with re-auth
				// already exhausted (fetchWithAuth returns it verbatim, status 200). The /Data
				// endpoint never legitimately redirects to HTML; without this guard the login
				// page would be silently base64-encoded and returned as the file's bytes.
				const contentTypeHeader = response.headers.get('content-type') ?? '';
				if (response.redirected && contentTypeHeader.includes('text/html')) {
					throw new Error(
						'creatio_download_file_failed:auth_bounce received the login page instead of file content (re-authentication did not restore access)',
					);
				}
				// Refuse oversized files BEFORE reading when Creatio declares a length; the
				// streaming read below re-enforces the limit for chunked responses.
				const declared = Number(response.headers.get('content-length') ?? NaN);
				if (Number.isFinite(declared) && declared > maxBytes) {
					throw new Error(
						`creatio_file_too_large:${declared} bytes exceeds maxBytes ${maxBytes}`,
					);
				}
				const bytes = await this._readBody(response, maxBytes);
				this._client.logSuccess('download-file', response.status, duration, {
					entity,
					id,
					sizeBytes: bytes.byteLength,
				});
				const contentType = response.headers.get('content-type') ?? undefined;
				const fileName = this._parseFileName(response);
				return {
					entity,
					id,
					sizeBytes: bytes.byteLength,
					base64: bytes.toString('base64'),
					...(contentType !== undefined ? { contentType } : {}),
					...(fileName !== undefined ? { fileName } : {}),
				};
			},
			{ errorPrefix: 'creatio_download_file_failed', logContext: { entity, id } },
		);
	}
}
