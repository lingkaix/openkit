import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { prepareNanoHostOwner } from '../app.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import {
  type AdmittedWorkerStorageAttachment,
  activateWorkerStorageAttachment,
  admitWorkerStorageContributor,
  createAndReserveWorkerStorageAttachment,
  getWorkerStorageBinding,
  reserveWorkerStorageAttachment,
} from '../runtime/worker-storage-bindings.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { transitionAdmittedNanoHostRuntimeTarget } from './nanohost-transport-owner.js';

it('posts ordinary attachments to the admitted Native CAS under current storage authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-serving-storage-attachment-'));
  const core = openCoreDb(root);
  let closeReader: (() => void) | undefined;
  onTestFinished(async () => {
    closeReader?.();
    await shutdownControlStoreWorkerClient();
    core.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(core);
  const first = await openAdmittedTestNanoHost(core);
  const read = await getControlStoreWorkerClient().openServerOwnerReadDb(root, 'nanohost');
  closeReader = () => {
    if (read.open) read.close();
  };
  let verify: ((handle: typeof read) => boolean) | undefined;
  const storage = await prepareNanoHostOwner(core, {
    enabled: () => true,
    verifyStorageBinding: (input) => input.kind === 'release' || verify?.(read) === true,
  });
  expect(storage.state).toBe('ready');
  if (storage.state !== 'ready') throw new Error('Native storage fixture is unavailable.');
  const { deploymentId } = readDataRootLayoutMarker(root);
  const placement = { targetId: 'fixture-target', identityId: 'fixture-host', deploymentId };
  const now = '2026-11-21T00:00:00.000Z';
  await expect(
    transitionAdmittedNanoHostRuntimeTarget(first.value, {
      kind: 'allocate',
      ...placement,
      observedAt: now,
    })
  ).resolves.toMatchObject({ state: 'ready' });
  await expect(
    transitionAdmittedNanoHostRuntimeTarget(first.value, {
      kind: 'ready',
      ...placement,
      observedAt: now,
      connectionGeneration: 1,
      ready: true,
      freshEmpty: true,
      predecessorFenced: true,
      physicalEpoch: 'a'.repeat(64),
    })
  ).resolves.toMatchObject({ state: 'ready' });
  const target = getNanoHostRuntimeTarget({ sqlite: read }, placement.targetId)!;
  let contributorAllowed = true;
  let revokeBeforePost = false;
  const authorized = vi.fn(() => contributorAllowed);
  const admitted: AdmittedWorkerStorageAttachment = {
    attemptId: 'fixture-attempt',
    target,
    read: storage.value.owner.read,
    authorizeContributor: authorized,
    isCurrentAttempt: () => true,
    async write(command, authority) {
      expect(authority.attemptId).toBe('fixture-attempt');
      if (revokeBeforePost) contributorAllowed = false;
      verify = authority.verifyBeforePost;
      try {
        return await storage.value.owner.workerStorageBinding(command);
      } finally {
        verify = undefined;
      }
    },
  };
  const layout = {
    family: 'openkit-worker',
    version: '1',
    uid: 1000,
    gid: 1000,
    workingDirectory: '/workspace',
    platform: { architecture: 'amd64', os: 'linux' },
    targets: [{ target: '/workspace' }],
  };
  const selection = {
    authorizeContributor: authorized,
    layout,
    purpose: 'work' as const,
    responsibleUserId: 'fixture-user',
    threadId: 'fixture-thread',
    workspaceId: 'fixture-workspace',
  };
  const reservation = {
    ...selection,
    agentSessionId: 'fixture-session',
    runtimeTargetId: placement.targetId,
    now,
  };
  const reserved = await createAndReserveWorkerStorageAttachment(
    core,
    { ...reservation, deploymentId },
    admitted
  );
  expect(reserved).toMatchObject({ state: 'reserved', attachmentGeneration: 1, revision: 2 });
  expect(authorized).toHaveBeenCalled();
  const activation = {
    storageRef: reserved.storageRef,
    expectedRevision: reserved.revision,
    attachmentGeneration: reserved.attachmentGeneration,
    sandboxBindingRef: 'fixture-sandbox',
    targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
    now,
  };
  revokeBeforePost = true;
  await expect(activateWorkerStorageAttachment(core, activation, admitted)).rejects.toThrow();
  expect(getWorkerStorageBinding({ sqlite: read }, reserved)).toEqual(reserved);
  revokeBeforePost = false;
  contributorAllowed = true;
  await expect(
    activateWorkerStorageAttachment(core, activation, {
      ...admitted,
      target: { ...target, connectionGeneration: 2 },
    })
  ).rejects.toThrow();
  expect(getWorkerStorageBinding({ sqlite: read }, reserved)).toEqual(reserved);
  await expect(
    activateWorkerStorageAttachment(core, activation, {
      ...admitted,
      isCurrentAttempt: () => false,
    })
  ).rejects.toThrow();
  expect(getWorkerStorageBinding({ sqlite: read }, reserved)).toEqual(reserved);
  const attached = await activateWorkerStorageAttachment(core, activation, admitted);
  expect(attached).toMatchObject({
    state: 'attached',
    currentSandboxBindingRef: 'fixture-sandbox',
  });
  const shared = await admitWorkerStorageContributor(
    core,
    {
      ...selection,
      adjudicatedThreadIds: ['fixture-thread', 'sibling-thread'],
      threadId: 'sibling-thread',
      storageRef: attached.storageRef,
      expectedRevision: attached.revision,
    },
    admitted
  );
  expect(shared.contributors.map((contributor) => contributor.threadId).sort()).toEqual([
    'fixture-thread',
    'sibling-thread',
  ]);
  const released = await storage.value.owner.workerStorageBinding({
    kind: 'release',
    storageRef: shared.storageRef,
    expectedRevision: shared.revision,
    attachmentGeneration: shared.attachmentGeneration,
    sandboxBindingRef: 'fixture-sandbox',
    cleanupProved: true,
  });
  await expect(
    reserveWorkerStorageAttachment(
      core,
      {
        ...reservation,
        adjudicatedThreadIds: ['fixture-thread', 'sibling-thread'],
        storageRef: released.storageRef,
        expectedRevision: released.revision,
      },
      admitted
    )
  ).resolves.toMatchObject({ state: 'reserved', attachmentGeneration: 2 });
});
