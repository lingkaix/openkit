import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { allocateEntityId } from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import { expect, it, vi } from 'vitest';
import {
  getCommandRequestRecordFromDb,
  inspectNanoHostEpochFenceReceipt,
  readCommandRequestRecordsFromSqlite,
  vaultEpochFenceOccurrence,
} from './command-request-records.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import type { NanoHostEpochInvalidation } from './nanohost-port.js';
import { storageRequestId } from './storage-owner.js';
import {
  applyControlVault,
  fenceNanoHostEpochInDb,
  reserveVaultEpochFenceInDb,
} from './vault-native.js';
import {
  getVaultInjectionReceipt,
  requireVaultReference,
  vaultCredentialWriterOf,
} from './vault-native-codecs.js';

vi.mock('node:worker_threads', async (load) => ({
  ...(await load<typeof import('node:worker_threads')>()),
  isMainThread: false,
}));

it('holds the exact no-Turn epoch census across immutable staging and opens only a disjoint writer', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-vault-epoch-'));
  let db = openCoreDb(root);
  try {
    applyMigrations(db);
    const placement = {
      deploymentId: readDataRootLayoutMarker(root).deploymentId,
      runtimeTargetId: 'original-target',
      physicalEpoch: 'original-physical-epoch',
      generation: 'original-connection-generation',
    };
    const createReference = () => {
      const referenceId = allocateEntityId('vault');
      db.sqlite.transaction(() =>
        applyControlVault(db, {
          kind: 'reference-create',
          record: {
            referenceId,
            ownerScope: 'server',
            displayName: 'Epoch fixture',
            secretKind: 'provider-api-key',
            backendKind: 'encrypted-file',
          },
        })
      )();
      return referenceId;
    };
    const reserve = (
      referenceId: string,
      receiptId: string,
      writerPlacement: typeof placement | null = placement
    ) =>
      db.sqlite.transaction(() =>
        applyControlVault(db, {
          kind: 'reference-writer',
          record: {
            action: 'delegate',
            referenceId,
            receiptId,
            expectedVersion: 1,
            expectedGeneration: 0,
            ...(writerPlacement && { placement: writerPlacement }),
          },
        })
      )();
    const abandon = (referenceId: string, receiptId: string) =>
      db.sqlite.transaction(() =>
        applyControlVault(db, {
          kind: 'reference-writer',
          record: {
            action: 'abandon',
            referenceId,
            receiptId,
            expectedVersion: 1,
            expectedGeneration: 1,
            neverSent: { receiptId },
          },
        })
      )();

    const first = createReference();
    const second = createReference();
    const abandoned = createReference();
    const unscoped = createReference();
    const successor = createReference();
    const late = createReference();
    reserve(first, 'first-pending-holder');

    const occurrence = vaultEpochFenceOccurrence(placement);
    const intentFor = (holderReceiptIds: string[]): NanoHostEpochInvalidation => {
      const target = {
        runtimeTargetId: placement.runtimeTargetId,
        physicalEpoch: placement.physicalEpoch,
        holderReceiptIds,
      };
      return {
        ...occurrence,
        target,
        requestId: storageRequestId(occurrence),
        expectedGeneration: placement.generation,
        inputDigest: sha256CanonicalJson(target),
      };
    };
    const stale = intentFor(['first-pending-holder']);
    reserve(second, 'second-pending-holder');
    reserve(abandoned, 'abandoned-holder');

    let staged: NanoHostEpochInvalidation | null = null;
    const fence = (intent: NanoHostEpochInvalidation) =>
      db.sqlite.transaction(() =>
        fenceNanoHostEpochInDb(db, intent, true, (original) => isDeepStrictEqual(original, staged))
      )();
    staged = stale;
    expect(fence(stale)).toEqual({ state: 'unknown' });
    staged = null;
    const census = (completeHistory: boolean, verified: boolean) =>
      db.sqlite.transaction(() =>
        reserveVaultEpochFenceInDb(db, placement, completeHistory, () => verified)
      )();
    expect(census(true, false)).toEqual({ state: 'unknown' });
    expect(census(false, true)).toEqual({ state: 'unknown' });
    reserve(unscoped, 'unscoped-holder', null);
    expect(census(true, true)).toEqual({ state: 'unknown' });
    abandon(unscoped, 'unscoped-holder');
    const complete = intentFor([
      'abandoned-holder',
      'first-pending-holder',
      'second-pending-holder',
    ]);
    expect(census(true, true)).toEqual({ state: 'settled', receipt: complete });
    expect(readCommandRequestRecordsFromSqlite(db.sqlite)).toEqual([]);
    expect(
      getCommandRequestRecordFromDb(db, complete.requestId, new Date().toISOString())
    ).toBeNull();
    expect(inspectNanoHostEpochFenceReceipt(db, complete, true)).toEqual({ state: 'absent' });
    expect(inspectNanoHostEpochFenceReceipt(db, stale, true)).toEqual({ state: 'conflict' });
    expect(fence(complete)).toEqual({ state: 'unknown' });
    expect(() => reserve(late, 'late-old-writer')).toThrow('Credential family is busy.');
    expect(() => reserve(late, 'unscoped-writer', null)).toThrow('Credential family is busy.');
    expect(() =>
      reserve(late, 'reconnected-writer', { ...placement, generation: 'new-generation' })
    ).toThrow('Credential family is busy.');
    expect(() =>
      reserve(successor, 'disjoint-writer', {
        ...placement,
        generation: 'new-generation',
        physicalEpoch: 'new-physical-epoch',
      })
    ).not.toThrow();
    abandon(abandoned, 'abandoned-holder');
    db.sqlite.close();
    db = openCoreDb(root);
    expect(census(false, true)).toEqual({ state: 'settled', receipt: complete });
    expect(fence(stale)).toEqual({ state: 'conflict' });
    staged = structuredClone(complete);
    const recorded = fence(complete);
    expect(recorded).toMatchObject({
      state: 'settled',
      receipt: { result: { fencedHolderReceiptIds: complete.target.holderReceiptIds } },
    });

    db.sqlite.close();
    db = openCoreDb(root);
    expect(inspectNanoHostEpochFenceReceipt(db, complete, false)).toEqual(recorded);
    expect(inspectNanoHostEpochFenceReceipt(db, stale, true)).toEqual({ state: 'conflict' });
    for (const [referenceId, holder] of [
      [first, 'first-pending-holder'],
      [second, 'second-pending-holder'],
    ] as const) {
      expect(vaultCredentialWriterOf(requireVaultReference(db, referenceId))).toMatchObject({
        state: 'fenced',
        holder,
        placement,
      });
      expect(getVaultInjectionReceipt(db, holder)).toBeNull();
    }
    expect(vaultCredentialWriterOf(requireVaultReference(db, abandoned))).toMatchObject({
      mode: 'core',
    });
    expect(() => reserve(late, 'late-old-writer')).toThrow('Credential family is busy.');
    expect(() =>
      reserve(late, 'reconnected-writer', { ...placement, generation: 'new-generation' })
    ).toThrow('Credential family is busy.');
    expect(vaultCredentialWriterOf(requireVaultReference(db, successor))).toMatchObject({
      state: 'pending',
      holder: 'disjoint-writer',
    });
    expect(
      db.sqlite.prepare('SELECT count(*) FROM scheduler_execution_attempts').pluck().get()
    ).toBe(0);
  } finally {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
