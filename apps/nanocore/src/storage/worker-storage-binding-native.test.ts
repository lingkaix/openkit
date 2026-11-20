// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import {
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  markWorkerStorageAttachmentUnknown,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  selectWorkerStorageBinding,
} from '../runtime/worker-storage-binding-records.js';

it('keeps an unproved attachment fenced across reopen while a disjoint binding can proceed', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-storage-binding-'));
  const path = join(root, 'state.sqlite');
  const layout = {
    family: 'openkit-worker',
    version: '1',
    uid: 1000,
    gid: 1000,
    workingDirectory: '/workspace',
    platform: { architecture: 'amd64', os: 'linux' },
    targets: [{ target: '/workspace' }],
  };
  const factsFor = (scope: string) => ({
    agentSessionId: `session-${scope}`,
    authorizeContributor: () => true,
    deploymentId: 'fixture-deployment',
    expectedRevision: 1,
    layout,
    now: '2026-11-20T00:00:00.000Z',
    purpose: 'work' as const,
    responsibleUserId: 'fixture-user',
    runtimeTargetId: 'fixture-target',
    storageRef: `storage-${scope}`,
    threadId: `thread-${scope}`,
    workspaceId: `workspace-${scope}`,
  });
  const held = factsFor('held');
  const independent = factsFor('independent');

  let sqlite = new Database(path);
  try {
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/extensions/nanohost/', import.meta.url)
      ),
    });
    sqlite
      .prepare(`INSERT INTO nanohost_runtime_targets (
      target_id, identity_id, deployment_id, connection_generation, predecessor_fenced,
      ready, fresh_empty, observed_at, slot_count
    ) VALUES ('fixture-target', 'fixture-identity', 'fixture-deployment', 1, 1, 1, 1, ?, 1)`)
      .run(held.now);
    createWorkerStorageBinding({ sqlite }, held);
    sqlite.exec(`CREATE TEMP TRIGGER refuse_contributor BEFORE INSERT ON worker_storage_contributors
      BEGIN SELECT RAISE(ABORT, 'fixture contributor write failed'); END`);
    expect(() => reserveWorkerStorageAttachment({ sqlite }, held)).toThrow(
      'fixture contributor write failed'
    );
    expect(getWorkerStorageBinding({ sqlite }, held)).toMatchObject({
      attachmentGeneration: 0,
      contributors: [],
      revision: 1,
      state: 'idle',
    });
    sqlite.exec('DROP TRIGGER refuse_contributor');

    const reserved = reserveWorkerStorageAttachment({ sqlite }, held);
    const attachment = {
      attachmentGeneration: reserved.attachmentGeneration,
      expectedRevision: reserved.revision,
      storageRef: held.storageRef,
    };
    expect(() =>
      markWorkerStorageAttachmentUnknown(
        { sqlite },
        {
          ...attachment,
          attachmentGeneration: reserved.attachmentGeneration + 1,
        }
      )
    ).toThrow('Worker storage revision changed.');
    expect(getWorkerStorageBinding({ sqlite }, held)).toEqual(reserved);
    const retained = markWorkerStorageAttachmentUnknown({ sqlite }, attachment);
    expect(retained).toMatchObject({
      attachmentGeneration: 1,
      contributors: [{ attachmentGeneration: 1, storageRef: held.storageRef }],
      state: 'unknown',
    });

    sqlite.close();
    sqlite = new Database(path, { fileMustExist: true });
    sqlite.pragma('foreign_keys = ON');
    expect(getWorkerStorageBinding({ sqlite }, held)).toEqual(retained);
    expect(() =>
      selectWorkerStorageBinding(
        { sqlite },
        {
          ...held,
          expectedRevision: retained.revision,
        }
      )
    ).toThrow('Worker storage is fenced.');
    expect(() =>
      releaseWorkerStorageAttachment(
        { sqlite },
        {
          ...attachment,
          cleanupProved: false,
          expectedRevision: retained.revision,
        }
      )
    ).toThrow('Worker storage cleanup is not proved.');

    createWorkerStorageBinding({ sqlite }, independent);
    const disjoint = reserveWorkerStorageAttachment({ sqlite }, independent);
    expect(disjoint).toMatchObject({
      attachmentGeneration: 1,
      contributors: [{ storageRef: independent.storageRef }],
      state: 'reserved',
    });
    expect(disjoint.targets[0]?.volumeRef).not.toBe(retained.targets[0]?.volumeRef);
    expect(getWorkerStorageBinding({ sqlite }, held)).toEqual(retained);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (sqlite.open) sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
