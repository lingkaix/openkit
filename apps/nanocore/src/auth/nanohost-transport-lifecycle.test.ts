import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { openAdmittedTestNanoHost } from '../test-support/admitted-nanohost.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openNanoHostTestOwner } from '../test-support/nanohost-owner.js';
import { createOpenKitAccessTokenSecret, hashOpenKitAccessTokenSecret } from './access-token.js';
import { requireCurrentDeploymentAdmin } from './access-token-store.js';
import { createCommunicationCredentialOperationImplementations } from './credential-operations.js';
import {
  createNanoHostOperationImplementations,
  type NanoHostAdministratorEnroll,
  revokeAdmittedNanoHostInboundCredential,
} from './nanohost-operations.js';
import { admitNativeNanoHostTransportConnection } from './nanohost-transport-admission.js';
import type {
  ControlNanoHostTransportInput,
  ControlNanoHostTransportResult,
} from './nanohost-transport-codecs.js';
import {
  abortNanoHostTransportRotation,
  fenceNanoHostTransportAuthority,
  fenceNanoHostTransportOnTokenUnusable,
} from './nanohost-transport-lifecycle.js';
import transportRevision from './nanohost-transport-revision.json' with { type: 'json' };
import { createNanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import { deliverNanoHostTransportTokenToNamedSlot } from './nanohost-transport-sink.js';
import {
  createNanoHostTransportTokenRecord,
  enrollNanoHostTransportIdentity,
  getNanoHostTransportTokenRecord,
  isNanoHostTransportIdentityActive,
  prepareNanoHostTransportWriter,
  revokeNanoHostTransportTokenRecord,
  rotateNanoHostTransportTokenRecord,
  submitNanoHostTransportDecommission,
  verifyNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/**
 * Focused Token-slot abort, revocation, expiry, and decommission oracles
 * (`docs/specs/20260802-nanohost_runtime_and_transport.md`).
 *
 * Successful connection allocation, replacement, and native close fencing are
 * covered only by the native HTTP/2 server lifecycle test.
 */

const IDENTITY = 'integration_nanohost_primary';
const DEPLOYMENT = testEntityId('dep', 'transport-lifecycle');
const TARGET = 'target_primary';
const PHYSICAL_EPOCH = 'a'.repeat(64);

/**
 * Opens a migrated Core database under a unique temp root.
 *
 * @returns Open Core database handles.
 */
function openMigratedCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-lifecycle-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return coreDb;
}

async function seedReadyRuntimeTarget(owner: ReturnType<typeof openNanoHostTestOwner>) {
  const configured = {
    deploymentId: DEPLOYMENT,
    identityId: IDENTITY,
    observedAt: '2026-08-08T00:00:00.000Z',
    targetId: TARGET,
  };
  const target = await owner.transition({ kind: 'allocate', ...configured });
  if (!target) throw new Error('Expected the admitted RuntimeTarget.');
  await owner.transition({
    kind: 'ready',
    ...configured,
    connectionGeneration: target.connectionGeneration,
    freshEmpty: true,
    physicalEpoch: PHYSICAL_EPOCH,
    predecessorFenced: true,
    ready: true,
  });
}

function expectRuntimeTargetUnready(owner: ReturnType<typeof openNanoHostTestOwner>): void {
  expect(getNanoHostRuntimeTarget(owner, TARGET)).toMatchObject({
    connectionGeneration: 1,
    freshEmpty: false,
    physicalEpoch: null,
    ready: false,
  });
}

function enrollFixtureOwner(owner: ReturnType<typeof openNanoHostTestOwner>, label: string) {
  return enrollNanoHostTransportIdentity(owner.storage, {
    deploymentId: DEPLOYMENT,
    expiresAt: '2026-09-08T00:00:00.000Z',
    now: new Date('2026-08-08T00:00:00.000Z'),
    ownerNanoHostIdentityId: IDENTITY,
    responsibleServerAdminActorId: testEntityId('usr', label),
    secret: createOpenKitAccessTokenSecret(),
    tokenId: testEntityId('nhtok', label),
  });
}

/**
 * Builds declared A/B sink paths under a unique temp root.
 *
 * @returns Slot A and B sink path pairs.
 */
function slotPair() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-slots-'));
  return {
    root,
    A: {
      companionPath: join(root, 'A.meta'),
      secretPath: join(root, 'A.token'),
    },
    B: {
      companionPath: join(root, 'B.meta'),
      secretPath: join(root, 'B.token'),
    },
  };
}

/**
 * Returns whether a named slot still holds readable secret+companion material.
 *
 * @param sink Declared sink paths for one slot.
 * @returns True when both files exist and the secret still looks like `okt_`.
 */
function slotHoldsUsableMaterial(sink: { companionPath: string; secretPath: string }): boolean {
  if (!existsSync(sink.secretPath) || !existsSync(sink.companionPath)) {
    return false;
  }
  try {
    const secret = readFileSync(sink.secretPath, 'utf8');
    return secret.startsWith('okt_') && secret.length > 0;
  } catch {
    return false;
  }
}

/**
 * Counts how many of the A/B slots currently hold usable material.
 *
 * @param slots Slot pair sinks.
 * @returns Number of usable slots (0–2).
 */
function usableSlotCount(slots: ReturnType<typeof slotPair>): number {
  return [slots.A, slots.B].filter(slotHoldsUsableMaterial).length;
}

it.each(['committed', 'not-committed', 'unknown'] as const)(
  'enrolls the first named-slot credential with split RuntimeTarget and transport storage (%s)',
  async (acknowledgement) => {
    const coreDb = openMigratedCoreDb();
    const admitted = await openAdmittedTestNanoHost(coreDb);
    const storage = admitted.value;
    const userId = ensureLocalUser(coreDb);
    const slots = slotPair();
    onTestFinished(() => rmSync(slots.root, { recursive: true, force: true }));
    const expiresAt = '2030-08-08T01:00:00.000Z';
    const sink = slots.A;
    let rechecks = 0;
    let submissions = 0;
    // The fixture composes the real Core check and Native mutation. Production orders them in A2's Worker.
    const commitEnroll: NanoHostAdministratorEnroll = async ({ actor, ...command }) => {
      expect(rechecks).toBe(1);
      requireCurrentDeploymentAdmin(coreDb, actor);
      expect(actor.userId).toBe(userId);
      expect(command.record.responsibleServerAdminActorId).toBe(userId);
      expect(command.record.tokenHash).toBe(
        hashOpenKitAccessTokenSecret(readFileSync(sink.secretPath, 'utf8'))
      );
      submissions += 1;
      if (acknowledgement === 'not-committed')
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      const result = await storage.owner.transport(command);
      if (result.kind !== 'record') throw new Error('Missing Native enrollment acknowledgement.');
      if (acknowledgement === 'unknown')
        throw new ControlStoreWorkerError('unavailable', 'unknown');
      return result;
    };
    const ack = Promise.withResolvers<void>();
    const identityReadQueued = Promise.withResolvers<AbortSignal | undefined>();
    const requestSignal = new AbortController().signal;
    const operations = createNanoHostOperationImplementations({
      coreDb,
      mode: 'server',
      nanoHostConfig: {
        identityId: IDENTITY,
        deploymentId: DEPLOYMENT,
        credentialRef: 'fixture-nanohost-credential',
        credentialSlots: slots,
      },
      readNanoHostTarget: (id) =>
        storage.owner.read((sqlite) => getNanoHostRuntimeTarget({ sqlite }, id)),
      async afterNanoHostTransportAcknowledgement<Value>(read: () => Value, signal?: AbortSignal) {
        identityReadQueued.resolve(signal);
        await ack.promise;
        return read();
      },
      nanoHostEnrollment: { storage: admitted, commitEnroll },
    });
    const context = {
      kind: 'public',
      actor: { kind: 'local', userId },
      actorRef: { kind: 'user', id: userId },
      scope: { kind: 'server' },
      signal: requestSignal,
      recheckAdmission: async () => {
        rechecks += 1;
      },
    } as const;
    const auditCount = () =>
      coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) FROM audit_events WHERE action = 'nanohost.transport.enroll' AND outcome = 'succeeded'"
        )
        .pluck()
        .get();
    const pending = operations['nanohost.enroll']({ expiresAt, targetSlot: 'A' }, context);
    void pending.catch(() => undefined);
    try {
      expect(
        await Promise.race([
          identityReadQueued.promise,
          pending.then(
            () => 'enrollment completed',
            () => 'enrollment refused'
          ),
        ])
      ).toBe(requestSignal);
      expect(rechecks).toBe(0);
      expect(submissions).toBe(0);
      expect(existsSync(sink.secretPath)).toBe(false);
      expect(existsSync(sink.companionPath)).toBe(false);
      expect(auditCount()).toBe(0);
    } finally {
      ack.resolve();
    }
    if (acknowledgement !== 'committed') {
      await expect(pending).rejects.toMatchObject({ code: 'nanohost_enroll_failed' });
      const retained = acknowledgement === 'unknown';
      expect(submissions).toBe(1);
      expect(existsSync(sink.secretPath)).toBe(retained);
      expect(existsSync(sink.companionPath)).toBe(retained);
      expect(
        storage.owner.read((sqlite) =>
          isNanoHostTransportIdentityActive({ sqlite }, IDENTITY, DEPLOYMENT)
        )
      ).toEqual({ state: 'ready', value: retained });
      expect(auditCount()).toBe(0);
      return;
    }
    const response = await pending;
    expect(submissions).toBe(1);
    expect(response.slotResult).toEqual({ slot: 'A', status: 'written', issuanceGeneration: 1 });
    expect(response.record).toMatchObject({
      ownerNanoHostIdentityId: IDENTITY,
      deploymentId: DEPLOYMENT,
      status: 'active',
      predecessorTokenId: null,
    });
    const secret = readFileSync(sink.secretPath, 'utf8');
    expect(JSON.stringify(response).includes(secret)).toBe(false);
    expect(readFileSync(sink.companionPath, 'utf8')).toContain(
      `token_id=${response.record.tokenId}\n`
    );
    expect(existsSync(slots.B.secretPath)).toBe(false);
    expect(existsSync(slots.B.companionPath)).toBe(false);
    expect(
      storage.owner.read((sqlite) => ({
        identity: isNanoHostTransportIdentityActive({ sqlite }, IDENTITY, DEPLOYMENT),
        record: getNanoHostTransportTokenRecord({ sqlite }, response.record.tokenId),
      }))
    ).toEqual({ state: 'ready', value: { identity: true, record: response.record } });
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('nanohost_integration_identities', 'nanohost_transport_tokens')"
        )
        .all()
    ).toEqual([]);
    expect(auditCount()).toBe(1);
    await expect(
      operations['nanohost.token-issue']({ expiresAt, targetSlot: 'B' }, context)
    ).rejects.toMatchObject({ code: 'nanohost_transport_storage_unavailable', status: 503 });
    await expect(
      operations['nanohost.enroll']({ expiresAt, targetSlot: 'B' }, context)
    ).rejects.toMatchObject({ code: 'nanohost_already_enrolled', status: 409 });
    expect(submissions).toBe(1);
    expect(existsSync(slots.B.secretPath)).toBe(false);
  }
);

describe('NanoHost transport lifecycle (WP-2b R3)', () => {
  it('rotation_abort_clears_successor_and_keeps_predecessor_usable', async () => {
    const native = openNanoHostTestOwner();
    const slots = slotPair();
    const authority = createNanoHostTransportSessionAuthority();
    const predecessor = await enrollFixtureOwner(native, 'rotation-abort');
    deliverNanoHostTransportTokenToNamedSlot({
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      issuanceGeneration: 1,
      secret: predecessor.secret,
      sink: slots.A,
      slot: 'A',
      tokenId: predecessor.tokenId,
      writeDisposition: 'replace',
    });
    const rotated = await rotateNanoHostTransportTokenRecord(native.storage, predecessor.tokenId, {
      now: new Date('2026-08-08T01:00:00.000Z'),
      overlapSeconds: 3600,
    });
    deliverNanoHostTransportTokenToNamedSlot({
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      issuanceGeneration: 2,
      secret: rotated!.secret,
      sink: slots.B,
      slot: 'B',
      tokenId: rotated!.tokenId,
      writeDisposition: 'replace',
    });

    const aborted = await abortNanoHostTransportRotation(native.storage, authority, {
      now: new Date('2026-08-08T01:10:00.000Z'),
      predecessorTokenId: predecessor.tokenId,
      successorSink: slots.B,
      successorTokenId: rotated!.tokenId,
    });

    expect(aborted.predecessor.status).toBe('active');
    expect(aborted.successor.status).toBe('revoked');
    expect(
      await verifyNanoHostTransportTokenRecord(native.storage, predecessor.secret, {
        now: new Date('2026-08-08T01:10:00.000Z'),
      })
    ).not.toBeNull();
    expect(
      await verifyNanoHostTransportTokenRecord(native.storage, rotated!.secret, {
        now: new Date('2026-08-08T01:10:00.000Z'),
      })
    ).toBeNull();
    expect(slotHoldsUsableMaterial(slots.A)).toBe(true);
    expect(slotHoldsUsableMaterial(slots.B)).toBe(false);
    expect(usableSlotCount(slots)).toBe(1);
  });

  it('revocation rejects reauthentication without creating process-local authority', async () => {
    const coreDb = openMigratedCoreDb();
    const native = openNanoHostTestOwner();
    const authority = createNanoHostTransportSessionAuthority();
    await seedReadyRuntimeTarget(native);
    const issued = await enrollFixtureOwner(native, 'revoked-reauthentication');
    const userId = ensureLocalUser(coreDb);
    const operations = createCommunicationCredentialOperationImplementations({
      coreDb,
      mode: 'server',
    });
    await expect(
      operations['credential.revoke'](
        { kind: 'nanohost-transport', id: issued.tokenId },
        {
          kind: 'public',
          actor: { kind: 'local', userId },
          actorRef: { kind: 'user', id: userId },
          scope: { kind: 'server' },
        }
      )
    ).rejects.toMatchObject({ status: 503 });
    expect(getNanoHostTransportTokenRecord(native, issued.tokenId)?.status).toBe('active');
    expect(getNanoHostRuntimeTarget(native, TARGET)?.ready).toBe(true);

    const now = new Date('2026-08-08T02:00:00.000Z');
    await revokeNanoHostTransportTokenRecord(native.storage, issued.tokenId, { now });
    await fenceNanoHostTransportAuthority(native.storage, authority, IDENTITY, now.toISOString());
    expect(getNanoHostTransportTokenRecord(native, issued.tokenId)?.status).toBe('revoked');
    expect(authority.authoritativeGeneration(IDENTITY)).toBeNull();
    expectRuntimeTargetUnready(native);
    expect(
      await verifyNanoHostTransportTokenRecord(native.storage, issued.secret, { now })
    ).toBeNull();
    expect(
      await admitNativeNanoHostTransportConnection(native.storage, authority, {
        transportRevision: String(transportRevision),
        physicalConnection: null,
        secret: issued.secret,
        now,
      })
    ).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('holds administrator revoke before contact and acknowledges Audit only after native fencing', async () => {
    const nanoHost = openNanoHostTestOwner();
    const sessionAuthority = createNanoHostTransportSessionAuthority();
    const target = await nanoHost.transition({
      kind: 'allocate',
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      observedAt: '2026-08-08T00:00:00.000Z',
      targetId: TARGET,
    });
    await nanoHost.transition({
      kind: 'ready',
      connectionGeneration: target!.connectionGeneration,
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      observedAt: '2026-08-08T00:00:01.000Z',
      targetId: TARGET,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      physicalEpoch: PHYSICAL_EPOCH,
    });
    const userId = testEntityId('usr', 'native-revoke-administrator');
    const tokenId = testEntityId('nhtok', 'native-administrator-revoke');
    const secret = createOpenKitAccessTokenSecret();
    await nanoHost.storage.owner.transport({
      kind: 'enroll',
      record: {
        tokenId,
        tokenHash: hashOpenKitAccessTokenSecret(secret),
        deploymentId: DEPLOYMENT,
        expiresAt: '2030-08-08T01:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: IDENTITY,
        responsibleServerAdminActorId: userId,
      },
    });
    const binding = {
      storage: { state: 'ready', value: nanoHost.storage },
      sessionAuthority,
    } as const;
    let rechecks = 0;
    const context = {
      kind: 'public',
      actor: { kind: 'local', userId },
      actorRef: { kind: 'user', id: userId },
      scope: { kind: 'server' },
      recheckAdmission: async () => {
        rechecks += 1;
      },
    } as const;
    await expect(
      revokeAdmittedNanoHostInboundCredential(binding, tokenId, context)
    ).rejects.toMatchObject({ status: 503 });
    expect(rechecks).toBe(0);
    expect(getNanoHostTransportTokenRecord(nanoHost, tokenId)?.status).toBe('active');
    expect(getNanoHostRuntimeTarget(nanoHost, TARGET)?.ready).toBe(true);

    let audited = false;
    await revokeAdmittedNanoHostInboundCredential(
      {
        ...binding,
        async commitRevoke({ actor, expected }) {
          expect(rechecks).toBe(1);
          expect(actor).toEqual(context.actor);
          expect(expected).toMatchObject({ tokenId, deploymentId: DEPLOYMENT, status: 'active' });
          const record = await revokeNanoHostTransportTokenRecord(nanoHost.storage, tokenId);
          return {
            state: 'ready',
            value: {
              record: record!,
              async acknowledgeAudit() {
                expect(getNanoHostTransportTokenRecord(nanoHost, tokenId)?.status).toBe('revoked');
                expect(getNanoHostRuntimeTarget(nanoHost, TARGET)?.ready).toBe(false);
                audited = true;
              },
            },
          };
        },
      },
      tokenId,
      context
    );
    expect(audited).toBe(true);
    expect(
      await admitNativeNanoHostTransportConnection(nanoHost.storage, sessionAuthority, {
        transportRevision: String(transportRevision),
        physicalConnection: null,
        secret,
      })
    ).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('expiry rejects stale authentication without creating process-local authority', async () => {
    const nanoHost = openNanoHostTestOwner();
    const authority = createNanoHostTransportSessionAuthority();
    await nanoHost.transition({
      kind: 'allocate',
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      observedAt: '2026-08-08T00:00:00.000Z',
      targetId: TARGET,
    });
    await nanoHost.transition({
      kind: 'ready',
      connectionGeneration: 1,
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      observedAt: '2026-08-08T00:00:01.000Z',
      targetId: TARGET,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      physicalEpoch: PHYSICAL_EPOCH,
    });
    const tokenId = testEntityId('nhtok', 'native-expiry');
    const secret = createOpenKitAccessTokenSecret();
    await nanoHost.storage.owner.transport({
      kind: 'enroll',
      record: {
        tokenId,
        tokenHash: hashOpenKitAccessTokenSecret(secret),
        deploymentId: DEPLOYMENT,
        expiresAt: '2026-08-08T01:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: IDENTITY,
        responsibleServerAdminActorId: 'usr_00000000-0000-768a-8658-44c33d82c1f5',
      },
    });
    const now = new Date('2026-08-08T01:30:00.000Z');
    const fenced = await fenceNanoHostTransportOnTokenUnusable(nanoHost.storage, authority, {
      identityId: IDENTITY,
      now,
      tokenId,
    });
    expect(fenced).toEqual({ usable: false, fenced: false });
    expect(authority.authoritativeGeneration(IDENTITY)).toBeNull();
    expect(getNanoHostRuntimeTarget(nanoHost, TARGET)).toMatchObject({
      connectionGeneration: 1,
      freshEmpty: false,
      physicalEpoch: null,
      ready: false,
    });
    expect(
      await admitNativeNanoHostTransportConnection(nanoHost.storage, authority, {
        transportRevision: String(transportRevision),
        physicalConnection: null,
        secret,
        now,
      })
    ).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('fences decommission on an unknown Native ACK without clearing the slot or auditing success', async () => {
    const coreDb = openMigratedCoreDb();
    const native = openNanoHostTestOwner();
    const authority = createNanoHostTransportSessionAuthority();
    const slots = slotPair();
    onTestFinished(() => rmSync(slots.root, { recursive: true, force: true }));
    const userId = ensureLocalUser(coreDb);
    await seedReadyRuntimeTarget(native);
    const issued = await enrollFixtureOwner(native, 'unknown-decommission-ack');
    deliverNanoHostTransportTokenToNamedSlot({
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      issuanceGeneration: 1,
      secret: issued.secret,
      sink: slots.A,
      slot: 'A',
      tokenId: issued.tokenId,
      writeDisposition: 'exclusive-create',
    });
    const unknown = new ControlStoreWorkerError('unavailable', 'unknown');
    const submit = vi.fn(
      async (_input: ControlNanoHostTransportInput): Promise<ControlNanoHostTransportResult> => {
        throw unknown;
      }
    );
    const operations = createNanoHostOperationImplementations({
      coreDb,
      mode: 'server',
      sessionAuthority: authority,
      nanoHostConfig: { identityId: IDENTITY, deploymentId: DEPLOYMENT, credentialSlots: slots },
      administratorTransport: {
        storage: { state: 'ready', value: native.storage },
        submit,
      },
    });
    await expect(
      operations['nanohost.decommission'](
        {},
        {
          kind: 'public',
          actor: { kind: 'local', userId },
          actorRef: { kind: 'user', id: userId },
          scope: { kind: 'server' },
        }
      )
    ).rejects.toBe(unknown);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      kind: 'decommission',
      deploymentId: DEPLOYMENT,
      identityId: IDENTITY,
      actor: { kind: 'local', userId },
    });
    expectRuntimeTargetUnready(native);
    expect(slotHoldsUsableMaterial(slots.A)).toBe(true);
    expect(getNanoHostTransportTokenRecord(native, issued.tokenId)?.status).toBe('active');
    expect(
      coreDb.sqlite
        .prepare(
          "SELECT COUNT(*) FROM audit_events WHERE action = 'nanohost.transport.decommission'"
        )
        .pluck()
        .get()
    ).toBe(0);
  });

  it('decommission revokes every token without fabricating a connection', async () => {
    const coreDb = openMigratedCoreDb();
    const native = openNanoHostTestOwner();
    const authority = createNanoHostTransportSessionAuthority();
    await seedReadyRuntimeTarget(native);
    const first = await enrollFixtureOwner(native, 'decommission');
    const second = await createNanoHostTransportTokenRecord(native.storage, {
      deploymentId: DEPLOYMENT,
      expiresAt: '2026-09-08T00:00:00.000Z',
      now: new Date('2026-08-08T00:30:00.000Z'),
      ownerNanoHostIdentityId: IDENTITY,
      responsibleServerAdminActorId: first.record.responsibleServerAdminActorId,
    });
    const userId = ensureLocalUser(coreDb);
    const operations = createNanoHostOperationImplementations({
      coreDb,
      mode: 'server',
      sessionAuthority: authority,
      nanoHostConfig: {
        identityId: IDENTITY,
        deploymentId: DEPLOYMENT,
        credentialSlots: slotPair(),
      },
      readNanoHostTarget: (id) =>
        native.storage.owner.read((sqlite) => getNanoHostRuntimeTarget({ sqlite }, id)),
    });
    await expect(
      operations['nanohost.decommission'](
        {},
        {
          kind: 'public',
          actor: { kind: 'local', userId },
          actorRef: { kind: 'user', id: userId },
          scope: { kind: 'server' },
        }
      )
    ).rejects.toMatchObject({ status: 503 });
    for (const issue of [first, second])
      expect(getNanoHostTransportTokenRecord(native, issue.tokenId)?.status).toBe('active');

    const now = new Date('2026-08-08T02:00:00.000Z');
    const revoked = await submitNanoHostTransportDecommission(
      await prepareNanoHostTransportWriter(native.storage),
      { identityId: IDENTITY, deploymentId: DEPLOYMENT, now }
    );
    expect(revoked).toHaveLength(2);
    await fenceNanoHostTransportAuthority(native.storage, authority, IDENTITY, now.toISOString());
    for (const issue of [first, second]) {
      expect(getNanoHostTransportTokenRecord(native, issue.tokenId)?.status).toBe('revoked');
      expect(
        await verifyNanoHostTransportTokenRecord(native.storage, issue.secret, { now })
      ).toBeNull();
    }
    expect(authority.authoritativeGeneration(IDENTITY)).toBeNull();
    expectRuntimeTargetUnready(native);
  });
});
