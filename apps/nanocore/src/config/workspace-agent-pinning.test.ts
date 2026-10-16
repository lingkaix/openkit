import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OperationId } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createRuntimeConfigManager } from './runtime-config.js';

const cleanups: (() => void)[] = [];
const workspaceFileId = 'workspaces/ws_00000000-0000-7000-8000-000000000001/workspace.jsonc';
const unrelatedBinding = { agentId: 'agent_kept', profileId: 'default', skills: [] };

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Uses real file, reload, authorization and catalog owners; inference supply is fixture-owned. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-pin-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  cleanups.push(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const thread = store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Pin admission');
  const write = (relativePath: string, content: string) => {
    const path = join(dataRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  const candidate = createTestAgentSetup({ agentId: 'agent_candidate' }).manifest;
  candidate.profiles.push({ id: 'review', instructionsRef: 'review', skills: [], mcp: [] });
  const unavailable = createTestAgentSetup({
    agentId: 'agent_unavailable',
    logicalModelId: 'missing-model',
  }).manifest;
  for (const manifest of [
    candidate,
    unavailable,
    createTestAgentSetup({ agentId: 'agent_kept' }).manifest,
    createTestAgentSetup({ agentId: 'agent_default' }).manifest,
  ]) {
    write(`config/agents/${manifest.id}.agent.jsonc`, JSON.stringify(manifest));
  }
  write(
    'config/providers/fixture.provider.jsonc',
    JSON.stringify({
      id: 'agent-openrouter',
      displayName: 'Synthetic local inference supply',
      kind: 'local',
      vendor: 'openai',
      models: ['openai/gpt-5.2'],
    })
  );
  const gatewayBytes = JSON.stringify(createTestGatewayConfig());
  const gatewayPath = write('config/gateway.jsonc', gatewayBytes);
  const initialConfig = {
    schemaVersion: 1,
    workspace: {
      name: 'Pin conformance',
      defaultAgentId: 'agent_default',
      agents: [unrelatedBinding, { agentId: 'agent_unavailable' }],
      roots: [],
    },
  };
  const workspacePath = write(
    'workspaces/ws_00000000-0000-7000-8000-000000000001/config/workspace.jsonc',
    JSON.stringify(initialConfig)
  );
  const manager = createRuntimeConfigManager({ dataRoot });
  const app = createApp({ dataRoot, coreDb, store, mode: 'server', runtimeConfigManager: manager });
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'server-admin',
    expiresAt: '2099-01-01T00:00:00.000Z',
    workspaceIds: [],
  });
  const member = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'workspace',
    expiresAt: '2099-01-01T00:00:00.000Z',
    workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
  });
  const noWorkspace = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'workspace',
    expiresAt: '2099-01-01T00:00:00.000Z',
    workspaceIds: ['ws_00000000-0000-7000-8000-000000000002'],
  });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Unexpected network effect.'));
  const createTurn = vi.spyOn(store, 'createTurn');
  const createSession = vi.spyOn(store, 'createAgentSession');
  const call = (id: OperationId, input: unknown = {}, secret = admin.secret) =>
    app.request(
      ...operationRequest(
        id,
        {},
        {
          headers: { authorization: `Bearer ${secret}` },
          body: JSON.stringify(input),
        }
      )
    );
  const read = async () => {
    const response = await call('runtime.file-read', { id: workspaceFileId });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ file: { revision: string }; content: string }>;
  };
  const targets = async () => {
    const response = await call(
      'conversation.targets',
      { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      member.secret
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      targets: { targetRef: string; profileId: string | null; availability: string }[];
    };
    return body.targets.filter((target) => target.targetRef.startsWith('warm-worker:'));
  };
  const noWork = () => {
    expect(fetch).not.toHaveBeenCalled();
    expect(createTurn).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ).toEqual([]);
    expect(store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id)).toEqual([]);
    expect(
      coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
    ).toEqual({ count: 0 });
  };
  return {
    admin,
    member,
    noWorkspace,
    coreDb,
    store,
    thread,
    manager,
    dataRoot,
    call,
    read,
    targets,
    noWork,
    workspacePath,
    gatewayPath,
    gatewayBytes,
  };
}

/** Changes only the selected binding in the exact file read from the registered owner. */
function pinContent(content: string, profileId: string | null) {
  const config = JSON.parse(content);
  config.workspace.agents = config.workspace.agents.filter(
    (binding: { agentId: string }) => binding.agentId !== 'agent_candidate'
  );
  if (profileId) config.workspace.agents.push({ agentId: 'agent_candidate', profileId });
  return JSON.stringify(config);
}

describe('Workspace Agent pins through existing runtime configuration', () => {
  it('keeps general inventory broad and applies exact-revision pin, profile change and unpin only after reload', async () => {
    const f = fixture();
    const inventory = await f.call('agent.list', {}, f.member.secret);
    expect(inventory.status).toBe(200);
    expect((await inventory.json()).items).toContainEqual(
      expect.objectContaining({ id: 'agent_candidate' })
    );
    expect(await f.targets()).not.toContainEqual(
      expect.objectContaining({ targetRef: 'warm-worker:agent_candidate:default' })
    );
    expect(await f.targets()).toContainEqual(
      expect.objectContaining({
        targetRef: 'warm-worker:agent_default:default',
        availability: 'available',
      })
    );
    const files = await f.call('runtime.file-list');
    expect(files.status).toBe(200);
    expect((await files.json()).files).toContainEqual(
      expect.objectContaining({ id: workspaceFileId, kind: 'workspace' })
    );
    const original = await f.read();
    const content = pinContent(original.content, 'review');
    const validation = await f.call('runtime.validate', {
      files: [{ id: workspaceFileId, content }],
    });
    expect(validation.status).toBe(200);
    expect(await validation.json()).toMatchObject({ valid: true });
    expect(readFileSync(f.workspacePath, 'utf8')).toBe(original.content);
    const update = await f.call('runtime.file-update', {
      id: workspaceFileId,
      kind: 'workspace',
      expectedRevision: original.file.revision,
      content,
    });
    expect(update.status).toBe(200);
    expect((await f.read()).content).toBe(content);
    expect(await f.targets()).not.toContainEqual(
      expect.objectContaining({ targetRef: 'warm-worker:agent_candidate:review' })
    );
    const stale = await f.call('runtime.file-update', {
      id: workspaceFileId,
      kind: 'workspace',
      expectedRevision: original.file.revision,
      content: original.content,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'config_revision_conflict' });
    expect(readFileSync(f.workspacePath, 'utf8')).toBe(content);
    const reload = await f.call('runtime.reload', { mode: 'safe' });
    expect(reload.status).toBe(200);
    expect(await reload.json()).toMatchObject({ status: 'applied' });
    expect(await f.targets()).toContainEqual(
      expect.objectContaining({
        targetRef: 'warm-worker:agent_candidate:review',
        profileId: 'review',
        availability: 'available',
      })
    );
    const restarted = createRuntimeConfigManager({ dataRoot: f.dataRoot });
    const restartedApp = createApp({
      dataRoot: f.dataRoot,
      coreDb: f.coreDb,
      store: f.store,
      mode: 'server',
      runtimeConfigManager: restarted,
    });
    const restartedTargets = await restartedApp.request(
      '/api/app/operations/conversation.targets',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${f.member.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }),
      }
    );
    expect(restartedTargets.status).toBe(200);
    expect((await restartedTargets.json()).targets).toContainEqual(
      expect.objectContaining({
        targetRef: 'warm-worker:agent_candidate:review',
        profileId: 'review',
        availability: 'available',
      })
    );
    for (const profileId of ['default', null]) {
      const current = await f.read();
      const next = pinContent(current.content, profileId);
      expect(
        (
          await f.call('runtime.file-update', {
            id: workspaceFileId,
            kind: 'workspace',
            expectedRevision: current.file.revision,
            content: next,
          })
        ).status
      ).toBe(200);
      expect(JSON.parse((await f.read()).content).workspace.agents).toContainEqual(
        unrelatedBinding
      );
      expect(await (await f.call('runtime.reload', { mode: 'safe' })).json()).toMatchObject({
        status: 'applied',
      });
      const selected = (await f.targets()).filter((target) =>
        target.targetRef.startsWith('warm-worker:agent_candidate:')
      );
      expect(selected).toEqual(
        profileId
          ? [
              expect.objectContaining({
                targetRef: 'warm-worker:agent_candidate:default',
                profileId: 'default',
                availability: 'available',
              }),
            ]
          : []
      );
    }
    const staleTarget = await f.call(
      'conversation.submit',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: f.thread.id,
        requestId: '0190f4c8-0000-7000-8000-000000000135',
        input: 'Inspect the selected work.',
        targetRef: 'warm-worker:agent_candidate:default',
        artifactRefs: [],
      },
      f.member.secret
    );
    expect(staleTarget.status, await staleTarget.clone().text()).toBe(409);
    expect(await staleTarget.json()).toMatchObject({ code: 'target_missing' });
    f.noWork();
  });

  it('keeps persisted pin separate from last-known-good catalog after a failed reload', async () => {
    const f = fixture();
    const original = await f.read();
    const before = await f.targets();
    const content = pinContent(original.content, 'review');
    expect(
      (
        await f.call('runtime.file-update', {
          id: workspaceFileId,
          kind: 'workspace',
          expectedRevision: original.file.revision,
          content,
        })
      ).status
    ).toBe(200);
    // A different configuration file can fail after the Workspace write has committed.
    writeFileSync(f.gatewayPath, '{');
    const version = f.manager.current().version;
    const reload = await f.call('runtime.reload', { mode: 'safe' });
    expect(reload.status).toBe(200);
    expect(await reload.json()).toMatchObject({ status: 'failed' });
    expect(f.manager.current().version).toBe(version);
    expect((await f.read()).content).toBe(content);
    expect(await f.targets()).toEqual(before);
    writeFileSync(f.gatewayPath, f.gatewayBytes);
    expect(await (await f.call('runtime.reload', { mode: 'safe' })).json()).toMatchObject({
      status: 'applied',
    });
    expect(await f.targets()).toContainEqual(
      expect.objectContaining({
        targetRef: 'warm-worker:agent_candidate:review',
        availability: 'available',
      })
    );
    f.noWork();
  });

  it('rechecks administrator authority and refuses unavailable or unauthorized supply before work', async () => {
    const f = fixture();
    const original = await f.read();
    const update = {
      id: workspaceFileId,
      kind: 'workspace',
      expectedRevision: original.file.revision,
      content: pinContent(original.content, 'review'),
    };
    const member = await f.call('runtime.file-update', update, f.member.secret);
    expect(member.status).toBe(403);
    expect(readFileSync(f.workspacePath, 'utf8')).toBe(original.content);
    revokeOpenKitAccessTokenRecord(f.coreDb, f.admin.tokenId);
    const revoked = await f.call('runtime.file-update', update);
    expect(revoked.status).toBe(401);
    expect(readFileSync(f.workspacePath, 'utf8')).toBe(original.content);
    const unauthorized = await f.call(
      'conversation.targets',
      { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      f.noWorkspace.secret
    );
    expect(unauthorized.status).toBe(403);
    const inventory = await f.call('agent.list', {}, f.noWorkspace.secret);
    expect(inventory.status).toBe(200);
    expect((await inventory.json()).items).toEqual([]);
    const unauthorizedSubmit = await f.call(
      'conversation.submit',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: f.thread.id,
        requestId: '0190f4c8-0000-7000-8000-000000000136',
        input: 'Inspect the selected work.',
        targetRef: 'warm-worker:agent_default:default',
        artifactRefs: [],
      },
      f.noWorkspace.secret
    );
    expect(unauthorizedSubmit.status).toBe(403);
    expect(await f.targets()).toContainEqual(
      expect.objectContaining({
        targetRef: 'warm-worker:agent_unavailable:default',
        availability: 'unavailable',
      })
    );
    const submit = await f.call(
      'conversation.submit',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: f.thread.id,
        requestId: '0190f4c8-0000-7000-8000-000000000134',
        input: 'Inspect the selected work.',
        targetRef: 'warm-worker:agent_unavailable:default',
        artifactRefs: [],
      },
      f.member.secret
    );
    expect(submit.status, await submit.clone().text()).toBe(409);
    expect(await submit.json()).toMatchObject({ code: 'target_unavailable' });
    expect(readFileSync(f.workspacePath, 'utf8')).toBe(original.content);
    f.noWork();
  });
});
