import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenSecret,
  hashOpenKitAccessTokenSecret,
} from '../auth/access-token.js';
import {
  createOpenKitAccessTokenRecord,
  getOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import type { CoreDb } from './db.js';

const NOW = new Date('2026-09-02T00:00:00.000Z');
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const roots: string[] = [];
const databases: CoreDb[] = [];

/** Creates current authority through the real identity and Token owners before fault injection. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'access-token-verification-native-'));
  roots.push(root);
  const coreDb = createTestCoreDb(root);
  databases.push(coreDb);
  const ownerUserId = ensureLocalUser(coreDb);
  const issued = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: EXPIRES_AT,
    now: NOW,
  });
  return { coreDb, ownerUserId, issued };
}

/** Rejects the retired Main last-use writer while leaving the real native SQLite owner intact. */
function rejectMainLastUseWrite(): void {
  const original = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (/^\s*UPDATE\s+openkit_access_tokens\s+SET\s+last_used_at\b/iu.test(sql)) {
      throw new Error('Token last-use mutation executed on Main.');
    }
    return original.call(this, sql);
  });
}

/** Injects a current-fact change after native opening and before the original deciding operation. */
function changeAfterProof(coreDb: CoreDb, change: () => void): () => number {
  const client = getControlStoreWorkerClient();
  const original = client.open.bind(client);
  let crossings = 0;
  vi.spyOn(client, 'open').mockImplementation(async (...args) => {
    await original(...args);
    expect(coreDb.sqlite.inTransaction).toBe(false);
    crossings++;
    change();
  });
  return () => crossings;
}

afterEach(async () => {
  try {
    await shutdownControlStoreWorkerClient();
  } finally {
    vi.restoreAllMocks();
    for (const coreDb of databases.splice(0)) closeTestCoreDb(coreDb);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

describe('human Token verification through the native Core owner', () => {
  it.each([
    'explicit',
    'native',
  ] as const)('records successful use without a Main writer or bearer command with the %s clock', async (clock) => {
    const f = fixture();
    const tokenHash = hashOpenKitAccessTokenSecret(f.issued.secret);
    const commands: Array<{ hasBearer: boolean; hasProof: boolean }> = [];
    const original = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const serialized = JSON.stringify(args[0]);
      // Keep only Boolean observations: a failing assertion must not disclose credential material.
      commands.push({
        hasBearer: serialized.includes(f.issued.secret) || serialized.includes('okt_'),
        hasProof: serialized.includes(f.issued.tokenId) && serialized.includes(tokenHash),
      });
      return original.apply(this, args);
    });
    rejectMainLastUseWrite();
    const startedAt = Date.now();

    const record = await verifyOpenKitAccessTokenRecord(f.coreDb, f.issued.secret, {
      channel: 'remote-mcp',
      source: 'loopback',
      ...(clock === 'explicit' ? { now: NOW } : {}),
    });

    // Remote Auth: Token format/record and channel authentication; Storage: native ownership.
    expect(record !== null).toBe(true);
    expect(record?.tokenId === f.issued.tokenId).toBe(true);
    expect(record?.ownerUserId === f.ownerUserId).toBe(true);
    expect(record?.lastUsedChannel).toBe('remote-mcp');
    expect(record?.lastUsedSource).toBe('loopback');
    if (clock === 'explicit') {
      expect(record?.lastUsedAt).toBe(NOW.toISOString());
    } else {
      const usedAt = Date.parse(record?.lastUsedAt ?? '');
      expect(usedAt >= startedAt && usedAt <= Date.now()).toBe(true);
    }
    const serializedRecord = JSON.stringify(record);
    expect(serializedRecord.includes(tokenHash)).toBe(false);
    expect(serializedRecord.includes(f.issued.secret)).toBe(false);
    expect(Object.keys(record ?? {}).some((key) => /hash|secret/iu.test(key))).toBe(false);
    expect(commands.length > 0).toBe(true);
    expect(commands.every((command) => !command.hasBearer)).toBe(true);
    expect(commands.filter((command) => command.hasProof).length).toBe(1);
    const retained = getOpenKitAccessTokenRecord(f.coreDb, f.issued.tokenId);
    expect(retained?.lastUsedAt).toBe(record?.lastUsedAt);
    expect(retained?.lastUsedChannel).toBe('remote-mcp');
    expect(retained?.lastUsedSource).toBe('loopback');
    expect(f.coreDb.sqlite.inTransaction).toBe(false);
  });

  it.each([
    'revoked',
    'expired',
    'hash-replaced',
    'owner-disabled',
    'grace-expired',
  ] as const)('returns null without recording use when the current Token becomes %s after Main proof', async (fault) => {
    const f = fixture();
    if (fault === 'grace-expired') {
      const rotation = rotateOpenKitAccessTokenRecord(f.coreDb, f.issued.tokenId, {
        graceSeconds: 60,
        now: NOW,
      });
      expect(rotation !== null).toBe(true);
    }
    const crossings = changeAfterProof(f.coreDb, () => {
      // Deliberate current-fact faults follow valid owner setup; they create no successful receipt.
      switch (fault) {
        case 'revoked':
          revokeOpenKitAccessTokenRecord(f.coreDb, f.issued.tokenId, NOW);
          break;
        case 'expired':
          f.coreDb.sqlite
            .prepare('UPDATE openkit_access_tokens SET expires_at = ? WHERE token_id = ?')
            .run(NOW.toISOString(), f.issued.tokenId);
          break;
        case 'hash-replaced':
          f.coreDb.sqlite
            .prepare('UPDATE openkit_access_tokens SET token_hash = ? WHERE token_id = ?')
            .run(hashOpenKitAccessTokenSecret(createOpenKitAccessTokenSecret()), f.issued.tokenId);
          break;
        case 'owner-disabled':
          f.coreDb.sqlite
            .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
            .run(f.ownerUserId);
          break;
        case 'grace-expired':
          f.coreDb.sqlite
            .prepare(
              'UPDATE openkit_access_tokens SET rotated_grace_expires_at = ? WHERE token_id = ?'
            )
            .run(NOW.toISOString(), f.issued.tokenId);
          break;
      }
    });
    rejectMainLastUseWrite();

    const record = await verifyOpenKitAccessTokenRecord(f.coreDb, f.issued.secret, {
      channel: 'remote-mcp',
      source: 'loopback',
      now: NOW,
    });

    // Immediate revocation, expiry/grace and active User authority must use current deciding facts.
    expect(crossings()).toBe(1);
    expect(record === null).toBe(true);
    const retained = getOpenKitAccessTokenRecord(f.coreDb, f.issued.tokenId);
    expect(retained?.lastUsedAt).toBeNull();
    expect(retained?.lastUsedChannel).toBeNull();
    expect(retained?.lastUsedSource).toBeNull();
    expect(f.coreDb.sqlite.inTransaction).toBe(false);
  });
});
