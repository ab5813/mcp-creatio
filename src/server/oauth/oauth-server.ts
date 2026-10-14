import crypto from 'crypto';

import log from '../../log';

import { OAuthClientManager } from './client-manager';
import { SealedRefreshPayload, TokenSealer } from './sealed-tokens';
import { OAuthStorage } from './storage';
import { OAuthTokenManager, TokenAudience } from './token-manager';
import { OAuthValidators } from './validators';

import type {
	OAuthAccessToken,
	OAuthAuthorizationRequest,
	OAuthClient,
	OAuthError,
	OAuthTokenRequest,
} from './types';
import type { UserTokens } from '../../sessions';

/** Refreshes the user's Creatio tokens with a Creatio refresh token (the broker's Creatio client). */
type CreatioRefresher = (creatioRefreshToken: string) => Promise<UserTokens>;

/** What a verified access token yields: who the caller is and the Creatio token to act with. */
export interface VerifiedAccess {
	userKey: string;
	creatioAccessToken: string;
}

/** What a token presented for revocation resolves to. */
export type RevocationTarget =
	| { kind: 'access'; userKey: string; creatioAccessToken: string }
	| { kind: 'refresh'; userKey: string; creatioRefreshToken: string };

/** Upper bound of an issued access token; it is also capped at the sealed Creatio token's expiry,
 *  so it never outlives the credential it carries (the client refreshes instead). */
const ACCESS_TOKEN_MAX_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Concurrent / retried refreshes with the same Creatio refresh token share one result for this
 *  long, so a rotating Creatio refresh token is never spent twice. */
const REFRESH_REPLAY_WINDOW_MS = 60_000;
const ISSUED_SCOPE = 'offline_access';

export class OAuthServer {
	private readonly _storage = new OAuthStorage();
	private readonly _tokenManager: OAuthTokenManager;
	private readonly _sealer: TokenSealer;
	// Creatio refresh token fingerprint → the in-flight / just-finished refresh (see
	// REFRESH_REPLAY_WINDOW_MS). The only per-user state, and it is disposable.
	private readonly _recentRefreshes = new Map<
		string,
		{ result: Promise<UserTokens>; expiresAt: number }
	>();

	/**
	 * @param jwtSecret stable secret (from `CREATIO_MCP_JWT_SECRET`) signing — and, derived, sealing —
	 *        the tokens issued to MCP clients. Stable so issued tokens survive a restart and work on
	 *        every replica sharing it.
	 */
	constructor(jwtSecret: string) {
		this._tokenManager = new OAuthTokenManager(jwtSecret);
		this._sealer = new TokenSealer(jwtSecret);
	}

	private _autoRegisterClientIfNeeded(client_id: string, redirect_uri: string): boolean {
		if (this._storage.hasClient(client_id)) {
			return false;
		}
		// Never auto-register a client bound to a redirect target we would not allow,
		// otherwise validateAuthorizationRequest would "pass" against an attacker URI (CWE-601).
		if (!OAuthValidators.isAllowedRedirectUri(redirect_uri)) {
			log.warn('oauth.client.auto_register_rejected', { client_id });
			return false;
		}
		const client = OAuthClientManager.autoRegisterClient(client_id, redirect_uri);
		this._storage.addClient(client);
		return true;
	}

	/**
	 * Mint the token pair for a user's current Creatio tokens: an access token carrying the sealed
	 * Creatio access token (living no longer than it), and — when Creatio issued one — a refresh
	 * token carrying the sealed Creatio refresh token. Nothing is stored server-side.
	 */
	private _issueTokens(
		userKey: string,
		client_id: string,
		aud: TokenAudience,
		creatio: UserTokens,
	): OAuthAccessToken {
		const creatioRemaining = Math.floor((creatio.accessTokenExpiryMs - Date.now()) / 1000);
		const expires_in = Math.max(1, Math.min(ACCESS_TOKEN_MAX_TTL_SECONDS, creatioRemaining));
		const access_token = this._tokenManager.generateAccessToken(
			userKey,
			client_id,
			aud,
			this._sealer.sealAccess(creatio.accessToken),
			expires_in,
		);
		const response: OAuthAccessToken = {
			access_token,
			token_type: 'Bearer',
			expires_in,
			scope: ISSUED_SCOPE,
		};
		if (creatio.refreshToken) {
			response.refresh_token = this._sealer.sealRefresh({
				sub: userKey,
				cid: client_id,
				crt: creatio.refreshToken,
				exp: Date.now() + REFRESH_TOKEN_TTL_MS,
			});
		}
		return response;
	}

	private _refreshKey(crt: string): string {
		return crypto.createHash('sha256').update(crt).digest('base64url');
	}

	/** One Creatio refresh per Creatio refresh token within the replay window (single-flight). */
	private _refreshCreatioOnce(
		crt: string,
		refreshCreatio: CreatioRefresher,
	): Promise<UserTokens> {
		const key = this._refreshKey(crt);
		const now = Date.now();
		const recent = this._recentRefreshes.get(key);
		if (recent && now < recent.expiresAt) {
			return recent.result;
		}
		const result = refreshCreatio(crt);
		this._recentRefreshes.set(key, { result, expiresAt: now + REFRESH_REPLAY_WINDOW_MS });
		// A failed refresh must not be replayed to the next caller as a cached failure.
		result.catch(() => this._recentRefreshes.delete(key));
		return result;
	}

	/**
	 * Records a brokered authorization in flight and returns its opaque broker state (used as the
	 * `state` on the Creatio leg). Server-side storage keeps the client's PKCE and our Creatio-leg
	 * verifier apart — nothing is embedded in the Creatio `state`.
	 */
	public createPendingAuthorization(data: {
		client_id: string;
		redirect_uri: string;
		code_challenge: string;
		code_challenge_method: string;
		client_state?: string | undefined;
		creatio_verifier: string;
	}): string {
		const brokerState = crypto.randomBytes(32).toString('base64url');
		this._storage.storePendingAuthorization(brokerState, data);
		return brokerState;
	}

	public takePendingAuthorization(brokerState: string) {
		return this._storage.takePendingAuthorization(brokerState);
	}

	public registerClient(redirect_uris: string[]): OAuthClient {
		const client = OAuthClientManager.createClient(redirect_uris);
		this._storage.addClient(client);
		return client;
	}

	public validateAuthorizationRequest(params: OAuthAuthorizationRequest): OAuthError | null {
		let client = this._storage.getClient(params.client_id);
		if (!client) {
			const wasRegistered = this._autoRegisterClientIfNeeded(
				params.client_id,
				params.redirect_uri,
			);
			if (wasRegistered) {
				client = this._storage.getClient(params.client_id);
			}
		}
		return OAuthValidators.validateAuthorizationRequest(params, client);
	}

	public generateAuthorizationCode(
		client_id: string,
		redirect_uri: string,
		code_challenge: string,
		code_challenge_method: string,
		userKey: string,
		creatio: UserTokens,
	): string {
		const code = crypto.randomBytes(32).toString('base64url');
		this._storage.storeAuthorizationCode(
			code,
			client_id,
			redirect_uri,
			code_challenge,
			code_challenge_method,
			userKey,
			creatio,
		);
		log.info('oauth.authorization_code.generated', { client_id, userKey });
		return code;
	}

	public async exchangeCodeForToken(
		params: OAuthTokenRequest,
		aud: TokenAudience,
	): Promise<OAuthAccessToken | OAuthError> {
		log.info('oauth.token.exchange_start', {
			grant_type: params.grant_type,
			client_id: params.client_id,
			redirect_uri: params.redirect_uri,
			has_code_verifier: !!params.code_verifier,
		});
		const validationError = OAuthValidators.validateTokenRequest(params);
		if (validationError) {
			return validationError;
		}
		const authCode = this._storage.getAuthorizationCode(params.code!);
		if (!authCode) {
			log.error('oauth.token.code_not_found', { client_id: params.client_id });
			return { error: 'invalid_grant', error_description: 'Invalid authorization code' };
		}
		const codeValidationError = this._tokenManager.validateAuthCodeData(authCode, params);
		if (codeValidationError) {
			if (
				codeValidationError.error === 'invalid_grant' &&
				codeValidationError.error_description === 'Authorization code expired'
			) {
				this._storage.deleteAuthorizationCode(params.code!);
			}
			return codeValidationError;
		}
		this._storage.deleteAuthorizationCode(params.code!);
		log.info('oauth.token.issued', { client_id: params.client_id, userKey: authCode.userKey });
		return this._issueTokens(authCode.userKey, params.client_id, aud, authCode.creatio);
	}

	/**
	 * `refresh_token` grant: open the sealed refresh token, refresh the user's Creatio tokens with the
	 * Creatio refresh token it carries, and mint a new pair carrying the new ones — no browser
	 * round-trip and no server-side state, so it works after a restart or on another replica. The
	 * token is bound to the client it was issued to. When Creatio rejects the refresh (expired or
	 * revoked upstream) the client gets `invalid_grant` and re-runs the authorization.
	 */
	public async exchangeRefreshToken(
		params: OAuthTokenRequest,
		aud: TokenAudience,
		refreshCreatio: CreatioRefresher,
	): Promise<OAuthAccessToken | OAuthError> {
		const validationError = OAuthValidators.validateTokenRequest(params);
		if (validationError) {
			return validationError;
		}
		const payload = this._sealer.openRefresh(params.refresh_token!);
		if (!payload) {
			return {
				error: 'invalid_grant',
				error_description: 'Invalid or expired refresh token',
			};
		}
		if (payload.cid !== params.client_id) {
			log.warn('oauth.token.refresh_client_mismatch', { userKey: payload.sub });
			return { error: 'invalid_grant', error_description: 'Client mismatch' };
		}
		let creatio: UserTokens;
		try {
			creatio = await this._refreshCreatioOnce(payload.crt, refreshCreatio);
		} catch (err) {
			log.warn('oauth.token.refresh_upstream_failed', {
				userKey: payload.sub,
				error: String((err as Error)?.message ?? err),
			});
			return {
				error: 'invalid_grant',
				error_description: 'Session expired; re-authorization required',
			};
		}
		log.info('oauth.token.refreshed', { client_id: payload.cid, userKey: payload.sub });
		return this._issueTokens(payload.sub, payload.cid, aud, creatio);
	}

	/** Verify a client-presented access token (signature, `iss`/`aud`, expiry) and open the Creatio
	 *  access token it carries; `null` when anything about it is off. */
	public verifyAccessToken(token: string, aud: TokenAudience): VerifiedAccess | null {
		const decoded = this._tokenManager.validateAccessToken(token, aud);
		if (!decoded) {
			return null;
		}
		const creatioAccessToken = this._sealer.openAccess(decoded.sealedCreatio);
		return creatioAccessToken ? { userKey: decoded.userKey, creatioAccessToken } : null;
	}

	/** RFC 7009: resolve a presented token — our access JWT or our sealed refresh token. `null` for
	 *  anything else (the caller still answers 200, so this is no validity oracle). */
	public resolveRevocationTarget(token: string, aud: TokenAudience): RevocationTarget | null {
		const access = this.verifyAccessToken(token, aud);
		if (access) {
			return { kind: 'access', ...access };
		}
		const refresh: SealedRefreshPayload | null = this._sealer.openRefresh(token);
		return refresh
			? { kind: 'refresh', userKey: refresh.sub, creatioRefreshToken: refresh.crt }
			: null;
	}

	/** Forget a just-made refresh so a revoked Creatio refresh token cannot be replayed through the
	 *  replay window (call on revocation). */
	public forgetRecentRefresh(creatioRefreshToken: string): void {
		this._recentRefreshes.delete(this._refreshKey(creatioRefreshToken));
	}

	public cleanup(): void {
		this._storage.cleanup();
		const now = Date.now();
		for (const [key, entry] of this._recentRefreshes) {
			if (now >= entry.expiresAt) {
				this._recentRefreshes.delete(key);
			}
		}
	}
}
