import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthoredAgentConfigSchema } from '@openkit/config-schema';
import { canonicalNativeEnvironment } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
} from '../runtime/nanohost-harness-records.js';
import {
  admitWorkerImageEnvironment,
  writeWorkerImageSettlement,
} from '../runtime/worker-image-settlements.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createAgentNativeEnvironmentService } from './agent-native-environment.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const roots: string[] = [];
const dbs: CoreDb[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dbs.splice(0).forEach((db) => {
    db.sqlite.close();
  });
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});
const actor = { kind: 'local' as const, userId: 'user_local' };
const imageDigest = `sha256:${'d'.repeat(64)}`;
const values = { DEFAULT: 'image', EMPTY: '', HOME: '/managed/image-home' };
const defaultsDigest = `sha256:${createHash('sha256').update(canonicalNativeEnvironment(values)).digest('hex')}`;

/** Real Core admission, file revision/CAS and safe reload; no native or image effect. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-admin-'));
  roots.push(root);
  const db = openCoreDb(root);
  dbs.push(db);
  applyMigrations(db);
  ensureLocalUser(db);
  const manifest = AuthoredAgentConfigSchema.parse({
    schemaVersion: 1,
    id: 'agent_native',
    displayName: 'Native',
    models: { preferredLogicalModelId: 'reasoning', allowedLogicalModelIds: ['reasoning'] },
    runtime: {
      adapter: 'pi',
      kind: 'pi',
      image: { kind: 'reference', pullPolicy: 'never', ref: imageDigest },
      binaries: [{ id: 'shim', path: '/usr/local/bin/openkit-worker-shim' }],
    },
    sandbox: { network: [] },
  });
  const fileId = 'agents/agent_native.agent.jsonc';
  mkdirSync(join(root, 'config/agents'), { recursive: true });
  const path = join(root, 'config', fileId);
  writeFileSync(path, '// preserved comment\n' + JSON.stringify(manifest));
  const manager = createRuntimeConfigManager({
    dataRoot: null,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      dataRoot: null,
      agentManifests: [manifest],
    }),
  });
  const files = new RuntimeConfigFileService({
    dataRoot: root,
    workspaceIds: [],
    userId: actor.userId,
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const store = createDemoStore({ dataRoot: root });
  const service = createAgentNativeEnvironmentService({
    coreDb: db,
    store,
    manager,
    filesForActor: () => files,
  });
  const candidate = {
    authoredArtifactId: 'ar_defaults',
    authoredArtifactVersion: 1 as const,
    authoredContentDigest: `sha256:${'a'.repeat(64)}`,
    inputDigest: `sha256:${'b'.repeat(64)}`,
  };
  writeWorkerImageSettlement(db, {
    ...candidate,
    requestId: '1'.repeat(64),
    operation: 'image.acquire',
    outcome: { kind: 'success', imageDigest },
  });
  return {
    root,
    db,
    path,
    fileId,
    manager,
    files,
    store,
    service,
    admit: () =>
      admitWorkerImageEnvironment(db, candidate, { imageDigest, defaultsDigest, values }),
  };
}

describe('Agent public native environment administration', () => {
  it('refuses unadmitted defaults and actors without current administrator authority', () => {
    const f = fixture();
    expect(() => f.service.view(actor, f.fileId)).toThrow(
      expect.objectContaining({
        code: 'worker_environment_preparation_required',
        status: 409,
        message:
          'Agent "agent_native" requires Worker environment preparation and activation before starting work; verified image defaults are unavailable.',
      })
    );
    f.admit();
    expect(() => f.service.view({ kind: 'session', userId: 'foreign' }, f.fileId)).toThrow();
    expect(f.service.view(actor, f.fileId)).toMatchObject({
      defaults: values,
      desired: { values: { DEFAULT: 'image', EMPTY: '' } },
      managedNames: ['HOME'],
      applied: [],
      reload: { matchesDesired: true },
    });
  });
  it('rejects stale identities and protected/null edits before existing file CAS or reload', () => {
    const f = fixture();
    f.admit();
    const update = vi.spyOn(f.files, 'updateFile');
    const reload = vi.spyOn(f.manager, 'reload');
    const baseline = readFileSync(f.path, 'utf8');
    const request = {
      fileId: f.fileId,
      expectedRevision: f.files.readFile(f.fileId).file.revision!,
      imageDigest,
      defaultsDigest,
      environment: { DEFAULT: null },
    };
    for (const invalid of [
      { ...request, expectedRevision: 'stale' },
      { ...request, imageDigest: `sha256:${'e'.repeat(64)}` },
      { ...request, defaultsDigest: `sha256:${'f'.repeat(64)}` },
      { ...request, environment: { HOME: null } },
    ])
      expect(() => f.service.update(actor, invalid)).toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe(baseline);
  });
  it('reads pending/acknowledged/unknown projections from bindings and hides private sibling Threads', () => {
    const f = fixture();
    f.admit();
    recordWorkspaceOwnerMembership({
      coreDb: f.db,
      workspaceId: 'ws_demo',
      ownerUserId: actor.userId,
    });
    const thread = f.store.createThread('ws_demo', 'Visible', 'native-visible');
    const hidden = f.store.createThread(
      'ws_demo',
      'Private sibling',
      'native-hidden',
      'conversation',
      { visibility: 'private', privateOwnerUserId: 'foreign' }
    );
    const now = '2026-10-01T00:00:00.000Z';
    f.db.sqlite
      .prepare(
        `INSERT INTO nanohost_runtime_targets (target_id, identity_id, deployment_id, connection_generation, predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count) VALUES ('target-native', 'identity-native', 'deployment-native', 1, 1, 1, 1, ?, ?, 1)`
      )
      .run('a'.repeat(64), now);
    createNanoHostHarnessRuntime(f.db, {
      adapterId: 'pi',
      adapterVersion: 'test',
      harnessInstanceId: 'harness-native',
      harnessBindingRef: 'harness-binding-native',
      harnessCompatibilityKey: 'a'.repeat(64),
      sandboxRuntimeId: 'sandbox-native',
      sandboxBindingRef: 'sandbox-binding-native',
      sandboxIntegrationBindingRef: 'integration-native',
      sandboxCompatibilityKey: 'b'.repeat(64),
      originPhysicalEpoch: 'a'.repeat(64),
      imageDigest,
      runtimeTargetId: 'target-native',
      timestamp: now,
    });
    const environment = f.service.view(actor, f.fileId).desired;
    expect(() =>
      openNanoHostAgentSessionBinding(f.db, {
        agentSessionId: 'as-wrong-image',
        agentSessionRuntimeBindingId: 'binding-wrong-image',
        agentSessionCompatibilityKey: 'c'.repeat(64),
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-native',
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        nativeEnvironment: {
          agentId: 'agent_native',
          ...environment,
          imageDigest: `sha256:${'e'.repeat(64)}`,
        },
        timestamp: now,
      })
    ).toThrow('measured Sandbox');
    for (const row of [thread, hidden])
      openNanoHostAgentSessionBinding(f.db, {
        agentSessionId: `as-${row.id}`,
        agentSessionRuntimeBindingId: `binding-${row.id}`,
        agentSessionCompatibilityKey: 'c'.repeat(64),
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-native',
        workspaceId: row.workspaceId,
        threadId: row.id,
        nativeEnvironment: { agentId: 'agent_native', ...environment },
        timestamp: now,
      });
    expect(f.service.view(actor, f.fileId).applied).toEqual([
      {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        state: 'pending',
        environment: null,
        matchesDesired: false,
      },
    ]);
    const body = {
      adapterId: 'pi',
      agentSessionCompatibilityKey: 'c'.repeat(64),
      agentSessionId: `as-${thread.id}`,
      agentSessionRuntimeBindingId: `binding-${thread.id}`,
      effectiveSetupGeneration: 1,
      resume: null,
      threadId: thread.id,
      workspaceId: 'ws_demo',
    };
    for (const nativeEnvironment of [undefined, { DEFAULT: 'wrong', EMPTY: '' }])
      expect(() =>
        queueNanoHostHarnessOperation(f.db, {
          harnessInstanceId: 'harness-native',
          operation: 'session.open',
          body: { ...body, ...(nativeEnvironment ? { nativeEnvironment } : {}) },
          timestamp: now,
        })
      ).toThrow('exact binding');
    f.db.sqlite
      .prepare(
        "UPDATE agent_session_runtime_bindings SET native_environment_applied = 1, lifecycle_state = 'open'"
      )
      .run();
    expect(f.service.view(actor, f.fileId).applied).toEqual([
      {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        state: 'acknowledged',
        environment,
        matchesDesired: true,
      },
    ]);
    f.db.sqlite.prepare("UPDATE sandbox_runtime_records SET lifecycle_state = 'closed'").run();
    expect(f.service.view(actor, f.fileId).applied[0]).toMatchObject({
      state: 'unknown',
      environment: null,
      matchesDesired: false,
    });
    f.db.sqlite.prepare("UPDATE sandbox_runtime_records SET lifecycle_state = 'open'").run();
    f.db.sqlite.prepare('UPDATE nanohost_runtime_targets SET ready = 0').run();
    expect(f.service.view(actor, f.fileId).applied[0]).toMatchObject({
      state: 'unknown',
      environment: null,
      matchesDesired: false,
    });
    f.db.sqlite
      .prepare('UPDATE nanohost_runtime_targets SET ready = 1, physical_epoch = ?')
      .run('b'.repeat(64));
    expect(f.service.view(actor, f.fileId).applied[0]).toMatchObject({
      state: 'unknown',
      environment: null,
      matchesDesired: false,
    });
    f.db.sqlite
      .prepare('UPDATE nanohost_runtime_targets SET physical_epoch = ?')
      .run('a'.repeat(64));
    f.db.sqlite
      .prepare("UPDATE agent_session_runtime_bindings SET cleanup_state = 'unknown'")
      .run();
    expect(f.service.view(actor, f.fileId).applied).toEqual([
      {
        workspaceId: 'ws_demo',
        threadId: thread.id,
        state: 'unknown',
        environment: null,
        matchesDesired: false,
      },
    ]);
  });

  it('publishes typed private runtime environment operations and refuses non-administrators before reading values', async () => {
    const f = fixture();
    f.admit();
    let viewer = actor as import('../auth/identity.js').Actor;
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', viewer);
      await next();
    });
    registerOperationJsonRoutes({
      app,
      coreDb: f.db,
      requestStore: () => f.store,
      runtimeConfigOperations: {
        nativeEnvironment: f.service,
        manager: f.manager,
        filesForActor: () => f.files,
      },
    });
    expect(
      (
        await app.request(
          ...operationRequest('runtime.agent-environment-read', { fileId: f.fileId })
        )
      ).status
    ).toBe(200);
    const response = await app.request(
      ...operationRequest(
        'runtime.agent-environment-update',
        {},
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fileId: f.fileId,
            expectedRevision: f.files.readFile(f.fileId).file.revision,
            imageDigest,
            defaultsDigest,
            environment: { EMPTY: '' },
            note: 'inert request metadata',
          }),
        }
      )
    );
    expect(response.status).toBe(200);
    expect((await response.json()).overrides).toEqual({ EMPTY: '' });
    expect(readFileSync(f.path, 'utf8')).not.toContain('inert request metadata');
    viewer = { kind: 'session', userId: 'foreign' };
    expect(
      (
        await app.request(
          ...operationRequest('runtime.agent-environment-read', { fileId: f.fileId })
        )
      ).status
    ).toBe(403);
  });

  it('persists literal overrides/removals through real CAS without claiming a failed reload or native application', () => {
    const f = fixture();
    f.admit();
    const previous = f.files.readFile(f.fileId).file.revision!;
    const result = f.service.update(actor, {
      fileId: f.fileId,
      expectedRevision: previous,
      imageDigest,
      defaultsDigest,
      environment: { DEFAULT: null, EMPTY: '', LITERAL: '$HOME\nx=y' },
    });
    expect(result.persistedRevision).not.toBe(previous);
    expect(result.desired.values).toEqual({ EMPTY: '', LITERAL: '$HOME\nx=y' });
    expect(result.reload.matchesDesired).toBe(false);
    expect(result.applied).toEqual([]);
    expect(f.manager.current().agentManifests[0]!.runtime.environment).toBeUndefined();
    expect(readFileSync(f.path, 'utf8')).toContain('// preserved comment');
    expect(() =>
      f.files.updateFile({ id: f.fileId, kind: 'agent', expectedRevision: previous, content: '{}' })
    ).toThrow();
    const restored = f.service.update(actor, {
      fileId: f.fileId,
      expectedRevision: result.persistedRevision,
      imageDigest,
      defaultsDigest,
      environment: {},
    });
    expect(restored.desired.values).toEqual({ DEFAULT: 'image', EMPTY: '' });
    expect(restored.reload.matchesDesired).toBe(true);
  });
});
