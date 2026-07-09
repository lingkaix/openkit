import type { AgentManifest } from '../agents/manifest.js';
import { computeReadiness } from '../agents/readiness.js';
import type { Actor } from '../auth/identity.js';
import type { CoreMode } from '../config/mode.js';
import type { ProviderRegistry, ProviderRegistrySummary } from '../providers/registry.js';
import type { CoreDb } from '../storage/db.js';
import { listAppliedMigrationIds } from '../storage/migrate.js';

/**
 * Auth diagnostics snapshot.
 */
export interface DiagnosticsAuthSnapshot {
  /** Runtime auth mode. */
  mode: CoreMode;
  /** Whether the request has a server-mode session. */
  signedIn?: boolean;
}

/**
 * Agent diagnostics snapshot.
 */
export interface DiagnosticsAgentSnapshot {
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
export interface DiagnosticsSnapshot {
  /** Auth state. */
  auth: DiagnosticsAuthSnapshot;
  /** Data root used by NanoCore. */
  dataRoot: string | null;
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
export interface CreateDiagnosticsSnapshotInput {
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
    dataRoot: input.dataRoot ?? null,
    migrations: {
      applied: input.coreDb ? listAppliedMigrationIds(input.coreDb) : [],
    },
    mode: input.mode,
    providers: input.providerRegistry.summarize(),
    agents: input.agentManifests.map((manifest) => {
      const readiness = computeReadiness(manifest, input.providerRegistry);

      return {
        displayName: manifest.displayName,
        id: manifest.id,
        readiness: readiness.status,
        reasons: readiness.reasons,
      };
    }),
  };
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
