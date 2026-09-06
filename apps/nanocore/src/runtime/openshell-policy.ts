/**
 * Input used to project one OpenShell sandbox policy from resolved AEP grants.
 */
export interface ProjectOpenShellWorkerPolicyInput {
  /** Additional filesystem grants derived from the Agent Environment Package policy. */
  additionalFilesystemGrants?: OpenShellFilesystemGrant[] | undefined;
  /** Additional outbound endpoints allowed for selected worker binaries. */
  additionalNetworkEndpoints?: OpenShellNetworkEndpoint[] | undefined;
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
  /** Bounded HTTP requests allowed instead of a broad access preset. */
  rules?: Array<{
    /** HTTP method allowed by the rule. */
    method: 'GET' | 'POST';
    /** Absolute HTTP path or OpenShell path pattern allowed by the rule. */
    path: string;
  }>;
}

/**
 * Validates OpenKit-authored grants and projects the structured sandbox policy consumed by NanoHost.
 *
 * @param input Resolved filesystem and network grants.
 * @returns Structured policy accepted by the NanoHost carriage boundary.
 * @throws Error when OpenKit-authored policy cannot be represented by the supported boundary.
 */
export function projectOpenShellWorkerPolicy(input: ProjectOpenShellWorkerPolicyInput) {
  const filesystemGrants = input.additionalFilesystemGrants ?? [];
  for (const grant of filesystemGrants) {
    if (!grant.path.startsWith('/') || /[\r\n\0]/.test(grant.path)) {
      throw new Error('OpenShell additional filesystem grant path must be absolute.');
    }
  }

  const networkPolicies = Object.fromEntries(
    (input.additionalNetworkEndpoints ?? []).map((entry) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
        throw new Error('OpenShell additional network endpoint name must be an identifier.');
      }
      if (!entry.host.trim() || /[\r\n\0]/.test(entry.host)) {
        throw new Error('OpenShell additional network endpoint host is required.');
      }
      if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
        throw new Error('OpenShell additional network endpoint port must be between 1 and 65535.');
      }

      const protocol = entry.protocol ?? 'rest';
      const rules = entry.rules ?? [];
      if (protocol !== 'rest') {
        throw new Error('OpenShell additional network endpoint protocol must be rest.');
      }
      if (
        entry.binaries.length === 0 ||
        entry.binaries.some((path) => path.length === 0 || /[\r\n\0]/.test(path))
      ) {
        throw new Error('OpenShell additional network endpoint requires non-empty binary paths.');
      }
      if (rules.length > 0 && entry.access) {
        throw new Error('OpenShell network endpoint cannot combine access with exact REST rules.');
      }
      if (entry.access && entry.access !== 'read-only' && entry.access !== 'read-write') {
        throw new Error('OpenShell network endpoint access must be read-only or read-write.');
      }
      for (const rule of rules) {
        if (rule.method !== 'GET' && rule.method !== 'POST') {
          throw new Error('OpenShell exact REST rules only support GET or POST.');
        }
        if (!rule.path.startsWith('/') || /[\r\n\0]/.test(rule.path)) {
          throw new Error(
            'OpenShell exact REST rule paths must be absolute and contain no line breaks.'
          );
        }
      }

      return [
        entry.name,
        {
          binaries: entry.binaries.map((path) => ({ path })),
          endpoints: [
            {
              ...(rules.length > 0
                ? { rules: rules.map((rule) => ({ allow: { ...rule } })) }
                : { access: entry.access ?? 'read-only' }),
              enforcement: 'enforce',
              host: entry.host,
              port: entry.port,
              protocol,
            },
          ],
          name: entry.name,
        },
      ];
    })
  );

  return {
    filesystem: {
      includeWorkdir: true,
      readOnly: [
        '/usr',
        '/lib',
        '/proc',
        '/dev/urandom',
        '/app',
        '/etc',
        '/var/log',
        ...filesystemGrants
          .filter((grant) => grant.access === 'read-only')
          .map((grant) => grant.path),
      ],
      readWrite: [
        '/sandbox',
        '/tmp',
        '/dev/null',
        ...filesystemGrants
          .filter((grant) => grant.access === 'read-write')
          .map((grant) => grant.path),
      ],
    },
    landlock: { compatibility: 'best_effort' },
    networkMiddlewares: {},
    networkPolicies,
    process: { runAsGroup: 'sandbox', runAsUser: 'sandbox' },
    version: 1,
  };
}
