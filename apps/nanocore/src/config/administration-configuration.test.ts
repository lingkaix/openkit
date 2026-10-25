import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  allocateEntityId,
  deriveEntityId,
  type PolicyBindingV1,
  type PolicyDocumentV1,
  PolicyDocumentV1Schema,
  writeRetainedV1,
} from '@openkit/protocol';
import { LocalStorage } from '@openkit/storage';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdministrationConfigurationTools } from '../administration/configuration-tools.js';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  currentWorkspaceAuthority,
  isCurrentServerPolicyAuthor,
} from '../auth/operation-authorizer.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createMcpConfig, updateMcpBinding } from '../catalog/resource-catalog.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import * as policyConfiguration from '../policy/configuration.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import {
  applyMcpToolProhibitions,
  selectMcpToolPermissions,
} from '../policy/mcp-tool-permissions.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { evaluateAdministratorWorkspaceAccess } from '../policy/server-access.js';
import { policyDigest } from '../policy/statements.js';
import { recordMcpToolSchemaSnapshot } from '../runtime/mcp-tool-schema-snapshots.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createAdministrationConfiguration } from './administration-configuration.js';
import { readDefaultKnowledgeBaseId } from './knowledge-base.js';
import { createRuntimeConfigManager } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const cleanup: (() => void)[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const fn of cleanup.splice(0)) fn();
});

/** Real temporary configuration, private Artifact store and current durable token authority. */
async function fixture(withWorkspaceSchemas = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-proposal-'));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    tokenId: allocateEntityId('tok'),
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: 'usr_00000000-0000-7000-8000-000000000001',
    tokenId: token.tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
  };
  const store = await createDemoStore({ dataRoot });
  const workspaceId = quickChatWorkspaceIdForUser(actor.userId);
  const thread = await store.createThread(
    workspaceId,
    'Catalog update',
    allocateEntityId('th'),
    'administration',
    { visibility: 'private', privateOwnerUserId: actor.userId }
  );
  const turn = await store.createTurn(
    workspaceId,
    thread.id,
    'Update catalog',
    { kind: 'user', id: actor.userId },
    null
  );
  const home = { threadId: thread.id, turnId: turn.id, requestId: randomUUID() };
  const provider = {
    id: 'codex',
    vendor: 'openai-codex',
    kind: 'oauth',
    displayName: 'Codex',
    models: ['gpt-5'],
    modelMetadata: { 'gpt-5': { limit: { context: 200000, output: 10000 }, tool_call: true } },
    extensions: {
      openkit: { subscriptionAccount: { accountSlotId: 'primary' } },
      private: { path: '/private/provider-account' },
    },
  };
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  writeFileSync(join(dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const providerPath = join(dataRoot, 'config/providers/catalog.provider.jsonc');
  writeFileSync(providerPath, JSON.stringify(writeRetainedV1(provider)));
  const logicalModel = {
    id: 'reasoning',
    displayName: 'Reasoning',
    contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
    routes: [{ id: 'primary', providerProfileId: 'codex', providerModel: 'gpt-5' }],
  };
  const gatewayPath = join(dataRoot, 'config/gateway.jsonc');
  writeFileSync(
    gatewayPath,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [logicalModel],
      defaultLogicalModelId: 'reasoning',
    })
  );
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId: actor.userId,
    workspaceIds: [workspaceId],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const workspaceDb = withWorkspaceSchemas ? openWorkspaceDb(dataRoot, workspaceId) : null;
  if (workspaceDb) {
    applyScopedMigrations(workspaceDb);
    cleanup.unshift(() => workspaceDb.sqlite.close());
    await openTestNativeWorkspace(workspaceDb);
  }
  const reload = vi.fn(() => manager.reload({ mode: 'safe', dryRun: false }));
  const inflightCommands = new WeakMap();
  const options = {
    actor,
    coreDb,
    store,
    files,
    reload,
    inflightCommands,
    runtimeConfig: () => manager.current(),
    repositoryWorkspaceDb: () => {
      if (!workspaceDb) throw new Error('Catalog tests use no retained Worker snapshot.');
      return workspaceDb;
    },
  };
  const service = createAdministrationConfiguration(options);
  const request = {
    targetFamily: 'provider' as const,
    targetId: 'codex',
    expectedRevision: files.readFile('providers/catalog.provider.jsonc').file.revision!,
    changes: {
      models: ['gpt-5', 'gpt-6'],
      modelMetadata: {
        ...provider.modelMetadata,
        'gpt-6': { limit: { context: 200000, output: 10000 }, tool_call: true },
      },
    },
  };
  const confirm = (proposal: Awaited<ReturnType<typeof service.propose>>) => ({
    requestId: randomUUID(),
    candidate: proposal.candidate,
    confirmation: proposal.confirmation,
  });
  return {
    ...options,
    dataRoot,
    home,
    manager,
    provider,
    providerPath,
    gatewayPath,
    logicalModel,
    service,
    request,
    confirm,
    token,
    workspaceId,
    turn,
  };
}

/** Composes retained catalog supply, the real AEP producer, and current schema observations. */
async function mcpPolicyFixture(observed = true) {
  const f = await fixture(true);
  const owner = { kind: 'workspace' as const, workspaceId: f.workspaceId };
  const created = createMcpConfig({
    dataRoot: f.dataRoot,
    owner,
    expectedRevision: 0,
    id: 'issues',
    displayName: 'Issues',
    createdAt: new Date().toISOString(),
    allowedTools: ['read'],
    selectCurrent: true,
    declaration: { kind: 'http', endpoint: 'https://mcp.example.test/mcp' },
  });
  updateMcpBinding({
    dataRoot: f.dataRoot,
    owner,
    entryId: 'issues',
    expectedRevision: created.catalog.revision,
    binding: { ...created.catalog.mcp.bindings[0]!, enabled: true },
  });
  f.manager.reload({ mode: 'safe', dryRun: false });
  const catalog = f.manager
    .current()
    .workspaceMcpServerCatalogs.find((entry) => entry.workspaceId === f.workspaceId)!.catalog;
  const environmentPackage = resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: allocateEntityId('as'),
    agentSetup: createTestAgentSetup({ mcpIds: ['issues'] }),
    backend: { kind: 'openshell' },
    createdAt: new Date().toISOString(),
    requestId: 'req_mcp_policy_schema',
    triggerActor: f.turn.triggerActor,
    turn: f.turn,
    workspaceCwd: '/workspace',
    workspaceMcpServerCatalog: catalog,
    workspaceRoots: [],
  });
  const observe = async (tools: Array<{ name: string; inputSchema: Record<string, unknown> }>) =>
    await recordMcpToolSchemaSnapshot({
      environmentPackage,
      schemaSnapshotId: `schema_${randomUUID()}`,
      serverId: 'issues',
      source: 'live',
      tools,
      workspaceDb: f.repositoryWorkspaceDb(),
      workspaceId: f.workspaceId,
    });
  if (observed) await observe([{ name: 'read', inputSchema: { type: 'object' } }]);
  const policyRequest = (
    toolName = 'read',
    effect: 'prohibit' | 'require_approval' = 'require_approval'
  ) => ({
    targetFamily: 'policy' as const,
    targetId: 'server',
    expectedRevision: f.files.readFile('server.jsonc').file.revision!,
    changes: {
      rationale: 'Require a human decision for this exact Workspace Tool.',
      proposed: {
        schemaVersion: 1,
        statements: [
          {
            id: 'human-tool-condition',
            kind: 'permission',
            effect,
            grant: { kind: 'ordinary' },
            author: { kind: 'human', id: f.actor.userId },
            authority: { kind: 'human', userId: f.actor.userId },
            authoredAt: new Date().toISOString(),
            state: 'active',
            scope: {
              subjects: [{ kind: 'human', id: f.actor.userId }],
              actions: ['tool.use'],
              resources: [
                { kind: 'mcp-tool', workspaceId: f.workspaceId, serverId: 'issues', toolName },
              ],
            },
            lifetime: { anchor: { owner, kind: 'workspace', id: f.workspaceId } },
          },
        ],
      },
    },
  });
  return { ...f, observe, policyRequest };
}

/** Builds the supported active binding without performing discovery or credential access. */
function activePolicyDocument(
  f: Awaited<ReturnType<typeof fixture>>,
  workspaceId = f.workspaceId
): PolicyDocumentV1 {
  const principal = { kind: 'human' as const, id: f.actor.userId };
  const scope = {
    subjects: [principal],
    actions: ['tool.use'],
    resources: [{ kind: 'mcp-tool' as const, workspaceId, serverId: 'issues', toolName: 'read' }],
  };
  return {
    schemaVersion: 1,
    statements: [
      {
        id: 'current-input',
        kind: 'binding',
        author: principal,
        authority: { kind: 'human', userId: f.actor.userId },
        authoredAt: '2026-10-18T00:00:00Z',
        state: 'active',
        scope,
        lifetime: {
          anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId },
        },
        operation: 'mcp.call-tool',
        stage: 'decide',
        mode: 'gate',
        participant: { kind: 'deterministic', id: 'test', version: `sha256:${'1'.repeat(64)}` },
        inputDisclosure: scope,
        order: 0,
        timeoutMs: 100,
        failure: 'escalate-to-human',
        circuit: { failures: 2, recoveryAfterMs: 100 },
      },
    ],
  };
}

describe('administration catalog configuration', () => {
  it('refuses an active binding whose input Workspace has no current authority', async () => {
    const f = await fixture();
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const original = readFileSync(serverPath, 'utf8');
    await expect(
      f.service.propose(
        {
          targetFamily: 'policy',
          targetId: 'server',
          expectedRevision: f.files.readFile('server.jsonc').file.revision!,
          changes: {
            proposed: activePolicyDocument(f, testEntityId('ws', 'missing-policy-input')),
            rationale: 'Do not activate input disclosure for a missing Workspace.',
          },
        },
        f.home
      )
    ).rejects.toThrow('Policy binding input authority');
    expect(readFileSync(serverPath, 'utf8')).toBe(original);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('rechecks binding input authority when the Workspace closes after proposal', async () => {
    const f = await fixture();
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      ownerUserId: f.actor.userId,
      workspaceId: f.workspaceId,
    });
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const original = readFileSync(serverPath, 'utf8');
    const proposal = await f.service.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: f.files.readFile('server.jsonc').file.revision!,
        changes: {
          proposed: activePolicyDocument(f),
          rationale: 'Review current bounded input disclosure.',
        },
      },
      f.home
    );
    f.coreDb.sqlite
      .prepare(
        "UPDATE workspace_registry SET status = 'deleting', revision = revision + 1 WHERE workspace_id = ?"
      )
      .run(f.workspaceId);
    await expect(f.service.apply(f.confirm(proposal))).rejects.toThrow(
      'Policy binding input authority'
    );
    expect(readFileSync(serverPath, 'utf8')).toBe(original);
    expect(f.reload).not.toHaveBeenCalled();
    expect(
      listServerPermissionDecisions(f.coreDb).filter(
        (row) => row.mediation?.operation === 'policy.write'
      )
    ).toEqual([]);
  });

  it('admits current human storage leases for exact reads and staging without publication', async () => {
    const f = await fixture();
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      workspaceId: f.workspaceId,
      ownerUserId: f.actor.userId,
    });
    const ownerScope = { kind: 'workspace' as const, workspaceId: f.workspaceId };
    const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: ownerScope });
    const principal = { kind: 'human' as const, id: f.actor.userId };
    const anchor = { owner: ownerScope, kind: 'workspace', id: f.workspaceId };
    const notAfter = new Date(Date.now() + 120_000).toISOString();
    const lease = {
      id: 'read-raw',
      kind: 'permission',
      state: 'active',
      author: principal,
      authority: { kind: 'human', userId: f.actor.userId },
      authoredAt: new Date().toISOString(),
      scope: {
        subjects: [principal],
        actions: ['knowledge.read'],
        resources: [{ kind: 'container', container: anchor }],
      },
      lifetime: { anchor, notAfter },
      effect: 'allow',
      grant: {
        kind: 'storage-lease',
        knowledgeBaseId,
        mount: 'local',
        pathPrefix: 'docs',
        mode: 'read-only',
      },
    };
    const proposed = PolicyDocumentV1Schema.parse({
      schemaVersion: 1,
      statements: [
        lease,
        {
          ...lease,
          id: 'stage-raw',
          scope: { ...lease.scope, actions: ['knowledge.write'] },
          grant: { ...lease.grant, mode: 'staged-write' },
        },
      ],
    });
    const proposal = await f.service.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: f.files.readFile('server.jsonc').file.revision!,
        changes: { proposed, rationale: 'Read and stage exact admitted raw bytes.' },
      },
      f.home
    );
    expect(await f.service.apply(f.confirm(proposal))).toMatchObject({
      persisted: true,
      reload: 'applied',
    });
    const policy = f.manager.current().openKitConfig.policy!.mediation;
    expect(readAdmittedPolicyDocument(f.coreDb, policy).statements).toHaveLength(2);
    const decision = listServerPermissionDecisions(f.coreDb).find(
      (row) => row.mediation?.operation === 'policy.write'
    );
    expect(decision).toMatchObject({ result: 'allow', mediation: { kernel: { effect: 'allow' } } });
    expect(listServerAuditEvents(f.coreDb)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'policy.write',
          permissionDecisionId: decision?.decisionId,
          outcome: 'succeeded',
        }),
      ])
    );
    const actor = { kind: 'user' as const, id: f.actor.userId };
    const subject = {
      principal,
      onBehalfOf: null,
      actor,
      process: null,
      credentialKind: 'token' as const,
      responsibleHumanId: f.actor.userId,
    };
    const kernels: PolicyDecision[] = [];
    expect(
      currentWorkspaceAuthority(f.coreDb, f.workspaceId, actor, 'knowledge.read', true, f.actor, {
        dependencyFailure: 'throw',
        onEvaluation: ({ decision: current }) => kernels.push(current),
      })
    ).not.toBeNull();
    expect(kernels[0]?.effect).toBe('allow');
    const input = {
      coreDb: f.coreDb,
      policy,
      statementId: lease.id,
      subject,
      ownerScope,
      knowledgeBaseId,
      action: 'knowledge.read' as const,
      kernel: kernels[0]!,
      anchorCurrent: (container: PolicyBindingV1['lifetime']['anchor']) =>
        container.kind === 'workspace' &&
        container.id === f.workspaceId &&
        f.store.getWorkspace(f.workspaceId).status === 'active',
      now: Date.now(),
    };
    const access = policyConfiguration.readStorageLeaseAccess(input);
    expect(access).toMatchObject({
      basis: 'lease',
      knowledgeBaseId,
      ownerScope,
      mount: 'local',
      pathPrefix: 'docs',
      mode: 'read-only',
      expiresAt: notAfter,
      revoked: false,
    });
    if (!access) throw new Error('Expected current storage lease.');
    const root = join(f.dataRoot, 'lease-originals');
    const stagingRoot = join(f.dataRoot, 'lease-staging');
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'docs-other'));
    mkdirSync(stagingRoot);
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    writeFileSync(join(root, 'docs/original.bin'), bytes);
    writeFileSync(join(root, 'docs-other/private.bin'), 'Sibling secret');
    const storage = new LocalStorage({
      mounts: [{ knowledgeBaseId, ownerScope, name: 'local', root }],
      stagingRoot,
    });
    const locator = { ownerScope, mount: 'local', path: 'docs/original.bin' };
    try {
      const observed = await storage.stat({ access, locator });
      expect(observed.status).toBe('ok');
      if (observed.status !== 'ok') throw new Error('Expected admitted original metadata.');
      expect(observed.value.reference.contentDigest).toBe(
        `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      );
      expect(
        await storage.read({ access, content: observed.value, offset: 0, length: bytes.length })
      ).toEqual({
        status: 'ok',
        value: { data: bytes.toString('base64'), offset: 0, nextOffset: null },
      });
      expect(
        await storage.stat({ access, locator: { ...locator, path: 'docs-other/private.bin' } })
      ).toEqual({ status: 'denied' });
      expect(await storage.beginStage({ access, locator, maxByteLength: 3 })).toEqual({
        status: 'denied',
      });
      const stageKernel = evaluateAdministratorWorkspaceAccess({
        userId: f.actor.userId,
        workspaceId: f.workspaceId,
        operation: 'knowledge.write',
      });
      const staged = policyConfiguration.readStorageLeaseAccess({
        ...input,
        statementId: 'stage-raw',
        action: 'knowledge.write',
        kernel: stageKernel,
      });
      expect(staged?.mode).toBe('staged-write');
      if (!staged) throw new Error('Expected current staged-write lease.');
      expect(await storage.stat({ access: staged, locator })).toEqual({ status: 'denied' });
      expect(
        await storage.read({ access: staged, content: observed.value, offset: 0, length: 1 })
      ).toEqual({ status: 'denied' });
      const stage = await storage.beginStage({ access: staged, locator, maxByteLength: 3 });
      expect(stage.status).toBe('ok');
      if (stage.status !== 'ok') throw new Error('Expected admitted temporary stage.');
      expect(
        await storage.writeStage({
          access: staged,
          handle: stage.value.handle,
          data: Buffer.from('new').toString('base64'),
        })
      ).toEqual({ status: 'ok', value: { byteLength: 3 } });
      expect(
        (await storage.finishStage({ access: staged, handle: stage.value.handle })).status
      ).toBe('ok');
      expect(readFileSync(join(root, locator.path))).toEqual(bytes);
      expect(
        policyConfiguration.readStorageLeaseAccess({ ...input, now: Date.parse(notAfter) })
      ).toBeNull();
      expect(
        policyConfiguration.readStorageLeaseAccess({ ...input, anchorCurrent: () => false })
      ).toBeNull();
      expect(
        policyConfiguration.readStorageLeaseAccess({
          ...input,
          kernel: evaluateAdministratorWorkspaceAccess({
            userId: '',
            workspaceId: f.workspaceId,
            operation: 'knowledge.read',
          }),
        })
      ).toBeNull();
      expect(
        policyConfiguration.readStorageLeaseAccess({
          ...input,
          knowledgeBaseId: allocateEntityId('kb'),
        })
      ).toBeNull();
      expect(
        policyConfiguration.readStorageLeaseAccess({
          ...input,
          action: 'knowledge.write',
          kernel: stageKernel,
        })
      ).toBeNull();
      expect(
        policyConfiguration.readStorageLeaseAccess({ ...input, ownerScope: { kind: 'server' } })
      ).toBeNull();
      expect(
        policyConfiguration.readStorageLeaseAccess({
          ...input,
          subject: { ...subject, principal: { kind: 'human', id: allocateEntityId('usr') } },
        })
      ).toBeNull();
      const withdrawal = await f.service.propose(
        {
          targetFamily: 'policy',
          targetId: 'server',
          expectedRevision: f.files.readFile('server.jsonc').file.revision!,
          changes: {
            proposed: { schemaVersion: 1, statements: [] },
            rationale: 'Withdraw both leases.',
          },
        },
        f.home
      );
      expect(await f.service.apply(f.confirm(withdrawal))).toMatchObject({
        persisted: true,
        reload: 'applied',
      });
      expect(
        listServerPermissionDecisions(f.coreDb).some(
          (row) => row.decisionId === decision?.decisionId
        )
      ).toBe(true);
      expect(
        policyConfiguration.readStorageLeaseAccess({
          ...input,
          policy: f.manager.current().openKitConfig.policy!.mediation,
        })
      ).toBeNull();
      const renewed = await f.service.propose(
        {
          targetFamily: 'policy',
          targetId: 'server',
          expectedRevision: f.files.readFile('server.jsonc').file.revision!,
          changes: { proposed, rationale: 'Issue new leases through a new human request.' },
        },
        { ...f.home, requestId: randomUUID() }
      );
      expect(await f.service.apply(f.confirm(renewed))).toMatchObject({
        persisted: true,
        reload: 'applied',
      });
      f.coreDb.sqlite.transaction(() =>
        disableCanonicalUser(f.coreDb, f.actor.userId, new Date())
      )();
      expect(
        policyConfiguration.readStorageLeaseAccess({
          ...input,
          policy: f.manager.current().openKitConfig.policy!.mediation,
        })
      ).toBeNull();
    } finally {
      await storage.close();
    }
  });

  it('reviews and applies a human Tool condition without pinning its observed input schema', async () => {
    const f = await mcpPolicyFixture();
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const original = readFileSync(serverPath, 'utf8');
    const proposal = await f.service.propose(f.policyRequest(), f.home);
    expect(readFileSync(serverPath, 'utf8')).toBe(original);
    const artifact = f.store.getArtifact(f.workspaceId, proposal.candidate.artifactId);
    if (artifact.content.format !== 'json') throw new Error('Expected candidate JSON.');
    const candidate = JSON.parse(artifact.content.body);
    expect(Object.keys(candidate.policyProposal).sort()).toEqual([
      'baseRevision',
      'proposed',
      'proposer',
      'rationale',
      'schemaVersion',
      'validation',
    ]);
    expect(candidate.after.statements).toEqual([
      expect.objectContaining({
        id: 'human-tool-condition',
        kind: 'permission',
        effect: 'require_approval',
        state: 'active',
        scope: {
          subjects: [{ kind: 'human', id: f.actor.userId }],
          actions: ['tool.use'],
          resources: [
            { kind: 'mcp-tool', workspaceId: f.workspaceId, serverId: 'issues', toolName: 'read' },
          ],
        },
      }),
    ]);
    // Schema validation is current-name validation, not a retained argument-schema pin.
    await f.observe([
      { name: 'read', inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
    ]);
    const confirmed = f.confirm(proposal);
    expect(await f.service.apply(confirmed)).toMatchObject({ persisted: true, reload: 'applied' });
    expect(
      readAdmittedPolicyDocument(f.coreDb, f.manager.current().openKitConfig.policy?.mediation)
    ).toEqual(candidate.after);
    expect(await f.service.apply(confirmed)).toMatchObject({ persisted: true });
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    'prohibit',
    'require_approval',
  ] as const)('prepares and applies unobserved %s with a digest-bound warning and later exact-name enforcement', async (effect) => {
    const f = await mcpPolicyFixture(false);
    const proposal = await f.service.propose(f.policyRequest('future-tool', effect), f.home);
    const artifact = f.store.getArtifact(f.workspaceId, proposal.candidate.artifactId);
    if (artifact.content.format !== 'json') throw new Error('Expected candidate JSON.');
    const body = JSON.parse(artifact.content.body);
    const message = `MCP Tool issues/future-tool has not been observed in Workspace ${f.workspaceId}; the statement applies when a Tool with this exact name is exposed.`;
    expect(body.warnings).toEqual([
      {
        code: 'mcp_tool_unobserved',
        workspaceId: f.workspaceId,
        serverId: 'issues',
        toolName: 'future-tool',
        message,
      },
    ]);
    expect(body.policyProposal).not.toHaveProperty('warnings');
    expect(artifact.contentDigest).toBe(
      `sha256:${createHash('sha256').update(artifact.content.body).digest('hex')}`
    );
    expect(proposal.confirmation.contentDigest).toBe(artifact.contentDigest);
    expect(proposal).toMatchObject({
      plan: {
        warnings: expect.arrayContaining([{ code: 'mcp_tool_unobserved', message }]),
      },
    });
    const confirmed = f.confirm(proposal);
    expect(await f.service.apply(confirmed)).toMatchObject({ persisted: true, reload: 'applied' });
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const admittedBytes = readFileSync(serverPath, 'utf8');
    const document = readAdmittedPolicyDocument(
      f.coreDb,
      f.manager.current().openKitConfig.policy?.mediation
    );
    await f.observe([{ name: 'future-tool', inputSchema: { type: 'object' } }]);
    const select = (toolName: string) =>
      selectMcpToolPermissions({
        document,
        proposal: {
          workspaceId: f.workspaceId,
          serverId: 'issues',
          toolName,
          subject: {
            principal: { kind: 'human', id: f.actor.userId },
            onBehalfOf: null,
            actor: { kind: 'user', id: f.actor.userId },
            process: null,
            credentialKind: 'token',
            responsibleHumanId: f.actor.userId,
          },
        },
        authorCurrent: (id) => isCurrentServerPolicyAuthor(f.coreDb, id),
      });
    expect(select('future-tool')).toMatchObject([{ id: 'human-tool-condition', effect }]);
    expect(select('future-tool-typo')).toEqual([]);
    if (effect === 'prohibit')
      expect(
        applyMcpToolProhibitions(
          {
            effect: 'allow',
            reasons: [],
            trace: {
              requiredAccessRights: ['use'],
              userClosure: [],
              targetClosure: [],
              policyClasses: [],
              matchedAssociations: [],
              matchedProhibitions: [],
            },
          },
          select('future-tool')
        ).effect
      ).toBe('deny');
    expect(readFileSync(serverPath, 'utf8')).toBe(admittedBytes);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(await f.service.apply(confirmed)).toMatchObject({ persisted: true });
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    'prohibit',
    'require_approval',
  ] as const)('does not warn for observed %s', async (effect) => {
    const f = await mcpPolicyFixture();
    const proposal = await f.service.propose(f.policyRequest('read', effect), f.home);
    expect(('warnings' in proposal.preview ? proposal.preview.warnings : undefined) ?? []).toEqual(
      []
    );
  });

  it('applies the confirmed warning unchanged when the Tool becomes observed', async () => {
    const f = await mcpPolicyFixture(false);
    const proposal = await f.service.propose(f.policyRequest('future-tool'), f.home);
    const before = f.store.getArtifact(f.workspaceId, proposal.candidate.artifactId);
    if (before.content.format !== 'json') throw new Error('Expected candidate JSON.');
    expect(JSON.parse(before.content.body).warnings).toHaveLength(1);
    await f.observe([{ name: 'future-tool', inputSchema: { type: 'object' } }]);
    expect(await f.service.apply(f.confirm(proposal))).toMatchObject({
      persisted: true,
      reload: 'applied',
    });
    expect(f.store.getArtifact(f.workspaceId, proposal.candidate.artifactId)).toEqual(before);
  });

  it('does not turn an observation loss into rejection of a confirmed restriction', async () => {
    const f = await mcpPolicyFixture();
    const proposal = await f.service.propose(f.policyRequest(), f.home);
    await f.observe([{ name: 'renamed', inputSchema: { type: 'object' } }]);
    expect(await f.service.apply(f.confirm(proposal))).toMatchObject({
      persisted: true,
      reload: 'applied',
    });
  });

  it('keeps active ordinary allow outside the admitted subset even for an unobserved Tool', async () => {
    const f = await mcpPolicyFixture(false);
    const request = f.policyRequest('missing');
    const proposed = {
      ...request,
      changes: {
        ...request.changes,
        proposed: {
          ...request.changes.proposed,
          statements: request.changes.proposed.statements.map((statement) => ({
            ...statement,
            effect: 'allow',
          })),
        },
      },
    };
    const before = readFileSync(join(f.dataRoot, 'config/server.jsonc'), 'utf8');
    await expect(f.service.propose(proposed, f.home)).rejects.toThrow(
      'Human Tool conditions require exact Workspace Tool scope without finite uses.'
    );
    expect(readFileSync(join(f.dataRoot, 'config/server.jsonc'), 'utf8')).toBe(before);
  });

  it('retains inactive Policy forms through the exact human candidate and records actual activation', async () => {
    const f = await fixture();
    const principal = { kind: 'human' as const, id: f.actor.userId };
    const fields = {
      author: principal,
      authority: { kind: 'human' as const, userId: f.actor.userId },
      authoredAt: '2026-10-18T00:00:00Z',
      state: 'inactive' as const,
      scope: {
        subjects: [principal],
        actions: ['tool.use'],
        resources: [
          {
            kind: 'mcp-tool' as const,
            workspaceId: f.workspaceId,
            serverId: 'issues',
            toolName: 'read',
          },
        ],
      },
      lifetime: {
        anchor: {
          owner: { kind: 'workspace' as const, workspaceId: f.workspaceId },
          kind: 'workspace',
          id: f.workspaceId,
        },
        uses: 1,
      },
    };
    const proposed = {
      schemaVersion: 1 as const,
      statements: [
        {
          ...fields,
          id: 'tool-rule',
          kind: 'permission' as const,
          effect: 'require_approval' as const,
          grant: { kind: 'ordinary' as const },
        },
      ],
    };
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const original = readFileSync(serverPath, 'utf8');
    const proposal = await f.service.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: f.files.readFile('server.jsonc').file.revision!,
        changes: {
          proposed,
          rationale: 'Retain inactive native declarations for their later consumers.',
        },
      },
      f.home
    );
    expect(readFileSync(serverPath, 'utf8')).toBe(original);
    const artifact = f.store.getArtifact(f.workspaceId, proposal.candidate.artifactId);
    if (artifact.content.format !== 'json') throw new Error('Expected candidate JSON.');
    const candidate = JSON.parse(artifact.content.body);
    expect(candidate.policyProposal).toMatchObject({
      proposer: principal,
      validation: 'valid',
    });
    expect(candidate.policyProposal).not.toHaveProperty('classification');
    expect(candidate.policyProposal).not.toHaveProperty('diff');
    expect(
      candidate.after.statements.every(
        (statement: { state: string }) => statement.state === 'inactive'
      )
    ).toBe(true);
    const confirmed = f.confirm(proposal);
    const result = await f.service.apply(confirmed);
    expect(result).toMatchObject({ persisted: true, reload: 'applied' });
    const loaded = readAdmittedPolicyDocument(
      f.coreDb,
      f.manager.current().openKitConfig.policy?.mediation
    );
    expect(loaded).toEqual(candidate.after);
    const decision = listServerPermissionDecisions(f.coreDb).find(
      (row) => row.mediation?.operation === 'policy.write'
    );
    expect(decision).toMatchObject({
      result: 'allow',
      enforcementPoint: 'policy.write@decide',
      mediation: {
        role: 'final',
        kernel: { effect: 'allow' },
        proposalDigest: proposal.candidate.contentDigest,
        subject: { principal, process: null, responsibleHumanId: f.actor.userId },
      },
    });
    const audit = listServerAuditEvents(f.coreDb).find((row) => row.action === 'policy.write');
    expect(audit).toMatchObject({
      permissionDecisionId: decision?.decisionId,
      outcome: 'succeeded',
      policyWriteOutcome: {
        persistedRevision: policyDigest(candidate.after),
        activeRevision: policyDigest(loaded),
        outcome: 'active',
      },
    });
    expect(await f.service.apply(confirmed)).toEqual(result);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it('applies Policy after the candidate Turn is terminal and replays the same outcome', async () => {
    const f = await fixture();
    const principal = { kind: 'human' as const, id: f.actor.userId };
    const proposed = PolicyDocumentV1Schema.parse({
      schemaVersion: 1,
      statements: [
        {
          id: 'tool-rule',
          kind: 'permission',
          effect: 'require_approval',
          grant: { kind: 'ordinary' },
          author: principal,
          authority: { kind: 'human', userId: f.actor.userId },
          authoredAt: '2026-10-18T00:00:00Z',
          state: 'inactive',
          scope: {
            subjects: [principal],
            actions: ['tool.use'],
            resources: [
              {
                kind: 'mcp-tool',
                workspaceId: f.workspaceId,
                serverId: 'issues',
                toolName: 'read',
              },
            ],
          },
          lifetime: {
            anchor: {
              owner: { kind: 'workspace', workspaceId: f.workspaceId },
              kind: 'workspace',
              id: f.workspaceId,
            },
            uses: 1,
          },
        },
      ],
    });
    const proposal = await f.service.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: f.files.readFile('server.jsonc').file.revision!,
        changes: {
          proposed,
          rationale: 'Human apply after the administration Turn completes.',
        },
      },
      f.home
    );
    await f.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const confirmed = f.confirm(proposal);
    const result = await f.service.apply(confirmed);
    expect(result).toMatchObject({ persisted: true, reload: 'applied' });
    const outcomeId = deriveEntityId('ar', [
      'configuration_result',
      { userId: f.actor.userId, request: confirmed },
    ]);
    const outcome = f.store.getArtifact(f.workspaceId, outcomeId);
    expect(outcome.content.format).toBe('json');
    expect(
      f.store
        .listThreadItems(f.workspaceId, f.home.threadId)
        .filter(
          (item) =>
            item.type === 'artifact-reference' &&
            item.turnId === f.turn.id &&
            item.artifactId === outcomeId
        )
    ).toHaveLength(1);
    expect(await f.service.apply(confirmed)).toEqual(result);
  });

  it('publishes only editable schema fields while preserving their constraints', async () => {
    const f = await fixture();
    const provider = f.service.schema('provider').schema;
    expect(Object.keys(provider.properties ?? {})).toEqual([
      'displayName',
      'models',
      'defaultModel',
      'modelMetadata',
    ]);
    expect(provider.additionalProperties).toBe(false);
    expect(provider).toHaveProperty('properties.models.minItems', 1);
    expect(provider).toHaveProperty(
      'properties.modelMetadata.additionalProperties.additionalProperties',
      false
    );
    expect(provider).toHaveProperty(
      'properties.modelMetadata.additionalProperties.properties.limit.properties.context.exclusiveMinimum',
      0
    );
    const gateway = f.service.schema('gateway').schema;
    expect(Object.keys(gateway.properties ?? {})).toEqual([
      'logicalModels',
      'defaultLogicalModelId',
    ]);
    expect(gateway.additionalProperties).toBe(false);
    expect(gateway).toHaveProperty('properties.logicalModels.items.additionalProperties', false);
    for (const schema of [provider, gateway]) {
      for (const field of ['secretRef', 'apiKey', 'clientSecret', 'secret', 'token'])
        expect(JSON.stringify(schema)).not.toContain(`"${field}"`);
    }
  });

  it('proposes through the Tool without writes, then applies exact Provider and Gateway catalogs', async () => {
    const f = await fixture();
    const original = readFileSync(f.providerPath, 'utf8');
    const tools = createAdministrationConfigurationTools(f.manager.current(), f.files, {
      ...f.service,
      propose: (value) => f.service.propose(value, f.home),
      applyDelegated: (value, context) =>
        f.service.applyDelegated(value, { ...f.home, signal: context.signal }),
    });
    const result = await tools[2].execute(f.request, {
      callId: 'provider',
      toolOccurrence: 1,
      signal: new AbortController().signal,
    });
    expect(result.isError).not.toBe(true);
    const proposal = JSON.parse(
      result.content[0]!.type === 'text' ? result.content[0]!.text : '{}'
    );
    expect(proposal.preview.after.models).toEqual(['gpt-5', 'gpt-6']);
    expect(readFileSync(f.providerPath, 'utf8')).toBe(original);
    expect(JSON.stringify(proposal)).not.toContain('/private/provider-account');
    expect(JSON.stringify(proposal)).not.toContain('accountSlotId');
    expect(
      f.store
        .listThreadItems(f.workspaceId, f.home.threadId)
        .filter(
          (item) =>
            item.type === 'artifact-reference' && item.artifactId === proposal.candidate.artifactId
        )
    ).toHaveLength(1);
    const request = f.confirm(proposal);
    const applied = await f.service.apply(request);
    expect(applied).toMatchObject({ persisted: true, reload: 'applied', restartRequired: true });
    expect(JSON.parse(readFileSync(f.providerPath, 'utf8'))).toMatchObject({
      models: ['gpt-5', 'gpt-6'],
      extensions: f.provider.extensions,
    });
    expect(await f.service.apply(request)).toEqual(applied);
    expect(f.reload).toHaveBeenCalledTimes(1);
    const reopened = createAdministrationConfiguration({
      ...f,
      store: new FsStore({ dataRoot: f.dataRoot }),
    });
    expect(await reopened.apply(request)).toEqual(applied);
    expect(f.reload).toHaveBeenCalledTimes(1);
    const gateway = await f.service.propose(
      {
        targetFamily: 'gateway',
        targetId: 'gateway',
        expectedRevision: f.files.readFile('gateway.jsonc').file.revision,
        changes: {
          logicalModels: [
            {
              ...f.logicalModel,
              routes: [{ id: 'primary', providerProfileId: 'codex', providerModel: 'gpt-6' }],
            },
          ],
        },
      },
      f.home
    );
    expect((await f.service.apply(f.confirm(gateway))).persisted).toBe(true);
    expect(
      JSON.parse(readFileSync(f.gatewayPath, 'utf8')).logicalModels[0].routes[0].providerModel
    ).toBe('gpt-6');
  });

  it('rejects unsupported fields, missing dependencies, stale revisions and changed confirmations without writes', async () => {
    const f = await fixture();
    const original = readFileSync(f.providerPath, 'utf8');
    for (const changes of [
      { secretRef: 'secret' },
      { extensions: {} },
      { baseUrl: 'https://bad.invalid' },
      { models: [] },
      {
        modelMetadata: {
          'gpt-5': { secretRef: 'vault://vault_00000000-0000-7cca-ad90-c1173d3bc17d' },
        },
      },
      { modelMetadata: { missing: { tool_call: true } } },
    ]) {
      await expect(f.service.propose({ ...f.request, changes }, f.home)).rejects.toThrow();
    }
    const gateway = {
      targetFamily: 'gateway',
      targetId: 'gateway',
      expectedRevision: f.files.readFile('gateway.jsonc').file.revision,
      changes: {
        logicalModels: [
          {
            ...f.logicalModel,
            routes: [{ id: 'primary', providerProfileId: 'missing', providerModel: 'gpt-6' }],
          },
        ],
      },
    };
    await expect(f.service.propose(gateway, f.home)).rejects.toThrow();
    const proposal = await f.service.propose(f.request, f.home);
    const request = f.confirm(proposal);
    await expect(
      f.service.apply({
        ...request,
        confirmation: { ...request.confirmation, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).rejects.toThrow();
    await expect(
      f.service.apply({
        ...request,
        candidate: { ...request.candidate, contentDigest: `sha256:${'0'.repeat(64)}` },
        confirmation: { ...request.confirmation, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).rejects.toMatchObject({ code: 'configuration_candidate_conflict' });
    expect(readFileSync(f.providerPath, 'utf8')).toBe(original);
    writeFileSync(f.providerPath, `${original}\n`);
    await expect(f.service.apply(request)).rejects.toMatchObject({
      code: 'config_revision_conflict',
    });
    expect(readFileSync(f.providerPath, 'utf8')).toBe(`${original}\n`);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('rechecks revoked authority before discovery, proposal, application and replay', async () => {
    const f = await fixture();
    const proposal = await f.service.propose(f.request, f.home);
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    expect(() => f.service.read('provider')).toThrow();
    await expect(f.service.propose(f.request, f.home)).rejects.toThrow();
    await expect(f.service.apply(f.confirm(proposal))).rejects.toThrow('administrator authority');
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('replays an extended retained apply outcome after reopening without repeating the effect', async () => {
    const f = await fixture();
    const proposal = await f.service.propose(f.request, f.home);
    const request = f.confirm(proposal);
    const outcomeId = deriveEntityId('ar', [
      'configuration_result',
      { userId: f.actor.userId, request },
    ]);
    const publish = f.store.createArtifact.bind(f.store);
    // Author descriptive additions before the real immutable v1 publisher receives its bytes.
    const publication = vi
      .spyOn(f.store, 'createArtifact')
      .mockImplementation((artifact, payload) => {
        if (artifact.id !== outcomeId || artifact.content.format !== 'json')
          return publish(artifact, payload);
        const result = JSON.parse(artifact.content.body);
        const bytes = JSON.stringify({
          ...result,
          annotation: 'outcome',
          candidate: { ...result.candidate, annotation: 'reference' },
        });
        return publish(
          {
            ...artifact,
            content: { format: 'json', body: bytes },
            contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          },
          payload
        );
      });
    const result = await f.service.apply(request).finally(() => publication.mockRestore());
    const outcome = f.store.getArtifact(f.workspaceId, outcomeId);
    expect(outcome.content.format).toBe('json');
    if (outcome.content.format !== 'json') throw new Error('Expected the published JSON outcome.');
    const bytes = outcome.content.body;
    expect(JSON.parse(bytes)).toEqual({
      ...result,
      annotation: 'outcome',
      candidate: { ...result.candidate, annotation: 'reference' },
    });
    const root = join(f.dataRoot, 'workspaces', f.workspaceId, 'artifacts', outcome.id);
    const versionRoot = join(root, 'versions', '1');
    const original = readFileSync(join(versionRoot, 'payload'));
    const descriptor = readFileSync(join(versionRoot, 'version-record.json'));
    expect(original.toString('utf8')).toBe(bytes);
    expect(f.store.listArtifactVersions(f.workspaceId, outcome.id)).toMatchObject([
      { artifactVersion: 1, parentVersion: null, contentDigest: outcome.contentDigest },
    ]);
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    const service = createAdministrationConfiguration({ ...f, store: reopened });
    expect(await service.apply(request)).toEqual(result);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(reopened.getArtifactVersion(f.workspaceId, outcome.id, 1).artifact.content).toEqual({
      format: 'json',
      body: bytes,
    });
    expect(await service.apply(request)).toEqual(result);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(versionRoot, 'payload'))).toEqual(original);
    expect(readFileSync(join(versionRoot, 'version-record.json'))).toEqual(descriptor);
  });

  it('retains persisted bytes and reports reload failure without repeating the effect', async () => {
    const f = await fixture();
    const proposal = await f.service.propose(f.request, f.home);
    f.reload.mockImplementation(() => {
      throw new Error('reload failed');
    });
    const request = f.confirm(proposal);
    const result = await f.service.apply(request);
    expect(result).toMatchObject({ persisted: true, reload: 'failed' });
    expect(JSON.parse(readFileSync(f.providerPath, 'utf8')).models).toContain('gpt-6');
    expect(await f.service.apply(request)).toEqual(result);
    expect(f.reload).toHaveBeenCalledTimes(1);
    await expect(
      f.service.apply({
        ...request,
        candidate: { ...request.candidate, artifactId: testEntityId('ar', 'missing') },
      })
    ).rejects.toThrow();
  });

  it('accepts Token-derived session authority, denies Workspace Tokens and hides foreign candidates', async () => {
    const f = await fixture();
    const session = createAdministrationConfiguration({
      ...f,
      actor: { kind: 'session', userId: f.actor.userId, adminTokenId: f.token.tokenId },
    });
    const proposal = await session.propose(f.request, f.home);
    expect(JSON.stringify(session.read('provider', 'codex'))).not.toContain('accountSlotId');
    expect(JSON.stringify(session.schema('provider'))).not.toContain('secretRef');
    const scoped = createAdministrationConfiguration({
      ...f,
      actor: {
        ...f.actor,
        kind: 'token',
        tokenId: f.token.tokenId,
        tokenScope: 'workspace',
        tokenWorkspaceIds: [f.workspaceId],
      },
    });
    await expect(scoped.apply(f.confirm(proposal))).rejects.toThrow('administrator authority');
    const foreign = await f.store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Project thread',
      allocateEntityId('th'),
      'administration',
      { visibility: 'private', privateOwnerUserId: f.actor.userId }
    );
    await expect(session.propose(f.request, { ...f.home, threadId: foreign.id })).rejects.toThrow();
    expect((await session.apply(f.confirm(proposal))).persisted).toBe(true);
  });

  it('conflicts on changed input under one request ID and fences interrupted writes', async () => {
    const f = await fixture();
    const first = await f.service.propose(f.request, f.home);
    const second = await f.service.propose(
      { ...f.request, changes: { displayName: 'Renamed Codex' } },
      f.home
    );
    const request = f.confirm(first);
    await f.service.apply(request);
    await expect(
      f.service.apply({ ...f.confirm(second), requestId: request.requestId })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    const next = await f.service.propose(
      {
        ...f.request,
        expectedRevision: f.files.readFile('providers/catalog.provider.jsonc').file.revision,
        changes: { displayName: 'Updated Codex' },
      },
      f.home
    );
    const nextRequest = f.confirm(next);
    const write = vi.spyOn(f.files, 'updateFile').mockImplementation(() => {
      throw new Error('interrupted write');
    });
    await expect(f.service.apply(nextRequest)).rejects.toMatchObject({
      code: 'configuration_recovery_required',
    });
    await expect(f.service.apply(nextRequest)).rejects.toMatchObject({
      code: 'configuration_recovery_required',
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('exposes human apply through the administration route and denies revoked tokens', async () => {
    const f = await fixture();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', f.actor);
      await next();
    });
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      ownerUserId: f.actor.userId,
      workspaceId: quickChatWorkspaceIdForUser(f.actor.userId),
    });
    registerOperationJsonRoutes({
      app,
      coreDb: f.coreDb,
      store: f.store,
      requestStore: () => f.store,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      administrationServices: {
        coreDb: f.coreDb,
        runtimeConfigFiles: () => f.files,
        reloadRuntimeConfig: f.reload,
        inflightCommands: f.inflightCommands,
        mode: 'server',
        quickChatWorkspaceIdForUser,
        runtimeConfig: () => f.manager.current(),
        environmentToolsForTurn: () => {
          throw new Error('Not exercised.');
        },
        resolveGatewayProvider: () => {
          throw new Error('Not exercised.');
        },
        llmGatewayDispatcher: {
          createResponses: async () => {
            throw new Error('Not exercised.');
          },
        },
      },
    });
    const request = f.confirm(await f.service.propose(f.request, f.home));
    const send = () =>
      app.request(
        ...operationRequest(
          'administration.configuration-apply',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          }
        )
      );
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ persisted: true });
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    expect((await send()).status).toBe(403);
  });
});
