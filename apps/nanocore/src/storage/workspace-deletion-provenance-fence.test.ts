import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { expect, it, vi } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import type { ControlProvenanceInput } from './control-store-worker-protocol.js';
import { openWorkspaceDb } from './db.js';

const WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';

it('refuses Task closeout provenance after the Workspace deletion freeze without recreating the canonical path', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provenance-freeze-'));
  await createDemoStore({ dataRoot });
  await shutdownControlStoreWorkerClient();
  const workspaceDb = openWorkspaceDb(dataRoot, WORKSPACE_ID);
  const workspaceRoot = join(dataRoot, 'workspaces', WORKSPACE_ID);
  const client = getControlStoreWorkerClient();
  const database = `workspace:${workspaceDb.sqlite.name}`;
  let releaseFreeze: (() => void) | undefined;
  const posts = vi.spyOn(Worker.prototype, 'postMessage');
  try {
    await client.open({
      database,
      path: workspaceDb.sqlite.name,
      dataRoot,
      create: false,
      initialize: 'workspace',
      productOwner: { kind: 'workspace', workspaceId: WORKSPACE_ID },
    });
    const frozen = client.tryFreezeWorkspace(dataRoot, WORKSPACE_ID, () => []);
    expect(frozen.status).toBe('frozen');
    if (frozen.status !== 'frozen') throw new Error('Expected the Workspace deletion freeze.');
    releaseFreeze = frozen.release;
    // Deletion has passed admission and removed the canonical Workspace directory.
    workspaceDb.sqlite.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
    expect(existsSync(workspaceRoot)).toBe(false);
    posts.mockClear();
    // Same client write `importWorkerRuntimeProvenance` uses from checkpoint clear.
    const input: ControlProvenanceInput = {
      workspaceId: WORKSPACE_ID,
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
      backend: { kind: 'openshell', placement: 'local', version: null },
      collectedAt: '2026-11-18T00:00:00.000Z',
      environmentPackage: {} as AgentEnvironmentPackage,
      files: [],
      normalizedBytes: 0,
      normalizedDigest: `sha256:${'ab'.repeat(32)}`,
    };
    await expect(client.provenance(database, input)).rejects.toMatchObject({
      code: 'workspace_frozen',
      status: 409,
    });
    expect(existsSync(workspaceRoot)).toBe(false);
    expect(posts.mock.calls.some(([message]) => message?.operation === 'provenance')).toBe(false);
  } finally {
    releaseFreeze?.();
    posts.mockRestore();
    try {
      await client.shutdown();
    } finally {
      await shutdownControlStoreWorkerClient();
      if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }
}, 60_000);
