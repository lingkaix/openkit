import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { admitNanoHostTransportConnection } from './nanohost-transport-admission.js';
import {
  abortNanoHostTransportRotation,
  decommissionNanoHostTransportAndFence,
  fenceNanoHostTransportOnTokenUnusable,
  revokeNanoHostTransportTokenAndFence,
} from './nanohost-transport-lifecycle.js';
import { createNanoHostTransportSessionAuthority } from './nanohost-transport-session.js';
import { deliverNanoHostTransportTokenToNamedSlot } from './nanohost-transport-sink.js';
import {
  createNanoHostTransportTokenRecord,
  rotateNanoHostTransportTokenRecord,
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
const DEPLOYMENT = 'deploy_primary';

/**
 * Opens a migrated Core database under a unique temp root.
 *
 * @returns Open Core database handles.
 */
function openMigratedCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-lifecycle-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
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

describe('NanoHost transport lifecycle (WP-2b R3)', () => {
  it('rotation_abort_clears_successor_and_keeps_predecessor_usable', () => {
    const coreDb = openMigratedCoreDb();
    const slots = slotPair();
    const authority = createNanoHostTransportSessionAuthority();

    try {
      const predecessor = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: DEPLOYMENT,
        expiresAt: '2026-09-08T00:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: IDENTITY,
        responsibleServerAdminActorId: 'user_admin',
      });
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
      const rotated = rotateNanoHostTransportTokenRecord(coreDb, predecessor.tokenId, {
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

      const aborted = abortNanoHostTransportRotation(coreDb, authority, {
        now: new Date('2026-08-08T01:10:00.000Z'),
        predecessorTokenId: predecessor.tokenId,
        successorSink: slots.B,
        successorTokenId: rotated!.tokenId,
      });

      expect(aborted.predecessor.status).toBe('active');
      expect(aborted.successor.status).toBe('revoked');
      expect(
        verifyNanoHostTransportTokenRecord(coreDb, predecessor.secret, {
          now: new Date('2026-08-08T01:10:00.000Z'),
        })
      ).not.toBeNull();
      expect(
        verifyNanoHostTransportTokenRecord(coreDb, rotated!.secret, {
          now: new Date('2026-08-08T01:10:00.000Z'),
        })
      ).toBeNull();
      expect(slotHoldsUsableMaterial(slots.A)).toBe(true);
      expect(slotHoldsUsableMaterial(slots.B)).toBe(false);
      expect(usableSlotCount(slots)).toBe(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('revocation rejects reauthentication without creating process-local authority', () => {
    const coreDb = openMigratedCoreDb();
    const authority = createNanoHostTransportSessionAuthority();

    try {
      const issued = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: DEPLOYMENT,
        expiresAt: '2026-09-08T00:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: IDENTITY,
        responsibleServerAdminActorId: 'user_admin',
      });
      const revoked = revokeNanoHostTransportTokenAndFence(coreDb, authority, {
        now: new Date('2026-08-08T02:00:00.000Z'),
        tokenId: issued.tokenId,
      });
      expect(revoked?.status).toBe('revoked');
      expect(authority.authoritativeGeneration(IDENTITY)).toBeNull();
      expect(
        verifyNanoHostTransportTokenRecord(coreDb, issued.secret, {
          now: new Date('2026-08-08T02:00:00.000Z'),
        })
      ).toBeNull();
      expect(
        admitNanoHostTransportConnection(coreDb, authority, {
          physicalConnection: null,
          secret: issued.secret,
          now: new Date('2026-08-08T02:00:00.000Z'),
        })
      ).toEqual({ ok: false, reason: 'unauthorized' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('expiry rejects stale authentication without creating process-local authority', () => {
    const coreDb = openMigratedCoreDb();
    const authority = createNanoHostTransportSessionAuthority();

    try {
      const issued = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: DEPLOYMENT,
        expiresAt: '2026-08-08T01:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: IDENTITY,
        responsibleServerAdminActorId: 'user_admin',
      });
      const fenced = fenceNanoHostTransportOnTokenUnusable(coreDb, authority, {
        identityId: IDENTITY,
        now: new Date('2026-08-08T01:30:00.000Z'),
        tokenId: issued.tokenId,
      });
      expect(fenced.usable).toBe(false);
      expect(fenced.fenced).toBe(false);
      expect(authority.authoritativeGeneration(IDENTITY)).toBeNull();
      expect(
        admitNanoHostTransportConnection(coreDb, authority, {
          physicalConnection: null,
          secret: issued.secret,
          now: new Date('2026-08-08T01:30:00.000Z'),
        })
      ).toEqual({ ok: false, reason: 'unauthorized' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('decommission revokes every token without fabricating a connection', () => {
    const coreDb = openMigratedCoreDb();
    const authority = createNanoHostTransportSessionAuthority();

    try {
      const first = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: DEPLOYMENT,
        expiresAt: '2026-09-08T00:00:00.000Z',
        now: new Date('2026-08-08T00:00:00.000Z'),
        ownerNanoHostIdentityId: IDENTITY,
        responsibleServerAdminActorId: 'user_admin',
      });
      const second = createNanoHostTransportTokenRecord(coreDb, {
        deploymentId: DEPLOYMENT,
        expiresAt: '2026-09-08T00:00:00.000Z',
        now: new Date('2026-08-08T00:30:00.000Z'),
        ownerNanoHostIdentityId: IDENTITY,
        responsibleServerAdminActorId: 'user_admin',
      });
      const revoked = decommissionNanoHostTransportAndFence(coreDb, authority, {
        identityId: IDENTITY,
        now: new Date('2026-08-08T02:00:00.000Z'),
      });
      expect(revoked.map((row) => row.tokenId).sort()).toEqual(
        [first.tokenId, second.tokenId].sort()
      );
      expect(revoked.every((row) => row.status === 'revoked')).toBe(true);
      expect(authority.authoritativeGeneration(IDENTITY)).toBeNull();
      expect(
        verifyNanoHostTransportTokenRecord(coreDb, first.secret, {
          now: new Date('2026-08-08T02:00:00.000Z'),
        })
      ).toBeNull();
      expect(
        verifyNanoHostTransportTokenRecord(coreDb, second.secret, {
          now: new Date('2026-08-08T02:00:00.000Z'),
        })
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });
});
