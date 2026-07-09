import type { AuthoredAgentConfig } from './manifest.js';

/**
 * Agent transport kind accepted by authored agent configs.
 */
export type AgentTransportKind = NonNullable<AuthoredAgentConfig['transport']>['kind'];

/**
 * Resolved agent transport with its source.
 */
export interface ResolvedAgentTransport {
  /** Effective transport kind. */
  kind: AgentTransportKind;
  /** Source of the effective transport kind. */
  origin: 'adapter-defaults' | 'agent-config';
}

/**
 * Resolves the effective transport for an authored agent config.
 *
 * @param config Authored agent config.
 * @returns Effective transport and origin.
 * @throws Error when no adapter default exists or an explicit override is unsupported.
 */
export function resolveAgentTransport(config: AuthoredAgentConfig): ResolvedAgentTransport {
  const supported = supportedTransportsFor(config);

  if (supported.length === 0) {
    throw new Error(
      `No transport default is registered for agent runtime ${config.runtime.kind}/${config.runtime.adapter}/${config.mode}.`
    );
  }

  const explicit = config.transport?.kind;

  if (!explicit) {
    const defaultKind = supported[0];

    if (!defaultKind) {
      throw new Error(
        `No transport default is registered for agent runtime ${config.runtime.kind}/${config.runtime.adapter}/${config.mode}.`
      );
    }

    return { kind: defaultKind, origin: 'adapter-defaults' };
  }

  if (!supported.includes(explicit)) {
    throw new Error(
      `Unsupported transport override "${explicit}" for agent runtime ${config.runtime.kind}/${config.runtime.adapter}/${config.mode}. Supported transports: ${supported.join(', ')}.`
    );
  }

  return { kind: explicit, origin: 'agent-config' };
}

/**
 * Lists supported transports for the known runtime, adapter, and mode combination.
 *
 * @param config Authored agent config.
 * @returns Supported transport kinds in default-preference order.
 */
function supportedTransportsFor(config: AuthoredAgentConfig): AgentTransportKind[] {
  if (
    config.runtime.kind === 'codex' &&
    config.runtime.adapter === 'codex-app-server' &&
    config.mode === 'local'
  ) {
    return ['stdio'];
  }

  if (
    config.runtime.kind === 'opencode' &&
    config.runtime.adapter === 'opencode-server' &&
    config.mode === 'local'
  ) {
    return ['http'];
  }

  if (config.mode === 'a2a') {
    return ['a2a'];
  }

  if (config.mode === 'remote') {
    return ['http', 'websocket'];
  }

  if (config.runtime.kind === 'custom' && config.mode === 'local') {
    return ['http', 'websocket'];
  }

  return [];
}
