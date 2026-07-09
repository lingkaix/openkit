import { assertOpenShellPolicyConformant } from '@openkit/openshell-schema-snapshot';

/**
 * Input used to render an OpenShell sandbox policy for the OpenKit worker relay.
 */
export interface RenderOpenShellWorkerPolicyInput {
  /** Additional filesystem grants derived from the Agent Environment Package policy. */
  additionalFilesystemGrants?: OpenShellFilesystemGrant[] | undefined;
  /** Additional outbound endpoints allowed for selected worker binaries. */
  additionalNetworkEndpoints?: OpenShellNetworkEndpoint[] | undefined;
  /** NanoCore Worker Control Gateway relay upstream URL. */
  relayUpstream: string;
  /** Executable paths allowed to use the worker control relay endpoint. */
  binaries?: string[] | undefined;
}

/**
 * OpenShell filesystem grant allowed by the generated worker policy.
 */
export interface OpenShellFilesystemGrant {
  /** Filesystem access mode granted for the sandbox path. */
  access: 'read-only' | 'read-write';
  /** Worker-visible sandbox path to allow. */
  path: string;
}

/**
 * OpenShell network endpoint allowed by the generated worker policy.
 */
export interface OpenShellNetworkEndpoint {
  /** Access mode granted by OpenShell for the endpoint. */
  access?: 'read-only' | 'read-write' | undefined;
  /** Executable paths allowed to use this endpoint. */
  binaries?: string[] | undefined;
  /** Hostname or address allowed by the endpoint. */
  host: string;
  /** Stable policy entry name. */
  name: string;
  /** TCP port allowed by the endpoint. */
  port: number;
  /** Endpoint protocol label understood by OpenShell. */
  protocol?: string | undefined;
}

/**
 * Renders the OpenShell policy schema accepted by the installed distribution.
 *
 * @param input Worker relay target.
 * @returns YAML policy text for `openshell sandbox create --policy`.
 */
export function renderOpenShellWorkerPolicy(input: RenderOpenShellWorkerPolicyInput): string {
  const endpoint = resolveRelayEndpoint(input.relayUpstream);
  const binaries = input.binaries ?? [
    '/usr/local/bin/node',
    '/usr/local/bin/openkit-worker-sidecar',
  ];
  const additionalNetworkPolicies = (input.additionalNetworkEndpoints ?? []).flatMap((entry) =>
    renderNetworkPolicyEntry(entry)
  );
  const additionalReadOnlyPaths = (input.additionalFilesystemGrants ?? [])
    .filter((grant) => grant.access === 'read-only')
    .map((grant) => renderFilesystemGrantPath(grant));
  const additionalReadWritePaths = (input.additionalFilesystemGrants ?? [])
    .filter((grant) => grant.access === 'read-write')
    .map((grant) => renderFilesystemGrantPath(grant));

  const policy = [
    'version: 1',
    'filesystem_policy:',
    '  include_workdir: true',
    '  read_only:',
    '    - /usr',
    '    - /lib',
    '    - /proc',
    '    - /dev/urandom',
    '    - /app',
    '    - /etc',
    '    - /var/log',
    ...additionalReadOnlyPaths,
    '  read_write:',
    '    - /sandbox',
    '    - /tmp',
    '    - /dev/null',
    ...additionalReadWritePaths,
    'landlock:',
    '  compatibility: best_effort',
    'process:',
    '  run_as_user: sandbox',
    '  run_as_group: sandbox',
    'network_policies:',
    '  openkit_worker_control_relay:',
    '    name: openkit_worker_control_relay',
    '    binaries:',
    ...binaries.map((binary) => `      - path: ${binary}`),
    '    endpoints:',
    `      - host: ${endpoint.host}`,
    `        port: ${endpoint.port}`,
    '        protocol: rest',
    '        enforcement: enforce',
    '        access: read-write',
    ...additionalNetworkPolicies,
    '',
  ].join('\n');

  assertOpenShellPolicyConformant(policy);

  return policy;
}

/**
 * Renders one filesystem grant path and rejects paths OpenShell cannot enforce.
 *
 * @param grant Filesystem grant declaration.
 * @returns YAML list item for the filesystem policy.
 * @throws Error when the path is not absolute.
 */
function renderFilesystemGrantPath(grant: OpenShellFilesystemGrant): string {
  if (!grant.path.startsWith('/')) {
    throw new Error('OpenShell additional filesystem grant path must be absolute.');
  }

  return `    - ${grant.path}`;
}

/**
 * Renders one additional OpenShell network policy entry.
 *
 * @param entry Endpoint declaration.
 * @returns YAML lines for the endpoint.
 * @throws Error when the declaration is not valid.
 */
function renderNetworkPolicyEntry(entry: OpenShellNetworkEndpoint): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
    throw new Error('OpenShell additional network endpoint name must be an identifier.');
  }

  if (!entry.host.trim()) {
    throw new Error('OpenShell additional network endpoint host is required.');
  }

  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
    throw new Error('OpenShell additional network endpoint port must be between 1 and 65535.');
  }

  const binaries = entry.binaries ?? [
    '/usr/bin/git',
    '/usr/bin/curl',
    '/usr/local/bin/codex',
    '/usr/local/lib/codex/codex/codex',
    '/usr/lib/git-core/git-remote-http',
    '/usr/lib/git-core/git-remote-https',
  ];
  const protocol = entry.protocol ?? 'rest';
  const access = entry.access ?? 'read-only';

  return [
    `  ${entry.name}:`,
    `    name: ${entry.name}`,
    '    binaries:',
    ...binaries.map((binary) => `      - path: ${binary}`),
    '    endpoints:',
    `      - host: ${entry.host}`,
    `        port: ${entry.port}`,
    `        protocol: ${protocol}`,
    '        enforcement: enforce',
    `        access: ${access}`,
  ];
}

/**
 * Resolves an HTTP URL into the host and port OpenShell policy expects.
 *
 * @param relayUpstream Relay upstream URL.
 * @returns Host and numeric port.
 * @throws Error when the URL is not HTTP(S).
 */
function resolveRelayEndpoint(relayUpstream: string): { host: string; port: number } {
  const url = new URL(relayUpstream);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenShell worker relay upstream must be an HTTP or HTTPS URL.');
  }

  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? '443' : '80')),
  };
}
