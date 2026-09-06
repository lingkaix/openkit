import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentPackage,
  GatewayConfig,
  WorkerSandboxAccess,
} from '@openkit/config-schema';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import type { WorkspaceDb } from '../storage/db.js';
import { seedWritableGitRepository } from './git-repository.js';

/**
 * Creates one complete setup fixture for tests whose subject is not manifest resolution.
 *
 * @param options Explicit setup differences required by the owning test.
 * @returns Fresh manifest and resolved logical model inputs.
 */
export function createTestAgentSetup(
  options: {
    readonly adapter?: string;
    readonly agentId?: string;
    readonly credentialDeclarations?: AgentEnvironmentCredentialDeclaration[];
    readonly displayName?: string;
    readonly filesystem?: WorkerSandboxAccess['filesystem'];
    readonly imageRef?: string;
    readonly logicalModelId?: string;
    readonly mcpIds?: string[];
    readonly network?: WorkerSandboxAccess['network'];
    readonly privateRoute?: { readonly providerProfileId: string; readonly providerModel: string };
    readonly requiredCapabilities?: AgentEnvironmentPackage['backend']['requiredCapabilities'];
    readonly skillIds?: string[];
  } = {}
): ResolvedAgentSetup {
  const adapter = options.adapter ?? 'codex';
  const logicalModelId = options.logicalModelId ?? 'openai/gpt-5.2';
  const privateRoute = options.privateRoute ?? {
    providerProfileId: 'agent-openrouter',
    providerModel: 'openai/gpt-5.2',
  };

  return {
    manifest: {
      defaultProfileId: 'default',
      displayName: options.displayName ?? 'Codex Agent',
      id: options.agentId ?? 'agent_codex_host',
      mcp: (options.mcpIds ?? []).map((id) => ({ id })),
      models: {
        preferredLogicalModelId: logicalModelId,
        allowedLogicalModelIds: [logicalModelId],
      },
      requiredFeatures: [],
      profiles: [{ id: 'default', instructionsRef: adapter, skills: [], mcp: [] }],
      runtime: {
        adapter,
        binaries: [
          { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
          { id: 'node', path: '/usr/local/bin/node' },
          { id: adapter, path: `/usr/local/bin/${adapter}` },
        ],
        image: {
          kind: 'reference',
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
    profileId: 'default',
    logicalModels: {
      preferredLogicalModelId: logicalModelId,
      allowed: [
        {
          id: logicalModelId,
          displayName: logicalModelId,
          capabilities: [
            'attachment',
            'chat-completions',
            'input:image',
            'input:text',
            'output:text',
            'reasoning',
            'responses',
            'tool-calling',
          ],
          modelFamilyId: 'gpt',
          routes: [
            {
              id: 'test-route',
              providerProfileId: privateRoute.providerProfileId,
              providerModel: privateRoute.providerModel,
            },
          ],
        },
      ],
    },
  };
}

/** Creates the logical Gateway catalog paired with one test Agent setup. */
export function createTestGatewayConfig(
  options: Parameters<typeof createTestAgentSetup>[0] = {}
): GatewayConfig {
  const setup = createTestAgentSetup(options);
  const logicalModel = setup.logicalModels.allowed[0]!;
  return {
    schemaVersion: 1,
    enabled: true,
    defaultLogicalModelId: logicalModel.id,
    logicalModels: [
      {
        id: logicalModel.id,
        displayName: logicalModel.displayName,
        routes: logicalModel.routes.map((route) => ({ ...route })),
      },
    ],
    requiredFeatures: [],
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
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-agent-environment-'));
  seedWritableGitRepository(repositoryPath);
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup(),
      agentSessionId: `as_${input.suffix}`,
      triggerActor: input.triggerActor,
      backend: {
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
        sourcePath: repositoryPath,
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
