/**
 * Config kinds represented by schema and policy catalogs.
 */
export type ConfigCatalogKind =
  | 'server'
  | 'gateway'
  | 'internal-role'
  | 'provider'
  | 'agent'
  | 'workspace'
  | 'data-source'
  | 'mcp-server'
  | 'user'
  | 'effective';

/**
 * Config policy catalog entry served to tools and UI.
 */
export interface ConfigPolicyCatalogEntry {
  /** Config kind that owns this path. */
  kind: ConfigCatalogKind;
  /** JSON path for the governed field. */
  path: string;
  /** Config layer that owns the field. */
  owner: 'server' | 'workspace' | 'user' | 'request';
  /** Merge policy used by the effective-config resolver. */
  merge: 'replace' | 'deep-merge' | 'append' | 'intersection' | 'deny-wins' | 'min-privilege';
  /** Workspace override rule. */
  workspaceOverride: 'allowed' | 'restrict-only' | 'forbidden';
  /** Future user override rule. */
  userOverride: 'allowed' | 'within-workspace-policy' | 'restrict-only' | 'forbidden';
  /** Request override rule. */
  requestOverride: 'allowed' | 'within-effective-policy' | 'forbidden';
  /** Runtime reload class. */
  reloadClass: 'hot-swappable' | 'session-scoped' | 'restart-required';
  /** Secret handling policy. */
  secretPolicy: 'no-secret' | 'secret-ref-only';
  /** Human-readable entry summary. */
  summary: string;
}

const POLICY_CATALOG: ConfigPolicyCatalogEntry[] = [
  {
    kind: 'server',
    path: '$.server',
    owner: 'server',
    merge: 'replace',
    workspaceOverride: 'forbidden',
    userOverride: 'forbidden',
    requestOverride: 'forbidden',
    reloadClass: 'restart-required',
    secretPolicy: 'no-secret',
    summary: 'Server networking and process configuration is server-owned.',
  },
  {
    kind: 'server',
    path: '$.nanohost',
    owner: 'server',
    merge: 'replace',
    workspaceOverride: 'forbidden',
    userOverride: 'forbidden',
    requestOverride: 'forbidden',
    reloadClass: 'restart-required',
    secretPolicy: 'no-secret',
    summary:
      'NanoHost identity, rendezvous endpoint, and non-secret credential reference are server-owned and restart-required.',
  },

  {
    kind: 'provider',
    path: '$',
    owner: 'server',
    merge: 'replace',
    workspaceOverride: 'forbidden',
    userOverride: 'forbidden',
    requestOverride: 'forbidden',
    reloadClass: 'restart-required',
    secretPolicy: 'secret-ref-only',
    summary: 'Provider profile changes take effect after restart.',
  },
  {
    kind: 'gateway',
    path: '$',
    owner: 'server',
    merge: 'replace',
    workspaceOverride: 'allowed',
    userOverride: 'allowed',
    requestOverride: 'allowed',
    reloadClass: 'hot-swappable',
    secretPolicy: 'no-secret',
    summary:
      'Gateway logical models and private ordered routes are Server resources selected by higher scopes.',
  },
  {
    kind: 'internal-role',
    path: '$',
    owner: 'server',
    merge: 'replace',
    workspaceOverride: 'allowed',
    userOverride: 'allowed',
    requestOverride: 'allowed',
    reloadClass: 'session-scoped',
    secretPolicy: 'no-secret',
    summary:
      'Internal-role profiles are Server supply with Workspace and User preference composition.',
  },
  {
    kind: 'agent',
    path: '$',
    owner: 'server',
    merge: 'replace',
    workspaceOverride: 'forbidden',
    userOverride: 'forbidden',
    requestOverride: 'forbidden',
    reloadClass: 'restart-required',
    secretPolicy: 'no-secret',
    summary: 'Agent config changes take effect after restart.',
  },
  {
    kind: 'workspace',
    path: '$.workspace.roots',
    owner: 'workspace',
    merge: 'replace',
    workspaceOverride: 'allowed',
    userOverride: 'forbidden',
    requestOverride: 'forbidden',
    reloadClass: 'session-scoped',
    secretPolicy: 'no-secret',
    summary: 'Workspace roots define host-local directories for new worker sessions.',
  },
  {
    kind: 'user',
    path: '$.workspaces',
    owner: 'user',
    merge: 'replace',
    workspaceOverride: 'forbidden',
    userOverride: 'allowed',
    requestOverride: 'allowed',
    reloadClass: 'hot-swappable',
    secretPolicy: 'no-secret',
    summary: 'Personal per-Workspace Agent, profile, logical-model, and internal-role preferences.',
  },
  {
    kind: 'data-source',
    path: '$.sources',
    owner: 'workspace',
    merge: 'replace',
    workspaceOverride: 'allowed',
    userOverride: 'forbidden',
    requestOverride: 'forbidden',
    reloadClass: 'session-scoped',
    secretPolicy: 'secret-ref-only',
    summary: 'Workspace data sources declare non-secret locators and vault grant references.',
  },
  {
    kind: 'mcp-server',
    path: '$.servers',
    owner: 'workspace',
    merge: 'replace',
    workspaceOverride: 'allowed',
    userOverride: 'forbidden',
    requestOverride: 'forbidden',
    reloadClass: 'session-scoped',
    secretPolicy: 'secret-ref-only',
    summary: 'Workspace MCP servers declare governed transports, tool rules, and Vault grants.',
  },
];

/**
 * Returns the config policy catalog.
 *
 * @returns Immutable policy catalog entries.
 */
export function getConfigPolicyCatalog(): readonly ConfigPolicyCatalogEntry[] {
  return POLICY_CATALOG;
}
