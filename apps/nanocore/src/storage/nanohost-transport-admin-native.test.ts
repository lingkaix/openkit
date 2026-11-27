// openkit-test-platform: posix
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it, onTestFinished } from 'vitest';
import { NANOHOST_TRANSPORT_ADMIN_REFUSAL } from '../auth/nanohost-transport-codecs.js';
import {
  getNanoHostTransportTokenRecord,
  isNanoHostTransportIdentityActive,
} from '../auth/nanohost-transport-token-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import { disposeTestStore } from '../test-support/store.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

it('joins current Core administrator authority to the redacted Native Token lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-transport-admin-native-'));
  const core = openCoreDb(root);
  onTestFinished(() => disposeTestStore(root, core));
  applyMigrations(core);
  const userId = ensureLocalUser(core);
  const owner = openNanoHostTestOwner();
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.database);
    const loaded = Promise.all(workerData.modules.map(url => import(url)));
    parentPort.on('message', async (input) => {
      const [native, db] = await loaded;
      const sqlite = new Database(workerData.path, { fileMustExist: true });
      const audit = input.kind === 'lifecycle-audit';
      const coreDb = audit ? db.openCoreDb(workerData.root) : db.openCoreReadDb(workerData.root);
      sqlite.pragma('foreign_keys = ON');
      sqlite.pragma('synchronous = FULL');
      try {
        const value = coreDb.sqlite.transaction(() =>
          audit
            ? native.applyControlNanoHostTransport(
                coreDb, input, input.admitNative ? { sqlite } : undefined
              )
            : sqlite.transaction(() =>
                native.applyNanoHostAdministratorTransport(sqlite, coreDb, input)
              ).immediate()
        )();
        parentPort.postMessage({ ok: true, value });
      } catch (error) {
        parentPort.postMessage({ ok: false, message: error.message, code: error.code });
      } finally {
        coreDb.sqlite.close();
        sqlite.close();
      }
    });
    `,
    {
      eval: true,
      workerData: {
        root,
        path: owner.sqlite.name,
        database: createRequire(import.meta.url).resolve('better-sqlite3'),
        modules: [
          new URL('../../dist/auth/nanohost-transport-native.js', import.meta.url).href,
          new URL('../../dist/storage/db.js', import.meta.url).href,
        ],
      },
    }
  );
  onTestFinished(async () => {
    await worker.terminate();
  });
  const publish = async (input: object) => {
    const reply = once(worker, 'message');
    worker.postMessage(input);
    const [result] = await reply;
    if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
    return result.value;
  };
  const actor = { kind: 'local', userId } as const;
  const deploymentId = testEntityId('dep', 'transport-admin-owner');
  const identityId = 'transport-admin-owner';
  const first = testEntityId('nhtok', 'transport-admin-first');
  const issued = testEntityId('nhtok', 'transport-admin-issued');
  const rotated = testEntityId('nhtok', 'transport-admin-rotated');
  const replacement = testEntityId('nhtok', 'transport-admin-replacement');
  const now = new Date('2026-11-21T00:00:00.000Z');
  const issuance = (tokenId: string, digit: string) => ({
    tokenId,
    tokenHash: `sha256:${digit.repeat(64)}`,
    ownerNanoHostIdentityId: identityId,
    deploymentId,
    responsibleServerAdminActorId: userId,
    expiresAt: '2030-11-21T00:00:00.000Z',
    now,
  });

  await expect(
    publish({ kind: 'enroll', actor, record: issuance(first, 'a') })
  ).resolves.toMatchObject({
    kind: 'record',
    record: { tokenId: first, status: 'active' },
  });
  await expect(
    publish({
      kind: 'issue',
      actor: { ...actor, userId: testEntityId('usr', 'transport-admin-denied') },
      record: issuance(issued, 'b'),
    })
  ).rejects.toMatchObject({ code: NANOHOST_TRANSPORT_ADMIN_REFUSAL.code });
  expect(getNanoHostTransportTokenRecord(owner, issued)).toBeNull();
  const original = await publish({ kind: 'issue', actor, record: issuance(issued, 'b') });
  expect(original).toMatchObject({ kind: 'record', record: { tokenId: issued, status: 'active' } });
  expect(original.record).not.toHaveProperty('tokenHash');

  const rotate = (tokenId: string) =>
    publish({
      kind: 'rotate',
      actor,
      tokenId,
      successorTokenId: rotated,
      successorTokenHash: issuance(rotated, 'c').tokenHash,
      overlapSeconds: 60,
      now,
    });
  await expect(rotate(rotated)).resolves.toEqual({ kind: 'rotation', result: null });
  await expect(rotate(issued)).resolves.toMatchObject({
    kind: 'rotation',
    result: {
      record: { tokenId: rotated, predecessorTokenId: issued },
      rotatedRecord: { status: 'rotated' },
    },
  });
  const decommission = (deploymentId: string) =>
    publish({
      kind: 'decommission',
      actor,
      identityId,
      deploymentId,
      now,
    });
  await expect(decommission(testEntityId('dep', 'transport-admin-foreign'))).rejects.toThrow(
    'exact active identity'
  );
  expect(getNanoHostTransportTokenRecord(owner, rotated)).toMatchObject({ status: 'active' });
  await expect(publish({ kind: 'revoke', actor, tokenId: first, now })).resolves.toMatchObject({
    kind: 'record',
    record: { tokenId: first, status: 'revoked' },
  });
  await expect(decommission(deploymentId)).resolves.toMatchObject({ kind: 'decommission' });
  expect(isNanoHostTransportIdentityActive(owner, identityId, deploymentId)).toBe(false);
  await expect(
    publish({ kind: 'enroll', actor, record: issuance(replacement, 'd') })
  ).resolves.toMatchObject({
    kind: 'record',
    record: { tokenId: replacement, status: 'active' },
  });
  await owner.reopen();
  const rotatedRecord = getNanoHostTransportTokenRecord(owner, rotated);
  expect(rotatedRecord).toMatchObject({ status: 'revoked' });
  expect(isNanoHostTransportIdentityActive(owner, identityId, deploymentId)).toBe(true);
  const audit = {
    kind: 'lifecycle-audit',
    action: 'nanohost.transport.rotate',
    record: rotatedRecord,
    actorUserId: userId,
  };
  await expect(publish(audit)).rejects.toMatchObject({
    code: 'nanohost_transport_storage_unavailable',
  });
  await expect(publish({ ...audit, admitNative: true })).resolves.toEqual({ kind: 'audit' });
  const auditRow = core.sqlite
    .prepare("SELECT outcome, summary FROM audit_events WHERE action = 'nanohost.transport.rotate'")
    .get();
  expect(auditRow).toEqual({
    outcome: 'failed',
    summary: expect.stringContaining(`predecessor ${issued} status=revoked`),
  });
});
