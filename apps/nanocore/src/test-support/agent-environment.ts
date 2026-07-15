import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import type { WorkspaceDb } from '../storage/db.js';

/** Input for one deterministic scheduler-recovery AEP fixture. */
export interface RecordTestAgentEnvironmentPackageInput {
  /** Stable suffix shared by the scheduler lease and AEP lineage. */
  readonly suffix: string;
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
      agent: {
        id: 'agent_codex_host',
        name: 'Codex Agent',
        kind: 'coder',
        status: 'enabled',
        modelId: null,
        skillIds: [],
        profiles: [
          {
            id: 'default',
            displayName: 'Default',
            instructionsRef: null,
            modelId: null,
            skillIds: [],
            capabilityIds: [],
          },
        ],
        defaultProfileId: 'default',
        capabilities: [],
        sandboxSummary: null,
        config: {
          adapterType: 'codex',
          command: null,
          baseUrl: null,
          workspaceRoot: '/workspace',
          environment: {},
          capabilities: [],
        },
        health: {
          checkedAt: null,
          message: 'Test fixture health is not probed.',
          status: 'unknown',
        },
      },
      agentSessionId: `as_${input.suffix}`,
      userId: workspaceDb.userId,
      backend: {
        workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'openkit/worker-codex:dev',
      },
      requestId: `request_${input.suffix}`,
      turn: {
        id: `turn_${input.suffix}`,
        workspaceId: workspaceDb.workspaceId,
        threadId: `thread_${input.suffix}`,
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
        sourcePath: `/tmp/openkit-test-${inputId}`,
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
