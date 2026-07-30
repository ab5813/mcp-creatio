import { describe, expect, it } from 'vitest';

import {
	extractTextFromBytes,
	UnsupportedFormatError,
	ZipReader,
} from '../../src/creatio/services/file-extraction';
import { extractRtf } from '../../src/creatio/services/file-extraction/rtf-extractor';
import { buildDocx, buildEdoc, buildXlsx, buildZip } from '../support/zip-builder';

describe('ZipReader', () => {
	it('lists and reads stored entries with UTF-8 names', () => {
		const zip = new ZipReader(buildZip({ 'mape/fails ār.txt': 'saturs' }));
		expect(zip.names()).toEqual(['mape/fails ār.txt']);
		expect(zip.readByName('mape/fails ār.txt')?.toString('utf8')).toBe('saturs');
	});

	it('rejects a buffer with no central directory', () => {
		expect(() => new ZipReader(Buffer.from('PK\x03\x04 not a real zip'))).toThrow(
			/zip_no_end_of_central_directory/,
		);
	});
});

describe('extractTextFromBytes dispatch', () => {
	it('extracts docx paragraphs and decodes XML entities', async () => {
		const bytes = buildDocx(['Pirmā rindkopa', 'Otrā &amp; trešā']);
		const result = await extractTextFromBytes(bytes, { fileName: 'x.docx' });
		expect(result.format).toBe('docx');
		expect(result.text).toBe('Pirmā rindkopa\nOtrā & trešā');
	});

	it('drops Word field instructions (TOC/REF plumbing) from docx text', async () => {
		const xml =
			'<w:document><w:body><w:p><w:r><w:instrText>REF _Ref00 \\h</w:instrText></w:r>' +
			'<w:r><w:t>redzamais teksts</w:t></w:r></w:p></w:body></w:document>';
		const bytes = buildZip({ 'word/document.xml': xml });
		const result = await extractTextFromBytes(bytes);
		expect(result.text).toBe('redzamais teksts');
	});

	it('renders xlsx as CSV with sheet headers, shared strings and quoting', async () => {
		const bytes = buildXlsx([
			['Nosaukums', 'Summa'],
			['Līgums "A", ar komatu', 42],
		]);
		const result = await extractTextFromBytes(bytes, { fileName: 'x.xlsx' });
		expect(result.format).toBe('xlsx');
		expect(result.meta?.sheets).toEqual(['Data']);
		expect(result.text).toContain('# Sheet: Data');
		expect(result.text).toContain('Nosaukums,Summa');
		expect(result.text).toContain('"Līgums ""A"", ar komatu",42');
	});

	it('unwraps an edoc container and recurses into nested payloads', async () => {
		const innerDocx = buildDocx(['Iekšējais dokuments']);
		const nestedEdoc = buildEdoc({ 'iesniegums.docx': buildDocx(['Pieteikums']) });
		const bytes = buildEdoc({ 'ligums.docx': innerDocx, 'pielikums.edoc': nestedEdoc });
		const result = await extractTextFromBytes(bytes, { fileName: 'x.edoc' });
		expect(result.format).toBe('edoc');
		expect(result.meta?.parts).toEqual(['ligums.docx', 'pielikums.edoc']);
		expect(result.text).toContain('Iekšējais dokuments');
		expect(result.text).toContain('Pieteikums');
	});

	it('lists image payloads as skipped instead of failing the container', async () => {
		const bytes = buildEdoc({
			'ligums.docx': buildDocx(['Teksts']),
			'skens.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		});
		const result = await extractTextFromBytes(bytes, { fileName: 'x.edoc' });
		expect(result.text).toContain('Teksts');
		expect(result.meta?.skippedParts).toEqual(['skens.png']);
	});

	it('reads plain text payloads directly', async () => {
		const result = await extractTextFromBytes(Buffer.from('rindas saturs\n'), {
			fileName: 'piezimes.txt',
		});
		expect(result.format).toBe('txt');
		expect(result.text).toBe('rindas saturs');
	});

	it('throws UnsupportedFormatError for binary content with no extractor', async () => {
		// High-entropy bytes with a .png name: no extractor and not text-like.
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff, 0xfe, 0x00, 0x9c]);
		await expect(extractTextFromBytes(bytes, { fileName: 'img.png' })).rejects.toThrow(
			UnsupportedFormatError,
		);
	});
});

describe('extractRtf', () => {
	it('decodes unicode escapes with fallback skips and paragraph breaks', () => {
		// \u257 is ā; the '?' after it is the ANSI fallback char that \uc1 says to skip.
		const rtf = String.raw`{\rtf1\ansi\ansicpg1252\uc1 Sveiki \u257?buls\par otr\u257? rinda}`;
		const result = extractRtf(Buffer.from(rtf, 'latin1'));
		expect(result.text).toBe('Sveiki ābuls\notrā rinda');
	});

	it("decodes \\'hh bytes via the cp1257 Baltic codepage when declared", () => {
		// 0xE2 is ā in cp1257 (â in cp1252) — the codepage switch must be honored.
		const rtf = String.raw`{\rtf1\ansi\ansicpg1257 st\'e2sts}`;
		const result = extractRtf(Buffer.from(rtf, 'latin1'));
		expect(result.text).toBe('stāsts');
	});

	it('skips font tables and ignorable destinations', () => {
		const rtf = String.raw`{\rtf1{\fonttbl{\f0 Arial;}}{\*\generator Word}saturs}`;
		const result = extractRtf(Buffer.from(rtf, 'latin1'));
		expect(result.text).toBe('saturs');
	});
});
