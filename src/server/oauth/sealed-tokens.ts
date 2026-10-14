import { decryptToken, deriveTokenKey, encryptToken } from '../../sessions';

/** Prefix + version of a sealed refresh token, so a format change can be told apart later. */
const REFRESH_PREFIX = 'rt1.';

/** What the broker's refresh token carries: everything needed to mint the next token pair. */
export interface SealedRefreshPayload {
	/** The user (Creatio `sub`) the token represents. */
	sub: string;
	/** The MCP client it was issued to; a different client cannot redeem it. */
	cid: string;
	/** The user's Creatio refresh token. */
	crt: string;
	/** Absolute expiry, epoch ms. */
	exp: number;
}

/**
 * Seals the user's Creatio tokens INTO the tokens the broker issues, so the broker itself keeps no
 * per-user state: a restart, a redeploy or a second replica loses nothing, as long as every
 * instance shares `CREATIO_MCP_JWT_SECRET`.
 *
 * - The access token (a signed JWT) carries the Creatio ACCESS token sealed in its `ct` claim.
 * - The refresh token is an opaque sealed blob carrying the Creatio REFRESH token.
 *
 * Sealing is AES-256-GCM (confidential + tamper-evident) with a key derived from the JWT secret,
 * domain-separated from the signing use. The client can neither read nor alter what it carries.
 */
export class TokenSealer {
	private readonly _key: Buffer;

	constructor(secret: string) {
		this._key = deriveTokenKey(secret);
	}

	public sealAccess(creatioAccessToken: string): string {
		return encryptToken(creatioAccessToken, this._key);
	}

	/** Returns the Creatio access token, or `null` when the blob is malformed or tampered with. */
	public openAccess(sealed: string): string | null {
		try {
			return decryptToken(sealed, this._key);
		} catch {
			return null;
		}
	}

	public sealRefresh(payload: SealedRefreshPayload): string {
		return REFRESH_PREFIX + encryptToken(JSON.stringify(payload), this._key);
	}

	/** Returns the payload, or `null` when the token is not ours, malformed, tampered or expired. */
	public openRefresh(token: string, now: number = Date.now()): SealedRefreshPayload | null {
		if (!token.startsWith(REFRESH_PREFIX)) {
			return null;
		}
		try {
			const payload = JSON.parse(
				decryptToken(token.slice(REFRESH_PREFIX.length), this._key),
			) as Partial<SealedRefreshPayload>;
			const valid =
				typeof payload.sub === 'string' &&
				typeof payload.cid === 'string' &&
				typeof payload.crt === 'string' &&
				typeof payload.exp === 'number';
			if (!valid || now > (payload.exp as number)) {
				return null;
			}
			return payload as SealedRefreshPayload;
		} catch {
			return null;
		}
	}
}
