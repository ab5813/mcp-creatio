import { inflateRawSync } from 'zlib';

export interface ZipEntry {
	name: string;
	compressedSize: number;
	uncompressedSize: number;
	/** 0 = stored, 8 = deflate — the only two methods real-world OOXML/ASiC writers emit. */
	method: number;
	localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD is 22 bytes + up to 65535 bytes of trailing comment. */
const EOCD_SCAN_MAX = 22 + 0xffff;

/**
 * Minimal read-only ZIP parser for the containers this server actually meets
 * (.docx / .xlsx / .edoc / plain .zip). Central-directory driven, zlib-only —
 * no dependency. ZIP64 archives are rejected explicitly: the download path
 * caps files at 50 MB, so a ZIP64 container here means something unexpected.
 */
export class ZipReader {
	private readonly _buf: Buffer;
	private readonly _entries: ZipEntry[];

	public get entries(): readonly ZipEntry[] {
		return this._entries;
	}

	constructor(buf: Buffer) {
		this._buf = buf;
		this._entries = this._readCentralDirectory();
	}

	private _readCentralDirectory(): ZipEntry[] {
		const buf = this._buf;
		// Scan backwards for the EOCD signature (it trails an optional comment).
		const scanFrom = Math.max(0, buf.length - EOCD_SCAN_MAX);
		let eocd = -1;
		for (let i = buf.length - 22; i >= scanFrom; i--) {
			if (buf.readUInt32LE(i) === EOCD_SIG) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) {
			throw new Error('zip_no_end_of_central_directory');
		}
		const count = buf.readUInt16LE(eocd + 10);
		const cdOffset = buf.readUInt32LE(eocd + 16);
		if (count === 0xffff || cdOffset === 0xffffffff) {
			throw new Error('zip_zip64_unsupported');
		}
		const entries: ZipEntry[] = [];
		let p = cdOffset;
		for (let i = 0; i < count; i++) {
			if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
				throw new Error('zip_corrupt_central_directory');
			}
			const method = buf.readUInt16LE(p + 10);
			const compressedSize = buf.readUInt32LE(p + 20);
			const uncompressedSize = buf.readUInt32LE(p + 24);
			const nameLen = buf.readUInt16LE(p + 28);
			const extraLen = buf.readUInt16LE(p + 30);
			const commentLen = buf.readUInt16LE(p + 32);
			const localHeaderOffset = buf.readUInt32LE(p + 42);
			// Bit 11 of the general-purpose flags marks a UTF-8 name; every OOXML /
			// eParaksts writer we meet sets it. Non-flagged names decode as latin1 so
			// byte values survive round-trips even if the display is imperfect.
			const flags = buf.readUInt16LE(p + 8);
			const rawName = buf.subarray(p + 46, p + 46 + nameLen);
			const name = rawName.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
			entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
			p += 46 + nameLen + extraLen + commentLen;
		}
		return entries;
	}

	public names(): string[] {
		return this._entries.map((e) => e.name);
	}

	public find(name: string): ZipEntry | undefined {
		return this._entries.find((e) => e.name === name);
	}

	public has(name: string): boolean {
		return this.find(name) !== undefined;
	}

	/** Inflate (or slice) a single entry's bytes. */
	public read(entry: ZipEntry): Buffer {
		const buf = this._buf;
		const off = entry.localHeaderOffset;
		if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) {
			throw new Error(`zip_corrupt_local_header:${entry.name}`);
		}
		// The local header repeats name/extra with its OWN lengths (they can differ
		// from the central directory's) — skip using the local values.
		const nameLen = buf.readUInt16LE(off + 26);
		const extraLen = buf.readUInt16LE(off + 28);
		const start = off + 30 + nameLen + extraLen;
		const data = buf.subarray(start, start + entry.compressedSize);
		if (entry.method === 0) {
			return Buffer.from(data);
		}
		if (entry.method === 8) {
			return inflateRawSync(data);
		}
		throw new Error(`zip_unsupported_method:${entry.method} ${entry.name}`);
	}

	public readByName(name: string): Buffer | undefined {
		const entry = this.find(name);
		return entry ? this.read(entry) : undefined;
	}
}
