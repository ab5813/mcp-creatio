import { ExtractedText } from './types';

/**
 * RTF → plain text. A real tokenizer (not regex): RTF's escapes (`\'hh` bytes
 * in a document-declared codepage, `\uN` unicode with `\ucN` fallback skips)
 * and skippable destination groups (font/color tables, embedded pictures)
 * cannot be handled by pattern substitution without corrupting Baltic text.
 *
 * Codepage tables are generated from Python's cp1252/cp1257 codecs — cp1257 is
 * what legacy Latvian Word installs write; cp1252 is the RTF default.
 */

const CP1252_HIGH: readonly number[] = [
	0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
	0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
	0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178, 0x00a0, 0x00a1, 0x00a2, 0x00a3,
	0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x00aa, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
	0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x00ba, 0x00bb,
	0x00bc, 0x00bd, 0x00be, 0x00bf, 0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c6, 0x00c7,
	0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf, 0x00d0, 0x00d1, 0x00d2, 0x00d3,
	0x00d4, 0x00d5, 0x00d6, 0x00d7, 0x00d8, 0x00d9, 0x00da, 0x00db, 0x00dc, 0x00dd, 0x00de, 0x00df,
	0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4, 0x00e5, 0x00e6, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb,
	0x00ec, 0x00ed, 0x00ee, 0x00ef, 0x00f0, 0x00f1, 0x00f2, 0x00f3, 0x00f4, 0x00f5, 0x00f6, 0x00f7,
	0x00f8, 0x00f9, 0x00fa, 0x00fb, 0x00fc, 0x00fd, 0x00fe, 0x00ff,
];

const CP1257_HIGH: readonly number[] = [
	0x20ac, 0xfffd, 0x201a, 0xfffd, 0x201e, 0x2026, 0x2020, 0x2021, 0xfffd, 0x2030, 0xfffd, 0x2039,
	0xfffd, 0x00a8, 0x02c7, 0x00b8, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
	0xfffd, 0x2122, 0xfffd, 0x203a, 0xfffd, 0x00af, 0x02db, 0xfffd, 0x00a0, 0xfffd, 0x00a2, 0x00a3,
	0x00a4, 0xfffd, 0x00a6, 0x00a7, 0x00d8, 0x00a9, 0x0156, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00c6,
	0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00f8, 0x00b9, 0x0157, 0x00bb,
	0x00bc, 0x00bd, 0x00be, 0x00e6, 0x0104, 0x012e, 0x0100, 0x0106, 0x00c4, 0x00c5, 0x0118, 0x0112,
	0x010c, 0x00c9, 0x0179, 0x0116, 0x0122, 0x0136, 0x012a, 0x013b, 0x0160, 0x0143, 0x0145, 0x00d3,
	0x014c, 0x00d5, 0x00d6, 0x00d7, 0x0172, 0x0141, 0x015a, 0x016a, 0x00dc, 0x017b, 0x017d, 0x00df,
	0x0105, 0x012f, 0x0101, 0x0107, 0x00e4, 0x00e5, 0x0119, 0x0113, 0x010d, 0x00e9, 0x017a, 0x0117,
	0x0123, 0x0137, 0x012b, 0x013c, 0x0161, 0x0144, 0x0146, 0x00f3, 0x014d, 0x00f5, 0x00f6, 0x00f7,
	0x0173, 0x0142, 0x015b, 0x016b, 0x00fc, 0x017c, 0x017e, 0x02d9,
];

/** Destinations whose content is machine plumbing, never document text. */
const SKIP_DESTINATIONS = new Set([
	'fonttbl',
	'colortbl',
	'stylesheet',
	'info',
	'pict',
	'object',
	'themedata',
	'colorschememapping',
	'datastore',
	'latentstyles',
	'listtable',
	'listoverridetable',
	'rsidtbl',
	'generator',
	'xmlnstbl',
	'header',
	'footer',
	'headerl',
	'headerr',
	'headerf',
	'footerl',
	'footerr',
	'footerf',
]);

export function extractRtf(bytes: Buffer): ExtractedText {
	const src = bytes.toString('latin1'); // byte-preserving; \'hh handled manually
	let highTable = CP1252_HIGH;
	let ucSkip = 1;
	const out: string[] = [];
	// Group stack tracks (skip-mode, ucSkip) so state restores on `}`.
	const stack: { skip: boolean; ucSkip: number }[] = [];
	let skip = false;
	let pendingUnicodeSkip = 0;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i]!;
		if (ch === '{') {
			stack.push({ skip, ucSkip });
			continue;
		}
		if (ch === '}') {
			const prev = stack.pop();
			if (prev) {
				skip = prev.skip;
				ucSkip = prev.ucSkip;
			}
			continue;
		}
		if (ch !== '\\') {
			if (!skip && ch !== '\r' && ch !== '\n') {
				if (pendingUnicodeSkip > 0) {
					pendingUnicodeSkip--;
				} else {
					out.push(ch);
				}
			}
			continue;
		}
		// --- control sequence ---
		const next = src[i + 1];
		if (next === undefined) {
			break;
		}
		if (next === "'") {
			// \'hh — one byte in the current codepage.
			const hex = src.slice(i + 2, i + 4);
			i += 3;
			if (skip) {
				continue;
			}
			if (pendingUnicodeSkip > 0) {
				pendingUnicodeSkip--;
				continue;
			}
			const code = parseInt(hex, 16);
			if (Number.isFinite(code)) {
				out.push(
					code < 0x80
						? String.fromCharCode(code)
						: String.fromCodePoint(highTable[code - 0x80] ?? 0xfffd),
				);
			}
			continue;
		}
		if (next === '\\' || next === '{' || next === '}') {
			if (!skip) {
				out.push(next);
			}
			i++;
			continue;
		}
		if (next === '~') {
			if (!skip) {
				out.push(' ');
			}
			i++;
			continue;
		}
		if (next === '*') {
			// `{\*\dest ...}` — an ignorable destination: skip the whole group.
			skip = true;
			i++;
			continue;
		}
		// Control word: letters + optional signed number + optional space delimiter.
		const m = /^([a-zA-Z]+)(-?\d+)?( ?)/.exec(src.slice(i + 1));
		if (!m) {
			continue;
		}
		const word = m[1]!;
		const param = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
		i += m[0].length; // skips the optional delimiter space too
		if (SKIP_DESTINATIONS.has(word)) {
			skip = true;
			continue;
		}
		switch (word) {
			case 'ansicpg':
				if (param === 1257) {
					highTable = CP1257_HIGH;
				}
				break;
			case 'uc':
				ucSkip = param ?? 1;
				break;
			case 'u': {
				if (!skip && param !== undefined) {
					const code = param < 0 ? param + 65536 : param;
					out.push(String.fromCodePoint(code));
				}
				pendingUnicodeSkip = ucSkip;
				break;
			}
			case 'par':
			case 'line':
			case 'row':
				if (!skip) {
					out.push('\n');
				}
				break;
			case 'tab':
			case 'cell':
				if (!skip) {
					out.push('\t');
				}
				break;
			case 'emdash':
				if (!skip) {
					out.push('—');
				}
				break;
			case 'endash':
				if (!skip) {
					out.push('–');
				}
				break;
			default:
				break; // formatting words carry no text
		}
	}
	const text = out
		.join('')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return { text, format: 'rtf' };
}
