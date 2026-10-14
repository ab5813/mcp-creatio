import { describe, expect, it } from 'vitest';

import { AuthProviderType } from '../../src/creatio';
import { BrokerProvider } from '../../src/creatio/auth/providers/broker-provider';
import { SessionContext } from '../../src/sessions/session-context';
import { runWithContext } from '../../src/utils';
import { resetSessionContext } from '../support/test-server';

function provider() {
	return new BrokerProvider({
		baseUrl: 'https://t.creatio.local',
		auth: { kind: AuthProviderType.Broker, clientId: 'app-1', jwtSecret: 'jwt' },
	} as never);
}

const withToken = <T>(token: string, fn: () => Promise<T>) =>
	runWithContext({ userKey: 'u1', credential: { kind: 'bearer', token } }, fn);

describe('BrokerProvider — attaches the Creatio token the edge opened from the request', () => {
	it('uses the per-request Creatio access token, no store and no network', async () => {
		const headers = await withToken('CREATIO-AT', () =>
			provider().getHeaders('application/json', true),
		);
		expect(headers.Authorization).toBe('Bearer CREATIO-AT');
		expect(headers['Content-Type']).toBe('application/json');
	});

	it('throws when the request carries no Creatio token', async () => {
		await expect(
			runWithContext({ userKey: 'u1' }, () => provider().getHeaders('application/json')),
		).rejects.toThrow(/broker_not_authorized/);
		await expect(provider().getHeaders('application/json')).rejects.toThrow(
			/broker_not_authorized/,
		);
	});

	it('refresh() is a no-op (the client refreshes through /token)', async () => {
		await expect(withToken('AT', () => provider().refresh())).resolves.toBeUndefined();
	});

	it('invalidate() marks the request token rejected so the edge challenges the next request', async () => {
		resetSessionContext();
		expect(SessionContext.instance.isCreatioTokenRejected('AT')).toBe(false);
		await withToken('AT', () => provider().invalidate());
		expect(SessionContext.instance.isCreatioTokenRejected('AT')).toBe(true);
		expect(SessionContext.instance.isCreatioTokenRejected('OTHER')).toBe(false);
	});

	it('invalidate() without a request token does nothing', async () => {
		resetSessionContext();
		await expect(provider().invalidate()).resolves.toBeUndefined();
	});
});

describe('SessionContext rejected Creatio tokens', () => {
	it('evicts entries once their token has expired', () => {
		resetSessionContext();
		const sc = SessionContext.instance;
		sc.markCreatioTokenRejected('old', 1_000);
		sc.markCreatioTokenRejected('live', 5_000);
		expect(sc.evictRejectedCreatioTokens(2_000)).toBe(1);
		expect(sc.isCreatioTokenRejected('old')).toBe(false);
		expect(sc.isCreatioTokenRejected('live')).toBe(true);
	});
});
