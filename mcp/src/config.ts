import { type NanoCoreCredentialStore, normalizeStoredNanoCoreToken } from './credential-store.js';
import type { CreateNanoCoreClientOptions } from './nanocore-client.js';

/** Environment used to configure the OpenKit AI Interface process. */
export type OpenKitAiInterfaceEnv = Partial<
  Record<'OPENKIT_NANOCORE_TOKEN' | 'OPENKIT_NANOCORE_URL', string>
>;

/** Options for creating NanoCore client configuration. */
export interface CreateNanoCoreClientOptionsFromEnvOptions {
  /** Optional desktop credential store used when no token env var is present. */
  credentialStore?: NanoCoreCredentialStore;
}

/**
 * Creates NanoCore client options from process environment variables.
 *
 * @param env Environment variable map.
 * @returns NanoCore client options for the MCP server.
 */
export function createNanoCoreClientOptionsFromEnv(
  env: OpenKitAiInterfaceEnv,
  options: CreateNanoCoreClientOptionsFromEnvOptions = {}
): CreateNanoCoreClientOptions {
  const baseUrl = env.OPENKIT_NANOCORE_URL ?? 'http://127.0.0.1:3000';
  const headers = createNanoCoreHeadersFromEnv(env, baseUrl, options.credentialStore);

  return {
    baseUrl,
    ...(headers === undefined ? {} : { headers }),
  };
}

/**
 * Creates remote NanoCore auth headers from supported environment variables.
 *
 * @param env Environment variable map.
 * @param baseUrl NanoCore endpoint lookup key.
 * @param credentialStore Optional desktop credential store.
 * @returns Static request headers, or undefined for unauthenticated local mode.
 */
function createNanoCoreHeadersFromEnv(
  env: OpenKitAiInterfaceEnv,
  baseUrl: string,
  credentialStore?: NanoCoreCredentialStore
): HeadersInit | undefined {
  const token =
    normalizedEnvValue(env.OPENKIT_NANOCORE_TOKEN) ??
    normalizeStoredNanoCoreToken(credentialStore?.readNanoCoreToken({ baseUrl }));

  return token
    ? {
        authorization: `Bearer ${token}`,
        'x-openkit-client-channel': 'mcp',
        'x-openkit-client-source': 'desktop-agent',
      }
    : undefined;
}

/**
 * Normalizes an optional environment variable value.
 *
 * @param value Environment variable value.
 * @returns Trimmed value or undefined when empty.
 */
function normalizedEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
