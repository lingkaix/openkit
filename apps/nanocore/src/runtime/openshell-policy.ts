import { OPENKIT_WORKER_CONTROL_POST_PATHS } from '@openkit/config-schema';
import { assertOpenShellPolicyConformant } from '@openkit/openshell-schema-snapshot';

/**
 * Input used to render an OpenShell sandbox policy for direct OpenKit worker control.
 */
export interface RenderOpenShellWorkerPolicyInput {
  /** Additional filesystem grants derived from the Agent Environment Package policy. */
  additionalFilesystemGrants?: OpenShellFilesystemGrant[] | undefined;
  /** Additional outbound endpoints allowed for selected worker binaries. */
  additionalNetworkEndpoints?: OpenShellNetworkEndpoint[] | undefined;
  /** Direct NanoCore Worker Control Gateway URL. */
  controlBaseUrl: string;
  /** Executable paths allowed to use the worker control endpoint. */
  binaries: string[];
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
  binaries: string[];
  /** Hostname or address allowed by the endpoint. */
  host: string;
  /** Stable policy entry name. */
  name: string;
  /** TCP port allowed by the endpoint. */
  port: number;
  /** Endpoint protocol label understood by OpenShell. */
  protocol?: string | undefined;
  /** Exact POST requests allowed instead of a broad access preset. */
  rules?: Array<{
    /** HTTP method allowed by the rule. */
    method: 'POST';
    /** Exact absolute HTTP path allowed by the rule. */
    path: string;
  }>;
}

/**
 * Renders the OpenShell policy schema accepted by the installed distribution.
 *
 * @param input Direct worker control target.
 * @returns YAML policy text for `openshell sandbox create --policy`.
 */
export function renderOpenShellWorkerPolicy(input: RenderOpenShellWorkerPolicyInput): string {
  const endpoint = resolveControlEndpoint(input.controlBaseUrl);
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
    '  openkit_worker_control:',
    '    name: openkit_worker_control',
    '    binaries:',
    ...input.binaries.map((binary) => `      - path: ${binary}`),
    '    endpoints:',
    `      - host: ${endpoint.host}`,
    `        port: ${endpoint.port}`,
    '        protocol: rest',
    '        enforcement: enforce',
    '        rules:',
    ...OPENKIT_WORKER_CONTROL_POST_PATHS.flatMap((path) => [
      '          - allow:',
      '              method: POST',
      `              path: ${path}`,
    ]),
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

  const protocol = entry.protocol ?? 'rest';
  const access = entry.access ?? 'read-only';
  const rules = entry.rules ?? [];

  if (rules.length > 0 && entry.access) {
    throw new Error('OpenShell network endpoint cannot combine access with exact REST rules.');
  }
  if (rules.length > 0 && protocol !== 'rest') {
    throw new Error('OpenShell exact HTTP rules require the rest protocol.');
  }
  for (const rule of rules) {
    if (rule.method !== 'POST') {
      throw new Error('OpenShell worker inference rules only support POST.');
    }
    if (!rule.path.startsWith('/') || /[\r\n*?]/.test(rule.path)) {
      throw new Error('OpenShell exact REST rule paths must be absolute and contain no globs.');
    }
  }

  return [
    `  ${entry.name}:`,
    `    name: ${entry.name}`,
    '    binaries:',
    ...entry.binaries.map((binary) => `      - path: ${binary}`),
    '    endpoints:',
    `      - host: ${entry.host}`,
    `        port: ${entry.port}`,
    `        protocol: ${protocol}`,
    '        enforcement: enforce',
    ...(rules.length > 0
      ? [
          '        rules:',
          ...rules.flatMap((rule) => [
            '          - allow:',
            `              method: ${rule.method}`,
            `              path: ${rule.path}`,
          ]),
        ]
      : [`        access: ${access}`]),
  ];
}

/**
 * Resolves an HTTP URL into the host and port OpenShell policy expects.
 *
 * @param controlBaseUrl Direct worker control URL.
 * @returns Host and numeric port.
 * @throws Error when the URL is not HTTP(S).
 */
function resolveControlEndpoint(controlBaseUrl: string): { host: string; port: number } {
  const url = new URL(controlBaseUrl);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenShell worker control endpoint must be an HTTP or HTTPS URL.');
  }

  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? '443' : '80')),
  };
}
