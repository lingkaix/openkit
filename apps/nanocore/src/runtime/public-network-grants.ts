import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import {
  resolveProviderSubscriptionFamily,
  type WorkerSandboxAccess,
  WorkerSandboxAccessSchema,
  WorkerSandboxNetworkGrantSchema,
  type WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import { type ResolvedAgentManifest, resolveAgentSetup } from '../agents/setup-resolver.js';
import type { ProviderProfile } from '../config/providers-loader.js';
import { createDefaultPiAiGatewayModels } from '../llm/pi-ai-client.js';
import { normalizeProviderId, type ProviderRegistry } from '../providers/registry.js';
import { OPENKIT_GENERATIVE_MCP_ID } from './openkit-generative-mcp.js';
import { OPENKIT_REPOSITORY_MCP_ID } from './openkit-repository-mcp.js';

/** Current authoritative destination facts used only for public grant admission. */
export interface PublicNetworkDestinationFacts {
  /** Complete configured Provider registry, including disabled profiles. */
  readonly providerRegistry: ProviderRegistry;
  /** Current Gateway and control route hosts from deployment configuration. */
  readonly controlHosts: readonly string[];
  /** Current selected managed MCP destination declarations. */
  readonly mcpCatalog?: WorkspaceMcpServerCatalog;
}

/** Classifies exact public grants before credentials or backend effects. */
export function assertPublicNetworkGrants(
  manifest: Pick<ResolvedAgentManifest, 'sandbox' | 'mcp'>,
  facts: PublicNetworkDestinationFacts
): void {
  const grants = WorkerSandboxAccessSchema.parse({
    network: (manifest.sandbox?.network ?? []).map((grant) =>
      'publicAccess' in grant && grant.publicAccess !== undefined
        ? { ...grant, host: canonicalPublicNetworkHost(grant.host) }
        : grant
    ),
  }).network;
  const publicGrants = grants.filter((grant) => 'publicAccess' in grant && grant.publicAccess);
  if (publicGrants.length === 0) return;
  const providerHosts = new Map(
    facts.providerRegistry.list().map((profile) => [profile.id, providerDestinationHost(profile)])
  );
  const excludedHosts = new Set([
    ...providerHosts.values(),
    ...facts.controlHosts.map(canonicalPublicNetworkHost),
  ]);

  // Only Provider attachments carry a destination association in the current credential shape.
  // Runtime env/file declarations carry sinks, not evidence about where their values are used.
  const credentialHosts = (manifest.sandbox?.credentialDeclarations ?? []).flatMap(
    (declaration) => {
      if (declaration.visibility !== 'sandbox-provider') return [];
      const host = providerHosts.get(declaration.provider.profileId);
      if (!host) throw new Error('Public network credential destination metadata is unavailable.');
      return [host];
    }
  );
  const managedDestinations = (manifest.mcp ?? []).flatMap((selection) => {
    const server = facts.mcpCatalog?.servers.find((candidate) => candidate.id === selection.id);
    // These built-in routes have no external destination; their capability authority stays mediated.
    if (selection.id === OPENKIT_REPOSITORY_MCP_ID || selection.id === OPENKIT_GENERATIVE_MCP_ID)
      return [];
    if (!server || !server.enabled)
      throw new Error('Public network managed destination metadata is unavailable.');
    if (server.transport.kind !== 'http') return [];
    const url = new URL(server.transport.endpoint);
    return [
      {
        host: canonicalPublicNetworkHost(url.hostname),
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      },
    ];
  });

  for (const grant of publicGrants) {
    const host = canonicalPublicNetworkHost(grant.host);
    if (credentialHosts.includes(host)) {
      throw new Error('Public network destination has a platform credential attachment.');
    }
    if (excludedHosts.has(host)) {
      throw new Error('Public network destination is an excluded Provider or control host.');
    }
    if (
      managedDestinations.some(
        (destination) => destination.host === host && destination.port === grant.port
      )
    ) {
      throw new Error('Public network destination requires managed Gateway mediation.');
    }
    for (const other of grants) {
      if (other.id === grant.id) continue;
      if (canonicalPublicNetworkHost(other.host) !== host || other.port !== grant.port) continue;
      if (!other.binaries.some((binary) => grant.binaries.includes(binary))) continue;
      const publicRules = 'rules' in grant ? grant.rules! : [];
      const overlaps = publicRules.some((rule) => {
        if (!other.rules) return other.access === 'read-write' || rule.method === 'GET';
        return other.rules.some(
          (candidate) =>
            candidate.method === rule.method && publicPathsMayOverlap(rule.path, candidate.path)
        );
      });
      if (overlaps) throw new Error('Public network destination has overlapping effective grants.');
    }
  }
}

/** Canonical URL host identity, without accepting a URL, authority, path or wildcard as a host. */
export function canonicalPublicNetworkHost(host: string): string {
  const text = host.trim().toLowerCase().replace(/\.$/, '');
  if (
    !text ||
    /[\s/@?#*\\]/.test(text) ||
    [...text].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Public network host metadata is invalid.');
  const address = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const ipv6 = isIP(address) === 6;
  const authority = ipv6 ? `[${address}]` : text;
  const url = new URL(`https://${authority}`);
  if (url.port || (url.hostname !== authority && !ipv6 && text.includes(':')))
    throw new Error('Public network host metadata is invalid.');
  // IPv4-mapped IPv6 addresses carry the same destination authority as their IPv4 address.
  const mapped = /^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/.exec(url.hostname);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return url.hostname.replace(/\.$/, '');
}

/** Resolves endpoint identity from configured URL or the existing native Provider metadata. */
function providerDestinationHost(profile: ProviderProfile): string {
  const models = createDefaultPiAiGatewayModels();
  const subscriptionFamily = resolveProviderSubscriptionFamily(profile);
  const adapter = subscriptionFamily ?? normalizeProviderId(profile.vendor ?? profile.id);
  if (adapter === 'openai-codex') models.setProvider(openaiCodexProvider());
  const baseUrl = profile.baseUrl ?? models.getProvider(adapter)?.baseUrl;
  if (!baseUrl) throw new Error('Public network Provider destination metadata is unavailable.');
  return canonicalPublicNetworkHost(new URL(baseUrl).hostname);
}

/** Proves disjoint literal prefixes; unsupported pattern intersection fails closed locally. */
function publicPathsMayOverlap(left: string, right: string): boolean {
  if (/[?[\]{}\\]/.test(left + right)) return true;
  if (!left.includes('*') && !right.includes('*')) return left === right;
  const leftPrefix = left.split('*')[0]!;
  const rightPrefix = right.split('*')[0]!;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

/** Network grant shape shared with authored and resolved exact policy. */
export type PublicNetworkGrant = WorkerSandboxAccess['network'][number];

/** Live configuration fields needed for current public-route eligibility, never AEP payload. */
export type PublicNetworkConfiguration = Pick<
  import('../config/runtime-config.js').RuntimeConfigSnapshot,
  | 'agentManifests'
  | 'gatewayConfig'
  | 'providerRegistry'
  | 'openKitConfig'
  | 'workspaceConfigs'
  | 'workspaceMcpServerCatalogs'
>;

/** Revalidates captured public grants against the currently composed setup and route metadata. */
export function assertCurrentPublicNetworkGrants(
  input: {
    readonly agentId: string;
    readonly profileId: string | null;
    readonly logicalModelId: string;
    readonly workspaceId: string;
    readonly sandbox: NonNullable<ResolvedAgentManifest['sandbox']>;
    readonly mcp: ResolvedAgentManifest['mcp'];
  },
  current: PublicNetworkConfiguration
): void {
  const authored = current.agentManifests.find((manifest) => manifest.id === input.agentId);
  if (!authored) throw new Error('Public network current Agent authority is unavailable.');
  const workspaceConfig = current.workspaceConfigs.find(
    (entry) => entry.workspaceId === input.workspaceId
  )?.config;
  const resolved = resolveAgentSetup(authored, {
    gatewayConfig: current.gatewayConfig,
    providerRegistry: current.providerRegistry,
    selectedProfileId: input.profileId,
    requestedLogicalModelId: input.logicalModelId,
    workspaceId: input.workspaceId,
    ...(workspaceConfig ? { workspaceConfig } : {}),
  }).setup;
  if (!resolved) throw new Error('Public network current setup metadata is unavailable.');
  const network = resolved.manifest.sandbox?.network ?? [];
  for (const grant of input.sandbox.network.filter(
    (grant) => 'publicAccess' in grant && grant.publicAccess !== undefined
  )) {
    const currentGrant = network.find((candidate) => candidate.id === grant.id);
    if (
      !currentGrant ||
      !isDeepStrictEqual(normalizedGrant(grant), normalizedGrant(currentGrant))
    ) {
      throw new Error('Public network exact grant authority was removed or changed.');
    }
  }
  const config = current.openKitConfig;
  const controlHosts = [
    ...(config.server?.publicBaseUrl ? [new URL(config.server.publicBaseUrl).hostname] : []),
    ...(config.server?.bind?.host && !['0.0.0.0', '::'].includes(config.server.bind.host)
      ? [config.server.bind.host]
      : []),
    ...(config.nanohost?.rendezvousUrl ? [new URL(config.nanohost.rendezvousUrl).hostname] : []),
    ...(config.nanohost?.bind?.host && !['0.0.0.0', '::'].includes(config.nanohost.bind.host)
      ? [config.nanohost.bind.host]
      : []),
  ];
  const mcpCatalog = current.workspaceMcpServerCatalogs.find(
    (entry) => entry.workspaceId === input.workspaceId
  )?.catalog;
  const destinationFacts = {
    providerRegistry: current.providerRegistry,
    controlHosts,
    ...(mcpCatalog ? { mcpCatalog } : {}),
  };
  assertPublicNetworkGrants(resolved.manifest, destinationFacts);
  assertPublicNetworkGrants(input, destinationFacts);
}

/** Normalizes only the owned grant shape when comparing captured and current authority. */
function normalizedGrant(grant: PublicNetworkGrant): PublicNetworkGrant {
  const parsed = WorkerSandboxNetworkGrantSchema.parse(grant);
  return { ...parsed, host: canonicalPublicNetworkHost(parsed.host) };
}
