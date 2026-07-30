/**
 * Shared OOXML-to-text helpers. Regex-based on purpose: WordprocessingML text
 * lives in well-formed, machine-written markup where tag-level substitution is
 * deterministic — a full DOM parse buys nothing but allocation here.
 */

const XML_ENTITY_RE = /&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g;

export function decodeXmlEntities(input: string): string {
	return input.replace(XML_ENTITY_RE, (_m, ent: string) => {
		switch (ent) {
			case 'amp':
				return '&';
			case 'lt':
				return '<';
			case 'gt':
				return '>';
			case 'quot':
				return '"';
			case 'apos':
				return "'";
			default: {
				const code =
					ent[1] === 'x' || ent[1] === 'X'
						? parseInt(ent.slice(2), 16)
						: parseInt(ent.slice(1), 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : '';
			}
		}
	});
}

/** Collapse runs of 3+ newlines and trim trailing space per line. */
export function tidyText(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/g, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
