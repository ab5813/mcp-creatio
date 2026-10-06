import log from '../../log';

import { EntityAccessPolicy, UNRESTRICTED_ENTITY_ACCESS } from './entity-access';

export interface CreatioEngine {
	readonly name: string;
}

/**
 * Domain-level cross-cutting context shared by every engine. It lives ABOVE the
 * provider interface so the behaviour is written once and applies uniformly to every
 * CRUD backend (OData today, DataService next). Two concerns live here:
 *
 * - `readonly` — a defense-in-depth guard. The MCP layer already avoids registering
 *   mutating tools in readonly mode; this guarantees a mutation throws even if some
 *   future caller reaches an engine directly.
 * - `audit` — a security-relevant trail for every mutation, independent of transport.
 * - `entityAccess` — the optional entity allowlist enforced by the CRUD and file engines.
 */
export interface EngineEnv {
	readonly readonly: boolean;
	audit(action: string, details?: Record<string, unknown>): void;
	/** Entity allowlist; absent ⇒ unrestricted. */
	readonly entityAccess?: EntityAccessPolicy;
}

/** Thrown when a mutating engine operation is attempted while `readonly` is on. */
export class ReadonlyModeError extends Error {
	public readonly action: string;

	constructor(action: string) {
		super(`readonly_mode_blocked:${action}`);
		this.name = 'ReadonlyModeError';
		this.action = action;
	}
}

/** Default env: mutations allowed, audit → structured info log. Used when an engine is
 *  built without an explicit env (keeps direct construction in tests effortless). */
export const DEFAULT_ENGINE_ENV: EngineEnv = {
	readonly: false,
	audit: (action, details) => log.audit(action, details),
};

/**
 * Base for engines. Holds the shared {@link EngineEnv} and centralizes the readonly
 * guard + audit trail for mutating operations so concrete engines never repeat it and
 * the providers below stay free of cross-cutting policy.
 */
export abstract class BaseEngine implements CreatioEngine {
	public abstract readonly name: string;

	protected readonly _env: EngineEnv;

	protected get _entityAccess(): EntityAccessPolicy {
		return this._env.entityAccess ?? UNRESTRICTED_ENTITY_ACCESS;
	}

	constructor(env: EngineEnv = DEFAULT_ENGINE_ENV) {
		this._env = env;
	}

	/** Guard (readonly) + audit a mutating operation, then run it. Always returns a
	 *  promise (a readonly violation surfaces as a rejection, never a synchronous throw)
	 *  so callers can rely on a single `.catch`/`await` path. */
	protected async _mutate<T>(
		action: string,
		details: Record<string, unknown>,
		run: () => Promise<T>,
	): Promise<T> {
		if (this._env.readonly) {
			throw new ReadonlyModeError(action);
		}
		// Record the attempt up front (so a mutation is auditable even if it then throws), and add a
		// distinct outcome record on failure so the trail distinguishes attempted-vs-failed mutations.
		this._env.audit(action, details);
		try {
			return await run();
		} catch (err) {
			this._env.audit(`${action}.failed`, {
				...details,
				error: String((err as Error)?.message ?? err),
			});
			throw err;
		}
	}
}
