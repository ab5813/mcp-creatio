import { describe, expect, it, vi } from 'vitest';

import { OAuthServer } from '../../src/server/oauth/oauth-server';

import type { TokenAudience } from '../../src/server/oauth/token-manager';
import type { UserTokens } from '../../src/sessions';
import type { OAuthAccessToken } from '../../src/server/oauth/types';

const AUD: TokenAudience = { issuer: 'https://mcp.local', audience: 'https://mcp.local/mcp' };
const REDIRECT = 'http://localhost:9999/cb';

function isToken(r: OAuthAccessToken | { error: string }): r is OAuthAccessToken {
	return !('error' in r);
}

describe('OAuthServer.validateAuthorizationRequest auto-register', () => {
	it('auto-registers an unknown client with an allowed redirect, then validates', () => {
		const server = new OAuthServer('a-secret');
		const err = server.validateAuthorizationRequest({
			client_id: 'vscode-x',
			redirect_uri: REDIRECT,
			response_type: 'code',
			code_challenge: 'chal',
			code_challenge_method: 'S256',
		});
		expect(err).toBeNull();
	});

	it('refuses to auto-register against a disallowed (remote) redirect', () => {
		const server = new OAuthServer('a-secret');
		const err = server.validateAuthorizationRequest({
			client_id: 'attacker',
			redirect_uri: 'https://evil.example.com/cb',
			response_type: 'code',
			code_challenge: 'chal',
			code_challenge_method: 'S256',
		});
		// No client was registered → invalid_client.
		expect(err?.error).toBe('invalid_client');
	});
});

// RFC 7636 known verifier/challenge pair — lets us pass real PKCE on the token exchange.
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function creatioTokens(overrides: Partial<UserTokens> = {}): UserTokens {
	return {
		accessToken: 'CREATIO-AT',
		accessTokenExpiryMs: Date.now() + 3_600_000,
		refreshToken: 'CREATIO-RT',
		...overrides,
	};
}

async function issueRealTokens(server: OAuthServer, userKey: string, creatio = creatioTokens()) {
	const client = server.registerClient([REDIRECT]);
	const code = server.generateAuthorizationCode(
		client.client_id,
		REDIRECT,
		PKCE_CHALLENGE,
		'S256',
		userKey,
		creatio,
	);
	const result = await server.exchangeCodeForToken(
		{
			grant_type: 'authorization_code',
			client_id: client.client_id,
			redirect_uri: REDIRECT,
			code,
			code_verifier: PKCE_VERIFIER,
		},
		AUD,
	);
	if (!isToken(result)) throw new Error('expected token');
	return { client, result };
}

function refreshRequest(client_id: string, refresh_token: string) {
	return { grant_type: 'refresh_token', client_id, refresh_token };
}

describe('OAuthServer — Creatio tokens sealed into the issued tokens', () => {
	it('the access token carries the Creatio access token, readable only by the server', async () => {
		const server = new OAuthServer('a-secret');
		const { result } = await issueRealTokens(server, 'u-1');
		expect(server.verifyAccessToken(result.access_token, AUD)).toEqual({
			userKey: 'u-1',
			creatioAccessToken: 'CREATIO-AT',
		});
		// Sealed, not merely encoded: neither Creatio token is visible in what the client holds.
		const payload = Buffer.from(result.access_token.split('.')[1]!, 'base64url').toString();
		expect(payload).not.toContain('CREATIO-AT');
		expect(result.refresh_token).toMatch(/^rt1\./);
		expect(result.refresh_token).not.toContain('CREATIO-RT');
	});

	it('caps the access-token lifetime at the Creatio token it carries', async () => {
		const server = new OAuthServer('a-secret');
		const short = await issueRealTokens(
			server,
			'u-1',
			creatioTokens({ accessTokenExpiryMs: Date.now() + 300_000 }),
		);
		expect(short.result.expires_in).toBeLessThanOrEqual(300);
		expect(short.result.expires_in).toBeGreaterThan(290);
		const long = await issueRealTokens(
			server,
			'u-1',
			creatioTokens({ accessTokenExpiryMs: Date.now() + 86_400_000 }),
		);
		expect(long.result.expires_in).toBe(3600);
	});

	it('issues no refresh token when Creatio issued none', async () => {
		const server = new OAuthServer('a-secret');
		const { result } = await issueRealTokens(
			server,
			'u-1',
			creatioTokens({ refreshToken: undefined }),
		);
		expect(result.refresh_token).toBeUndefined();
	});

	it('rejects tokens sealed under a different secret, and garbage', async () => {
		const { result } = await issueRealTokens(new OAuthServer('a-secret'), 'u-1');
		const other = new OAuthServer('another-secret');
		expect(other.verifyAccessToken(result.access_token, AUD)).toBeNull();
		expect(other.verifyAccessToken('garbage', AUD)).toBeNull();
	});
});

describe('OAuthServer.exchangeRefreshToken', () => {
	const refresher = (next: Partial<UserTokens> = {}) =>
		vi.fn(async (_crt: string) =>
			creatioTokens({ accessToken: 'CREATIO-AT-2', refreshToken: 'CREATIO-RT-2', ...next }),
		);

	it('rejects an invalid/unknown refresh token', async () => {
		const server = new OAuthServer('a-secret');
		const r = await server.exchangeRefreshToken(refreshRequest('c1', 'nope'), AUD, refresher());
		expect('error' in r && r.error).toBe('invalid_grant');
	});

	it('rejects a missing refresh_token (validation)', async () => {
		const server = new OAuthServer('a-secret');
		const r = await server.exchangeRefreshToken(
			{ grant_type: 'refresh_token', client_id: 'c1' },
			AUD,
			refresher(),
		);
		expect('error' in r && r.error).toBe('invalid_request');
	});

	it('rejects when a different client presents the refresh token', async () => {
		const server = new OAuthServer('a-secret');
		const { result } = await issueRealTokens(server, 'u-1');
		const refresh = refresher();
		const r = await server.exchangeRefreshToken(
			refreshRequest('different-client', result.refresh_token!),
			AUD,
			refresh,
		);
		expect('error' in r && r.error_description).toBe('Client mismatch');
		expect(refresh).not.toHaveBeenCalled();
	});

	it('refreshes Creatio with the sealed Creatio refresh token and re-seals the new tokens', async () => {
		const server = new OAuthServer('a-secret');
		const { client, result } = await issueRealTokens(server, 'u-1');
		const refresh = refresher();
		const r = await server.exchangeRefreshToken(
			refreshRequest(client.client_id, result.refresh_token!),
			AUD,
			refresh,
		);
		expect(refresh).toHaveBeenCalledWith('CREATIO-RT');
		if (!isToken(r)) throw new Error('expected token');
		expect(server.verifyAccessToken(r.access_token, AUD)?.creatioAccessToken).toBe(
			'CREATIO-AT-2',
		);
		expect(r.refresh_token).not.toBe(result.refresh_token);
	});

	it('works on a fresh server instance sharing the secret (restart / another replica)', async () => {
		const before = await issueRealTokens(new OAuthServer('a-secret'), 'u-1');
		const restarted = new OAuthServer('a-secret');
		expect(restarted.verifyAccessToken(before.result.access_token, AUD)?.userKey).toBe('u-1');
		const r = await restarted.exchangeRefreshToken(
			refreshRequest(before.client.client_id, before.result.refresh_token!),
			AUD,
			refresher(),
		);
		expect(isToken(r)).toBe(true);
	});

	it('answers invalid_grant when Creatio rejects the refresh, and does not cache the failure', async () => {
		const server = new OAuthServer('a-secret');
		const { client, result } = await issueRealTokens(server, 'u-1');
		const failing = vi.fn(async () => {
			throw new Error('creatio_oauth_refresh_error:400');
		});
		const r = await server.exchangeRefreshToken(
			refreshRequest(client.client_id, result.refresh_token!),
			AUD,
			failing,
		);
		expect('error' in r && r.error_description).toMatch(/re-authorization required/i);
		const retry = await server.exchangeRefreshToken(
			refreshRequest(client.client_id, result.refresh_token!),
			AUD,
			refresher(),
		);
		expect(isToken(retry)).toBe(true);
	});

	it('spends a Creatio refresh token once for concurrent refreshes with the same token', async () => {
		const server = new OAuthServer('a-secret');
		const { client, result } = await issueRealTokens(server, 'u-1');
		const refresh = refresher();
		const req = refreshRequest(client.client_id, result.refresh_token!);
		const [a, b] = await Promise.all([
			server.exchangeRefreshToken(req, AUD, refresh),
			server.exchangeRefreshToken(req, AUD, refresh),
		]);
		expect(isToken(a) && isToken(b)).toBe(true);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});

describe('OAuthServer.resolveRevocationTarget', () => {
	it('resolves an access token and a refresh token to what they carry', async () => {
		const server = new OAuthServer('a-secret');
		const { result } = await issueRealTokens(server, 'u-1');
		expect(server.resolveRevocationTarget(result.access_token, AUD)).toEqual({
			kind: 'access',
			userKey: 'u-1',
			creatioAccessToken: 'CREATIO-AT',
		});
		expect(server.resolveRevocationTarget(result.refresh_token!, AUD)).toEqual({
			kind: 'refresh',
			userKey: 'u-1',
			creatioRefreshToken: 'CREATIO-RT',
		});
	});

	it('returns null for an unknown token', () => {
		expect(new OAuthServer('a-secret').resolveRevocationTarget('garbage', AUD)).toBeNull();
	});
});

describe('OAuthServer.cleanup', () => {
	it('runs without throwing', () => {
		expect(() => new OAuthServer('a-secret').cleanup()).not.toThrow();
	});
});
