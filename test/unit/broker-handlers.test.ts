import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProviderType } from '../../src/creatio';
import { CreatioOAuthClient } from '../../src/creatio/auth/providers/creatio-oauth-client';
import { BrokerHandlers } from '../../src/server/http/broker-handlers';
import { OAuthServer } from '../../src/server/oauth';
import { SessionContext } from '../../src/sessions/session-context';
import { generatePkcePair } from '../../src/utils';
import { resetSessionContext } from '../support/test-server';

const CLIENT_REDIRECT = 'http://localhost:7777/cb';

function makeHandlers() {
	const oauth = new OAuthServer('test-jwt-secret');
	const creatio = new CreatioOAuthClient('https://t.creatio.local', {
		kind: AuthProviderType.Broker,
		clientId: 'creatio-app',
		jwtSecret: 'test-jwt-secret',
	} as never);
	return new BrokerHandlers(oauth, creatio, SessionContext.instance);
}

function req(opts: {
	query?: Record<string, unknown>;
	body?: unknown;
	headers?: Record<string, string>;
}) {
	return {
		query: opts.query ?? {},
		body: opts.body,
		headers: opts.headers ?? {},
		protocol: 'http',
		get: () => 'localhost:3000',
	} as Record<string, unknown>;
}
function res() {
	const r: Record<string, unknown> = {
		statusCode: 200,
		headers: {},
		redirectedTo: undefined,
		jsonBody: undefined,
	};
	r.status = vi.fn((c: number) => ((r.statusCode = c), r));
	r.json = vi.fn((b: unknown) => ((r.jsonBody = b), r));
	r.redirect = vi.fn((_c: number, url: string) => ((r.redirectedTo = url), r));
	r.setHeader = vi.fn((k: string, v: string) => {
		(r.headers as Record<string, string>)[k] = v;
	});
	return r;
}

function jsonOk(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

beforeEach(() => resetSessionContext());
afterEach(() => vi.unstubAllGlobals());

describe('BrokerHandlers — full authorization_code broker flow', () => {
	it('register → authorize → callback → token → mcpAuth, end to end', async () => {
		const h = makeHandlers();

		// 1) Dynamic client registration.
		const regRes = res();
		h.handleRegister(
			req({ body: { redirect_uris: [CLIENT_REDIRECT] } }) as never,
			regRes as never,
		);
		expect(regRes.statusCode).toBe(201);
		const clientId = (regRes.jsonBody as { client_id: string }).client_id;

		// 2) Client authorize (with its own PKCE) → redirect to Creatio.
		const { verifier: clientVerifier, challenge: clientChallenge } = await generatePkcePair();
		const authRes = res();
		await h.handleAuthorize(
			req({
				query: {
					client_id: clientId,
					redirect_uri: CLIENT_REDIRECT,
					response_type: 'code',
					code_challenge: clientChallenge,
					code_challenge_method: 'S256',
					state: 'client-state-1',
				},
			}) as never,
			authRes as never,
		);
		const creatioUrl = new URL(authRes.redirectedTo as string);
		expect(creatioUrl.pathname).toContain('/0/connect/authorize');
		// Our OWN Creatio-leg PKCE challenge is present and DIFFERENT from the client's (no collision).
		expect(creatioUrl.searchParams.get('code_challenge')).toBeTruthy();
		expect(creatioUrl.searchParams.get('code_challenge')).not.toBe(clientChallenge);
		const brokerState = creatioUrl.searchParams.get('state')!;
		expect(brokerState).toBeTruthy();

		// 3) Creatio calls back → broker exchanges (mocked) → stores tokens → issues OUR code.
		const creatioToken = jwt.sign({ sub: 'creatio-user-1' }, 'irrelevant', { expiresIn: 3600 });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonOk({ access_token: creatioToken, refresh_token: 'RT', expires_in: 3600 }),
			),
		);
		const cbRes = res();
		await h.handleCallback(
			req({ query: { code: 'creatio-code', state: brokerState } }) as never,
			cbRes as never,
		);
		const clientRedirect = new URL(cbRes.redirectedTo as string);
		expect(clientRedirect.origin + clientRedirect.pathname).toBe(CLIENT_REDIRECT);
		expect(clientRedirect.searchParams.get('state')).toBe('client-state-1');
		const ourCode = clientRedirect.searchParams.get('code')!;
		expect(ourCode).toBeTruthy();

		// 4) Client exchanges OUR code (+ its verifier) for OUR token.
		const tokRes = res();
		await h.handleToken(
			req({
				body: {
					grant_type: 'authorization_code',
					code: ourCode,
					redirect_uri: CLIENT_REDIRECT,
					client_id: clientId,
					code_verifier: clientVerifier,
				},
			}) as never,
			tokRes as never,
		);
		const ourToken = (tokRes.jsonBody as { access_token: string }).access_token;
		expect(ourToken).toBeTruthy();

		// 5) /mcp guard accepts OUR token, exposes the userKey and hands the request the Creatio
		//    access token it opened from the token — nothing was stored server-side.
		const next = vi.fn();
		const guardReq = req({ headers: { authorization: `Bearer ${ourToken}` } });
		await h.mcpAuth()(guardReq as never, res() as never, next);
		expect(next).toHaveBeenCalled();
		expect(guardReq.userKey).toBe('creatio-user-1');
		expect(guardReq.credential).toEqual({ kind: 'bearer', token: creatioToken });

		// 6) A restarted broker (fresh instance, same secret) serves the SAME token unchanged.
		const next2 = vi.fn();
		const restartedReq = req({ headers: { authorization: `Bearer ${ourToken}` } });
		await makeHandlers().mcpAuth()(restartedReq as never, res() as never, next2);
		expect(next2).toHaveBeenCalled();
		expect(restartedReq.credential).toEqual({ kind: 'bearer', token: creatioToken });

		// 7) A garbage token is challenged with invalid_token (the client refreshes / re-auths).
		const next3 = vi.fn();
		const r3 = res();
		await h.mcpAuth()(
			req({ headers: { authorization: 'Bearer not-ours' } }) as never,
			r3 as never,
			next3,
		);
		expect(next3).not.toHaveBeenCalled();
		expect(r3.statusCode).toBe(401);
		expect((r3.headers as Record<string, string>)['WWW-Authenticate']).toContain(
			'error="invalid_token"',
		);
	});

	it('mcpAuth rejects a missing token with a WWW-Authenticate challenge', async () => {
		const h = makeHandlers();
		const r = res();
		const next = vi.fn();
		await h.mcpAuth()(req({}) as never, r as never, next);
		expect(r.statusCode).toBe(401);
		expect((r.headers as Record<string, string>)['WWW-Authenticate']).toContain(
			'resource_metadata=',
		);
		expect(next).not.toHaveBeenCalled();
	});

	it('refresh_token grant refreshes Creatio and re-issues without re-auth', async () => {
		const h = makeHandlers();
		const regRes = res();
		h.handleRegister(
			req({ body: { redirect_uris: [CLIENT_REDIRECT] } }) as never,
			regRes as never,
		);
		const clientId = (regRes.jsonBody as { client_id: string }).client_id;
		const { verifier, challenge } = await generatePkcePair();
		const authRes = res();
		await h.handleAuthorize(
			req({
				query: {
					client_id: clientId,
					redirect_uri: CLIENT_REDIRECT,
					response_type: 'code',
					code_challenge: challenge,
					code_challenge_method: 'S256',
				},
			}) as never,
			authRes as never,
		);
		const brokerState = new URL(authRes.redirectedTo as string).searchParams.get('state')!;
		const creatioToken = jwt.sign({ sub: 'refresh-user' }, 'irrelevant', { expiresIn: 3600 });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonOk({ access_token: creatioToken, refresh_token: 'RT', expires_in: 3600 }),
			),
		);
		const cbRes = res();
		await h.handleCallback(
			req({ query: { code: 'c', state: brokerState } }) as never,
			cbRes as never,
		);
		const ourCode = new URL(cbRes.redirectedTo as string).searchParams.get('code')!;
		const tokRes = res();
		await h.handleToken(
			req({
				body: {
					grant_type: 'authorization_code',
					code: ourCode,
					redirect_uri: CLIENT_REDIRECT,
					client_id: clientId,
					code_verifier: verifier,
				},
			}) as never,
			tokRes as never,
		);
		const issued = tokRes.jsonBody as { access_token: string; refresh_token: string };
		expect(issued.refresh_token).toBeTruthy();

		// Refresh → the broker refreshes Creatio with the sealed Creatio refresh token.
		const refreshedCreatio = jwt.sign({ sub: 'refresh-user' }, 'irrelevant', {
			expiresIn: 3600,
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonOk({ access_token: refreshedCreatio, refresh_token: 'RT2', expires_in: 3600 }),
			),
		);
		const refRes = res();
		await h.handleToken(
			req({
				body: {
					grant_type: 'refresh_token',
					refresh_token: issued.refresh_token,
					client_id: clientId,
				},
			}) as never,
			refRes as never,
		);
		const refreshed = refRes.jsonBody as { access_token: string; refresh_token: string };
		expect(refreshed.access_token).toBeTruthy();
		expect(refreshed.refresh_token).not.toBe(issued.refresh_token);
		const body = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '');
		expect(body).toContain('grant_type=refresh_token');
		expect(body).toContain('refresh_token=RT');
		const next = vi.fn();
		const guardReq = req({ headers: { authorization: `Bearer ${refreshed.access_token}` } });
		await h.mcpAuth()(guardReq as never, res() as never, next);
		expect(guardReq.credential).toEqual({ kind: 'bearer', token: refreshedCreatio });

		// Once Creatio rejects the Creatio refresh token, the refresh fails → client re-auths.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })),
		);
		const goneRes = res();
		await h.handleToken(
			req({
				body: {
					grant_type: 'refresh_token',
					refresh_token: refreshed.refresh_token,
					client_id: clientId,
				},
			}) as never,
			goneRes as never,
		);
		expect(goneRes.statusCode).toBe(400);
	});

	it('an access token bound to one origin is rejected at a different origin (aud/iss binding)', async () => {
		const h = makeHandlers();
		const regRes = res();
		h.handleRegister(
			req({ body: { redirect_uris: [CLIENT_REDIRECT] } }) as never,
			regRes as never,
		);
		const clientId = (regRes.jsonBody as { client_id: string }).client_id;
		const { verifier, challenge } = await generatePkcePair();
		const authRes = res();
		await h.handleAuthorize(
			req({
				query: {
					client_id: clientId,
					redirect_uri: CLIENT_REDIRECT,
					response_type: 'code',
					code_challenge: challenge,
					code_challenge_method: 'S256',
				},
			}) as never,
			authRes as never,
		);
		const brokerState = new URL(authRes.redirectedTo as string).searchParams.get('state')!;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonOk({
					access_token: jwt.sign({ sub: 'aud-user' }, 'x'),
					refresh_token: 'RT',
					expires_in: 3600,
				}),
			),
		);
		const cbRes = res();
		await h.handleCallback(
			req({ query: { code: 'c', state: brokerState } }) as never,
			cbRes as never,
		);
		const ourCode = new URL(cbRes.redirectedTo as string).searchParams.get('code')!;
		const tokRes = res();
		await h.handleToken(
			req({
				body: {
					grant_type: 'authorization_code',
					code: ourCode,
					redirect_uri: CLIENT_REDIRECT,
					client_id: clientId,
					code_verifier: verifier,
				},
			}) as never,
			tokRes as never,
		);
		const ourToken = (tokRes.jsonBody as { access_token: string }).access_token;

		// Same origin (localhost:3000) → accepted.
		const okNext = vi.fn();
		await h.mcpAuth()(
			req({ headers: { authorization: `Bearer ${ourToken}` } }) as never,
			res() as never,
			okNext,
		);
		expect(okNext).toHaveBeenCalled();

		// A request arriving with a DIFFERENT host → aud/iss mismatch → rejected.
		const otherHostReq = {
			query: {},
			body: undefined,
			headers: { authorization: `Bearer ${ourToken}` },
			protocol: 'http',
			get: () => 'evil.example.com',
		} as Record<string, unknown>;
		const badNext = vi.fn();
		const badRes = res();
		await h.mcpAuth()(otherHostReq as never, badRes as never, badNext);
		expect(badNext).not.toHaveBeenCalled();
		expect(badRes.statusCode).toBe(401);
	});

	it('revoke (RFC 7009): refresh token → Creatio revocation, access token → rejected here; always 200', async () => {
		const h = makeHandlers();
		const regRes = res();
		h.handleRegister(
			req({ body: { redirect_uris: [CLIENT_REDIRECT] } }) as never,
			regRes as never,
		);
		const clientId = (regRes.jsonBody as { client_id: string }).client_id;
		const { verifier, challenge } = await generatePkcePair();
		const authRes = res();
		await h.handleAuthorize(
			req({
				query: {
					client_id: clientId,
					redirect_uri: CLIENT_REDIRECT,
					response_type: 'code',
					code_challenge: challenge,
					code_challenge_method: 'S256',
				},
			}) as never,
			authRes as never,
		);
		const brokerState = new URL(authRes.redirectedTo as string).searchParams.get('state')!;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonOk({
					access_token: jwt.sign({ sub: 'revoke-user' }, 'x'),
					refresh_token: 'RT',
					expires_in: 3600,
				}),
			),
		);
		const cbRes = res();
		await h.handleCallback(
			req({ query: { code: 'c', state: brokerState } }) as never,
			cbRes as never,
		);
		const ourCode = new URL(cbRes.redirectedTo as string).searchParams.get('code')!;
		const tokRes = res();
		await h.handleToken(
			req({
				body: {
					grant_type: 'authorization_code',
					code: ourCode,
					redirect_uri: CLIENT_REDIRECT,
					client_id: clientId,
					code_verifier: verifier,
				},
			}) as never,
			tokRes as never,
		);
		const issued = tokRes.jsonBody as { access_token: string; refresh_token: string };
		const ourToken = issued.access_token;

		// Capture the upstream Creatio revocation call.
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: { body?: string }) => {
				calls.push(`${url}|${init?.body ?? ''}`);
				return new Response('', { status: 200 });
			}),
		);
		// Revoking the refresh token revokes the Creatio refresh token it carries, upstream.
		const revRes = res();
		await h.handleRevoke(
			req({ body: { token: issued.refresh_token } }) as never,
			revRes as never,
		);
		expect(revRes.statusCode).toBe(200);
		expect(calls.some((c) => c.includes('/connect/revocation') && c.includes('RT'))).toBe(true);

		// Revoking the access token makes the guard reject it from now on.
		const revAccessRes = res();
		await h.handleRevoke(req({ body: { token: ourToken } }) as never, revAccessRes as never);
		expect(revAccessRes.statusCode).toBe(200);
		const next = vi.fn();
		const guardRes = res();
		await h.mcpAuth()(
			req({ headers: { authorization: `Bearer ${ourToken}` } }) as never,
			guardRes as never,
			next,
		);
		expect(next).not.toHaveBeenCalled();
		expect(guardRes.statusCode).toBe(401);

		// An unknown token is still answered 200 (no token-scanning oracle).
		const unknownRes = res();
		await h.handleRevoke(
			req({ body: { token: 'not-a-real-token' } }) as never,
			unknownRes as never,
		);
		expect(unknownRes.statusCode).toBe(200);
	});

	it('token exchange fails for a wrong PKCE verifier', async () => {
		const h = makeHandlers();
		const regRes = res();
		h.handleRegister(
			req({ body: { redirect_uris: [CLIENT_REDIRECT] } }) as never,
			regRes as never,
		);
		const clientId = (regRes.jsonBody as { client_id: string }).client_id;
		const { challenge } = await generatePkcePair();
		const authRes = res();
		await h.handleAuthorize(
			req({
				query: {
					client_id: clientId,
					redirect_uri: CLIENT_REDIRECT,
					response_type: 'code',
					code_challenge: challenge,
					code_challenge_method: 'S256',
				},
			}) as never,
			authRes as never,
		);
		const brokerState = new URL(authRes.redirectedTo as string).searchParams.get('state')!;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonOk({ access_token: jwt.sign({ sub: 'u' }, 'x'), expires_in: 3600 }),
			),
		);
		const cbRes = res();
		await h.handleCallback(
			req({ query: { code: 'c', state: brokerState } }) as never,
			cbRes as never,
		);
		const ourCode = new URL(cbRes.redirectedTo as string).searchParams.get('code')!;
		const tokRes = res();
		await h.handleToken(
			req({
				body: {
					grant_type: 'authorization_code',
					code: ourCode,
					redirect_uri: CLIENT_REDIRECT,
					client_id: clientId,
					code_verifier: 'WRONG-VERIFIER',
				},
			}) as never,
			tokRes as never,
		);
		expect(tokRes.statusCode).toBe(400);
	});
});
