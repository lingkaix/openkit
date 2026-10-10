import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentPackageSchema,
  type SessionWorkspaceMaterializationPlan,
  type WorkerSandboxAccess,
  WorkerSandboxAccessSchema,
} from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  type Node,
  ScriptTarget,
  transpileModule,
} from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import { importWorkspaceSkill, setWorkspaceSkillPin } from '../catalog/resource-catalog.js';
import { loadAgentManifests } from '../config/agents-loader.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestGatewayConfig } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import {
  admitTestNativeEnvironment,
  createTestNativeEnvironmentDb,
} from '../test-support/native-environment.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  resolveAgentSessionCompatibilityKey as resolveCompatibility,
  resolveAgentEnvironmentPackageMetadata as resolveMetadata,
  resolveAgentEnvironmentPackage as resolvePackage,
} from './agent-environment.js';
import {
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
} from './execution-attempt-records.js';
import {
  acceptNanoHostAttemptHeartbeat,
  resolveNanoHostAttemptTokenBinding,
} from './nanohost-attempt-records.js';
import { TurnStartValidationError } from './orchestrator.js';
import type { PublicNetworkConfiguration } from './public-network-grants.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import type { PrepareAgentSessionForTurnInput } from './types.js';
import { DeterministicAgentPreparationError } from './types.js';

// Other-contract fixtures explicitly confirm synthetic image defaults before resolution.
const environmentFixtureDb = createTestNativeEnvironmentDb();
function preparedInput<T extends Parameters<typeof resolveMetadata>[0]>(
  input: T
): T & { coreDb: typeof environmentFixtureDb } {
  const coreDb = input.coreDb ?? environmentFixtureDb;
  admitTestNativeEnvironment(coreDb, input.agentSetup.manifest);
  return { ...input, coreDb };
}
const resolveAgentEnvironmentPackage: typeof resolvePackage = (input) =>
  resolvePackage(preparedInput(input));
const resolveAgentEnvironmentPackageMetadata: typeof resolveMetadata = (input) =>
  resolveMetadata(preparedInput(input));
const resolveAgentSessionCompatibilityKey: typeof resolveCompatibility = (input) =>
  resolveCompatibility(preparedInput(input));

const USER_TRIGGER_ACTOR = { kind: 'user', id: 'user_local' } as const satisfies ActorRef;
const AUTOMATION_TRIGGER_ACTOR = {
  kind: 'automation',
  id: 'automation_release',
  responsibleUserId: 'user_local',
} as const satisfies ActorRef;

/**
 * Creates one complete resolved setup for AEP contract tests.
 *
 * @param options Explicit manifest changes relevant to the test.
 * @returns Complete manifest and resolved logical model snapshot.
 */
function createTestSetup(
  options: {
    readonly adapter?: string;
    readonly credentialDeclarations?: AgentEnvironmentCredentialDeclaration[];
    readonly logicalModelId?: string;
    readonly mcpIds?: string[];
    readonly network?: WorkerSandboxAccess['network'];
    readonly requiredCapabilities?: Array<
      'backend-local-inference' | 'trusted-worker-inference-relay' | 'worker.runtime-provenance.v1'
    >;
    readonly runtimeBinaries?: Array<{ readonly id: string; readonly path: string }>;
    readonly skillIds?: string[];
  } = {}
): ResolvedAgentSetup {
  const adapter = options.adapter ?? 'codex';
  const logicalModelId = options.logicalModelId ?? 'reasoning';

  return {
    manifest: {
      defaultProfileId: 'default',
      displayName: 'Test Worker',
      id: 'agent_codex_host',
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
          ...(options.runtimeBinaries ?? []),
        ],
        image: {
          kind: 'reference',
          pullPolicy: 'never',
          ref: `registry.example.com/openkit/worker-${adapter}:test`,
        },
        kind: `${adapter}-runtime`,
        version: '1.0.0',
      },
      sandbox: {
        backend: {
          allowedKinds: ['openshell'],
          preferred: 'openshell',
          requiredCapabilities: options.requiredCapabilities ?? ['trusted-worker-inference-relay'],
        },
        credentialDeclarations: options.credentialDeclarations ?? [],
        filesystem: [],
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
          capabilities: ['chat-completions', 'responses', 'tool-calling'],
          modelFamilyId: 'test-model-family',
          routes: [
            {
              id: 'primary',
              providerProfileId: 'agent-openrouter',
              providerModel: 'openai/gpt-5.1',
            },
          ],
        },
      ],
    },
  };
}

/**
 * Creates one product turn for AEP tests.
 *
 * @param input User-visible turn input.
 * @returns Accepted turn.
 */
function createTurnFixture(
  input: string,
  coreDb?: ReturnType<typeof openCoreDb>,
  triggerActor: ActorRef = USER_TRIGGER_ACTOR,
  serverAdminTokenId?: string
) {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', input, triggerActor);
  if (coreDb) {
    createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue_${turn.id}`,
      triggerActor,
      ...(serverAdminTokenId ? { serverAdminTokenId } : {}),
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      turnInput: input,
      requestedAgentId: 'agent_codex_host',
    });
  }
  return turn;
}

/** Gives a credential fixture its exact durable Worker package and prepared execution attempt. */
function prepareCredentialAttemptFixture(
  coreDb: ReturnType<typeof openCoreDb>,
  turn: ReturnType<typeof createTurnFixture>,
  agentSessionId: string
): void {
  recordTestExecutionAttempt(coreDb, {
    entry: requireSchedulerAdmissionEntry(coreDb, `queue_${turn.id}`),
    attemptId: `lease_${turn.id}`,
    agentSessionId,
    inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
    bindingRef: `lease-token:${turn.id}`,
    sessionCompatibilityKey: 'sha256:credential-fixture',
    now: () => new Date().toISOString(),
  });
}

describe('agent environment package resolver', () => {
  it('binds explicit encoded-slash authority into immutable package and session material identity', () => {
    const turn = createTurnFixture('Read packages');
    const resolve = (allowEncodedSlash?: boolean) => {
      const network = WorkerSandboxAccessSchema.parse({
        network: [
          {
            id: 'package-read',
            host: 'packages.example.com',
            port: 443,
            protocol: 'rest',
            access: 'read-only',
            purpose: 'Read scoped packages.',
            binaries: ['/usr/local/bin/node'],
            ...(allowEncodedSlash === undefined ? {} : { allowEncodedSlash }),
          },
        ],
      }).network;
      return resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup({ network }),
        agentSessionId: 'as_encoding',
        backend: { kind: 'openshell' },
        createdAt: '2026-10-08T00:00:00.000Z',
        turn,
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceRoots: [],
      });
    };
    const omitted = resolve();
    const historicalBytes = JSON.stringify(omitted);
    const strict = resolve(false);
    const allowed = resolve(true);
    const identity = (pkg: typeof omitted) =>
      (
        pkg.extensions.openkit as {
          sessionWorkspace: { compatibilityKey: { digest: string } };
        }
      ).sessionWorkspace.compatibilityKey.digest;
    expect(allowed.policy.network?.rules).toContainEqual(
      expect.objectContaining({ allowEncodedSlash: true })
    );
    expect(strict.policy.network?.rules).toContainEqual(
      expect.objectContaining({ allowEncodedSlash: false })
    );
    expect(identity(allowed)).not.toBe(identity(strict));
    expect(identity(allowed)).not.toBe(identity(omitted));
    expect(JSON.stringify(omitted)).toBe(historicalBytes);
    expect(JSON.stringify(resolve())).toBe(historicalBytes);
    expect(JSON.stringify(AgentEnvironmentPackageSchema.parse(JSON.parse(historicalBytes)))).toBe(
      historicalBytes
    );
    expect(historicalBytes).not.toContain('allowEncodedSlash');
  });

  it.each(['repo', 'turn'])('preserves authored root %s with unique output ids', (id) => {
    const commit = 'a'.repeat(40);
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestSetup(),
      agentSessionId: 'as_review',
      backend: { kind: 'openshell' },
      turn: createTurnFixture('Use the authored writable root'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [
        {
          id,
          access: 'read-write',
          sourceKind: 'remote-git',
          sourceCommit: commit,
          workerPath: '/workspace/repo',
        },
      ],
      workspaceSourceRefs: { [id]: 'source' },
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            id: 'source',
            displayName: 'Repository',
            kind: 'git',
            locator: { url: 'https://example.invalid/repo.git', commit },
            status: 'active',
            sensitivity: 'internal',
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
          },
        ],
      },
    });
    expect(resolved.workspace.inputs).toContainEqual(expect.objectContaining({ id }));
    const outputs = resolved.workspace.outputs;
    expect(outputs).toHaveLength(2);
    expect(new Set(outputs.map((output) => output.id)).size).toBe(outputs.length);
    expect(outputs).toContainEqual(
      expect.objectContaining({ id: `${id}-output`, registerAsArtifacts: true })
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({ path: '/openkit/sessions/as_review/outputs' })
    );
  });

  it('declares the generated session-private output slot without authored roots', () => {
    for (const agentSessionId of ['as_output_a', 'as_output_b']) {
      const resolved = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup(),
        agentSessionId,
        backend: { kind: 'openshell' },
        turn: createTurnFixture('Write a report'),
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceRoots: [],
      });
      const path = `/openkit/sessions/${agentSessionId}/outputs`;
      expect(resolved.workspace.outputs).toEqual([
        { id: 'turn-output-root', path, registerAsArtifacts: true, retention: 'sync-on-turn-end' },
      ]);
      const plan = (
        resolved.extensions.openkit as { sessionWorkspace: SessionWorkspaceMaterializationPlan }
      ).sessionWorkspace;
      expect(plan.layout.slots.find((slot) => slot.id === 'turn-output')).toMatchObject({
        path,
        access: 'read-write',
        allowedSourceKinds: ['generated'],
        allowedMaterializationModes: ['create-empty'],
        retention: 'turn',
      });
      expect(plan.materialization.outputSlotIds).toContain('turn-output');
    }
  });

  it.each([
    { cpu: { maxCores: 1 } },
    { unsupportedLimit: 0 },
    { cpu: null },
  ])('refuses non-empty authored resources before runtime effects: %j', (resources) => {
    const setup = createTestSetup();
    const input = {
      agentSetup: { ...setup, manifest: { ...setup.manifest, resources } },
      agentSessionId: 'session_resource_refusal',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Respect authored resource intent'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    for (const resolve of [
      resolveAgentEnvironmentPackageMetadata,
      resolveAgentSessionCompatibilityKey,
    ]) {
      expect(() => resolve(input)).toThrow(DeterministicAgentPreparationError);
      expect(() => resolve(input)).toThrow(
        'Agent resources is not supported; leave resources empty or absent.'
      );
    }
    expect(() =>
      resolveAgentEnvironmentPackage({
        ...input,
        captureCoverage: { scope: 'server', value: 'off' },
      })
    ).toThrow(DeterministicAgentPreparationError);
  });

  it.each([undefined, {}])('keeps absent and empty authored resources usable: %j', (resources) => {
    const setup = createTestSetup();
    const input = {
      agentSetup: {
        ...setup,
        manifest: { ...setup.manifest, ...(resources ? { resources } : {}) },
      },
      agentSessionId: 'session_resource_empty',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Use supported default resources'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    expect(resolveAgentEnvironmentPackageMetadata(input).resources).toEqual({});
    expect(
      resolveAgentEnvironmentPackage({
        ...input,
        captureCoverage: { scope: 'server', value: 'off' },
      }).resources
    ).toEqual({});
    expect(resolveAgentSessionCompatibilityKey(input)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('resolves the shipped DeepSeek template with its authored dsh binary', () => {
    const loaded = loadAgentManifests(
      fileURLToPath(new URL('../../data-templates/', import.meta.url))
    );
    expect(
      loaded.diagnostics.filter((diagnostic) => diagnostic.agentId === 'agent_deepseek')
    ).toEqual([]);
    const manifest = loaded.manifests.find((candidate) => candidate.id === 'agent_deepseek');
    if (!manifest) throw new Error('Expected the shipped DeepSeek template to load.');
    const result = resolveAgentSetup(manifest, {
      gatewayConfig: createTestGatewayConfig({ logicalModelId: 'smart' }),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Test Provider',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    expect(result.diagnostics).toEqual([]);
    if (!result.setup) throw new Error('Expected the shipped DeepSeek setup to resolve.');
    const input = {
      agentSetup: result.setup,
      agentSessionId: 'session_deepseek_template',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Resolve the shipped DeepSeek Agent'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    const preview = resolveAgentEnvironmentPackageMetadata(input);
    expect(preview.runtime.binaries).toEqual(manifest.runtime.binaries);
    expect(preview.runtime.binaries).toContainEqual({ id: 'dsh', path: '/usr/local/bin/dsh' });
    expect(resolveAgentSessionCompatibilityKey(input)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      resolveAgentEnvironmentPackage({
        ...input,
        captureCoverage: { scope: 'server', value: 'off' },
      }).runtime.binaries
    ).toEqual(manifest.runtime.binaries);
  });

  it('resolves the shipped Codex template without unsupported runtime provenance', () => {
    const loaded = loadAgentManifests(
      fileURLToPath(new URL('../../data-templates/', import.meta.url))
    );
    expect(loaded.diagnostics.filter((entry) => entry.agentId === 'agent_codex_host')).toEqual([]);
    const manifest = loaded.manifests.find((entry) => entry.id === 'agent_codex_host');
    if (!manifest) throw new Error('Expected the shipped Codex template.');
    const result = resolveAgentSetup(manifest, {
      gatewayConfig: createTestGatewayConfig({ logicalModelId: 'smart' }),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Test Provider',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    expect(result.diagnostics).toEqual([]);
    if (!result.setup) throw new Error('Expected the shipped Codex setup.');
    const input = {
      agentSetup: result.setup,
      agentSessionId: 'session_codex_template',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Resolve the shipped Codex Agent'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    const preview = resolveAgentEnvironmentPackageMetadata(input);
    const resolved = resolveAgentEnvironmentPackage({
      ...input,
      captureCoverage: { scope: 'server', value: 'off' },
    });
    expect(preview.backend.requiredCapabilities).toContain('trusted-worker-inference-relay');
    expect(resolved.backend.requiredCapabilities).not.toContain('worker.runtime-provenance.v1');
    expect(preview.control.transcript.runtimeProvenance).toBeUndefined();
    expect(resolved.control.transcript.runtimeProvenance).toBeUndefined();
  });

  it('previews a future Turn without fabricating admitted capture coverage', () => {
    const input = {
      agentSetup: createTestSetup(),
      agentSessionId: 'session_unadmitted',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Plan without capture admission'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    const preview = resolveAgentEnvironmentPackageMetadata(input);
    expect(preview).not.toHaveProperty('observability');
    expect(AgentEnvironmentPackageSchema.safeParse(preview).success).toBe(false);
    expect(resolveAgentSessionCompatibilityKey(input)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('partitions compatibility by the exact allowed logical models but not the preferred one', () => {
    const setup = createTestSetup();
    const second = {
      ...setup.logicalModels.allowed[0]!,
      id: 'second-model',
      displayName: 'Second',
    };
    const input = {
      agentSetup: setup,
      agentSessionId: 'session_models',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Model admission'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    const original = resolveAgentSessionCompatibilityKey(input);
    const allowed = [setup.logicalModels.allowed[0]!, second];
    const expanded = resolveAgentSessionCompatibilityKey({
      ...input,
      agentSetup: { ...setup, logicalModels: { preferredLogicalModelId: 'reasoning', allowed } },
    });
    expect(expanded).not.toBe(original);
    expect(
      resolveAgentSessionCompatibilityKey({
        ...input,
        agentSetup: {
          ...setup,
          logicalModels: { preferredLogicalModelId: 'second-model', allowed },
        },
      })
    ).toBe(expanded);
    expect(() =>
      resolveAgentSessionCompatibilityKey({
        ...input,
        agentSetup: {
          ...setup,
          logicalModels: {
            preferredLogicalModelId: 'reasoning',
            allowed: [allowed[0]!, allowed[0]!],
          },
        },
      })
    ).toThrow();
    expect(() =>
      resolveAgentSessionCompatibilityKey({
        ...input,
        agentSetup: {
          ...setup,
          logicalModels: { preferredLogicalModelId: 'missing-model', allowed },
        },
      })
    ).toThrow();
  });

  it('projects exact admitted capture coverage without partitioning session compatibility', () => {
    const input = {
      agentSetup: createTestSetup(),
      agentSessionId: 'session_capture',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Use immutable capture admission'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    const key = resolveAgentSessionCompatibilityKey(input);
    for (const scope of ['server', 'workspace', 'task'] as const) {
      for (const value of ['off', 'on'] as const) {
        const captureCoverage = { scope, value };
        const environmentPackage = resolveAgentEnvironmentPackage({ ...input, captureCoverage });
        expect(environmentPackage.observability.captureCoverage).toEqual(captureCoverage);
        expect(
          (
            environmentPackage.extensions.openkit as {
              sessionWorkspace: SessionWorkspaceMaterializationPlan;
            }
          ).sessionWorkspace.compatibilityKey.digest
        ).toBe(key);
      }
    }
  });

  it('rejects missing capture admission before credential authority resolution', () => {
    const input = {
      agentSetup: createTestSetup({
        credentialDeclarations: [
          {
            id: 'test_key',
            targetEnvVarName: 'TEST_KEY',
            vaultGrantId: 'grant_missing',
            visibility: 'runtime-env',
          },
        ],
      }),
      agentSessionId: 'session_missing_capture',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('Reject missing capture admission'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    expect(() =>
      resolveAgentEnvironmentPackage(input as Parameters<typeof resolveAgentEnvironmentPackage>[0])
    ).toThrow('expected object');
  });

  it('refuses retired repository MCP supply without a catalog binding', () => {
    const resolve = (mcpIds: string[]) =>
      resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup({ mcpIds }),
        agentSessionId: 'session_repository',
        backend: { kind: 'openshell' },
        createdAt: '2026-09-15T00:00:00.000Z',
        requestId: 'request_repository',
        turn: createTurnFixture('Publish an admitted commit'),
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
    expect(resolve([]).supply.mcpServers.some((server) => server.id === 'openkit-repository')).toBe(
      false
    );
    expect(() => resolve(['openkit-repository'])).toThrow(/MCP|catalog/);
  });

  it('requires one explicit container backend', () => {
    const turn = createTurnFixture('Use the repository');
    const common = {
      captureCoverage: { scope: 'server', value: 'off' } as const,
      agentSetup: createTestSetup(),
      agentSessionId: 'session_1',
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    };

    expect(() => resolveAgentEnvironmentPackage(common)).toThrow(
      'Agent Environment Package resolution requires a container backend.'
    );
    expect(() =>
      resolveAgentEnvironmentPackage({ ...common, backend: { kind: 'host' } as never })
    ).toThrow('Host Agent Environment Package backends are not supported.');
  });

  it('projects the exact trigger actor into V2 scope without legacy identity fields', () => {
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestSetup({ requiredCapabilities: ['backend-local-inference'] }),
      agentSessionId: 'session_actor_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_actor_1',
      triggerActor: AUTOMATION_TRIGGER_ACTOR,
      turn: createTurnFixture('Project exact actor'),
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(resolved.schemaVersion).toBe(4);
    expect(resolved.scope.triggerActor).toEqual(AUTOMATION_TRIGGER_ACTOR);
    expect(resolved.scope).not.toHaveProperty('userId');
    expect(resolved.scope).not.toHaveProperty('automationId');
    expect(resolved.scope).not.toHaveProperty('organizationId');
  });

  it.each([
    true,
    false,
  ])('projects complete admitted model parameters into the AEP: %s', (complete) => {
    const setupResult = resolveAgentSetup(createTestSetup().manifest, {
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              {
                id: 'primary',
                providerProfileId: 'private-provider',
                providerModel: 'private-model',
              },
            ],
          },
        ],
      },
      providerRegistry: new ProviderRegistry([
        {
          id: 'private-provider',
          displayName: 'Private Provider',
          kind: 'custom',
          baseUrl: 'https://private.example/v1',
          models: ['private-model'],
          modelMetadata: {
            'private-model': complete
              ? {
                  limit: { context: 128_000, output: 16_000 },
                  modalities: { input: ['text', 'audio', 'pdf'] },
                  reasoning: false,
                }
              : { limit: { context: 128_000 } },
          },
        },
      ]),
    });
    expect(setupResult.diagnostics).toEqual([]);
    if (!setupResult.setup) throw new Error('Expected admitted model setup.');
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: setupResult.setup,
      agentSessionId: 'session_parameters',
      backend: { kind: 'openshell' },
      turn: createTurnFixture('Use admitted model parameters'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    });
    const serialized = JSON.parse(JSON.stringify(resolved));
    const route = serialized.llm.routes[0];
    expect(route.model).toBe('reasoning');
    expect(JSON.stringify(route)).not.toContain('private-provider');
    expect(JSON.stringify(route)).not.toContain('private-model');
    expect(JSON.stringify(route)).not.toContain('private.example');
    if (complete) {
      expect(route.modelParameters).toEqual({
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        inputModalities: ['text', 'audio', 'pdf'],
        reasoning: false,
      });
    } else {
      expect(route).not.toHaveProperty('modelParameters');
    }
  });

  it('projects unequal mixed-family member parameters into the AEP', () => {
    const setupResult = resolveAgentSetup(createTestSetup().manifest, {
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              {
                id: 'primary',
                providerProfileId: 'private-provider',
                providerModel: 'private-model',
              },
              { id: 'backup', providerProfileId: 'backup-provider', providerModel: 'backup-model' },
            ],
          },
        ],
      },
      providerRegistry: new ProviderRegistry([
        {
          id: 'private-provider',
          displayName: 'Private Provider',
          kind: 'custom',
          baseUrl: 'https://private.example/v1',
          models: ['private-model'],
          modelMetadata: {
            'private-model': {
              family: 'private-family',
              limit: { context: 128_000, output: 16_000 },
              modalities: { input: ['text', 'audio', 'pdf'] },
              reasoning: false,
            },
          },
        },
        {
          id: 'backup-provider',
          displayName: 'Backup',
          kind: 'custom',
          models: ['backup-model'],
          modelMetadata: {
            'backup-model': {
              family: 'other',
              limit: { context: 64_000, output: 8_000 },
              modalities: { input: ['text', 'image'] },
              reasoning: true,
            },
          },
        },
      ]),
    });
    expect(setupResult.diagnostics).toEqual([]);
    if (!setupResult.setup) throw new Error('Expected admitted model setup.');
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: setupResult.setup,
      agentSessionId: 'session_parameters',
      backend: { kind: 'openshell' },
      turn: createTurnFixture('Use admitted model parameters'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    });
    const serialized = JSON.parse(JSON.stringify(resolved));
    const route = serialized.llm.routes[0];
    expect(route.model).toBe('reasoning');
    expect(JSON.stringify(route)).not.toContain('private-provider');
    expect(JSON.stringify(route)).not.toContain('private-model');
    expect(JSON.stringify(route)).not.toContain('private.example');
    expect(route.modelParameters).toEqual({
      contextWindow: 64_000,
      maxOutputTokens: 8_000,
      inputModalities: ['text'],
      reasoning: false,
    });
    expect(setupResult.setup.logicalModels.allowed[0]?.modelFamilyId).toBeNull();
  });

  it('projects one resolved opaque manifest into the generic relay launch contract', () => {
    const turn = createTurnFixture('Run the opaque worker');
    const setupResult = resolveAgentSetup(createTestSetup({ adapter: 'future-adapter' }).manifest, {
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              {
                id: 'primary',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.1',
              },
            ],
          },
        ],
        requiredFeatures: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.1',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.1'],
          vendor: 'openrouter',
        },
      ]),
    });

    expect(setupResult.diagnostics).toEqual([]);
    if (!setupResult.setup) {
      throw new Error('Expected the opaque agent setup to resolve.');
    }

    const resolved = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: setupResult.setup,
        agentSessionId: 'session_future_1',
        backend: {
          kind: 'openshell',
        },
        createdAt: '2026-07-18T00:00:00.000Z',
        requestId: 'req_future_1',
        turn,
        turnInput: 'Run the opaque worker',
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );

    expect(resolved.runtime).toMatchObject({
      binaries: setupResult.setup.manifest.runtime.binaries,
      command: { argv: ['openkit-worker-shim'] },
      image: {
        kind: 'reference',
        pullPolicy: 'never',
        ref: 'registry.example.com/openkit/worker-future-adapter:test',
      },
    });
    expect(resolved.control.adapter).toEqual({
      kind: 'openkit-worker-shim',
      targetRuntime: 'future-adapter',
    });
    expect(resolved.llm).toEqual({
      mode: 'gateway',
      preferredLogicalModelId: 'reasoning',
      routes: [
        expect.objectContaining({
          credentialVisibility: 'placeholder',
          model: 'reasoning',
          providerInstanceId: 'openkit-gateway',
        }),
      ],
    });
    expect(resolved.supply).not.toHaveProperty('binaries');
    expect(resolved.extensions.openkit).not.toHaveProperty('codexCommand');
    expect(resolved.extensions.openkit).not.toHaveProperty('resultMessagePath');
  });

  it('rejects retired remote Gateway topology inputs', () => {
    const turn = createTurnFixture('Run remotely');
    expect(() =>
      resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup(),
        agentSessionId: 'session_remote_1',
        backend: {
          gatewayUrl: 'https://gateway.example.test',
          kind: 'openshell',
          placement: 'remote',
          workerControlBaseUrl: 'https://nanocore.example.test/api/worker-control',
        } as never,
        createdAt: '2026-07-18T00:00:00.000Z',
        requestId: 'req_remote_1',
        turn,
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    ).toThrow();
  });

  it('preserves authored development grants with trusted inference and rejects incomplete provenance', () => {
    const turn = createTurnFixture('Reject authority conflict');
    const common = {
      captureCoverage: { scope: 'server', value: 'off' } as const,
      agentSessionId: 'session_reject_1',
      backend: {
        kind: 'openshell' as const,
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_reject_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    };

    const resolved = resolveAgentEnvironmentPackage({
      ...common,
      agentSetup: createTestSetup({
        network: [
          {
            binaries: ['/usr/bin/git'],
            host: 'github.com',
            id: 'github-git-read',
            port: 443,
            protocol: 'rest',
            purpose: 'Clone and fetch Git repositories',
            rules: [
              { method: 'GET', path: '/**/info/refs*' },
              { method: 'POST', path: '/**/git-upload-pack' },
            ],
            scope: 'session',
          },
        ],
        runtimeBinaries: [
          { id: 'git', path: '/usr/bin/git' },
          { id: 'codex-native', path: '/usr/local/lib/codex/bin/codex' },
        ],
      }),
    });

    expect(resolved.schemaVersion).toBe(4);
    expect(resolved.control).toMatchObject({
      mode: 'sandbox-integration',
      bindings: {
        inference: {
          pathPrefix: '/inference/',
          tokenRef: 'runtime://openkit/inference-token',
        },
      },
    });
    expect(resolved.llm).toEqual({
      mode: 'gateway',
      preferredLogicalModelId: 'reasoning',
      routes: [
        expect.objectContaining({
          credentialVisibility: 'placeholder',
          endpoint: {
            kind: 'openai-compatible',
            upstream: {
              baseUrlRef: 'openkit-gateway',
              kind: 'nanocore-gateway',
            },
          },
          providerInstanceId: 'openkit-gateway',
        }),
      ],
    });
    expect(resolved.credentials.declarations).toEqual([]);
    expect(resolved.policy.network?.rules).toEqual([
      {
        action: 'allow',
        binaries: ['/usr/bin/git'],
        host: 'github.com',
        id: 'github-git-read',
        port: 443,
        protocol: 'rest',
        purpose: 'Clone and fetch Git repositories',
        rules: [
          { method: 'GET', path: '/**/info/refs*' },
          { method: 'POST', path: '/**/git-upload-pack' },
        ],
        scope: 'session',
      },
    ]);
    const baseBuildSetup = createTestSetup();
    const buildSetup = {
      ...baseBuildSetup,
      manifest: {
        ...baseBuildSetup.manifest,
        runtime: {
          ...baseBuildSetup.manifest.runtime,
          image: {
            arguments: { NODE_VERSION: '24.16.0' },
            contextRef: 'build-context://empty/v1',
            egress: [{ host: 'registry.npmjs.org', port: 443 }],
            input: { content: 'FROM node:24.16.0', kind: 'dockerfile' as const },
            kind: 'build' as const,
            layerLimit: 128,
            outputLimitBytes: 21_474_836_480,
            timeLimitSeconds: 1800,
          },
        },
      },
    };
    expect(
      resolveAgentEnvironmentPackage({ ...common, agentSetup: buildSetup }).runtime.image
    ).toMatchObject({
      contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      contextRef: 'build-context://empty/v1',
      egress: [{ host: 'registry.npmjs.org', port: 443 }],
      kind: 'build',
      layerLimit: 128,
      outputLimitBytes: 21_474_836_480,
      timeLimitSeconds: 1800,
    });
    expect(() =>
      resolveAgentEnvironmentPackage({
        ...common,
        agentSetup: {
          ...buildSetup,
          manifest: {
            ...buildSetup.manifest,
            runtime: {
              ...buildSetup.manifest.runtime,
              image: {
                ...buildSetup.manifest.runtime.image,
                contextRef: 'workspace://build-context',
              },
            },
          },
        },
      })
    ).toThrow();
    expect(
      resolveAgentEnvironmentPackage({
        ...common,
        agentSetup: createTestSetup({
          requiredCapabilities: ['worker.runtime-provenance.v1'],
        }),
      }).backend.requiredCapabilities
    ).toEqual(
      expect.arrayContaining(['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'])
    );
  });

  it('resolves catalog Skill supply onto the AgentSession-private worker-supply root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-skill-catalog-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const turn = createTurnFixture('Use catalog skill');
      const created = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo guidelines',
        expectedRevision: 0,
        producer: { id: 'user_local', kind: 'user' },
        tree: [
          {
            contentBase64: Buffer.from('# Hello\n', 'utf8').toString('base64'),
            kind: 'file',
            path: 'SKILL.md',
          },
        ],
        workspaceId: turn.workspaceId,
      });
      const resolved = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup({ skillIds: ['repo-guidelines'] }),
        agentSessionId: 'session_skill_1',
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: '2026-09-08T00:00:00.000Z',
        requestId: 'req_skill_1',
        turn,
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      });
      expect(resolved.supply.skills).toEqual([
        expect.objectContaining({
          id: 'repo-guidelines',
          integrity: { sha256: created.version.digest },
          materialization: {
            kind: 'filesystem-copy',
            targetPath: '/openkit/sessions/session_skill_1/supply/inputs/repo-guidelines',
          },
          target: '/openkit/sessions/session_skill_1/supply/inputs/repo-guidelines',
        }),
      ]);
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('resolves a pinned Skill digest instead of a later current version', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-skill-pin-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    try {
      const turn = createTurnFixture('Use pinned skill');
      const first = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:00:00.000Z',
        dataRoot,
        displayName: 'Repo guidelines',
        expectedRevision: 0,
        producer: { id: 'user_local', kind: 'user' },
        tree: [
          {
            contentBase64: Buffer.from('# v1\n', 'utf8').toString('base64'),
            kind: 'file',
            path: 'SKILL.md',
          },
        ],
        workspaceId: turn.workspaceId,
      });
      const pinned = setWorkspaceSkillPin({
        dataRoot,
        digest: first.version.digest,
        entryId: 'repo-guidelines',
        expectedRevision: first.catalog.revision,
        workspaceId: turn.workspaceId,
      });
      const second = importWorkspaceSkill({
        activate: true,
        createdAt: '2026-09-08T00:01:00.000Z',
        dataRoot,
        displayName: 'Repo guidelines',
        expectedRevision: pinned.revision,
        id: 'repo-guidelines',
        producer: { id: 'user_local', kind: 'user' },
        tree: [
          {
            contentBase64: Buffer.from('# v2\n', 'utf8').toString('base64'),
            kind: 'file',
            path: 'SKILL.md',
          },
        ],
        workspaceId: turn.workspaceId,
      });
      const resolved = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup({ skillIds: ['repo-guidelines'] }),
        agentSessionId: 'session_skill_pin',
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: '2026-09-08T00:02:00.000Z',
        requestId: 'req_skill_pin',
        turn,
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      });
      expect(second.catalog.skills.entries[0]?.currentDigest).toBe(second.version.digest);
      expect(resolved.supply.skills[0]?.integrity).toEqual({ sha256: first.version.digest });
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it.each([
    'codex',
    'pi',
    'opencode',
    'deepseek',
  ])('resolves selected MCP supply for %s without exposing its server topology', (adapter) => {
    const turn = createTurnFixture('Use static supply');
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestSetup({
        adapter,
        mcpIds: ['github'],
        skillIds: [],
      }),
      agentSessionId: 'session_supply_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_supply_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
      workspaceMcpServerCatalog: {
        schemaVersion: 1,
        servers: [
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            credentialBindings: [],
            deniedTools: [],
            enabled: true,
            id: 'github',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 60_000,
            transport: {
              args: ['fixtures/echo.mjs'],
              command: 'node',
              environment: {},
              kind: 'stdio',
            },
          },
        ],
      },
    });

    expect(resolved.supply.skills).toEqual([]);
    expect(resolved.supply.mcpServers).toEqual([
      expect.objectContaining({
        allowedTools: ['echo'],
        catalogDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        id: 'github',
        schemaPolicy: 'tracking',
      }),
      expect.objectContaining({
        catalogDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        id: 'openkit-generative',
        schemaPolicy: 'pinned',
      }),
      expect.objectContaining({
        allowedTools: [
          'work_request_input',
          'work_list_peers',
          'work_read_peer',
          'work_submit_artifact',
        ],
        catalogDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        id: 'openkit-work',
        schemaPolicy: 'pinned',
      }),
    ]);
    expect(resolved.supply.mcpServers[0]).not.toHaveProperty('command');
    expect(resolved.supply.mcpServers[0]).not.toHaveProperty('transport');
    expect(resolved.supply.mcpServers[0]).not.toHaveProperty('credentialBindings');
    expect(resolved.capabilities).toEqual({
      mode: 'enabled',
      protocol: 'openkit-worker-capability-v1',
      routes: ['mcp.list_servers', 'mcp.list_tools', 'mcp.call_tool'],
    });
    expect(resolved).not.toHaveProperty('providers');
  });

  it('projects one prepared worker Context Package through the existing generated context slot', () => {
    const turn = createTurnFixture('Use the prepared Context Package');
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestSetup(),
      agentSessionId: 'session_context_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      preparedContextPackage: {
        contentDigest,
        workspaceRoot: {
          access: 'read-only',
          id: `context_${turn.id}`,
          sourceKind: 'materialized-dir',
          sourcePath: '/private/context-package',
          workerPath: '/openkit/sessions/session_context_1/context',
        },
      },
      requestId: 'req_context_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(resolved.workspace.inputs).toEqual([
      {
        access: 'read-only',
        id: `context_${turn.id}`,
        kind: 'generated',
        materialization: {
          contentDigest,
          slotId: 'context',
          strategy: 'filesystem',
        },
        source: {
          kind: 'generated',
          pathRef: `threads/${turn.threadId}/turns/${turn.id}/context-package`,
        },
        target: '/openkit/sessions/session_context_1/context',
      },
    ]);
  });

  it('refuses an unsupported filesystem source without inspecting host Git', () => {
    expect(() =>
      resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup(),
        agentSessionId: 'session_filesystem',
        backend: { kind: 'openshell' },
        createdAt: '2026-07-18T00:00:00.000Z',
        requestId: 'req_filesystem',
        turn: createTurnFixture('Use an ordinary filesystem root'),
        triggerActor: USER_TRIGGER_ACTOR,
        workspaceCwd: null,
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'files',
            sourceKind: 'host-dir',
            sourcePath: '/unreachable/host',
            workerPath: '/workspace/openkit',
          },
        ],
      })
    ).toThrow(
      'Only credential-free remote Git sources can be materialized into a work slot in this release. Folder and other source kinds are not supported yet. Work without a source input still runs.'
    );
  });

  it('records catalog-resolved workspace lineage without inventing provider attachments', () => {
    const baseCommit = 'a'.repeat(40);
    const turn = createTurnFixture('Use a catalog source');
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestSetup(),
      agentSessionId: 'session_source_1',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_source_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: null,
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Main repository',
            id: 'main-repo',
            kind: 'git',
            locator: { commit: baseCommit, url: 'https://example.invalid/repository.git' },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'remote-git',
          sourceCommit: baseCommit,
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo: 'main-repo' },
      workerStorageWorkSlotRef: 'wsl_selected_predecessor',
    });

    expect(resolved.workspace.inputs[0]?.source).toMatchObject({
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      commit: baseCommit,
      sourceId: 'main-repo',
      sourceRef: 'main-repo',
    });
    expect(resolved.workspace).toMatchObject({
      root: '/workspace',
      inputs: [{ id: 'repo', target: '/workspace/worktrees/wsl_selected_predecessor' }],
      outputs: [
        { id: 'repo-output', path: '/workspace/worktrees/wsl_selected_predecessor' },
        { id: 'turn-output-root', path: '/openkit/sessions/session_source_1/outputs' },
      ],
    });
    expect(resolved.runtime.command.workingDirectory).toBe(
      '/workspace/worktrees/wsl_selected_predecessor'
    );
    expect(resolved.policy.filesystem?.rules).toContainEqual(
      expect.objectContaining({
        id: 'repo',
        workerPath: '/workspace/worktrees/wsl_selected_predecessor',
      })
    );
    expect(resolved).not.toHaveProperty('providers');
  });

  it('does not apply responsible-user identity to server-scoped Vault authority', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-direct-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';
    const declaration: AgentEnvironmentCredentialDeclaration = {
      id: 'anthropic_api_key',
      targetEnvVarName: 'ANTHROPIC_API_KEY',
      vaultGrantId: 'grant_anthropic_api_key',
      visibility: 'runtime-env',
    };
    const runtimeEnvCredentials: Array<{
      credentialValue: string;
      targetEnvVarName: string;
    }> = [];

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 21) });
    vaultUnlockState.backend().store({
      material: 'direct_secret_value',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_anthropic_api_key',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_anthropic_api_key',
      displayName: 'Anthropic API key',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_anthropic_api_key',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_anthropic_api_key',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_direct_1',
      vaultReferenceId: 'vault_anthropic_api_key',
    });

    try {
      const turn = createTurnFixture('Run Pi directly', coreDb, AUTOMATION_TRIGGER_ACTOR);
      prepareCredentialAttemptFixture(coreDb, turn, 'session_direct_1');
      const resolve = () =>
        resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSetup: createTestSetup({
            adapter: 'pi',
            credentialDeclarations: [declaration],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/node'],
                host: 'api.anthropic.com',
                id: 'anthropic-api',
                port: 443,
                protocol: 'rest',
              },
            ],
            logicalModelId: 'claude',
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_direct_1',
          backend: {
            kind: 'openshell',
          },
          coreDb,
          createdAt: now,
          requestId: 'req_direct_1',
          runtimeEnvCredentialSink: (credential) => runtimeEnvCredentials.push(credential),
          turn,
          triggerActor: AUTOMATION_TRIGGER_ACTOR,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        });
      const resolved = resolve();

      expect(resolved.llm).toEqual({
        mode: 'gateway',
        preferredLogicalModelId: 'claude',
        routes: [
          expect.objectContaining({
            credentialVisibility: 'placeholder',
            model: 'claude',
            providerInstanceId: 'openkit-gateway',
          }),
        ],
      });
      expect(resolved.policy.network?.rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            binaries: ['/usr/local/bin/node'],
            id: 'anthropic-api',
          }),
        ])
      );
      expect(resolved.vault.references[0]).not.toHaveProperty('providerInstanceId');
      expect(resolved.scope.triggerActor).toEqual(AUTOMATION_TRIGGER_ACTOR);
      expect(runtimeEnvCredentials).toEqual([
        {
          credentialValue: 'direct_secret_value',
          materialVersion: 1,
          vaultReferenceId: 'vault_anthropic_api_key',
          targetEnvVarName: 'ANTHROPIC_API_KEY',
        },
      ]);
      expect(JSON.stringify(resolved)).not.toContain('direct_secret_value');
      expect(listVaultInjectionPlans(coreDb)).toHaveLength(1);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toHaveLength(1);
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET input_ref = ? WHERE turn_id = ?')
        .run('aepsnap_wrong_package', turn.id);
      expect(resolve).toThrow(TurnStartValidationError);
      expect(runtimeEnvCredentials).toHaveLength(1);
      expect(listVaultInjectionPlans(coreDb)).toHaveLength(1);
      expect(listVaultUseRecords(coreDb)).toHaveLength(1);
      // A submitted Native process awaiting exact adoption has revoked mediated route authority.
      recordSchedulerExecutionOperation(coreDb, {
        attemptId: `lease_${turn.id}`,
        operationId: `submit:${turn.id}`,
        submission: true,
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        attemptId: `lease_${turn.id}`,
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
        heartbeatTimeoutMs: 30_000,
      });
      acceptNanoHostAttemptHeartbeat(coreDb, {
        attemptId: `lease_${turn.id}`,
        workerSequence: 1,
        heartbeatTimeoutMs: 30_000,
      });
      coreDb.sqlite
        .prepare(
          'UPDATE scheduler_execution_attempts SET input_ref = ?, recovery_state = ?, recovery_deadline = ? WHERE turn_id = ?'
        )
        .run(
          `aepsnap_${turn.id}_session_direct_1`,
          'awaiting-reconnect',
          '2099-01-01T00:00:00.000Z',
          turn.id
        );
      expect(
        resolveNanoHostAttemptTokenBinding(coreDb, {
          sandboxBindingRef: `lease-token:${turn.id}`,
          lineage: {
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.id,
            agentSessionId: 'session_direct_1',
            packageSnapshotId: `aepsnap_${turn.id}_session_direct_1`,
          },
        })
      ).toEqual({ status: 'rejected', reason: 'reconnect-required' });
      // Native mediated routes reject adoption independently; the generic AEP resolver owns Core phase authority.
      markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: `lease_${turn.id}`,
        cause: 'authority-revoked',
      });
      expect(resolve).toThrow(TurnStartValidationError);
      expect(runtimeEnvCredentials).toHaveLength(1);
      expect(listVaultInjectionPlans(coreDb)).toHaveLength(1);
      expect(listVaultUseRecords(coreDb)).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('materializes a Workspace-bound credential requirement without exposing its value', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-workspace-binding-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';
    const runtimeEnvCredentials: string[] = [];

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 24) });
    vaultUnlockState.backend().store({
      material: 'workspace_github_secret',
      metadata: { ownerScope: 'workspace', workspaceId: 'ws_demo' },
      referenceId: 'vault_workspace_github',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_workspace_github',
      displayName: 'Workspace GitHub token',
      now: () => now,
      ownerScope: 'workspace',
      referenceId: 'vault_workspace_github',
      secretKind: 'provider-api-key',
      workspaceId: 'ws_demo',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_workspace_github',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'workspace',
      targetAgentId: 'agent_codex_host',
      targetAgentSessionId: 'session_workspace_binding',
      vaultReferenceId: 'vault_workspace_github',
      workspaceId: 'ws_demo',
    });

    try {
      const turn = createTurnFixture('Use the Workspace GitHub account', coreDb);
      prepareCredentialAttemptFixture(coreDb, turn, 'session_workspace_binding');
      const resolved = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSetup: createTestSetup({
          credentialDeclarations: [
            {
              id: 'github_token',
              requirementId: 'github-token',
              targetEnvVarName: 'GITHUB_TOKEN',
              vaultGrantId: 'grant_workspace_github',
              visibility: 'runtime-env',
            },
          ],
          requiredCapabilities: [],
        }),
        agentSessionId: 'session_workspace_binding',
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: now,
        requestId: 'req_workspace_binding',
        runtimeEnvCredentialSink: (credential) =>
          runtimeEnvCredentials.push(credential.credentialValue),
        turn,
        triggerActor: USER_TRIGGER_ACTOR,
        vaultBackend: () => vaultUnlockState.backend(),
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      });

      expect(resolved.credentials.declarations).toEqual([
        expect.objectContaining({
          requirementId: 'github-token',
          vaultGrantId: 'grant_workspace_github',
        }),
      ]);
      expect(runtimeEnvCredentials).toEqual(['workspace_github_secret']);
      expect(JSON.stringify(resolved)).not.toContain('workspace_github_secret');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'scope',
    'version',
    'health',
  ] as const)('rejects a publicly minted Worker GitHub grant on Vault %s disagreement before Turn injection', async (failure) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-aep-public-github-${failure}-`));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const runtimeEnvCredentials: string[] = [];
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 27) });
    const app = createApp({ coreDb, dataRoot, vaultUnlockState });
    const post = (
      operation: 'vault.secret-create' | 'vault.grant-create',
      body: Record<string, unknown>
    ) =>
      app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const secretResponse = await post('vault.secret-create', {
        workspaceId: 'ws_demo',
        secretKind: 'github-token',
        material: 'public-worker-canary',
      });
      expect(secretResponse.status).toBe(200);
      const reference = await secretResponse.json();
      const grantResponse = await post('vault.grant-create', {
        workspaceId: 'ws_demo',
        referenceId: reference.referenceId,
        injectionPath: 'runtime-env',
      });
      expect(grantResponse.status).toBe(200);
      const grant = await grantResponse.json();
      if (failure === 'scope') {
        const backend = vaultUnlockState.backend();
        const listReferences = backend.listReferences.bind(backend);
        vi.spyOn(backend, 'listReferences').mockImplementation((scope) =>
          listReferences(scope).map((entry) =>
            entry.referenceId === reference.referenceId
              ? { ...entry, workspaceId: 'ws_other' }
              : entry
          )
        );
      } else if (failure === 'version') {
        vaultUnlockState.backend().rotate({
          referenceId: reference.referenceId,
          material: 'unprojected-worker-version',
        });
      } else {
        vaultUnlockState.lock();
      }
      const expectedError = {
        scope: 'Vault reference requires inspection before worker credential injection.',
        version: 'Vault reference requires inspection before worker credential injection.',
        health: 'Vault backend is unavailable for worker credential injection.',
      }[failure];
      const turn = createTurnFixture(`Reject ${failure} Worker grant`, coreDb);
      prepareCredentialAttemptFixture(coreDb, turn, 'session_public_github');
      expect(() =>
        resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSetup: createTestSetup({
            credentialDeclarations: [
              {
                id: 'github_token',
                requirementId: 'github-token',
                targetEnvVarName: 'GITHUB_TOKEN',
                vaultGrantId: grant.grantId,
                visibility: 'runtime-env',
              },
            ],
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_public_github',
          backend: { kind: 'openshell' },
          coreDb,
          createdAt: '2026-07-18T00:00:00.000Z',
          requestId: `req_public_github_${failure}`,
          runtimeEnvCredentialSink: (credential) =>
            runtimeEnvCredentials.push(credential.credentialValue),
          turn,
          triggerActor: USER_TRIGGER_ACTOR,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow(expectedError);
      expect(runtimeEnvCredentials).toEqual([]);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      coreDb.sqlite.close();
    }
  });

  it('previews nonmember administrator credentials without effects and denies a revoked bearer', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-compatibility-preview-'));
    const coreDb = openCoreDb(dataRoot);
    const now = '2026-07-18T00:00:00.000Z';
    const declaration: AgentEnvironmentCredentialDeclaration = {
      id: 'preview_api_key',
      targetEnvVarName: 'PREVIEW_API_KEY',
      vaultGrantId: 'grant_preview_api_key',
      visibility: 'runtime-env',
    };
    const agentSetup = createTestSetup({
      adapter: 'pi',
      credentialDeclarations: [declaration],
      network: [
        {
          access: 'read-write',
          binaries: ['/usr/local/bin/node'],
          host: 'api.example.invalid',
          id: 'preview-api',
          port: 443,
          protocol: 'rest',
        },
      ],
      logicalModelId: 'preview-model',
      requiredCapabilities: [],
    });
    let sinkCalls = 0;
    let vaultBackendCalls = 0;

    applyMigrations(coreDb);
    const triggerActor = { kind: 'user', id: 'user_admin_preview' } as const;
    coreDb.sqlite
      .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
      VALUES (?, 'Preview Admin', 'preview-admin@example.test', false, ?, ?, 'human', 'active')`)
      .run(triggerActor.id, Date.parse(now), Date.parse(now));
    createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: triggerActor.id,
      scope: 'server-admin',
      tokenId: 'token_admin_preview',
      workspaceIds: [],
    });
    const turn = createTurnFixture(
      'Preview compatibility without effects',
      coreDb,
      triggerActor,
      'token_admin_preview'
    );
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_preview_api_key',
      displayName: 'Preview API key',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_preview_api_key',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_preview_api_key',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_preview_1',
      vaultReferenceId: 'vault_preview_api_key',
    });

    try {
      const compatibilityKey = resolveAgentSessionCompatibilityKey({
        agentSessionId: 'session_preview_1',
        agentSetup,
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: now,
        requestId: 'req_preview_1',
        runtimeEnvCredentialSink: () => {
          sinkCalls += 1;
        },
        turn,
        triggerActor,
        vaultBackend: () => {
          vaultBackendCalls += 1;
          throw new Error('Compatibility preview must not resolve the Vault backend.');
        },
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      } as Parameters<typeof resolveAgentSessionCompatibilityKey>[0]);
      const metadataPackage = resolveAgentEnvironmentPackageMetadata({
        agentSessionId: 'session_preview_1',
        agentSetup,
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: now,
        requestId: 'req_preview_1',
        turn,
        triggerActor,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      });

      expect(compatibilityKey).toMatch(/^sha256:/);
      expect(
        (
          metadataPackage.extensions.openkit as {
            sessionWorkspace: SessionWorkspaceMaterializationPlan;
          }
        ).sessionWorkspace.compatibilityKey.digest
      ).toBe(compatibilityKey);
      expect(sinkCalls).toBe(0);
      expect(vaultBackendCalls).toBe(0);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
      revokeOpenKitAccessTokenRecord(coreDb, 'token_admin_preview', new Date(now));
      expect(() =>
        resolveAgentEnvironmentPackageMetadata({
          agentSessionId: 'session_preview_1',
          agentSetup,
          backend: { kind: 'openshell' },
          coreDb,
          createdAt: now,
          requestId: 'req_preview_1',
          turn,
          triggerActor,
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow(TurnStartValidationError);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
      const keyForContextDigest = (character: string) => {
        const environmentPackage = resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSessionId: 'session_context_digest',
          agentSetup: createTestSetup(),
          backend: { kind: 'openshell' },
          createdAt: now,
          preparedContextPackage: {
            contentDigest: `sha256:${character.repeat(64)}`,
            workspaceRoot: {
              access: 'read-only',
              id: `context_${turn.id}`,
              sourceKind: 'materialized-dir',
              sourcePath: `/private/context-${character}`,
              workerPath: '/openkit/sessions/session_context_digest/context',
            },
          },
          requestId: 'req_context_digest',
          turn,
          triggerActor: AUTOMATION_TRIGGER_ACTOR,
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        });
        return (
          environmentPackage.extensions.openkit as {
            sessionWorkspace: SessionWorkspaceMaterializationPlan;
          }
        ).sessionWorkspace.compatibilityKey.digest;
      };
      expect(keyForContextDigest('a')).toBe(keyForContextDigest('b'));
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies stale AEP authority before Vault resolution or injection side effects', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-vault-authority-'));
    const coreDb = openCoreDb(dataRoot);
    const now = '2026-07-18T00:00:00.000Z';
    let backendCalls = 0;
    const runtimeEnvCredentials: string[] = [];

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_stale_authority',
      displayName: 'Stale authority credential',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_stale_authority',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_stale_authority',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_stale_authority',
      vaultReferenceId: 'vault_stale_authority',
    });
    coreDb.sqlite
      .prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(Date.parse(now), 'user_local');

    try {
      let error: unknown;
      try {
        resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSetup: createTestSetup({
            credentialDeclarations: [
              {
                id: 'stale_authority',
                targetEnvVarName: 'STALE_AUTHORITY_SECRET',
                vaultGrantId: 'grant_stale_authority',
                visibility: 'runtime-env',
              },
            ],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/codex'],
                host: 'api.example.test',
                id: 'stale-authority-api',
                port: 443,
                protocol: 'rest',
              },
            ],
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_stale_authority',
          backend: {
            kind: 'openshell',
          },
          coreDb,
          createdAt: now,
          requestId: 'req_stale_authority',
          runtimeEnvCredentialSink: (credential) =>
            runtimeEnvCredentials.push(credential.credentialValue),
          turn: createTurnFixture('Reject stale Vault authority'),
          triggerActor: USER_TRIGGER_ACTOR,
          vaultBackend: () => {
            backendCalls += 1;
            throw new Error('Vault backend must not be resolved after authority loss.');
          },
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(TurnStartValidationError);
      expect(error).toMatchObject({ code: 'workspace_access_denied', status: 403 });
      expect(backendCalls).toBe(0);
      expect(runtimeEnvCredentials).toEqual([]);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expectedError: 'Credential requirement binding must use a Workspace grant: scope_user',
      grantTarget: {},
      name: 'user',
      referenceScope: { ownerScope: 'user' as const, userId: 'user_other' },
      triggerActor: AUTOMATION_TRIGGER_ACTOR,
    },
    {
      expectedError: 'Credential requirement binding must use a Workspace grant: scope_workspace',
      grantTarget: {},
      name: 'workspace',
      referenceScope: { ownerScope: 'workspace' as const, workspaceId: 'ws_other' },
      triggerActor: USER_TRIGGER_ACTOR,
    },
    {
      expectedError: 'Vault grant targets a different agent: scope_agent',
      grantTarget: { targetAgentId: 'agent_other' },
      name: 'agent',
      referenceScope: { ownerScope: 'server' as const },
      triggerActor: USER_TRIGGER_ACTOR,
    },
    {
      expectedError: 'Vault grant targets an unproven capability: scope_capability',
      grantTarget: { targetCapabilityId: 'mcp.github.call_tool' },
      name: 'capability',
      referenceScope: { ownerScope: 'server' as const },
      triggerActor: USER_TRIGGER_ACTOR,
    },
  ])('rejects a mismatched $name credential grant before sinks or injection records', ({
    expectedError,
    grantTarget,
    name,
    referenceScope,
    triggerActor,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-aep-scope-${name}-`));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';
    const declarationId = `scope_${name}`;
    const referenceId = `vault_${declarationId}`;
    const grantId = `grant_${declarationId}`;
    const runtimeEnvCredentials: string[] = [];

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 23) });
    vaultUnlockState.backend().store({
      material: `secret_${name}`,
      metadata: referenceScope,
      referenceId,
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: `encrypted-file://server/vault/${referenceId}`,
      displayName: `${name} scope credential`,
      now: () => now,
      ...referenceScope,
      referenceId,
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId,
      lifetime: 'agent-session',
      now: () => now,
      ...referenceScope,
      ...grantTarget,
      targetAgentSessionId: 'session_scope_1',
      vaultReferenceId: referenceId,
    });

    try {
      expect(() =>
        resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSetup: createTestSetup({
            credentialDeclarations: [
              {
                id: declarationId,
                ...(name === 'user' || name === 'workspace'
                  ? { requirementId: `requirement_${name}` }
                  : {}),
                targetEnvVarName: 'SCOPE_SECRET',
                vaultGrantId: grantId,
                visibility: 'runtime-env',
              },
            ],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/codex'],
                host: 'api.example.test',
                id: 'scope-api',
                port: 443,
                protocol: 'rest',
              },
            ],
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_scope_1',
          backend: {
            kind: 'openshell',
          },
          coreDb,
          createdAt: now,
          requestId: `req_scope_${name}`,
          runtimeEnvCredentialSink: (credential) =>
            runtimeEnvCredentials.push(credential.credentialValue),
          turn: createTurnFixture(`Reject ${name} scope`),
          triggerActor,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow(expectedError);
      expect(runtimeEnvCredentials).toEqual([]);
      expect(listVaultInjectionPlans(coreDb)).toEqual([]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('writes no receipt when a credential sink fails after Vault resolution', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-aep-direct-sink-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const now = '2026-07-18T00:00:00.000Z';

    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({
      coreDb,
      now: new Date(now),
      ownerUserId: 'user_local',
      workspaceId: 'ws_demo',
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 22) });
    vaultUnlockState.backend().store({
      material: 'missing_sink_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_missing_sink',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_missing_sink',
      displayName: 'Missing sink credential',
      now: () => now,
      ownerScope: 'server',
      referenceId: 'vault_missing_sink',
      secretKind: 'provider-api-key',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_missing_sink',
      lifetime: 'agent-session',
      now: () => now,
      ownerScope: 'server',
      targetAgentSessionId: 'session_missing_sink',
      vaultReferenceId: 'vault_missing_sink',
    });

    try {
      const turn = createTurnFixture('Reject missing sink', coreDb, AUTOMATION_TRIGGER_ACTOR);
      prepareCredentialAttemptFixture(coreDb, turn, 'session_missing_sink');
      expect(() =>
        resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSetup: createTestSetup({
            adapter: 'pi',
            credentialDeclarations: [
              {
                id: 'missing_sink',
                targetEnvVarName: 'ANTHROPIC_API_KEY',
                vaultGrantId: 'grant_missing_sink',
                visibility: 'runtime-env',
              },
            ],
            network: [
              {
                access: 'read-write',
                binaries: ['/usr/local/bin/node'],
                host: 'api.anthropic.com',
                id: 'anthropic-api',
                port: 443,
                protocol: 'rest',
              },
            ],
            logicalModelId: 'claude',
            requiredCapabilities: [],
          }),
          agentSessionId: 'session_missing_sink',
          backend: {
            kind: 'openshell',
          },
          coreDb,
          createdAt: now,
          requestId: 'req_missing_sink',
          runtimeEnvCredentialSink: () => {
            throw new Error('credential sink failed');
          },
          turn,
          triggerActor: AUTOMATION_TRIGGER_ACTOR,
          vaultBackend: () => vaultUnlockState.backend(),
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      ).toThrow('credential sink failed');
      expect(listVaultInjectionPlans(coreDb)).toHaveLength(1);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      expect(listVaultUseRecords(coreDb)).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects retired backend-local inference inputs', () => {
    const turn = createTurnFixture('Reject backend-local inference');
    const common = {
      captureCoverage: { scope: 'server', value: 'off' } as const,
      agentSessionId: 'session_backend_local_1',
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_backend_local_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    };

    expect(() =>
      resolveAgentEnvironmentPackage({
        ...common,
        agentSetup: createTestSetup({ requiredCapabilities: ['backend-local-inference'] }),
        backend: {
          inferenceBaseUrl: 'https://inference.local/v1',
          kind: 'openshell',
          workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
        } as never,
      })
    ).toThrow();
  });

  it('preserves the manifest network grant exact binary scope', () => {
    const turn = createTurnFixture('Use a declared public endpoint');
    const setup = createTestSetup({
      network: [
        {
          host: 'docs.example.com',
          id: 'public-docs',
          port: 443,
          purpose: 'Read public documentation',
          binaries: ['/usr/local/bin/codex'],
        },
      ],
      requiredCapabilities: ['backend-local-inference'],
    });
    const resolved = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'session_network_defaults_1',
      agentSetup: setup,
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      requestId: 'req_network_defaults_1',
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(resolved.policy.network?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binaries: ['/usr/local/bin/codex'],
          id: 'public-docs',
        }),
      ])
    );
  });
});

describe('public network AEP admission', () => {
  const network = [
    {
      id: 'public-search',
      host: 'search.example.com',
      port: 443,
      protocol: 'rest' as const,
      purpose: 'Public search',
      scope: 'session' as const,
      binaries: ['/usr/local/bin/node'],
      rules: [{ method: 'POST' as const, path: '/mcp' }],
      publicAccess: { kind: 'credential-free-non-llm' as const },
    },
  ];

  it('admits public grants through the boot-supplied runtime and observes active configuration reload', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-public-boot-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const store = createDemoStore({ dataRoot });
    const turn = createTurnFixture('Public boot admission', coreDb);
    const agentSetup = createTestSetup({ network });
    const gatewayConfig = createTestGatewayConfig({
      logicalModelId: 'reasoning',
      privateRoute: { providerProfileId: 'agent-openrouter', providerModel: 'openai/gpt-5.1' },
    });
    const provider = {
      id: 'agent-openrouter',
      vendor: 'openrouter',
      kind: 'gateway' as const,
      displayName: 'Gateway',
      baseUrl: 'https://provider.example.com/v1',
      models: ['openai/gpt-5.1'],
    };
    const manager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot,
        openKitConfig: { mode: 'local' },
        agentManifests: [agentSetup.manifest],
        gatewayConfig,
        providerRegistry: new ProviderRegistry([provider]),
      }),
    });
    const reads = vi.spyOn(manager, 'current');
    // Evaluate the actual boot call, rather than reproducing its option list in the test.
    const source = createSourceFile(
      'index.ts',
      readFileSync(new URL('../index.ts', import.meta.url), 'utf8'),
      ScriptTarget.Latest,
      true
    );
    const calls: string[] = [];
    const visit = (node: Node): void => {
      if (
        isCallExpression(node) &&
        node.expression.getText(source) === 'createConfiguredWorkerLifecycleRuntime'
      )
        calls.push(node.getText(source));
      forEachChild(node, visit);
    };
    visit(source);
    expect(calls).toHaveLength(1);
    const javascript = transpileModule(
      `const runtime = ${calls[0]}; const runtimeConfigManager = manager; return runtime;`,
      { compilerOptions: { target: ScriptTarget.ES2022 } }
    ).outputText;
    const runtime = new Function(
      'createConfiguredWorkerLifecycleRuntime',
      'manager',
      'recoveryCoreDb',
      'recoveryStore',
      'nanoHostSessionDispatch',
      'vaultUnlockState',
      'requireBootValue',
      'bootWorkerControlGateway',
      'workspaceMutationAdmission',
      javascript
    )(
      createConfiguredWorkerLifecycleRuntime,
      manager,
      coreDb,
      store,
      undefined,
      undefined,
      (value: unknown) => value,
      undefined,
      undefined
    ) as ReturnType<typeof createConfiguredWorkerLifecycleRuntime>;
    expect(reads).not.toHaveBeenCalled();
    const preview = runtime.turnExecutor as unknown as {
      previewAgentEnvironmentPackage: (
        id: string,
        input: PrepareAgentSessionForTurnInput
      ) => ReturnType<typeof resolveAgentEnvironmentPackageMetadata>;
    };
    const input: PrepareAgentSessionForTurnInput = {
      agentSetup,
      freshAgentSessionId: 'session_public_boot',
      requestId: null,
      turn,
      turnInput: 'Public boot admission',
      workspaceCwd: null,
      workspaceRoots: [],
    };
    try {
      createApp({
        coreDb,
        dataRoot,
        store,
        mode: 'local',
        runtimeConfigManager: manager,
        workerLifecycleRuntime: runtime,
        turnExecutor: runtime.turnExecutor,
      });
      expect(
        preview.previewAgentEnvironmentPackage(input.freshAgentSessionId, input).policy.network
          ?.rules
      ).toContainEqual({ ...network[0], action: 'allow' });
      expect(reads).toHaveBeenCalled();
      mkdirSync(join(dataRoot, 'config', 'agents'), { recursive: true });
      mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
      writeFileSync(
        join(dataRoot, 'config', 'agents', 'public.agent.jsonc'),
        JSON.stringify({
          ...agentSetup.manifest,
          sandbox: { ...agentSetup.manifest.sandbox, network: [] },
        })
      );
      writeFileSync(
        join(dataRoot, 'config', 'providers', 'agent-openrouter.provider.jsonc'),
        JSON.stringify(provider)
      );
      writeFileSync(join(dataRoot, 'config', 'gateway.jsonc'), JSON.stringify(gatewayConfig));
      const version = manager.current().version;
      expect(manager.reload({ dryRun: false, mode: 'safe' }).status).toBe('applied');
      expect(manager.current().version).toBeGreaterThan(version);
      expect(() =>
        preview.previewAgentEnvironmentPackage(input.freshAgentSessionId, input)
      ).toThrow(/removed or changed/i);
    } finally {
      reads.mockRestore();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('preserves immutable public evidence and rechecks current grant removal and actor revocation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-public-grant-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      tokenId: 'token_public',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const turn = createTurnFixture('Public endpoint', coreDb, USER_TRIGGER_ACTOR, 'token_public');
    const agentSetup = createTestSetup({ network });
    const current: PublicNetworkConfiguration = {
      agentManifests: [agentSetup.manifest],
      gatewayConfig: {
        schemaVersion: 1 as const,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        requiredFeatures: [],
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction' as const, compactThreshold: 8000 }],
            routes: [
              {
                id: 'primary',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.1',
              },
            ],
          },
        ],
      },
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          vendor: 'openrouter',
          kind: 'gateway',
          displayName: 'Gateway',
          baseUrl: 'https://provider.example.com/v1',
          models: ['openai/gpt-5.1'],
        },
      ]),
      openKitConfig: { mode: 'local' as const },
      workspaceConfigs: [],
      workspaceMcpServerCatalogs: [],
    };
    const input = {
      agentSetup,
      agentSessionId: 'session_public',
      backend: { kind: 'openshell' as const },
      coreDb,
      captureCoverage: { scope: 'server' as const, value: 'off' as const },
      turn,
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
      readRuntimeConfig: () => current,
    };
    try {
      const preview = resolveAgentEnvironmentPackageMetadata(input);
      expect(preview.policy.network?.rules).toContainEqual({ ...network[0], action: 'allow' });
      prepareCredentialAttemptFixture(coreDb, turn, 'session_public');
      const resolved = resolveAgentEnvironmentPackage(input);
      const canonicalBytes = JSON.stringify(resolved);
      const uppercaseSetup = createTestSetup({
        network: [{ ...network[0]!, host: 'SEARCH.EXAMPLE.COM.' }],
      });
      expect(() =>
        resolveAgentEnvironmentPackage({ ...input, agentSetup: uppercaseSetup })
      ).not.toThrow();
      expect(
        resolveAgentEnvironmentPackage({ ...input, agentSetup: uppercaseSetup }).policy.network
          ?.rules
      ).toContainEqual({ ...network[0], action: 'allow' });

      const staleSetup = createTestSetup({
        network: [
          ...network,
          {
            id: 'stale-broader',
            host: network[0]!.host,
            port: 443,
            protocol: 'rest',
            purpose: 'Stale broad route',
            scope: 'session',
            binaries: ['/usr/local/bin/node'],
            access: 'read-write',
          },
        ],
      });
      expect(() => resolveAgentEnvironmentPackage({ ...input, agentSetup: staleSetup })).toThrow(
        /overlap/i
      );

      current.agentManifests = [staleSetup.manifest];
      expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/overlap/i);
      current.agentManifests = [agentSetup.manifest];

      expect(resolved.policy.network?.rules).toContainEqual({ ...network[0], action: 'allow' });
      const compatibilityKey = resolveAgentSessionCompatibilityKey(input);
      const { publicAccess: _publicAccess, ...ordinary } = network[0]!;

      expect(
        resolveAgentSessionCompatibilityKey({
          ...input,
          agentSetup: createTestSetup({ network: [ordinary] }),
        })
      ).not.toBe(compatibilityKey);

      expect(() =>
        resolveAgentEnvironmentPackage({ ...input, readRuntimeConfig: undefined })
      ).toThrow(/metadata is required/i);

      current.agentManifests = [];
      expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/current Agent authority/i);
      current.agentManifests = [agentSetup.manifest];
      const currentGateway = current.gatewayConfig;
      current.gatewayConfig = { ...currentGateway, logicalModels: [] };
      expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/current setup metadata/i);
      current.gatewayConfig = currentGateway;
      current.agentManifests = [
        createTestSetup({
          network: [{ ...network[0]!, rules: [{ method: 'POST', path: '/other' }] }],
        }).manifest,
      ];
      expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/removed or changed/i);
      current.agentManifests = [agentSetup.manifest];
      for (const config of [
        { mode: 'local' as const, server: { publicBaseUrl: 'https://search.example.com' } },
        { mode: 'local' as const, server: { bind: { host: 'search.example.com' } } },
        {
          mode: 'local' as const,
          nanohost: { rendezvousUrl: 'https://search.example.com/control' },
        },
        {
          mode: 'local' as const,
          nanohost: {
            rendezvousUrl: 'https://other.example.com/control',
            bind: { host: 'search.example.com', port: 7443 },
          },
        },
      ]) {
        current.openKitConfig = config as PublicNetworkConfiguration['openKitConfig'];
        expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/excluded/i);
      }
      current.openKitConfig = { mode: 'local' };

      current.agentManifests = [createTestSetup().manifest];

      expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/Public network/i);
      expect(() => resolveAgentEnvironmentPackageMetadata(input)).toThrow(/Public network/i);
      current.agentManifests = [agentSetup.manifest];
      current.providerRegistry = new ProviderRegistry([
        {
          id: 'agent-openrouter',
          vendor: 'openrouter',
          kind: 'gateway',
          displayName: 'Gateway',
          baseUrl: 'https://search.example.com/llm',
          models: ['openai/gpt-5.1'],
        },
      ]);
      expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/excluded/i);
      current.providerRegistry = new ProviderRegistry([
        {
          id: 'agent-openrouter',
          vendor: 'openrouter',
          kind: 'gateway',
          displayName: 'Gateway',
          baseUrl: 'https://provider.example.com/v1',
          models: ['openai/gpt-5.1'],
        },
      ]);
      expect(resolveAgentSessionCompatibilityKey(input)).toBe(compatibilityKey);
      revokeOpenKitAccessTokenRecord(coreDb, 'token_public', new Date());

      expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/authority/i);
      expect(JSON.stringify(resolved)).toBe(canonicalBytes);
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses missing current admission metadata without falling back to ordinary grants', () => {
    const input = {
      captureCoverage: { scope: 'server' as const, value: 'off' as const },
      agentSetup: createTestSetup({ network }),
      agentSessionId: 'session_public_missing',
      backend: { kind: 'openshell' as const },
      turn: createTurnFixture('No current metadata'),
      triggerActor: USER_TRIGGER_ACTOR,
      workspaceRoots: [],
    };
    expect(() => resolveAgentEnvironmentPackage(input)).toThrow(/Public network/i);
  });
});

it.each([
  { effort: 'none' as const, levels: ['none', 'high'], expected: ['none', 'high'] },
  { effort: undefined, levels: [], expected: [] },
  { effort: undefined, levels: undefined, expected: undefined },
] as const)('projects only recorded Turn effort and advertised model levels into immutable package bytes: %j', ({
  effort,
  levels,
  expected,
}) => {
  const setup = createTestSetup();
  const model = {
    ...setup.logicalModels.allowed[0]!,
    ...(levels !== undefined ? { reasoningEffortLevels: levels } : {}),
  };
  const input = {
    agentSetup: {
      ...setup,
      manifest: {
        ...setup.manifest,
        models: { ...setup.manifest.models, reasoningEffort: 'max' as const },
      },
      logicalModels: { ...setup.logicalModels, allowed: [model] },
    },
    agentSessionId: 'session_effort',
    backend: { kind: 'openshell' as const },
    turn: {
      ...createTurnFixture('Effort projection'),
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    },
    triggerActor: USER_TRIGGER_ACTOR,
    workspaceRoots: [],
    captureCoverage: { scope: 'server' as const, value: 'off' as const },
  };
  const resolved = resolveAgentEnvironmentPackage(input);
  const bytes = JSON.stringify(resolved);
  expect(JSON.parse(bytes).llm).toEqual(resolved.llm);
  if (effort === undefined) expect(resolved.llm).not.toHaveProperty('reasoningEffort');
  else expect(resolved.llm).toHaveProperty('reasoningEffort', effort);
  if (expected === undefined)
    expect(resolved.llm.routes[0]).not.toHaveProperty('reasoningEffortLevels');
  else expect(resolved.llm.routes[0]).toHaveProperty('reasoningEffortLevels', expected);
  expect(resolveAgentSessionCompatibilityKey(input)).toBe(
    resolveAgentSessionCompatibilityKey({
      ...input,
      turn: { ...input.turn, reasoningEffort: 'high' },
    })
  );
});
