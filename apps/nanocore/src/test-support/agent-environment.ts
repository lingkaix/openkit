import type {
  AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentPackage,
  WorkerSandboxAccess,
} from '@openkit/config-schema';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import type { WorkspaceDb } from '../storage/db.js';

/**
 * Creates one complete setup fixture for tests whose subject is not manifest resolution.
 *
 * @param options Explicit setup differences required by the owning test.
 * @returns Fresh manifest and resolved provider inputs.
 */
export function createTestAgentSetup(
  options: {
    readonly adapter?: string;
    readonly agentId?: string;
    readonly credentialDeclarations?: AgentEnvironmentCredentialDeclaration[];
    readonly displayName?: string;
    readonly filesystem?: WorkerSandboxAccess['filesystem'];
    readonly imageRef?: string;
    readonly mcpIds?: string[];
    readonly network?: WorkerSandboxAccess['network'];
    readonly provider?: ResolvedAgentSetup['provider'];
    readonly requiredCapabilities?: AgentEnvironmentPackage['backend']['requiredCapabilities'];
    readonly skillIds?: string[];
  } = {}
): ResolvedAgentSetup {
  const adapter = options.adapter ?? 'codex';
  const provider =
    options.provider === undefined
      ? {
          model: 'openai/gpt-5.2',
          origin: 'server-providers' as const,
          providerId: 'agent-openrouter',
          secretRef: null,
        }
      : options.provider;

  return {
    manifest: {
      defaultProfileId: 'default',
      displayName: options.displayName ?? 'Codex Agent',
      id: options.agentId ?? 'agent_codex_host',
      mcp: (options.mcpIds ?? []).map((id) => ({ id })),
      ...(provider
        ? {
            provider: {
              model: provider.model ?? 'openai/gpt-5.2',
              ref: provider.providerId,
            },
          }
        : {}),
      requiredFeatures: [],
      profiles: [{ id: 'default', instructionsRef: adapter, skills: [] }],
      runtime: {
        adapter,
        binaries: [
          { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
          { id: 'node', path: '/usr/local/bin/node' },
          { id: adapter, path: `/usr/local/bin/${adapter}` },
        ],
        image: {
          pullPolicy: 'if-not-present',
          ref: options.imageRef ?? `openkit/worker-${adapter}:dev`,
        },
        kind: adapter,
        version: 'test',
      },
      sandbox: {
        backend: {
          allowedKinds: ['openshell'],
          preferred: 'openshell',
          requiredCapabilities: options.requiredCapabilities ?? ['backend-local-inference'],
        },
        credentialDeclarations: options.credentialDeclarations ?? [],
        filesystem: options.filesystem ?? [],
        network: options.network ?? [],
      },
      schemaVersion: 1,
      skills: (options.skillIds ?? []).map((id) => ({ id })),
    },
    provider,
  };
}

/** Input for one deterministic scheduler-recovery AEP fixture. */
export interface RecordTestAgentEnvironmentPackageInput {
  /** Stable suffix shared by the scheduler lease and AEP lineage. */
  readonly suffix: string;
  /** Exact actor whose action triggered the test package. */
  readonly triggerActor: ActorRef;
  /** Workspace input ids expected to produce materialization records. */
  readonly workspaceInputIds: readonly string[];
}

/**
 * Records one deterministic AEP snapshot for scheduler recovery tests.
 *
 * @param workspaceDb Workspace database that owns the package snapshot.
 * @param input Stable lineage suffix and expected workspace input ids.
 * @returns Parsed package snapshot with production-shaped workspace input ids.
 */
export function recordTestAgentEnvironmentPackage(
  workspaceDb: WorkspaceDb,
  input: RecordTestAgentEnvironmentPackageInput
): AgentEnvironmentPackage {
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: `as_${input.suffix}`,
      triggerActor: input.triggerActor,
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
      },
      requestId: `request_${input.suffix}`,
      turn: {
        id: `turn_${input.suffix}`,
        workspaceId: workspaceDb.workspaceId,
        threadId: `thread_${input.suffix}`,
        triggerActor: input.triggerActor,
        items: [],
        status: 'running',
        humanGate: null,
        error: null,
        configVersion: null,
        startedAt: '2026-07-05T00:00:01.000Z',
        completedAt: null,
        durationMs: null,
      },
      turnInput: `Run ${input.suffix}`,
      workspaceCwd: '/workspace',
      workspaceRoots: input.workspaceInputIds.map((inputId) => ({
        access: 'read-write' as const,
        id: inputId,
        sourceKind: 'host-dir' as const,
        sourcePath: process.cwd(),
        workerPath: `/workspace/${inputId}`,
      })),
    })
  );

  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    createdAt: '2026-07-05T00:00:01.000Z',
    environmentPackage,
  });
  return environmentPackage;
}
