import { FilterNode, ReadQuery } from '../contracts';

/** Suffix of the attachment entity Creatio pairs with an object (`Report` → `ReportFile`). */
const FILE_ENTITY_SUFFIX = 'File';

/** Thrown when an operation names an entity (or a column path into one) outside the allowlist. */
export class EntityAccessError extends Error {
	constructor(reason: string) {
		super(`entity_access_denied:${reason}`);
		this.name = 'EntityAccessError';
	}
}

/**
 * Entity allowlist (`CREATIO_MCP_ALLOWED_ENTITIES`). When configured, the CRUD and file engines
 * expose ONLY the listed objects plus their attachment companions (`<Entity>File`, so their files
 * can be listed and read). A read may not traverse a lookup into another object: column, filter
 * and order paths are limited to the entity's own columns, plus `<Lookup>.Id` (the foreign-key
 * value the record already holds). Matching is case-insensitive, like Creatio's schema names.
 *
 * An empty allowlist means unrestricted — every check is a no-op, so the default deployment is
 * unchanged.
 */
export class EntityAccessPolicy {
	private readonly _allowed: Map<string, string>;

	public get restricted(): boolean {
		return this._allowed.size > 0;
	}

	constructor(entities: readonly string[] = []) {
		this._allowed = new Map();
		for (const raw of entities) {
			const name = raw.trim();
			if (!name) {
				continue;
			}
			for (const entity of [name, name + FILE_ENTITY_SUFFIX]) {
				this._allowed.set(entity.toLowerCase(), entity);
			}
		}
	}

	/** Parses a comma-separated allowlist (env value); unset/blank ⇒ unrestricted. */
	public static fromList(value: string | undefined): EntityAccessPolicy {
		return new EntityAccessPolicy((value ?? '').split(','));
	}

	private _assertFilter(node: FilterNode): void {
		if (node.kind === 'group') {
			node.items.forEach((item) => this._assertFilter(item));
			return;
		}
		this._assertOwnPath(node.field);
	}

	/** `Name`, `OwnerId` and `Owner.Id` / `Owner/Id` stay on the record; `Owner.Name` does not. */
	private _assertOwnPath(path: string): void {
		const segments = path.split(/[./]/);
		const ownColumn = segments.length === 1;
		const foreignKey = segments.length === 2 && segments[1] === 'Id';
		if (!ownColumn && !foreignKey) {
			throw new EntityAccessError(`path:${path}`);
		}
	}

	public isAllowed(entity: string): boolean {
		return !this.restricted || this._allowed.has(entity.trim().toLowerCase());
	}

	public assertEntity(entity: string): void {
		if (!this.isAllowed(entity)) {
			throw new EntityAccessError(`entity:${entity}`);
		}
	}

	public filterEntities(entities: string[]): string[] {
		return this.restricted ? entities.filter((e) => this.isAllowed(e)) : entities;
	}

	/** Entity + every column/filter/order path the query touches; rejects OData escape hatches
	 *  whose contents cannot be inspected (raw `$filter`, `$expand`). */
	public assertRead(query: ReadQuery): void {
		if (!this.restricted) {
			return;
		}
		this.assertEntity(query.entity);
		if (query.odata?.rawFilter) {
			throw new EntityAccessError('raw_filter');
		}
		if (query.odata?.expand?.length) {
			throw new EntityAccessError('expand');
		}
		for (const column of query.columns ?? []) {
			this._assertOwnPath(column);
		}
		for (const term of query.order ?? []) {
			this._assertOwnPath(term.field);
		}
		if (query.filter) {
			this._assertFilter(query.filter);
		}
	}
}

/** Shared unrestricted instance (the default for engines built without an explicit env). */
export const UNRESTRICTED_ENTITY_ACCESS = new EntityAccessPolicy();
