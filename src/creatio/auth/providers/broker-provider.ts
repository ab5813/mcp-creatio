import log from '../../../log';
import { SessionContext } from '../../../sessions';
import { getEffectiveUserKey, getInjectedCredential } from '../../../utils';
import { BrokerAuthConfig } from '../../client-config';
import { buildHeaders } from '../auth';

import { BaseProvider } from './base-provider';

/**
 * Runtime auth provider for `broker` mode. The broker edge has already verified the client's token
 * and opened the Creatio access token sealed inside it; it arrives here as the request's injected
 * credential. This provider only attaches it — it holds no tokens and never refreshes on its own:
 * the client refreshes through the broker's `/token`, which is where the Creatio refresh token lives.
 */
export class BrokerProvider extends BaseProvider<BrokerAuthConfig> {
	private readonly _session = SessionContext.instance;

	private _currentToken(): string | undefined {
		const credential = getInjectedCredential();
		return credential?.kind === 'bearer' ? credential.token : undefined;
	}

	public async getHeaders(accept: string, isJson?: boolean): Promise<Record<string, string>> {
		const token = this._currentToken();
		if (!token) {
			throw new Error('broker_not_authorized');
		}
		return buildHeaders(accept, Boolean(isJson), token);
	}

	/** No server-side refresh: the Creatio refresh token travels with the client's refresh token, so
	 *  a mid-request 401 is answered by {@link invalidate} and the client's next request refreshes. */
	public async refresh(): Promise<void> {
		// Intentionally empty.
	}

	/** Creatio rejected a Creatio token that had not expired yet (revoked upstream): mark it so the
	 *  edge answers the next request with `401 invalid_token` and the client refreshes / re-auths. */
	public async invalidate(): Promise<void> {
		const token = this._currentToken();
		if (!token) {
			return;
		}
		log.warn('broker.creatio.token_rejected', { userKey: getEffectiveUserKey() });
		// No broker access token lives longer than an hour, so after that this Creatio token can no
		// longer be presented and the entry is safe to drop.
		this._session.markCreatioTokenRejected(token, Date.now() + 60 * 60 * 1000);
	}
}
