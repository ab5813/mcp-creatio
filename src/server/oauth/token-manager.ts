import crypto from 'crypto';

import jwt from 'jsonwebtoken';

import log from '../../log';

import type { AuthorizationCodeData } from './storage';
import type { OAuthError, OAuthTokenRequest } from './types';

/**
 * Issuer + audience an access token is bound to: this MCP deployment's own origin (`iss`) and its
 * `/mcp` resource (`aud`). Binding both closes token-redirection / confused-deputy — a token minted
 * for deployment A is rejected by deployment B even when both share `CREATIO_MCP_JWT_SECRET`
 * (the documented multi-instance setup). Mirrors RFC 9068 (`aud`) / RFC 8707 (resource indicators).
 */
export interface TokenAudience {
	issuer: string;
	audience: string;
}

/** The claims we trust off a verified access token. */
export interface DecodedAccessToken {
	userKey: string;
	client_id: string;
	/** The sealed Creatio access token (`ct` claim), opened by the {@link TokenSealer}. */
	sealedCreatio: string;
}

export class OAuthTokenManager {
	private readonly _jwtSecret: string;

	constructor(jwtSecret: string) {
		this._jwtSecret = jwtSecret;
	}

	/** Mint an access token bound to `userKey` (as `sub`), the issuing `client_id`, and the
	 *  deployment's `iss`/`aud`, carrying the sealed Creatio access token as `ct`. */
	public generateAccessToken(
		userKey: string,
		client_id: string,
		aud: TokenAudience,
		sealedCreatio: string,
		expiresInSeconds: number,
	): string {
		return jwt.sign({ client_id, ct: sealedCreatio }, this._jwtSecret, {
			subject: userKey,
			expiresIn: expiresInSeconds,
			issuer: aud.issuer,
			audience: aud.audience,
		});
	}

	/** Verify signature AND issuer/audience binding; return the trusted claims or `null`. */
	public validateAccessToken(token: string, aud: TokenAudience): DecodedAccessToken | null {
		try {
			const decoded = jwt.verify(token, this._jwtSecret, {
				issuer: aud.issuer,
				audience: aud.audience,
			}) as jwt.JwtPayload;
			const userKey = typeof decoded.sub === 'string' ? decoded.sub : null;
			const client_id = typeof decoded.client_id === 'string' ? decoded.client_id : '';
			const sealedCreatio = typeof decoded.ct === 'string' ? decoded.ct : null;
			return userKey && sealedCreatio ? { userKey, client_id, sealedCreatio } : null;
		} catch (error) {
			log.warn('oauth.token.invalid', { error: String(error) });
			return null;
		}
	}

	public verifyPKCE(code_verifier: string, code_challenge: string): boolean {
		const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
		return hash === code_challenge;
	}

	public validateAuthCodeData(
		authCode: AuthorizationCodeData,
		params: OAuthTokenRequest,
	): OAuthError | null {
		if (Date.now() > authCode.expires_at) {
			return { error: 'invalid_grant', error_description: 'Authorization code expired' };
		}
		if (authCode.client_id !== params.client_id) {
			return { error: 'invalid_grant', error_description: 'Client mismatch' };
		}
		if (authCode.redirect_uri !== params.redirect_uri) {
			return { error: 'invalid_grant', error_description: 'Redirect URI mismatch' };
		}
		if (!params.code_verifier) {
			return { error: 'invalid_request', error_description: 'Missing code_verifier' };
		}
		if (!this.verifyPKCE(params.code_verifier, authCode.code_challenge)) {
			return { error: 'invalid_grant', error_description: 'PKCE verification failed' };
		}
		return null;
	}
}
