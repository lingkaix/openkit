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
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { admitTestNativeEnvironment, createTestNativeEnvironmentDb } from './native-environment.js';

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
          contextManagement: { type: 'compaction', compactThreshold: 8_000 },
          modelFamilyId: 'gpt',
          autoFailover: true,
          routes: [
            {
              available: true,
              unavailableReason: null,
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

/** Creates authored Gateway configuration, omitting the resolved members' availability projection. */
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
        contextManagement: [logicalModel.contextManagement],
        routes: logicalModel.routes.map(({ id, providerProfileId, providerModel }) => ({
          id,
          providerProfileId,
          providerModel,
        })),
      },
    ],
    requiredFeatures: [],
  };
}

/** Input for one deterministic scheduler-recovery AEP fixture. */
export interface RecordTestAgentEnvironmentPackageInput {
  /** Actual Core owner when storage or physical runtime consumers are part of the test. */
  readonly coreDb?: CoreDb;
  /** Stable suffix shared by the scheduler lease and AEP lineage. */
  readonly suffix: string;
  /** Exact actor whose action triggered the test package. */
  readonly triggerActor: ActorRef;
  /** Workspace input ids expected to produce materialization records. */
  readonly workspaceInputIds: readonly string[];
  /** Optional Item lineage the recorded scope carries. */
  readonly itemId?: string;
}

/**
 * Records one deterministic AEP snapshot for scheduler recovery tests.
 *
 * @param workspaceDb Workspace database that owns the package snapshot.
 * @param input Stable lineage suffix, expected workspace input ids, and optional Item lineage.
 * @returns Parsed package snapshot with supported remote Git inputs and exact requested ids.
 */
export function recordTestAgentEnvironmentPackage(
  workspaceDb: WorkspaceDb,
  input: RecordTestAgentEnvironmentPackageInput
): AgentEnvironmentPackage {
  const sourceCommit = 'a'.repeat(40);
  const coreDb = input.coreDb ?? createTestNativeEnvironmentDb();
  admitTestNativeEnvironment(coreDb, createTestAgentSetup().manifest);
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      coreDb,
      captureCoverage: { scope: 'server', value: 'off' },
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
        sourceKind: 'remote-git' as const,
        sourceCommit,
        workerPath: `/workspace/${inputId}`,
      })),
      workspaceSourceRefs: Object.fromEntries(input.workspaceInputIds.map((id) => [id, id])),
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        requiredFeatures: [],
        extensions: {},
        sources: input.workspaceInputIds.map((id) => ({
          id,
          displayName: id,
          kind: 'git' as const,
          locator: { commit: sourceCommit, url: 'https://example.invalid/recovery.git' },
          access: 'read-write' as const,
          allowedSlotKinds: ['worktree' as const],
          sensitivity: 'internal' as const,
          status: 'active' as const,
          syncHints: {},
          requiredFeatures: [],
          extensions: {},
        })),
      },
    })
  );

  const scoped = input.itemId
    ? AgentEnvironmentPackageSchema.parse({
        ...environmentPackage,
        scope: { ...environmentPackage.scope, itemId: input.itemId },
      })
    : environmentPackage;

  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    createdAt: '2026-07-05T00:00:01.000Z',
    environmentPackage: scoped,
  });
  return scoped;
}
