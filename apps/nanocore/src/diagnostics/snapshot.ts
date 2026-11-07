import type { GatewayConfig } from '@openkit/config-schema';
import type { AgentManifest } from '../agents/manifest.js';
import { computeReadiness } from '../agents/readiness.js';
import { resolveAgentSetup, unsupportedAgentResourceDiagnostic } from '../agents/setup-resolver.js';
import type { Actor } from '../auth/identity.js';
import type { CoreMode } from '../config/mode.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type {
  ProviderCredentialConfigured,
  ProviderRegistry,
  ProviderRegistrySummary,
} from '../providers/registry.js';
import type { CoreDb } from '../storage/db.js';
import { listAppliedMigrationIds } from '../storage/migrate.js';

/**
 * Auth diagnostics snapshot.
 */
interface DiagnosticsAuthSnapshot {
  /** Runtime auth mode. */
  mode: CoreMode;
  /** Whether the request has a server-mode session. */
  signedIn?: boolean;
}

/**
 * Agent diagnostics snapshot.
 */
interface DiagnosticsAgentSnapshot {
  /** Agent id. */
  id: string;
  /** Agent display name. */
  displayName: string;
  /** Computed readiness status. */
  readiness: string;
  /** Readiness reason strings. */
  reasons: string[];
}

/**
 * Aggregate NanoCore diagnostics snapshot.
 */
interface DiagnosticsSnapshot {
  /** Auth state. */
  auth: DiagnosticsAuthSnapshot;
  /** Whether NanoCore has a configured data root. */
  dataRoot: 'configured' | null;
  /** Applied storage migrations. */
  migrations: { applied: string[] };
  /** Runtime mode. */
  mode: CoreMode;
  /** Redacted provider summaries. */
  providers: ProviderRegistrySummary[];
  /** Agent readiness summaries. */
  agents: DiagnosticsAgentSnapshot[];
}

/**
 * Input for creating an aggregate diagnostics snapshot.
 */
interface CreateDiagnosticsSnapshotInput {
  /** Request actor, when auth middleware has resolved one. */
  actor?: Actor;
  /** Core database handle used to inspect migrations. */
  coreDb?: CoreDb;
  /** Data root used by NanoCore. */
  dataRoot?: string | null;
  /** Runtime mode. */
  mode: CoreMode;
  /** Provider registry used for redacted provider summaries. */
  providerRegistry: ProviderRegistry;
  /** Loaded agent manifests. */
  agentManifests: AgentManifest[];
  /**
   * Current Gateway supply. Absent means Agent readiness checks have not run,
   * so a declared or omitted `ready` is not launchability proof.
   */
  gatewayConfig?: GatewayConfig;
  /** Current API-key presence without resolving Vault material. */
  providerCredentialConfigured?: ProviderCredentialConfigured;
  /** Current network-free subscription supply when its live owner is available. */
  subscriptionAccounts?: Pick<ProviderSubscriptionAccountManager, 'gatewayUnavailableReason'>;
}

/**
 * Creates a redacted aggregate diagnostics snapshot.
 *
 * @param input Snapshot input.
 * @returns Aggregate diagnostics snapshot.
 */
export function createDiagnosticsSnapshot(
  input: CreateDiagnosticsSnapshotInput
): DiagnosticsSnapshot {
  return {
    auth: createAuthSnapshot(input.mode, input.actor),
    dataRoot: input.dataRoot ? 'configured' : null,
    migrations: {
      applied: input.coreDb ? listAppliedMigrationIds(input.coreDb) : [],
    },
    mode: input.mode,
    providers: input.providerRegistry.summarize(),
    agents: input.agentManifests.map((manifest) => projectAgentDiagnostics(manifest, input)),
  };
}

/**
 * Projects launchability for one Agent.
 *
 * Omitted or declared `ready` is published only after the setup resolver accepts
 * the manifest. Without that check, or when a required setup check fails, the
 * snapshot reports `unknown` or `blocked` instead of `ready`.
 */
function projectAgentDiagnostics(
  manifest: AgentManifest,
  input: CreateDiagnosticsSnapshotInput
): DiagnosticsAgentSnapshot {
  const declared = computeReadiness(manifest);
  const identity = { displayName: manifest.displayName, id: manifest.id };
  const unsupportedResources = unsupportedAgentResourceDiagnostic(manifest);
  if (!input.gatewayConfig) {
    if (unsupportedResources) {
      return { ...identity, readiness: 'blocked', reasons: [unsupportedResources.message] };
    }
    // Omitted readiness defaults to ready. That default is not launchability proof.
    if (declared.status === 'ready') {
      return {
        ...identity,
        readiness: 'unknown',
        reasons: ['Agent readiness has not been established.'],
      };
    }
    return { ...identity, readiness: declared.status, reasons: declared.reasons };
  }

  const setup = resolveAgentSetup(manifest, {
    gatewayConfig: input.gatewayConfig,
    providerRegistry: input.providerRegistry,
    providerCredentialConfigured: input.providerCredentialConfigured,
    subscriptionAccounts: input.subscriptionAccounts,
  });
  if (setup.diagnostics.length > 0) {
    return {
      ...identity,
      readiness: 'blocked',
      reasons: [
        ...(declared.status === 'ready' ? [] : declared.reasons),
        ...setup.diagnostics.map((diagnostic) => diagnostic.message),
      ],
    };
  }

  const established = manifest.readiness?.status
    ? declared
    : { reasons: [], status: 'ready' as const };
  return { ...identity, readiness: established.status, reasons: established.reasons };
}

/**
 * Creates auth diagnostics without exposing session identifiers.
 *
 * @param mode Runtime mode.
 * @param actor Request actor.
 * @returns Auth diagnostics snapshot.
 */
function createAuthSnapshot(mode: CoreMode, actor: Actor | undefined): DiagnosticsAuthSnapshot {
  if (mode === 'server') {
    return {
      mode,
      signedIn: actor?.kind === 'session',
    };
  }

  return { mode };
}
