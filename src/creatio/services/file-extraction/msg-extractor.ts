import { ExtractedText } from './types';

/**
 * Outlook .msg (CFBF) via `@kenjiuno/msgreader`: renders a mail as readable
 * headers + body. Attachment payloads are listed by name, not extracted —
 * recursing into them belongs to the caller via the dispatcher if ever needed.
 */
interface MsgRecipient {
	name?: string;
	email?: string;
}

interface MsgAttachment {
	fileName?: string;
	fileNameShort?: string;
}

interface MsgFileData {
	subject?: string;
	senderName?: string;
	senderEmail?: string;
	messageDeliveryTime?: string;
	body?: string;
	recipients?: MsgRecipient[];
	attachments?: MsgAttachment[];
}

export async function extractMsg(bytes: Buffer): Promise<ExtractedText> {
	const mod = (await import('@kenjiuno/msgreader')) as unknown as Record<string, unknown>;
	// CJS/ESM interop: under our CJS build the namespace nests the class one
	// level deeper (mod.default.default); a future ESM build flattens it.
	type MsgReaderCtor = new (b: ArrayBuffer | Uint8Array) => { getFileData(): MsgFileData };
	const inner = mod['default'] as Record<string, unknown> | MsgReaderCtor;
	const MsgReader = (
		typeof inner === 'function' ? inner : (inner as Record<string, unknown>)['default']
	) as MsgReaderCtor;
	const msg = new MsgReader(bytes).getFileData();
	const lines: string[] = [];
	const from = [msg.senderName, msg.senderEmail && `<${msg.senderEmail}>`]
		.filter(Boolean)
		.join(' ');
	if (from) {
		lines.push(`From: ${from}`);
	}
	const to = (msg.recipients ?? [])
		.map((r) => [r.name, r.email && `<${r.email}>`].filter(Boolean).join(' '))
		.filter(Boolean)
		.join(', ');
	if (to) {
		lines.push(`To: ${to}`);
	}
	if (msg.messageDeliveryTime) {
		lines.push(`Date: ${msg.messageDeliveryTime}`);
	}
	if (msg.subject) {
		lines.push(`Subject: ${msg.subject}`);
	}
	lines.push('', (msg.body ?? '').trim());
	const attachmentNames = (msg.attachments ?? [])
		.map((a) => a.fileName ?? a.fileNameShort ?? '')
		.filter(Boolean);
	if (attachmentNames.length > 0) {
		lines.push('', `[Attachments: ${attachmentNames.join(', ')}]`);
	}
	return {
		text: lines.join('\n').trim(),
		format: 'msg',
		...(attachmentNames.length > 0 ? { meta: { parts: attachmentNames } } : {}),
	};
}
