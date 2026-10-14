import crypto from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import log from '../log';

export interface SessionInfo {
	id: string;
	userKey?: string | undefined;
	transport?: StreamableHTTPServerTransport | undefined;
	isLogged: boolean;
	createdAt: Date;
	remoteIp?: string | undefined;
}

/**
 * A user's Creatio tokens as obtained by the `broker` login / refresh. The broker stores none of
 * them server-side: they travel sealed inside the tokens it issues to the client (see
 * `server/oauth/sealed-tokens.ts`), so a restart or another replica loses nothing.
 */
export interface UserTokens {
	accessToken: string;
	accessTokenExpiryMs: number;
	refreshToken?: string | undefined;
}

function tokenFingerprint(token: string): string {
	return crypto.createHash('sha256').update(token).digest('base64url');
}

/**
 * Tracks live MCP streamable-HTTP sessions (id ↔ transport ↔ user identity) for the HTTP server.
 *
 * In the stateless per-request Bearer model the MCP stores NO tokens: every request carries its own
 * Creatio access token (delegated: from the client; gateway: injected by the Control-Plane). This
 * context therefore only manages transport/session lifecycle and the identity used for logging.
 */
export class SessionContext {
	private static _instance: SessionContext | undefined;
	private readonly _sessions = new Map<string, SessionInfo>();
	private readonly _deletingSessions = new Set<string>();
	// Broker: Creatio access tokens that Creatio rejected although they were not yet expired
	// (fingerprint → expiry ms). The edge answers 401 for them so the client refreshes instead of
	// failing every call until the token's natural expiry. Self-limiting: entries die with the token.
	private readonly _rejectedCreatioTokens = new Map<string, number>();

	public static get instance(): SessionContext {
		if (!SessionContext._instance) {
			SessionContext._instance = new SessionContext();
		}
		return SessionContext._instance;
	}

	public createSession(sessionId: string, userKey?: string, remoteIp?: string): SessionInfo {
		const session: SessionInfo = {
			id: sessionId,
			isLogged: false,
			createdAt: new Date(),
		};
		if (userKey !== undefined) {
			session.userKey = userKey;
		}
		if (remoteIp !== undefined) {
			session.remoteIp = remoteIp;
		}
		this._sessions.set(sessionId, session);
		return session;
	}

	public getSession(sessionId: string): SessionInfo | undefined {
		return this._sessions.get(sessionId);
	}

	public hasSession(sessionId: string): boolean {
		return this._sessions.has(sessionId);
	}

	public markSessionAsLogged(sessionId: string): boolean {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.isLogged = true;
			return true;
		}
		return false;
	}

	public setSessionTransport(sessionId: string, transport: StreamableHTTPServerTransport): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.transport = transport;
		}
	}

	public mapSessionToUser(sessionId: string, userKey: string): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.userKey = userKey;
			log.info('session_mapping.set', { sessionId, userKey });
		}
	}

	public deleteSession(sessionId: string): void {
		if (this._deletingSessions.has(sessionId)) {
			return;
		}
		this._deletingSessions.add(sessionId);
		const session = this._sessions.get(sessionId);
		this._sessions.delete(sessionId);
		if (session?.transport) {
			try {
				session.transport.close();
			} catch (err) {
				log.warn('transport.close.failed', { sessionId, error: String(err) });
			}
		}
		this._deletingSessions.delete(sessionId);
	}

	public getAllSessions(): SessionInfo[] {
		return Array.from(this._sessions.values());
	}

	public getSessionsForUser(userKey: string): SessionInfo[] {
		return Array.from(this._sessions.values()).filter((s) => s.userKey === userKey);
	}

	public getStats(): { sessionsCount: number } {
		return { sessionsCount: this._sessions.size };
	}

	// --- Rejected Creatio access tokens (broker mode) ---

	/** Remember that Creatio rejected `token`; it is treated as dead until `expiresAtMs`. */
	public markCreatioTokenRejected(token: string, expiresAtMs: number): void {
		this._rejectedCreatioTokens.set(tokenFingerprint(token), expiresAtMs);
	}

	public isCreatioTokenRejected(token: string): boolean {
		return this._rejectedCreatioTokens.has(tokenFingerprint(token));
	}

	/** Drop entries whose token has expired anyway; returns how many were removed. */
	public evictRejectedCreatioTokens(now: number = Date.now()): number {
		let removed = 0;
		for (const [fingerprint, expiresAtMs] of this._rejectedCreatioTokens) {
			if (now > expiresAtMs) {
				this._rejectedCreatioTokens.delete(fingerprint);
				removed++;
			}
		}
		return removed;
	}
}
