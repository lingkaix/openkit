import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { createInMemoryRuntimeConfigSnapshot } from './config/runtime-config.js';
import { FsStore } from './lib/store.js';
import { isExactWorkerApprovalSourceDecision } from './policy/approval-gates.js';
import { listPolicyApprovalSourceDecisions } from './policy/permission-decisions.js';
import { ProviderRegistry } from './providers/registry.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import * as gitExecutor from './runtime/git-push-executor.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { recordWorkspaceApplyResult } from './runtime/workspace-apply-results.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { seedWritableGitRepository } from './test-support/git-repository.js';
import { createVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { registerWorkerMcpRoutes } from './worker-mcp-routes.js';
import { upsertWorkspaceRepositoryResource } from './workspace/repository-store.js';
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
  const start = (userId = 'user_local') => {
    const turn = store.createTurn('ws_demo', 'th_demo', 'Publish admitted commit', {
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
      threadId: 'th_demo',
      updatedAt: new Date().toISOString(),
      workspaceId: 'ws_demo',
    });
    store.updateTurn(turn.id, { agentSessionId: sessionId });
    return {
      turn,
      environmentPackage: resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup({ mcpIds: ['openkit-repository'] }),
        agentSessionId: sessionId,
        backend: { kind: 'openshell' },
        createdAt: new Date().toISOString(),
        requestId: randomUUID(),
        triggerActor: turn.triggerActor,
        turn,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      }),
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
  const runner = vi.spyOn(gitExecutor, 'runGitPushCommand').mockImplementation((input) =>
    originalRunner({
      ...input,
      args: input.args.map((arg) =>
        arg === 'https://github.com/openkit/fixture.git' ? remotePath : arg
      ),
    })
  );
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
    upstream,
    canary,
    git,
    remotePath,
    active: () => active,
    successor: (userId = 'user_local') => {
      active = start(userId);
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
  it('auto-allows, replays and executes through the host owner while the worker remains running', async () => {
    const f = await fixture();
    try {
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'repository_push_request_approval',
        'repository_push_execute',
      ]);
      const approved = await call(f, 'repository_push_request_approval', f.request);
      const data = approved.structuredContent as { approval: { id: string; status: string } };
      expect(data.approval.status).toBe('granted');
      expect(f.store.getTurnById(f.active().turn.id)).toMatchObject({
        status: 'running',
        humanGate: null,
        completedAt: null,
      });
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.runner).not.toHaveBeenCalled();
      const replay = await call(f, 'repository_push_request_approval', f.request);
      expect(replay.structuredContent).toEqual(approved.structuredContent);
      const execute = {
        requestId: randomUUID(),
        resourceId: 'repo_default',
        approvalRequestId: data.approval.id,
      };
      const pushed = await call(f, 'repository_push_execute', execute);
      expect(pushed.structuredContent).toMatchObject({
        outcome: 'pushed',
        approvalRowId: f.store
          .listThreadItems('ws_demo', 'th_demo')
          .find((item) => item.type === 'approval-request')?.id,
        actorId: 'user_local',
      });
      expect(f.git(['rev-parse', 'refs/heads/feature/issue84'], f.remotePath)).toBe(
        f.request.commitIds[0]
      );
      const count = f.runner.mock.calls.length;
      expect((await call(f, 'repository_push_execute', execute)).structuredContent).toEqual(
        pushed.structuredContent
      );
      expect(f.runner).toHaveBeenCalledTimes(count);
      expect(f.upstream).not.toHaveBeenCalled();
      expect(f.store.getTurnById(f.active().turn.id).status).toBe('running');
    } finally {
      await f.cleanup();
    }
  });

  it('uses a reloaded exact grant from a fresh AgentSession without rewriting its lineage', async () => {
    const f = await fixture();
    try {
      const approved = (await call(f, 'repository_push_request_approval', f.request))
        .structuredContent as { approval: { id: string } };
      const old = f.active();
      f.store.updateTurn(old.turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      f.store.updateAgentSession(old.environmentPackage.scope.agentSessionId, { status: 'closed' });
      const immutable = f.store.getApproval(approved.approval.id);
      f.reload();
      expect(f.store.getApproval(approved.approval.id)).toEqual(immutable);
      const successor = f.successor();
      const result = await call(f, 'repository_push_execute', {
        requestId: randomUUID(),
        resourceId: 'repo_default',
        approvalRequestId: approved.approval.id,
      });
      expect(result.structuredContent).toMatchObject({ outcome: 'pushed', actorId: 'user_local' });
      expect(f.store.getApproval(approved.approval.id)).toEqual(immutable);
      expect(f.store.getTurnById(successor.turn.id).status).toBe('running');
    } finally {
      await f.cleanup();
    }
  });

  it('executes a prior grant as a different current editor after the source actor is disabled', async () => {
    const f = await fixture();
    try {
      const approved = (await call(f, 'repository_push_request_approval', f.request))
        .structuredContent as { approval: { id: string } };
      const immutable = f.store.getApproval(approved.approval.id);
      const now = new Date().toISOString();
      f.coreDb.sqlite
        .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind)
        VALUES ('user_successor', 'Successor', 'successor@example.invalid', 0, ?, ?, 'human')`)
        .run(now, now);
      f.coreDb.sqlite
        .prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
        VALUES ('ws_demo', 'user_successor', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`)
        .run(now, now, now);
      f.coreDb.sqlite.prepare("UPDATE users SET status = 'disabled' WHERE id = 'user_local'").run();
      f.store.updateTurn(f.active().turn.id, { status: 'completed', completedAt: now });
      f.store.updateAgentSession(f.active().environmentPackage.scope.agentSessionId, {
        status: 'closed',
      });
      f.successor('user_successor');
      const result = await call(f, 'repository_push_execute', {
        requestId: randomUUID(),
        resourceId: 'repo_default',
        approvalRequestId: approved.approval.id,
      });
      expect(result.structuredContent).toMatchObject({
        outcome: 'pushed',
        actorId: 'user_successor',
      });
      expect(f.store.getApproval(approved.approval.id)).toEqual(immutable);
      expect(f.git(['rev-parse', 'refs/heads/feature/issue84'], f.remotePath)).toBe(
        f.request.commitIds[0]
      );
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
        f.client.callTool({ name: 'repository_push_request_approval', arguments: f.request })
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
      expect(await call(f, 'repository_push_request_approval', f.request)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'git_push_failed' } },
      });
      expect(f.runner).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });

  it('rejects a denied-call source transplanted onto another Approval and Item', async () => {
    const f = await fixture('require_human_approval');
    try {
      const result = await call(f, 'repository_push_request_approval', f.request);
      const data = result.structuredContent as {
        approval: { id: string; createdAt: string };
        approvalItemId: string;
      };
      const source = listPolicyApprovalSourceDecisions(
        f.workspaceDb,
        'ws_demo',
        data.approval.id
      )[0]!;
      const input = {
        approvalCreatedAt: data.approval.createdAt,
        approvalId: data.approval.id,
        approvalItemId: data.approvalItemId,
        source,
        threadId: 'th_demo',
        turnId: f.active().turn.id,
        workspaceDb: f.workspaceDb,
        workspaceId: 'ws_demo',
        store: f.store,
      };
      // The original package is explicit fixture authority, as it would be in a real checkpoint.
      f.store.updateAgentSession(f.active().environmentPackage.scope.agentSessionId, {
        environmentPackageSnapshotId: f.active().environmentPackage.snapshotId,
      });
      expect(isExactWorkerApprovalSourceDecision(input)).toBe(true);
      expect(
        isExactWorkerApprovalSourceDecision({
          ...input,
          approvalId: 'ap_transplanted',
          approvalItemId: 'it_transplanted',
        })
      ).toBe(false);
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
  ] as const)('refuses %s before host push or Gate effects', async (failure) => {
    const f = await fixture();
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
        await call(f, 'repository_push_request_approval', f.request);
        args.targetBranch = 'feature/other';
      }
      if (failure === 'missing-ref' || failure === 'changed-request') {
        const result = await call(f, 'repository_push_request_approval', args);
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
          f.client.callTool({ name: 'repository_push_request_approval', arguments: args })
        ).rejects.toThrow();
      expect(f.runner).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.store.getTurnById(f.active().turn.id).status).toBe('running');
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    'stopped',
    'stop-failed',
    'receipt-failed',
  ] as const)('persists the human Gate and fails closed for %s without reconstructing a stop', async (failure) => {
    const f = await fixture('require_human_approval');
    try {
      if (failure === 'stop-failed')
        f.stop.mockImplementation(() => {
          throw new Error('injected stop failure');
        });
      if (failure === 'receipt-failed')
        vi.spyOn(f.store, 'recordCommandRequest').mockImplementation(() => {
          throw new Error('injected receipt failure');
        });
      if (failure === 'stop-failed')
        await expect(
          f.client.callTool({ name: 'repository_push_request_approval', arguments: f.request })
        ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
      else {
        const result = await call(f, 'repository_push_request_approval', f.request);
        if (failure === 'stopped')
          expect(result.structuredContent).toMatchObject({ approval: { status: 'pending' } });
        else
          expect(result).toMatchObject({
            isError: true,
            structuredContent: { error: { code: 'recovery_required' } },
          });
      }
      expect(f.store.getTurnById(f.active().turn.id)).toMatchObject({
        status: 'awaiting_human',
        humanGate: { kind: 'approval' },
      });
      expect(f.stop).toHaveBeenCalledTimes(failure === 'receipt-failed' ? 0 : 1);
      await expect(
        f.client.callTool({ name: 'repository_push_request_approval', arguments: f.request })
      ).rejects.toThrow();
      expect(f.stop).toHaveBeenCalledTimes(failure === 'receipt-failed' ? 0 : 1);
      expect(f.runner).not.toHaveBeenCalled();
      expect(
        getWorkerCheckpoint(f.workspaceDb, 'ws_demo', 'th_demo', f.active().turn.id)
      ).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
});
