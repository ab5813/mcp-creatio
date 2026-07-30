export interface FileDownloadRequest {
	/** File entity set holding the attachment (e.g. ActivityFile, AccountFile, SysFile). */
	entity: string;
	/** Primary key (Id) of the file record. */
	id: string;
	/** Refuse downloads larger than this many bytes (provider default applies when omitted). */
	maxBytes?: number;
	/**
	 * 'text' (default) — extract readable text server-side (docx, xlsx→CSV, pdf incl. OCR,
	 * edoc/asice containers, rtf, legacy doc, Outlook msg, plain text).
	 * 'base64' — return the raw bytes base64-encoded instead.
	 */
	format?: 'text' | 'base64';
	/** Truncate extracted text beyond this many characters (text format only). */
	maxChars?: number;
	/** Attempt OCR on image-only (scanned) PDFs. Default true; needs optional OCR deps. */
	ocr?: boolean;
}

export interface FileExtractionInfo {
	/** Detected payload format, e.g. 'docx' | 'xlsx' | 'pdf' | 'pdf+ocr' | 'edoc' | 'rtf' | 'doc' | 'msg' | 'zip' | 'txt'. */
	format: string;
	/** Set when the text was cut at maxChars. */
	truncated?: boolean;
	pages?: number;
	ocr?: boolean;
	/** OCR stopped after this many pages (cost guard). */
	ocrPagesLimited?: number;
	sheets?: string[];
	/** Container payloads that were extracted (edoc/zip). */
	parts?: string[];
	/** Container payloads that could not be extracted (images, unsupported). */
	skippedParts?: string[];
}

export interface FileDownloadResult {
	entity: string;
	id: string;
	/** Original file name, when Creatio exposes it via Content-Disposition. */
	fileName?: string;
	/** MIME type as reported by Creatio's Content-Type response header. */
	contentType?: string;
	/** Exact size of the downloaded content in bytes (before base64/text conversion). */
	sizeBytes: number;
	/** The file bytes, base64-encoded (format:'base64' only). */
	base64?: string;
	/** Extracted plain text (format:'text' only). */
	text?: string;
	/** How the text was produced (format:'text' only). */
	extraction?: FileExtractionInfo;
}

export interface FileProvider {
	readonly kind: string;
	download(request: FileDownloadRequest): Promise<FileDownloadResult>;
}
