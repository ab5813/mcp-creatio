import { ExtractedText } from './types';
import { decodeXmlEntities, tidyText } from './xml-text';
import { ZipReader } from './zip-reader';

/**
 * WordprocessingML → plain text. Reads the main document part plus footnotes/
 * endnotes; headers/footers are skipped (boilerplate that repeats per page and
 * pollutes LLM context). Field instruction text (`w:instrText` — TOC/REF/TITLE
 * plumbing) is dropped: it is Word-internal syntax, not document content.
 */
export function extractDocx(zip: ZipReader): ExtractedText {
	const main = zip.readByName('word/document.xml');
	if (!main) {
		throw new Error('docx_missing_document_xml');
	}
	const parts = [main.toString('utf8')];
	for (const extra of ['word/footnotes.xml', 'word/endnotes.xml']) {
		const bytes = zip.readByName(extra);
		if (bytes) {
			parts.push(bytes.toString('utf8'));
		}
	}
	const text = tidyText(parts.map(xmlPartToText).join('\n'));
	// Embedded images signal a scan-inside-docx; callers use this to warn when
	// a "document" yields almost no text but carries megabytes of pictures.
	const mediaCount = zip.names().filter((n) => n.startsWith('word/media/')).length;
	const meta = mediaCount > 0 ? { parts: [`${mediaCount} embedded media file(s)`] } : undefined;
	return { text, format: 'docx', ...(meta ? { meta } : {}) };
}

function xmlPartToText(xml: string): string {
	let s = xml;
	// Field instructions and deleted-text runs are markup, not content.
	s = s.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '');
	s = s.replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, '');
	// Structural whitespace before stripping tags.
	s = s.replace(/<w:tab[^>]*\/>/g, '\t');
	s = s.replace(/<w:br[^>]*\/>/g, '\n');
	s = s.replace(/<\/w:p>/g, '\n');
	// Table cells → tab-separated, rows → newline (readable, greppable tables).
	s = s.replace(/<\/w:tc>/g, '\t');
	s = s.replace(/<\/w:tr>/g, '\n');
	s = s.replace(/<[^>]+>/g, '');
	return decodeXmlEntities(s);
}
