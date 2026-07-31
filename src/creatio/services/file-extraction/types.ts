/** What a single extraction produced, before any maxChars truncation. */
export interface ExtractedText {
	text: string;
	/** Detected payload format, e.g. 'docx' | 'xlsx' | 'pdf' | 'pdf+ocr' | 'rtf' | 'doc' | 'msg' | 'edoc' | 'zip' | 'txt'. */
	format: string;
	/** Extra facts an LLM benefits from (page counts, OCR usage, container parts). */
	meta?: {
		pages?: number;
		ocr?: boolean;
		ocrPagesLimited?: number;
		sheets?: string[];
		/** Names of container payloads that were extracted (edoc/zip). */
		parts?: string[];
		/** Names of container payloads that could NOT be extracted. */
		skippedParts?: string[];
	};
}

export interface ExtractOptions {
	/** File name hint for format detection (extension) — content magic wins on conflict.
	 *  Often ABSENT: Creatio's file endpoint sends no Content-Disposition. */
	fileName?: string;
	/** MIME type as reported by the server — a secondary hint when the container
	 *  alone is ambiguous (e.g. `application/msword` on a CFBF payload). */
	contentType?: string;
	/** Container recursion depth remaining (edoc inside edoc is real). */
	depth?: number;
	/** Attempt OCR for image-only PDFs (needs optional deps + language data). */
	ocr?: boolean;
	/** Max pages to OCR per document — OCR is seconds-per-page expensive. */
	ocrMaxPages?: number;
}

/** Thrown when the payload is a format this extractor intentionally does not read. */
export class UnsupportedFormatError extends Error {
	public readonly formatHint: string;

	constructor(formatHint: string, detail?: string) {
		super(`unsupported_format:${formatHint}${detail ? ` ${detail}` : ''}`);
		this.name = 'UnsupportedFormatError';
		this.formatHint = formatHint;
	}
}
