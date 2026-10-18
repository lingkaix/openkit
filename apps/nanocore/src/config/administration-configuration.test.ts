import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, deriveEntityId, type PolicyDocumentV1 } from '@openkit/protocol';
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
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { policyDigest } from '../policy/statements.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { createAdministrationConfiguration } from './administration-configuration.js';
import { createRuntimeConfigManager } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Real temporary configuration, private Artifact store and current durable token authority. */
function fixture() {
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
  const store = createDemoStore({ dataRoot });
  const workspaceId = quickChatWorkspaceIdForUser(actor.userId);
  const thread = store.createThread(
    workspaceId,
    'Catalog update',
    allocateEntityId('th'),
    'administration',
    { visibility: 'private', privateOwnerUserId: actor.userId }
  );
  const turn = store.createTurn(
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
  writeFileSync(providerPath, JSON.stringify(provider));
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
      throw new Error('Catalog tests use no retained Worker snapshot.');
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
  const confirm = (proposal: ReturnType<typeof service.propose>) => ({
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
  };
}

/** Builds the supported active binding without performing discovery or credential access. */
function activePolicyDocument(
  f: ReturnType<typeof fixture>,
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
        point: 'mcp.call-tool@decide',
        mode: 'gate',
        participant: { kind: 'deterministic', id: 'test', version: `sha256:${'1'.repeat(64)}` },
        inputContract: 'mcp-tool-summary-v1',
        inputDisclosure: scope,
        outputContract: 'gate-v1',
        order: 0,
        timeoutMs: 100,
        failure: 'escalate-to-human',
        circuit: { failures: 2, recoveryAfterMs: 100 },
      },
    ],
  };
}

describe('administration catalog configuration', () => {
  it('refuses an active binding whose input Workspace has no current authority', () => {
    const f = fixture();
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const original = readFileSync(serverPath, 'utf8');
    expect(() =>
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
    ).toThrow('Policy binding input authority');
    expect(readFileSync(serverPath, 'utf8')).toBe(original);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('rechecks binding input authority when the Workspace closes after proposal', async () => {
    const f = fixture();
    recordWorkspaceOwnerMembership({
      coreDb: f.coreDb,
      ownerUserId: f.actor.userId,
      workspaceId: f.workspaceId,
    });
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const original = readFileSync(serverPath, 'utf8');
    const proposal = f.service.propose(
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

  it('retains inactive Policy forms through the exact human candidate and records actual activation', async () => {
    const f = fixture();
    const leaseKnowledgeBaseId = allocateEntityId('kb');
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
          grant: { kind: 'gateway-tool-rule' as const, toolNames: ['issues.read'] },
        },
        {
          ...fields,
          id: 'storage-lease',
          kind: 'permission' as const,
          effect: 'allow' as const,
          lifetime: { ...fields.lifetime, notAfter: '2999-01-01T00:00:00Z' },
          grant: {
            kind: 'storage-lease' as const,
            knowledgeBaseId: leaseKnowledgeBaseId,
            mount: 'work',
            pathPrefix: 'inputs',
            mode: 'read-only' as const,
          },
        },
        {
          ...fields,
          id: 'agent-worker',
          kind: 'agent-principal' as const,
          principal: { kind: 'agent' as const, id: 'worker' },
          creator: { kind: 'human' as const, id: testEntityId('usr', 'claimed-creator') },
          responsiblePrincipal: principal,
        },
      ],
    };
    const serverPath = join(f.dataRoot, 'config/server.jsonc');
    const original = readFileSync(serverPath, 'utf8');
    for (const knowledgeBaseId of ['invalid-kb', f.workspaceId]) {
      const invalid = {
        ...proposed,
        statements: proposed.statements.map((statement) =>
          statement.kind === 'permission' && statement.grant.kind === 'storage-lease'
            ? { ...statement, grant: { ...statement.grant, knowledgeBaseId } }
            : statement
        ),
      };
      expect(() =>
        f.service.propose(
          {
            targetFamily: 'policy',
            targetId: 'server',
            expectedRevision: f.files.readFile('server.jsonc').file.revision!,
            changes: {
              proposed: invalid,
              rationale: 'Reject a malformed or wrong-kind lease target.',
            },
          },
          f.home
        )
      ).toThrow(/knowledgeBaseId/);
      expect(readFileSync(serverPath, 'utf8')).toBe(original);
      expect(f.reload).not.toHaveBeenCalled();
    }
    const proposal = f.service.propose(
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
      classification: 'widening',
      validation: 'valid',
      diff: { added: ['tool-rule', 'storage-lease', 'agent-worker'], changed: [], removed: [] },
    });
    expect(candidate.after.statements[2].creator).toEqual(principal);
    expect(candidate.after.statements[1].grant).toEqual({
      kind: 'storage-lease',
      knowledgeBaseId: leaseKnowledgeBaseId,
      mount: 'work',
      pathPrefix: 'inputs',
      mode: 'read-only',
    });
    expect(candidate.after.statements[1].lifetime.notAfter).toBe('2999-01-01T00:00:00Z');
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

  it('publishes only editable schema fields while preserving their constraints', () => {
    const f = fixture();
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
    const f = fixture();
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
    const gateway = f.service.propose(
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
    const f = fixture();
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
      expect(() => f.service.propose({ ...f.request, changes }, f.home)).toThrow();
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
    expect(() => f.service.propose(gateway, f.home)).toThrow();
    const proposal = f.service.propose(f.request, f.home);
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
    const f = fixture();
    const proposal = f.service.propose(f.request, f.home);
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    expect(() => f.service.read('provider')).toThrow();
    expect(() => f.service.propose(f.request, f.home)).toThrow();
    await expect(f.service.apply(f.confirm(proposal))).rejects.toThrow('administrator authority');
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('replays an extended retained apply outcome after reopening without repeating the effect', async () => {
    const f = fixture();
    const proposal = f.service.propose(f.request, f.home);
    const request = f.confirm(proposal);
    const result = await f.service.apply(request);
    const outcome = f.store
      .listArtifacts(f.workspaceId)
      .find(
        (artifact) =>
          artifact.id ===
          deriveEntityId('ar', ['configuration_result', { userId: f.actor.userId, request }])
      )!;
    const root = join(f.dataRoot, 'workspaces', f.workspaceId, 'artifacts', outcome.id);
    const body = {
      ...result,
      annotation: 'outcome',
      candidate: { ...result.candidate, annotation: 'reference' },
    };
    const bytes = JSON.stringify(body);
    const metadataPath = join(root, 'artifact.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    metadata.contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    writeFileSync(join(root, 'files/content.json'), bytes);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    const service = createAdministrationConfiguration({ ...f, store: reopened });
    expect(await service.apply(request)).toEqual(result);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'files/content.json'), 'utf8')).toBe(bytes);
    expect(await service.apply(request)).toEqual(result);
  });

  it('retains persisted bytes and reports reload failure without repeating the effect', async () => {
    const f = fixture();
    const proposal = f.service.propose(f.request, f.home);
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
    const f = fixture();
    const session = createAdministrationConfiguration({
      ...f,
      actor: { kind: 'session', userId: f.actor.userId },
    });
    const proposal = session.propose(f.request, f.home);
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
    const foreign = f.store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Project thread',
      allocateEntityId('th'),
      'administration',
      { visibility: 'private', privateOwnerUserId: f.actor.userId }
    );
    expect(() => session.propose(f.request, { ...f.home, threadId: foreign.id })).toThrow();
    expect((await session.apply(f.confirm(proposal))).persisted).toBe(true);
  });

  it('conflicts on changed input under one request ID and fences interrupted writes', async () => {
    const f = fixture();
    const first = f.service.propose(f.request, f.home);
    const second = f.service.propose(
      { ...f.request, changes: { displayName: 'Renamed Codex' } },
      f.home
    );
    const request = f.confirm(first);
    await f.service.apply(request);
    await expect(
      f.service.apply({ ...f.confirm(second), requestId: request.requestId })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    const next = f.service.propose(
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
    const f = fixture();
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
    const request = f.confirm(f.service.propose(f.request, f.home));
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
