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
 * `filename*=UTF-8''…` (RFC 5987) or plain `filename="…"` from a Content-Disposition header.
 * The extended form is tried first so a UTF-8 name wins over its ASCII fallback.
 */
const CONTENT_DISPOSITION_FILENAME_RE = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i;

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
		const match = CONTENT_DISPOSITION_FILENAME_RE.exec(disposition);
		const raw = match?.[1] ?? match?.[2];
		if (!raw) {
			return undefined;
		}
		try {
			return decodeURIComponent(raw);
		} catch {
			// A name that isn't valid percent-encoding is still a usable name.
			return raw;
		}
	}

	public async download(request: FileDownloadRequest): Promise<FileDownloadResult> {
		const { entity, id } = request;
		const maxBytes = request.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
		const url = this._buildDataUrl(entity, id);
		return this._client.request(
			'download-file',
			url,
			async () => {
				const headers = await this._client.getJsonHeaders();
				return this._client.fetchWithAuth(url, async () => ({ headers }));
			},
			async (response, duration) => {
				// Refuse oversized files BEFORE buffering when Creatio declares a length, and
				// re-check after reading — the header is optional on chunked responses.
				const declared = Number(response.headers.get('content-length') ?? NaN);
				if (Number.isFinite(declared) && declared > maxBytes) {
					throw new Error(
						`creatio_file_too_large:${declared} bytes exceeds maxBytes ${maxBytes}`,
					);
				}
				const bytes = Buffer.from(await response.arrayBuffer());
				if (bytes.byteLength > maxBytes) {
					throw new Error(
						`creatio_file_too_large:${bytes.byteLength} bytes exceeds maxBytes ${maxBytes}`,
					);
				}
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
