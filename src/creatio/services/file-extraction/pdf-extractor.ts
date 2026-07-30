import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ExtractOptions, ExtractedText } from './types';

/**
 * PDF → text. Two tiers:
 *  1. Text layer via `unpdf` (serverless pdf.js build — pure JS).
 *  2. When the text layer is near-empty (the scanned-contract signature:
 *     pages of images, no fonts), fall back to OCR — render each page with
 *     pdf.js + `@napi-rs/canvas`, recognize with `tesseract.js`.
 *
 * OCR deps are optionalDependencies: when they are missing or language data
 * is unreachable, the error says exactly that instead of pretending the
 * document is empty.
 */

/** Under this many characters per page the "text layer" is OCR noise/empty. */
const TEXT_LAYER_MIN_CHARS_PER_PAGE = 50;

const OCR_LANGS = process.env['CREATIO_MCP_OCR_LANGS'] || 'lav+eng+rus';
/** Local traineddata dir (offline deployments); default fetches from the tessdata CDN. */
const OCR_LANG_PATH = process.env['CREATIO_MCP_OCR_LANG_PATH'];
const OCR_DISABLED = (process.env['CREATIO_MCP_OCR_DISABLE'] || '').toLowerCase() === 'true';

export async function extractPdf(bytes: Buffer, opts: ExtractOptions): Promise<ExtractedText> {
	const { extractText, getDocumentProxy } = await import('unpdf');
	// pdf.js TRANSFERS (detaches) the buffer it is handed to its worker — every
	// consumer below gets its own copy or the second use throws DataCloneError.
	const pdf = await getDocumentProxy(new Uint8Array(bytes));
	const totalPages = pdf.numPages;
	const { text } = await extractText(pdf, { mergePages: true });
	const layerText = (typeof text === 'string' ? text : (text as string[]).join('\n')).trim();

	if (layerText.length >= TEXT_LAYER_MIN_CHARS_PER_PAGE * totalPages) {
		return { text: layerText, format: 'pdf', meta: { pages: totalPages } };
	}

	// --- scanned document path ---
	if (opts.ocr === false || OCR_DISABLED) {
		return {
			text: layerText,
			format: 'pdf',
			meta: { pages: totalPages, ocr: false },
		};
	}
	const ocrMaxPages = opts.ocrMaxPages ?? 10;
	const pages = Math.min(totalPages, ocrMaxPages);
	const ocrText = await ocrPdfPages(bytes, pages);
	const combined = [layerText, ocrText].filter(Boolean).join('\n').trim();
	return {
		text: combined,
		format: 'pdf+ocr',
		meta: {
			pages: totalPages,
			ocr: true,
			...(pages < totalPages ? { ocrPagesLimited: pages } : {}),
		},
	};
}

async function ocrPdfPages(bytes: Buffer, pages: number): Promise<string> {
	let renderPageAsImage: typeof import('unpdf').renderPageAsImage;
	let createWorker: typeof import('tesseract.js').createWorker;
	try {
		({ renderPageAsImage } = await import('unpdf'));
		({ createWorker } = await import('tesseract.js'));
		await import('@napi-rs/canvas');
	} catch (err) {
		throw new Error(
			`ocr_unavailable: this PDF is a scan with no text layer, and the optional OCR dependencies (tesseract.js, @napi-rs/canvas) are not installed (${String(
				(err as Error)?.message ?? err,
			)})`,
		);
	}
	// Cache downloaded traineddata in a stable tmp dir — NOT the process cwd
	// (tesseract.js's default), which would litter the deployment directory.
	const cachePath = join(tmpdir(), 'mcp-creatio-tessdata');
	mkdirSync(cachePath, { recursive: true });
	const worker = await createWorker(OCR_LANGS.split('+'), 1, {
		cachePath,
		...(OCR_LANG_PATH ? { langPath: OCR_LANG_PATH, gzip: false } : {}),
	});
	try {
		const parts: string[] = [];
		for (let pageNo = 1; pageNo <= pages; pageNo++) {
			// 2x scale ≈ 150dpi for typical letter pages — the accuracy/speed sweet
			// spot for printed contracts; higher wins nothing but CPU time.
			// Fresh copy per call: renderPageAsImage re-opens the document and
			// pdf.js detaches whatever buffer it receives.
			const image = await renderPageAsImage(new Uint8Array(bytes), pageNo, {
				scale: 2,
				canvasImport: () => import('@napi-rs/canvas'),
			});
			const { data: result } = await worker.recognize(Buffer.from(image));
			parts.push(result.text.trim());
		}
		return parts.filter(Boolean).join('\n\n');
	} finally {
		await worker.terminate();
	}
}
