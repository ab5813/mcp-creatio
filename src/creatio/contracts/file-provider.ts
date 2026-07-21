export interface FileDownloadRequest {
	/** File entity set holding the attachment (e.g. ActivityFile, AccountFile, SysFile). */
	entity: string;
	/** Primary key (Id) of the file record. */
	id: string;
	/** Refuse downloads larger than this many bytes (provider default applies when omitted). */
	maxBytes?: number;
}

export interface FileDownloadResult {
	entity: string;
	id: string;
	/** Original file name, when Creatio exposes it via Content-Disposition. */
	fileName?: string;
	/** MIME type as reported by Creatio's Content-Type response header. */
	contentType?: string;
	/** Exact size of the downloaded content in bytes (before base64 expansion). */
	sizeBytes: number;
	/** The file bytes, base64-encoded. */
	base64: string;
}

export interface FileProvider {
	readonly kind: string;
	download(request: FileDownloadRequest): Promise<FileDownloadResult>;
}
