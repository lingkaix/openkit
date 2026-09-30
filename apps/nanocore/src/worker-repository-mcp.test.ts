import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { ensureLocalUser } from './auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { FsStore } from './lib/store.js';
import { ProviderRegistry } from './providers/registry.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import * as gitExecutor from './runtime/git-push-executor.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { recordWorkspaceApplyResult } from './runtime/workspace-apply-results.js';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
} from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { seedWritableGitRepository } from './test-support/git-repository.js';
import { createVaultGrant, revokeVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { registerWorkerMcpRoutes } from './worker-mcp-routes.js';
import {
  getWorkspaceRepositoryResource,
  upsertWorkspaceRepositoryResource,
} from './workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Creates one isolated selected-MCP boundary with real repository, Vault and command owners. */
async function fixture(mode: 'auto_allow' | 'require_human_approval' = 'auto_allow') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-repository-'));
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-push-host-'));
  const remotePath = mkdtempSync(join(dataRoot, 'remote-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  let store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  seedWritableGitRepository(repositoryPath);
  const git = (args: string[], cwd = repositoryPath) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '--bare'], remotePath);
  git(['remote', 'add', 'origin', 'https://github.com/openkit/fixture.git']);
  git(['push', remotePath, 'HEAD:refs/heads/main']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);
  writeFileSync(join(repositoryPath, 'README.md'), '# Accepted change\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'accepted change']);
  const commitId = git(['rev-parse', 'HEAD']);
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server/vault'),
  });
  vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 27) });
  const canary = `test-only-${randomUUID()}`;
  vaultUnlockState.backend().store({
    material: canary,
    metadata: { ownerScope: 'workspace', workspaceId: 'ws_demo' },
    referenceId: 'vault_push',
  });
  createVaultReference(coreDb, {
    backendKind: 'encrypted-file',
    backendLocator: 'encrypted-file://workspace/vault_push',
    displayName: 'Test push',
    ownerScope: 'workspace',
    referenceId: 'vault_push',
    secretKind: 'github-token',
    workspaceId: 'ws_demo',
  });
  createVaultGrant(coreDb, {
    allowedInjectionPaths: ['gateway-only'],
    grantId: 'grant_push',
    lifetime: 'workspace',
    ownerScope: 'workspace',
    vaultReferenceId: 'vault_push',
    workspaceId: 'ws_demo',
  });
  upsertWorkspaceRepositoryResource(workspaceDb, {
    workspaceExists: (id) => store.getWorkspace(id).id === id,
    workspaceId: 'ws_demo',
    resourceId: 'repo_default',
    displayName: 'Host fixture',
    localPath: repositoryPath,
    git: {
      authorEmail: null,
      authorName: null,
      commitOnApply: false,
      allowedPushTargets: ['feature/issue84'],
      protectedBranchPatterns: ['main'],
      requireReviewLinkage: true,
      stagingStrategy: 'staging-root',
      vaultGrantRef: 'grant_push',
    },
  });
  recordWorkspaceApplyResult(workspaceDb, {
    requestId: randomUUID(),
    result: {
      appliedAt: new Date().toISOString(),
      appliedPaths: ['README.md'],
      changeSetId: 'changes_fixture',
      commitIds: [commitId],
      conflictRecords: [],
      id: 'apply_fixture',
      reviewId: 'review_fixture',
      skippedPaths: [],
      status: 'applied',
      verification: [],
      workspaceId: 'ws_demo',
    },
  });
  const start = (
    userId = 'user_local',
    serverAdminTokenId: string | null = null,
    threadId = 'th_demo'
  ) => {
    const turn = store.createTurn('ws_demo', threadId, 'Publish admitted commit', {
      kind: 'user',
      id: userId,
    });
    const sessionId = `as_${randomUUID()}`;
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: new Date().toISOString(),
      id: sessionId,
      message: null,
      status: 'busy',
      threadId,
      updatedAt: new Date().toISOString(),
      workspaceId: 'ws_demo',
    });
    store.updateTurn(turn.id, { agentId: 'agent_codex_host', agentSessionId: sessionId });
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSetup: createTestAgentSetup({ mcpIds: ['openkit-repository'] }),
      agentSessionId: sessionId,
      backend: { kind: 'openshell' },
      createdAt: new Date().toISOString(),
      requestId: randomUUID(),
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: `queue_${turn.id}`,
      requestId: `request_${turn.id}`,
      triggerActor: turn.triggerActor,
      serverAdminTokenId,
      workspaceId: 'ws_demo',
      threadId,
      turnId: turn.id,
      turnInput: 'Publish admitted commit',
      requestedAgentId: environmentPackage.agent.agentId,
      priorityClass: 'interactive',
      requiredPoolConstraints: [],
    });
    createSchedulerPlacementPlan(coreDb, {
      planId: `plan_${turn.id}`,
      queueEntryId: `queue_${turn.id}`,
      selectedPoolId: 'pool_test',
      selectedTargetId: 'target_test',
      plannedLeaseDurationMs: 900_000,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      degradedOptionalFeatures: [],
      policyDecisionIds: [],
      schedulerEpoch: 1,
    });
    createSchedulerSessionLease(coreDb, {
      leaseId: `lease_${turn.id}`,
      planId: `plan_${turn.id}`,
      agentSessionId: sessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      expiresAt: '2099-01-01T00:00:00.000Z',
      heartbeatDeadline: '2099-01-01T00:00:00.000Z',
      startupDeadline: '2099-01-01T00:00:00.000Z',
      sandboxTokenBindingRef: `binding_${turn.id}`,
    });
    return {
      turn,
      environmentPackage,
    };
  };
  let active = start();
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    agentManifests: [createTestAgentSetup({ mcpIds: ['openkit-repository'] }).manifest],
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry: new ProviderRegistry([
      { displayName: 'Fixture', id: 'agent-openrouter', kind: 'local', models: ['openai/gpt-5.2'] },
    ]),
  });
  const workerControlGateway = {
    authenticatePackageToken: vi.fn(() => active.environmentPackage),
  } as unknown as WorkerControlGateway;
  const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
  const upstream = vi.spyOn(workerMcpGateway, 'callTool');
  const stop = vi.fn();
  const createRouteApp = () => {
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      approvalPolicy: { workspaceApprovalModes: { ws_demo: { 'repo.push': mode } } },
      runtimeConfig: () => snapshot,
      store,
      workerControlGateway,
      workerMcpGateway,
      vaultUnlockState,
      requestHumanGateStop: stop,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    return app;
  };
  let app = createRouteApp();
  const client = new Client({ name: 'repository-regression', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL('http://fixture.invalid/api/worker-capabilities/mcp/openkit-repository'),
      {
        fetch: (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: 'Bearer fixture-capability' } },
      }
    )
  );
  const originalRunner = gitExecutor.runGitPushCommand;
  const runHostCommand = (input: Parameters<typeof gitExecutor.runGitPushCommand>[0]) =>
    originalRunner({
      ...input,
      args: input.args.map((arg) =>
        arg === 'https://github.com/openkit/fixture.git' ? remotePath : arg
      ),
    });
  const runner = vi.spyOn(gitExecutor, 'runGitPushCommand').mockImplementation(runHostCommand);
  const request = {
    requestId: randomUUID(),
    resourceId: 'repo_default',
    sourceRef: commitId,
    targetBranch: 'feature/issue84',
    commitIds: [commitId],
  };
  return {
    app,
    client,
    coreDb,
    snapshot,
    get store() {
      return store;
    },
    reload: () => {
      store = new FsStore({ dataRoot });
      app = createRouteApp();
    },
    workspaceDb,
    request,
    stop,
    runner,
    vaultUnlockState,
    runHostCommand,
    upstream,
    canary,
    git,
    remotePath,
    active: () => active,
    successor: (
      userId = 'user_local',
      serverAdminTokenId: string | null = null,
      threadId = 'th_demo'
    ) => {
      active = start(userId, serverAdminTokenId, threadId);
      return active;
    },
    cleanup: async () => {
      runner.mockRestore();
      await client.close();
      await workerMcpGateway.close();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

/** Reads the built-in public result with its matching JSON text. */
async function call(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  args: Record<string, unknown>
) {
  const result = await f.client.callTool({ name, arguments: args });
  expect(result.content).toEqual([
    { type: 'text', text: JSON.stringify(result.structuredContent) },
  ]);
  expect(JSON.stringify(result)).not.toContain(f.canary);
  return result;
}

describe('selected repository MCP', () => {
  it('raises one human-mode pending push without stopping the Turn or contacting Git', async () => {
    const f = await fixture('require_human_approval');
    try {
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'repository_push',
      ]);
      const pending = await call(f, 'repository_push', f.request);
      expect(pending.isError).toBe(true);
      expect(pending.structuredContent).toMatchObject({ status: 'pending-approval' });
      expect(f.store.getTurnById(f.active().turn.id).status).toBe('running');
      expect(f.runner).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect((await call(f, 'repository_push', f.request)).structuredContent).toEqual(
        pending.structuredContent
      );
      expect(
        f.store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.type === 'approval-request')
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it('serializes concurrent human Git raises before the sixteenth-request boundary', async () => {
    const f = await fixture('require_human_approval');
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 17 }, () =>
          call(f, 'repository_push', { ...f.request, requestId: randomUUID() })
        )
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(16);
      expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
        { reason: { data: { code: 'request_limit_reached' } } },
      ]);
      expect(
        (
          f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS n FROM capability_calls').get() as {
            n: number;
          }
        ).n
      ).toBe(16);
      expect(
        (
          f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS n FROM pending_requests').get() as {
            n: number;
          }
        ).n
      ).toBe(16);
    } finally {
      await f.cleanup();
    }
  });

  it('deduplicates and bounds human Git raises at the MCP boundary before ledger writes', async () => {
    const f = await fixture('require_human_approval');
    try {
      const first = await call(f, 'repository_push', f.request);
      const count = () =>
        (
          f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS n FROM capability_calls').get() as {
            n: number;
          }
        ).n;
      const before = count();
      expect((await call(f, 'repository_push', f.request)).structuredContent).toEqual(
        first.structuredContent
      );
      expect(count()).toBe(before);
      for (let i = 1; i < 16; i++)
        await call(f, 'repository_push', { ...f.request, requestId: randomUUID() });
      const atLimit = count();
      await expect(
        call(f, 'repository_push', { ...f.request, requestId: randomUUID() })
      ).rejects.toMatchObject({ data: { code: 'request_limit_reached' } });
      expect(count()).toBe(atLimit);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    'vault-revoked',
    'target-removed',
  ] as const)('refuses captured Git authority before a claim: %s', async (fault) => {
    const f = await fixture('require_human_approval');
    try {
      await call(f, 'repository_push', f.request);
      const item = f.store
        .listThreadItems('ws_demo', 'th_demo')
        .find((item) => item.type === 'approval-request');
      if (!item || item.type !== 'approval-request')
        throw new Error('Missing captured push request.');
      f.store.updateTurn(f.active().turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      if (fault === 'vault-revoked') revokeVaultGrant(f.coreDb, { grantId: 'grant_push' });
      else {
        const repository = getWorkspaceRepositoryResource(
          f.workspaceDb,
          'ws_demo',
          'repo_default'
        )!;
        upsertWorkspaceRepositoryResource(f.workspaceDb, {
          ...repository,
          workspaceExists: () => true,
          git: { ...repository.git, allowedPushTargets: [] },
        });
      }
      const app = createApp({
        coreDb: f.coreDb,
        store: f.store,
        runtimeConfigManager: createRuntimeConfigManager({
          dataRoot: null,
          initialSnapshot: f.snapshot,
        }),
        vaultUnlockState: f.vaultUnlockState,
      });
      const response = await app.request(`/api/approvals/${item.approvalRequestId}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: f.active().turn.id,
          requestId: randomUUID(),
          decision: 'granted',
        }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        f.workspaceDb.sqlite
          .prepare('SELECT claim, disposition FROM pending_requests WHERE request_id = ?')
          .get(item.approvalRequestId)
      ).toEqual({ claim: 'unclaimed', disposition: 'denied-not-executed' });
      expect(f.runner).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it('executes the captured human-mode push once from the approval command after the raising Turn ends', async () => {
    const f = await fixture('require_human_approval');
    try {
      const pending = await call(f, 'repository_push', f.request);
      const approvalItem = f.store
        .listThreadItems('ws_demo', 'th_demo')
        .find((item) => item.type === 'approval-request');
      if (!approvalItem || approvalItem.type !== 'approval-request')
        throw new Error('Missing pending push request.');
      f.store.updateTurn(f.active().turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const app = createApp({
        coreDb: f.coreDb,
        store: f.store,
        runtimeConfigManager: createRuntimeConfigManager({
          dataRoot: null,
          initialSnapshot: f.snapshot,
        }),
        vaultUnlockState: f.vaultUnlockState,
      });
      const response = await app.request(
        `/api/approvals/${approvalItem.approvalRequestId}/respond`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: f.active().turn.id,
            requestId: randomUUID(),
            decision: 'granted',
          }),
        }
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(
        f.runner,
        JSON.stringify(
          f.workspaceDb.sqlite
            .prepare(
              'SELECT request_id, disposition, disposition_reason, claim FROM pending_requests'
            )
            .all()
        )
      ).toHaveBeenCalled();
      const calls = f.workspaceDb.sqlite
        .prepare("SELECT call_id, status FROM capability_calls WHERE operation = 'git.push'")
        .all() as Array<{ call_id: string; status: string }>;
      expect(calls).toEqual([
        { call_id: `cap_pending_${approvalItem.approvalRequestId}`, status: 'succeeded' },
      ]);
      const permission = f.workspaceDb.sqlite
        .prepare(
          "SELECT context_summary_json FROM permission_decisions WHERE approval_id = ? AND result = 'allow'"
        )
        .get(approvalItem.approvalRequestId) as { context_summary_json: string };
      expect(JSON.parse(permission.context_summary_json)).toMatchObject({
        capabilityCallId: calls[0]!.call_id,
      });
      expect(f.git(['rev-parse', 'refs/heads/feature/issue84'], f.remotePath)).toBe(
        f.request.commitIds[0]
      );
      expect(f.store.getTurnById(f.active().turn.id).status).toBe('completed');
      expect(pending.isError).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('auto-allows, replays and executes through the host owner while the worker remains running', async () => {
    const f = await fixture();
    try {
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'repository_push',
      ]);
      const pushed = await call(f, 'repository_push', f.request);
      expect(pushed.structuredContent).toMatchObject({ outcome: 'pushed', actorId: 'user_local' });
      expect(f.store.getTurnById(f.active().turn.id)).toMatchObject({
        status: 'running',
        completedAt: null,
      });
      expect(f.stop).not.toHaveBeenCalled();
      expect(
        f.runner,
        JSON.stringify(
          f.workspaceDb.sqlite
            .prepare(
              'SELECT request_id, disposition, disposition_reason, claim FROM pending_requests'
            )
            .all()
        )
      ).toHaveBeenCalled();
      expect(f.git(['rev-parse', 'refs/heads/feature/issue84'], f.remotePath)).toBe(
        f.request.commitIds[0]
      );
      const count = f.runner.mock.calls.length;
      expect((await call(f, 'repository_push', f.request)).structuredContent).toEqual(
        pushed.structuredContent
      );
      expect(f.runner).toHaveBeenCalledTimes(count);
      expect(f.upstream).not.toHaveBeenCalled();
      expect(f.store.getTurnById(f.active().turn.id).status).toBe('running');
    } finally {
      await f.cleanup();
    }
  });

  it('revokes old package listing and calls after current manifest selection is removed', async () => {
    const f = await fixture();
    try {
      const originalPackage = JSON.stringify(f.active().environmentPackage);
      f.snapshot.agentManifests[0]!.mcp = [];
      await expect(f.client.listTools()).rejects.toThrow();
      await expect(
        f.client.callTool({ name: 'repository_push', arguments: f.request })
      ).rejects.toThrow();
      expect(JSON.stringify(f.active().environmentPackage)).toBe(originalPackage);
      expect(f.runner).not.toHaveBeenCalled();
      expect(
        f.store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.type === 'approval-request')
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('keeps bad repository configuration distinct from a missing source ref', async () => {
    const f = await fixture();
    try {
      f.git(['remote', 'remove', 'origin']);
      expect(await call(f, 'repository_push', f.request)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'git_push_failed' } },
      });
      expect(f.runner).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    'missing-ref',
    'claimed-scope',
    'unselected',
    'stale-actor',
    'wrong-session',
    'changed-request',
  ] as const)('refuses %s before host push or pending-request effects', async (failure) => {
    const f = await fixture('require_human_approval');
    try {
      const args: Record<string, unknown> = { ...f.request };
      if (failure === 'missing-ref') args.sourceRef = 'absent-worker-only-ref';
      if (failure === 'claimed-scope') args.workspaceId = 'ws_other';
      if (failure === 'unselected') f.active().environmentPackage.supply.mcpServers = [];
      if (failure === 'wrong-session')
        f.store.updateTurn(f.active().turn.id, { agentSessionId: null });
      if (failure === 'stale-actor')
        f.coreDb.sqlite
          .prepare("UPDATE users SET status = 'disabled' WHERE id = 'user_local'")
          .run();
      if (failure === 'changed-request') {
        await call(f, 'repository_push', f.request);
        args.targetBranch = 'feature/other';
      }
      if (failure === 'missing-ref' || failure === 'changed-request') {
        const result = await call(f, 'repository_push', args);
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code:
                failure === 'missing-ref'
                  ? 'git_push_source_unavailable'
                  : 'idempotency_key_conflict',
            },
          },
        });
      } else
        await expect(
          f.client.callTool({ name: 'repository_push', arguments: args })
        ).rejects.toThrow();
      expect(f.runner).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.store.getTurnById(f.active().turn.id).status).toBe('running');
    } finally {
      await f.cleanup();
    }
  });
});
