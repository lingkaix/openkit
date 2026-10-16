import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { type Actor, ensureLocalUser } from '../auth/identity.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createAdministrationConfiguration } from './administration-configuration.js';
import { createRuntimeConfigManager } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

const repositoryPath = '/team/project.git';
const unrelatedRule = { method: 'GET' as const, path: '/health' };
const originalRules = [
  { method: 'GET' as const, path: '/project.git/info/refs*' },
  { method: 'POST' as const, path: '/project.git/git-upload-pack' },
  unrelatedRule,
];
const correctedRules = [
  { method: 'GET' as const, path: '/team/project.git/info/refs*' },
  { method: 'POST' as const, path: '/team/project.git/git-upload-pack' },
  unrelatedRule,
];
const assignment = {
  responsibleUserId: 'user_local',
  agentId: 'agent_repair',
  networkGrantId: 'git-read',
  host: 'git.example.test',
  port: 443,
  protocol: 'rest',
  repositoryPaths: [repositoryPath],
  binaries: ['/usr/bin/git'],
  validFrom: '2020-01-01T00:00:00.000Z',
  expiresAt: '2999-01-01T00:00:00.000Z',
  enabled: true,
};

/** Composes real configuration, terminal failure, AEP ledger, Artifact and receipt owners. */
function fixture(repositoryCount = 1) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-delegated-git-read-'));
  cleanup.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'user_local',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: 'user_local',
    tokenId: token.tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
  };
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.userId, workspaceId: 'ws_demo' });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  cleanup.push(() => workspaceDb.sqlite.close());
  applyScopedMigrations(workspaceDb);
  const setup = createTestAgentSetup({
    agentId: assignment.agentId,
    logicalModelId: 'reasoning',
    network: [
      {
        id: 'git-read',
        host: 'git.example.test',
        port: 443,
        protocol: 'rest',
        binaries: ['/usr/bin/git'],
        purpose: 'Read project sources',
        scope: 'session',
        rules: originalRules,
      },
    ],
  });
  setup.manifest.runtime.binaries.push({ id: 'git', path: '/usr/bin/git' });
  const authored = { ...setup.manifest, futureDescription: { retained: 'authored sibling' } };
  mkdirSync(join(dataRoot, 'config/agents'), { recursive: true });
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  const agentPath = join(dataRoot, 'config/agents/registered.agent.jsonc');
  writeFileSync(agentPath, JSON.stringify(authored));
  const serverPath = join(dataRoot, 'config/server.jsonc');
  const saveAssignments = (entries: unknown) =>
    writeFileSync(
      serverPath,
      JSON.stringify({
        schemaVersion: 1,
        policy: { workerGitReadMaintenance: entries },
      })
    );
  saveAssignments([assignment]);
  writeFileSync(
    join(dataRoot, 'config/providers/local.provider.jsonc'),
    JSON.stringify({
      id: 'agent-openrouter',
      vendor: 'openai',
      kind: 'local',
      displayName: 'Synthetic supply',
      models: ['openai/gpt-5.2'],
    })
  );
  writeFileSync(
    join(dataRoot, 'config/gateway.jsonc'),
    JSON.stringify(createTestGatewayConfig({ logicalModelId: 'reasoning' }))
  );

  const failedThread = store.createThread('ws_demo', 'Failed materialization', randomUUID());
  const sessionId = randomUUID();
  const failedTurn = store.createTurn(
    'ws_demo',
    failedThread.id,
    'Read the project',
    { kind: 'user', id: actor.userId },
    null,
    {
      agentId: assignment.agentId,
      agentSessionId: sessionId,
    }
  );
  admitTestNativeEnvironment(coreDb, setup.manifest);
  const sourceIds = Array.from({ length: repositoryCount }, (_, index) => `repository-${index}`);
  const commit = 'a'.repeat(40);
  const environmentPackage = resolveAgentEnvironmentPackage({
    coreDb,
    agentSetup: setup,
    agentSessionId: sessionId,
    backend: { kind: 'openshell' },
    captureCoverage: { scope: 'server', value: 'off' },
    requestId: randomUUID(),
    turn: failedTurn,
    triggerActor: failedTurn.triggerActor,
    workspaceCwd: '/workspace',
    workspaceRoots: sourceIds.map((id) => ({
      id,
      access: 'read-write' as const,
      sourceKind: 'remote-git' as const,
      sourceCommit: commit,
      workerPath: `/workspace/${id}`,
    })),
    workspaceSourceRefs: Object.fromEntries(sourceIds.map((id) => [id, id])),
    workspaceDataSourceCatalog: {
      schemaVersion: 1,
      requiredFeatures: [],
      extensions: {},
      sources: sourceIds.map((id) => ({
        id,
        displayName: id,
        kind: 'git' as const,
        locator: { url: `https://git.example.test${repositoryPath}`, commit },
        access: 'read-write' as const,
        allowedSlotKinds: ['worktree' as const],
        sensitivity: 'internal' as const,
        status: 'active' as const,
        syncHints: {},
        requiredFeatures: [],
        extensions: {},
      })),
    },
  });
  const retained = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    environmentPackage,
    createdAt: '2026-10-16T00:00:00.000Z',
  });
  store.createAgentSession({
    id: sessionId,
    agentId: assignment.agentId,
    workspaceId: 'ws_demo',
    threadId: failedThread.id,
    status: 'failed',
    message: 'Synthetic Git fetch refusal',
    environmentPackageSnapshotId: retained.snapshotId,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:01.000Z',
  });
  store.updateTurn(failedTurn.id, {
    status: 'failed',
    completedAt: '2026-10-16T00:00:01.000Z',
    error: {
      code: 'worker_failed',
      message: 'Git fetch refused',
      explanation: {
        code: 'git_fetch_http_refused',
        stage: 'workspace_materialization',
        operation: 'git.fetch',
        dependency: 'git_remote',
        producer: 'worker-shim',
        observedAt: '2026-10-16T00:00:01.000Z',
        basis: 'direct_observation',
        subprocess: 'exit',
        httpStatus: 403,
        enforcement: 'unavailable',
        evidence: { availability: 'partial', outputTruncated: false },
      },
    },
  });

  const workspaceId = quickChatWorkspaceIdForUser(actor.userId);
  const thread = store.createThread(
    workspaceId,
    'Repair the Git-read rule',
    randomUUID(),
    'administration'
  );
  const turn = store.createTurn(workspaceId, thread.id, 'Repair the assigned rule', {
    kind: 'user',
    id: actor.userId,
  });
  const home = { threadId: thread.id, turnId: turn.id, requestId: randomUUID() };
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId: actor.userId,
    workspaceIds: ['ws_demo', workspaceId],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const write = vi.spyOn(files, 'updateFile');
  const reload = vi.fn(() => manager.reload({ mode: 'safe', dryRun: false }));
  const options = {
    actor,
    coreDb,
    store,
    files,
    reload,
    runtimeConfig: () => manager.current(),
    repositoryWorkspaceDb: () => openWorkspaceDb(dataRoot, 'ws_demo'),
    inflightCommands: new WeakMap(),
  };
  const service = createAdministrationConfiguration(options);
  const request = {
    targetFamily: 'agent' as const,
    targetId: assignment.agentId,
    expectedRevision: files.readFile('agents/registered.agent.jsonc').file.revision!,
    failure: { workspaceId: 'ws_demo', threadId: failedThread.id, turnId: failedTurn.id },
    changes: { networkGrantId: 'git-read', rules: correctedRules },
  };
  return {
    ...options,
    service,
    manager,
    dataRoot,
    agentPath,
    authored,
    workspaceId,
    home,
    request,
    saveAssignments,
    token,
    retained,
    failedTurn,
    write,
    propose: () => service.propose(request, home),
  };
}

describe('finite delegated Worker Git-read application', () => {
  it('binds a real failed Turn to an immutable candidate and writes once across receipt replay and reopen', async () => {
    const f = fixture();
    const original = readFileSync(f.agentPath, 'utf8');
    const proposal = f.propose();
    expect(readFileSync(f.agentPath, 'utf8')).toBe(original);
    expect(proposal.preview).toMatchObject({
      targetFamily: 'agent',
      targetId: assignment.agentId,
      expectedRevision: f.request.expectedRevision,
      failure: f.request.failure,
      before: { networkGrantId: 'git-read', rules: originalRules },
      after: { networkGrantId: 'git-read', rules: correctedRules },
      failureEvidence: {
        snapshotId: f.retained.snapshotId,
        snapshotDigest: f.retained.contentDigest,
        agentSessionId: f.retained.agentSessionId,
        repositoryInputId: 'repository-0',
      },
    });
    const artifact = f.store.getArtifact(f.workspaceId, proposal.candidate.artifactId);
    const candidateBytes = artifact.content.body;
    expect(proposal.candidate).toMatchObject({
      artifactVersion: 1,
      contentDigest: `sha256:${createHash('sha256').update(candidateBytes).digest('hex')}`,
    });
    expect(f.write).not.toHaveBeenCalled();
    const loadedBefore = f.manager.current();
    // Saved revocation is pending; only a successful reload changes effective Policy authority.
    f.saveAssignments([]);
    expect(f.manager.current().openKitConfig.policy?.workerGitReadMaintenance).toEqual([
      assignment,
    ]);
    f.store.updateTurn(f.home.turnId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const applyingTurn = f.store.createTurn(
      f.workspaceId,
      f.home.threadId,
      'Apply the prepared correction',
      { kind: 'user', id: f.actor.userId }
    );
    const invocation = { threadId: f.home.threadId, turnId: applyingTurn.id };
    const apply = { requestId: randomUUID(), candidate: proposal.candidate };
    const result = await f.service.applyDelegated(apply, invocation);
    expect(result).toMatchObject({ persisted: true, reload: 'applied', restartRequired: false });
    expect(f.manager.current().openKitConfig.policy?.workerGitReadMaintenance).toEqual([]);
    expect(JSON.parse(readFileSync(f.agentPath, 'utf8'))).toEqual({
      ...f.authored,
      sandbox: {
        ...f.authored.sandbox,
        network: [{ ...f.authored.sandbox!.network![0], rules: correctedRules }],
      },
    });
    expect(
      f.manager.current().agentManifests.find((agent) => agent.id === assignment.agentId)?.sandbox
        ?.network[0]?.rules
    ).toEqual(correctedRules);
    expect(
      loadedBefore.agentManifests.find((agent) => agent.id === assignment.agentId)?.sandbox
        ?.network[0]?.rules
    ).toEqual(originalRules);
    expect(listServerPermissionDecisions(f.coreDb)).toContainEqual(
      expect.objectContaining({
        result: 'allow',
        ownerScope: 'server',
        action: 'administration.configuration.apply',
        policySnapshotId: loadedBefore.contentHash,
        contextSummary: expect.objectContaining({
          threadId: f.home.threadId,
          turnId: applyingTurn.id,
          purpose: 'git-read',
          candidate: proposal.candidate,
          baseRevision: f.request.expectedRevision,
          failure: f.request.failure,
        }),
      })
    );
    expect(await f.service.applyDelegated(apply, invocation)).toEqual(result);
    const reopened = createAdministrationConfiguration({
      ...f,
      store: new FsStore({ dataRoot: f.dataRoot }),
    });
    expect(await reopened.applyDelegated(apply, invocation)).toEqual(result);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.store.getArtifact(f.workspaceId, proposal.candidate.artifactId).content.body).toBe(
      candidateBytes
    );
    expect(f.store.getTurn('ws_demo', f.request.failure.threadId, f.failedTurn.id)).toMatchObject({
      status: 'failed',
    });
  });

  it('reports persistence separately when reload fails and replays without another write', async () => {
    const f = fixture();
    const proposal = f.propose();
    const loaded = f.manager.current();
    f.reload.mockImplementationOnce(() => {
      throw new Error('Injected reload outage.');
    });
    const request = { requestId: randomUUID(), candidate: proposal.candidate };
    const result = await f.service.applyDelegated(request, f.home);
    expect(result).toMatchObject({ persisted: true, reload: 'failed' });
    expect(JSON.parse(readFileSync(f.agentPath, 'utf8')).sandbox.network[0].rules).toEqual(
      correctedRules
    );
    expect(f.manager.current()).toBe(loaded);
    expect(await f.service.applyDelegated(request, f.home)).toEqual(result);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    'outcome',
    'receipt',
  ] as const)('fences replay and reopen after an interrupted %s publication following the actual write', async (stage) => {
    const f = fixture();
    const request = { requestId: randomUUID(), candidate: f.propose().candidate };
    const interrupt = () => {
      throw new Error(`Injected ${stage} publication interruption.`);
    };
    const publication =
      stage === 'outcome'
        ? vi.spyOn(f.store, 'createArtifact').mockImplementationOnce(interrupt)
        : vi.spyOn(f.store, 'recordCommandRequest').mockImplementationOnce(interrupt);

    await expect(f.service.applyDelegated(request, f.home)).rejects.toThrow(
      `Injected ${stage} publication interruption.`
    );
    publication.mockRestore();
    const persisted = readFileSync(f.agentPath, 'utf8');
    expect(JSON.parse(persisted).sandbox.network[0].rules).toEqual(correctedRules);
    expect(
      f.store.getCommandRequest('administration.configuration.apply', request.requestId, {
        actorId: f.actor.userId,
        workspaceId: f.workspaceId,
        threadId: f.home.threadId,
      })
    ).toBeNull();
    await expect(f.service.applyDelegated(request, f.home)).rejects.toMatchObject({
      code: 'configuration_recovery_required',
    });
    const reopened = createAdministrationConfiguration({
      ...f,
      store: new FsStore({ dataRoot: f.dataRoot }),
    });
    await expect(reopened.applyDelegated(request, f.home)).rejects.toMatchObject({
      code: 'configuration_recovery_required',
    });
    expect(readFileSync(f.agentPath, 'utf8')).toBe(persisted);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed candidate for an already completed request without another effect', async () => {
    const f = fixture();
    const request = { requestId: randomUUID(), candidate: f.propose().candidate };
    const otherCandidate = f.propose().candidate;
    expect(otherCandidate.artifactId).not.toBe(request.candidate.artifactId);
    const result = await f.service.applyDelegated(request, f.home);
    const persisted = readFileSync(f.agentPath, 'utf8');
    const changed = { ...request, candidate: otherCandidate };
    await expect(f.service.applyDelegated(changed, f.home)).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    const reopened = createAdministrationConfiguration({
      ...f,
      store: new FsStore({ dataRoot: f.dataRoot }),
    });
    await expect(reopened.applyDelegated(changed, f.home)).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    expect(await reopened.applyDelegated(request, f.home)).toEqual(result);
    expect(readFileSync(f.agentPath, 'utf8')).toBe(persisted);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reason: 'absent', entries: [] },
    { reason: 'disabled', entries: [{ ...assignment, enabled: false }] },
    { reason: 'expired', entries: [{ ...assignment, expiresAt: '2021-01-01T00:00:00.000Z' }] },
    {
      reason: 'outside repository bounds',
      entries: [{ ...assignment, repositoryPaths: ['/other/project.git'] }],
    },
  ])('refuses current $reason authority after Tool assembly and before a write', async ({
    entries,
  }) => {
    const f = fixture();
    const candidate = f.propose().candidate;
    const original = readFileSync(f.agentPath, 'utf8');
    f.saveAssignments(entries);
    expect(f.manager.reload({ mode: 'safe', dryRun: false }).status).toBe('applied');
    await expect(
      f.service.applyDelegated({ requestId: randomUUID(), candidate }, f.home)
    ).rejects.toMatchObject({ code: 'configuration_delegation_required' });
    expect(readFileSync(f.agentPath, 'utf8')).toBe(original);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('refuses changed source and candidate identity without a configuration write', async () => {
    const f = fixture();
    const candidate = f.propose().candidate;
    await expect(
      f.service.applyDelegated(
        {
          requestId: randomUUID(),
          candidate: { ...candidate, contentDigest: `sha256:${'0'.repeat(64)}` },
        },
        f.home
      )
    ).rejects.toMatchObject({ code: 'configuration_candidate_conflict' });
    const changed = JSON.stringify({ ...f.authored, displayName: 'An intervening operator edit' });
    writeFileSync(f.agentPath, changed);
    await expect(
      f.service.applyDelegated({ requestId: randomUUID(), candidate }, f.home)
    ).rejects.toMatchObject({ code: 'config_revision_conflict' });
    expect(readFileSync(f.agentPath, 'utf8')).toBe(changed);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('refuses cancelled, mismatched and no-longer-running private invocations before a write', async () => {
    const f = fixture();
    const candidate = f.propose().candidate;
    const original = readFileSync(f.agentPath, 'utf8');
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.applyDelegated(
        { requestId: randomUUID(), candidate },
        { ...f.home, signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'configuration_cancelled' });
    await expect(
      f.service.applyDelegated(
        { requestId: randomUUID(), candidate },
        { ...f.home, threadId: f.request.failure.threadId }
      )
    ).rejects.toMatchObject({ code: 'configuration_candidate_conflict' });
    f.store.updateTurn(f.home.turnId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    await expect(
      f.service.applyDelegated({ requestId: randomUUID(), candidate }, f.home)
    ).rejects.toMatchObject({ code: 'configuration_cancelled' });
    expect(readFileSync(f.agentPath, 'utf8')).toBe(original);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('rechecks current administrator eligibility before mutation', async () => {
    const f = fixture();
    const candidate = f.propose().candidate;
    const original = readFileSync(f.agentPath, 'utf8');
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    await expect(
      f.service.applyDelegated({ requestId: randomUUID(), candidate }, f.home)
    ).rejects.toThrow();
    expect(readFileSync(f.agentPath, 'utf8')).toBe(original);
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: 'push',
      changes: {
        networkGrantId: 'git-read',
        rules: [...correctedRules, { method: 'POST', path: '/team/project.git/git-receive-pack' }],
      },
    },
    {
      reason: 'unrelated-rule removal',
      changes: { networkGrantId: 'git-read', rules: correctedRules.slice(0, 2) },
    },
    {
      reason: 'unrelated fields',
      changes: {
        networkGrantId: 'git-read',
        rules: correctedRules,
        displayName: 'Unauthorized change',
      },
    },
  ])('refuses a $reason proposal without a write', ({ changes }) => {
    const f = fixture();
    const original = readFileSync(f.agentPath, 'utf8');
    expect(() => f.service.propose({ ...f.request, changes }, f.home)).toThrow();
    expect(readFileSync(f.agentPath, 'utf8')).toBe(original);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('refuses ambiguous failed-Turn repository lineage without selecting an input', () => {
    const f = fixture(2);
    expect(() => f.propose()).toThrow(
      expect.objectContaining({ code: 'configuration_failure_unproved' })
    );
    expect(f.write).not.toHaveBeenCalled();
  });

  it('keeps Gateway candidates outside delegated application', async () => {
    const f = fixture();
    const proposal = f.service.propose(
      {
        targetFamily: 'gateway',
        targetId: 'gateway',
        expectedRevision: f.files.readFile('gateway.jsonc').file.revision,
        changes: {
          logicalModels: [
            {
              ...createTestGatewayConfig({ logicalModelId: 'reasoning' }).logicalModels[0],
              displayName: 'An ordinary catalog edit',
            },
          ],
        },
      },
      f.home
    );
    await expect(
      f.service.applyDelegated({ requestId: randomUUID(), candidate: proposal.candidate }, f.home)
    ).rejects.toMatchObject({ code: 'configuration_delegation_required' });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });
});
