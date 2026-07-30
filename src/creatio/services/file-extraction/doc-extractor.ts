import { ExtractedText } from './types';

/** Legacy binary Word (.doc, CFBF) via the pure-JS `word-extractor` package. */
export async function extractDoc(bytes: Buffer): Promise<ExtractedText> {
	const { default: WordExtractor } = await import('word-extractor');
	const doc = await new WordExtractor().extract(bytes);
	const body = doc.getBody() ?? '';
	const footnotes = doc.getFootnotes() ?? '';
	const text = [body, footnotes]
		.filter((s) => s.trim())
		.join('\n\n')
		.trim();
	return { text, format: 'doc' };
}
