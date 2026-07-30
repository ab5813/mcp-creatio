import { ExtractedText } from './types';
import { decodeXmlEntities } from './xml-text';
import { ZipReader } from './zip-reader';

/**
 * SpreadsheetML → CSV, one `# Sheet: <name>` block per worksheet. CSV (not a
 * table drawing) because it is the densest tokenization an LLM reads reliably.
 * Numbers stay raw (dates remain Excel serials — converting needs the style
 * table and gets locale-messy; the raw serial is at least unambiguous).
 */
export function extractXlsx(zip: ZipReader): ExtractedText {
	const workbook = zip.readByName('xl/workbook.xml')?.toString('utf8');
	if (!workbook) {
		throw new Error('xlsx_missing_workbook_xml');
	}
	const rels = zip.readByName('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
	const relTargets = new Map<string, string>();
	for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
		const tag = m[0];
		const id = /\bId="([^"]+)"/.exec(tag)?.[1];
		const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
		if (id && target) {
			relTargets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
		}
	}
	const shared = parseSharedStrings(zip.readByName('xl/sharedStrings.xml')?.toString('utf8'));

	const blocks: string[] = [];
	const sheetNames: string[] = [];
	for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
		const tag = m[0];
		const name = decodeXmlEntities(/\bname="([^"]*)"/.exec(tag)?.[1] ?? 'Sheet');
		const rid = /\br:id="([^"]+)"/.exec(tag)?.[1];
		const target = rid ? relTargets.get(rid) : undefined;
		const sheetXml = target ? zip.readByName(target)?.toString('utf8') : undefined;
		if (!sheetXml) {
			continue;
		}
		sheetNames.push(name);
		blocks.push(`# Sheet: ${name}\n${sheetToCsv(sheetXml, shared)}`);
	}
	return { text: blocks.join('\n\n').trim(), format: 'xlsx', meta: { sheets: sheetNames } };
}

function parseSharedStrings(xml: string | undefined): string[] {
	if (!xml) {
		return [];
	}
	const out: string[] = [];
	for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
		// An <si> may hold several rich-text runs — concatenate their <t> parts.
		let s = '';
		for (const t of m[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
			s += decodeXmlEntities(t[1]!);
		}
		out.push(s);
	}
	return out;
}

function sheetToCsv(sheetXml: string, shared: string[]): string {
	const lines: string[] = [];
	for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
		const cells: string[] = [];
		for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const attrs = cellMatch[1] ?? '';
			const inner = cellMatch[2] ?? '';
			const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
			const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
			let value = '';
			if (type === 'inlineStr') {
				value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
					.map((t) => decodeXmlEntities(t[1]!))
					.join('');
			} else {
				const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
				if (type === 's') {
					value = shared[parseInt(v, 10)] ?? '';
				} else if (type === 'b') {
					value = v === '1' ? 'TRUE' : 'FALSE';
				} else {
					value = decodeXmlEntities(v);
				}
			}
			// Respect the cell's column so gaps stay visible in the CSV.
			const col = ref ? columnIndex(ref) : cells.length;
			while (cells.length < col) {
				cells.push('');
			}
			cells[col] = value;
		}
		lines.push(cells.map(csvField).join(','));
	}
	return lines.join('\n');
}

function columnIndex(letters: string): number {
	let n = 0;
	for (const ch of letters) {
		n = n * 26 + (ch.charCodeAt(0) - 64);
	}
	return n - 1;
}

function csvField(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
