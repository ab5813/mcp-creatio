/**
 * Minimal STORE-only ZIP writer for building synthetic .docx/.xlsx/.edoc
 * fixtures in tests — no binary blobs in the repo, no dependency. Pairs with
 * src/creatio/services/file-extraction/zip-reader.ts.
 */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (const b of buf) {
		c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: Record<string, string | Buffer>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(entries)) {
		const nameBuf = Buffer.from(name, 'utf8');
		const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
		local.writeUInt16LE(0, 8); // method: store
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
		central.writeUInt16LE(0, 10); // method: store
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);

		offset += 30 + nameBuf.length + data.length;
	}
	const centralSize = centrals.reduce((n, b) => n + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(Object.keys(entries).length, 8);
	eocd.writeUInt16LE(Object.keys(entries).length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, eocd]);
}

/** A minimal-but-valid WordprocessingML fixture. */
export function buildDocx(paragraphs: string[]): Buffer {
	const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
	return buildZip({
		'[Content_Types].xml': '<Types/>',
		'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
	});
}

/** A one-sheet SpreadsheetML fixture with shared and inline values. */
export function buildXlsx(rows: (string | number)[][]): Buffer {
	const shared: string[] = [];
	const rowXml = rows
		.map((cells, r) => {
			const cellXml = cells
				.map((v, c) => {
					const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
					if (typeof v === 'number') {
						return `<c r="${ref}"><v>${v}</v></c>`;
					}
					shared.push(v);
					return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
				})
				.join('');
			return `<row r="${r + 1}">${cellXml}</row>`;
		})
		.join('');
	const sst = shared.map((s) => `<si><t>${s}</t></si>`).join('');
	return buildZip({
		'[Content_Types].xml': '<Types/>',
		'xl/workbook.xml':
			'<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
		'xl/_rels/workbook.xml.rels':
			'<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
		'xl/sharedStrings.xml': `<sst>${sst}</sst>`,
		'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
	});
}

/** An ASiC-E (.edoc) fixture wrapping the given payload entries. */
export function buildEdoc(payload: Record<string, Buffer>): Buffer {
	return buildZip({
		mimetype: 'application/vnd.etsi.asic-e+zip',
		'META-INF/manifest.xml': '<manifest/>',
		'META-INF/edoc-signatures-S1.xml': '<signature/>',
		...payload,
	});
}
