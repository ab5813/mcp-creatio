/** Hand-rolled declarations for pure-JS extraction deps that ship no types. */

declare module 'word-extractor' {
	class WordDocument {
		public getBody(): string;
		public getFootnotes(): string;
		public getEndnotes(): string;
		public getHeaders(): string;
	}
	export default class WordExtractor {
		public extract(input: Buffer | string): Promise<WordDocument>;
	}
}
