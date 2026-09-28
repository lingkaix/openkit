import {
  WorkspaceDataSourceCatalogSchema,
  WorkspaceDataSourceSchema,
} from '@openkit/config-schema';

/** One ignored authored key and its JSON location, without its value. */
export interface UnknownConfigKey {
  key: string;
  path: string;
}

/** Authored files whose optional unknown fields have an explicit tolerance contract. */
export type TolerantConfigKind = 'server' | 'user' | 'workspace' | 'data-source';

/** Narrows a JSON object while excluding arrays and null. */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Appends one escaped object key to a JSON path. */
function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

/** Finds keys omitted by a tolerant schema at one object location. */
function strippedKeys(raw: unknown, parsed: unknown, path: string): UnknownConfigKey[] {
  const source = record(raw);
  const accepted = record(parsed);
  if (!source || !accepted) return [];
  return Object.keys(source)
    .filter((key) => !Object.hasOwn(accepted, key))
    .map((key) => ({ key, path: childPath(path, key) }));
}

/** Finds passthrough data-source keys outside the public schema shape. */
function keysOutside(raw: unknown, known: Set<string>, path: string): UnknownConfigKey[] {
  const source = record(raw);
  if (!source) return [];
  return Object.keys(source)
    .filter((key) => !known.has(key))
    .map((key) => ({ key, path: childPath(path, key) }));
}

/** Lists only keys tolerated by the four hand-written configuration readers after successful validation. */
export function unknownConfigKeys(
  kind: TolerantConfigKind,
  raw: unknown,
  parsed: unknown
): UnknownConfigKey[] {
  if (kind === 'data-source') {
    const catalog = record(raw);
    const keys = keysOutside(
      raw,
      new Set(Object.keys(WorkspaceDataSourceCatalogSchema.shape)),
      '$'
    );
    const sources = catalog?.sources;
    if (Array.isArray(sources)) {
      const knownSourceKeys = new Set(Object.keys(WorkspaceDataSourceSchema.shape));
      for (const [index, source] of sources.entries()) {
        keys.push(...keysOutside(source, knownSourceKeys, `$.sources[${index}]`));
      }
    }
    return keys;
  }

  const keys = strippedKeys(raw, parsed, '$');
  const source = record(raw);
  const accepted = record(parsed);
  if (kind === 'server' || !source || !accepted) return keys;

  if (kind === 'user') {
    const rawWorkspaces = source.workspaces;
    const parsedWorkspaces = accepted.workspaces;
    if (Array.isArray(rawWorkspaces) && Array.isArray(parsedWorkspaces)) {
      for (const [index, workspace] of rawWorkspaces.entries()) {
        const parsedWorkspace = parsedWorkspaces[index];
        const path = `$.workspaces[${index}]`;
        keys.push(...strippedKeys(workspace, parsedWorkspace, path));
        const rawRoles = record(workspace)?.internalRoles;
        const parsedRoles = record(parsedWorkspace)?.internalRoles;
        if (Array.isArray(rawRoles) && Array.isArray(parsedRoles)) {
          for (const [roleIndex, role] of rawRoles.entries()) {
            keys.push(
              ...strippedKeys(role, parsedRoles[roleIndex], `${path}.internalRoles[${roleIndex}]`)
            );
          }
        }
      }
    }
    return keys;
  }

  const rawRoles = record(source.workspace)?.internalRoles;
  const parsedRoles = record(accepted.workspace)?.internalRoles;
  if (Array.isArray(rawRoles) && Array.isArray(parsedRoles)) {
    for (const [index, role] of rawRoles.entries()) {
      keys.push(...strippedKeys(role, parsedRoles[index], `$.workspace.internalRoles[${index}]`));
    }
  }
  return keys;
}

/** Formats a warning with an escaped key and location, never an authored value. */
export function unknownConfigKeyMessage(key: UnknownConfigKey): string {
  return `Unknown configuration key ${JSON.stringify(key.key)} at ${key.path} was ignored.`;
}
