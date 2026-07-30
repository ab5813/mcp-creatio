import { extractDoc } from './doc-extractor';
import { extractDocx } from './docx-extractor';
import { extractMsg } from './msg-extractor';
import { extractPdf } from './pdf-extractor';
import { extractRtf } from './rtf-extractor';
import { ExtractOptions, ExtractedText, UnsupportedFormatError } from './types';
import { extractXlsx } from './xlsx-extractor';
import { ZipReader } from './zip-reader';

/**
 * Content-first format dispatch: magic bytes decide the container class, the
 * file name only disambiguates within it (.doc vs .msg share CFBF; .docx /
 * .xlsx / .edoc share ZIP but are told apart by their entries). Signed
 * containers (.edoc / ASiC-E) and plain .zip recurse into their payloads —
 * edoc-inside-edoc exists in the wild.
 */

const MAX_CONTAINER_DEPTH = 3;

/** Payload extensions we deliberately do not read (silently listed, not fatal). */
const SKIPPED_PAYLOAD_RE = /\.(png|jpe?g|gif|bmp|tiff?)$/i;

export async function extractTextFromBytes(
	bytes: Buffer,
	opts: ExtractOptions = {},
): Promise<ExtractedText> {
	const depth = opts.depth ?? MAX_CONTAINER_DEPTH;
	const name = (opts.fileName ?? '').toLowerCase();

	// --- ZIP family ---
	if (bytes.length > 3 && bytes.readUInt32LE(0) === 0x04034b50) {
		const zip = new ZipReader(bytes);
		if (zip.has('word/document.xml')) {
			return extractDocx(zip);
		}
		if (zip.has('xl/workbook.xml')) {
			return extractXlsx(zip);
		}
		const mimetype = zip.readByName('mimetype')?.toString('utf8').trim() ?? '';
		const isAsic =
			mimetype.includes('asic') || name.endsWith('.edoc') || name.endsWith('.asice');
		return extractContainer(zip, isAsic ? 'edoc' : 'zip', { ...opts, depth });
	}

	// --- PDF ---
	if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
		return extractPdf(bytes, opts);
	}

	// --- RTF ---
	if (bytes.subarray(0, 5).toString('latin1') === '{\\rtf') {
		return extractRtf(bytes);
	}

	// --- CFBF (legacy .doc / Outlook .msg share the container) ---
	if (bytes.length > 8 && bytes.readUInt32BE(0) === 0xd0cf11e0) {
		if (name.endsWith('.msg')) {
			return extractMsg(bytes);
		}
		if (name.endsWith('.doc') || name.endsWith('.dot')) {
			return extractDoc(bytes);
		}
		// Unlabeled CFBF: try mail first (cheap structural probe), then Word.
		try {
			return await extractMsg(bytes);
		} catch {
			return extractDoc(bytes);
		}
	}

	// --- plain text-ish payloads (txt/csv/xml/html) ---
	if (name.match(/\.(txt|csv|xml|html?)$/) || looksLikeText(bytes)) {
		return { text: bytes.toString('utf8').trim(), format: 'txt' };
	}

	throw new UnsupportedFormatError(
		name.split('.').pop() || 'unknown',
		'— no text extractor for this content; use format:"base64" if you need the raw file',
	);
}

async function extractContainer(
	zip: ZipReader,
	format: 'edoc' | 'zip',
	opts: ExtractOptions,
): Promise<ExtractedText> {
	const depth = opts.depth ?? MAX_CONTAINER_DEPTH;
	if (depth <= 0) {
		throw new UnsupportedFormatError(format, '— container nesting too deep');
	}
	// ASiC-E: everything except the signature plumbing is payload.
	const payloads = zip
		.names()
		.filter((n) => !n.startsWith('META-INF/') && n !== 'mimetype' && !n.endsWith('/'));
	const parts: string[] = [];
	const extractedNames: string[] = [];
	const skipped: string[] = [];
	for (const entryName of payloads) {
		if (SKIPPED_PAYLOAD_RE.test(entryName)) {
			skipped.push(entryName);
			continue;
		}
		const payload = zip.readByName(entryName);
		if (!payload) {
			continue;
		}
		try {
			const inner = await extractTextFromBytes(payload, {
				...opts,
				fileName: entryName,
				depth: depth - 1,
			});
			extractedNames.push(entryName);
			parts.push(
				payloads.length > 1 || inner.format === 'edoc'
					? `--- ${entryName} ---\n${inner.text}`
					: inner.text,
			);
		} catch {
			skipped.push(entryName);
		}
	}
	if (parts.length === 0) {
		throw new UnsupportedFormatError(
			format,
			`— container holds no extractable payload (entries: ${payloads.join(', ') || 'none'})`,
		);
	}
	return {
		text: parts.join('\n\n').trim(),
		format,
		meta: {
			parts: extractedNames,
			...(skipped.length > 0 ? { skippedParts: skipped } : {}),
		},
	};
}

/** Cheap printable-ratio probe for extensionless text payloads. */
function looksLikeText(bytes: Buffer): boolean {
	const sample = bytes.subarray(0, 512);
	if (sample.length === 0) {
		return false;
	}
	let printable = 0;
	for (const b of sample) {
		if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc0) {
			printable++;
		}
	}
	return printable / sample.length > 0.97;
}
