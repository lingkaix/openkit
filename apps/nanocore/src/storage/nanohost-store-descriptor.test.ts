// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { listNanoHostTransportTokenRecords } from '../auth/nanohost-transport-token-store.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  fenceNanoHostRuntimeTargetAfterRestart,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target-records.js';
import { nanoHostStoreDescriptor } from './nanohost-store-descriptor.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/extensions/nanohost/', import.meta.url)
);

describe('NanoHost extension baseline', () => {
  it('installs one native ledger and the exact owner schema, which can be read after close', () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    expect(journal.entries).toEqual([
      expect.objectContaining({ idx: 0, tag: '0000_baseline', when: expect.any(Number) }),
    ]);
    expect(readdirSync(migrationsFolder).filter((name) => name.endsWith('.sql'))).toEqual([
      '0000_baseline.sql',
    ]);
    const baselineBytes = readFileSync(join(migrationsFolder, '0000_baseline.sql'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-nanohost-baseline-'));
    const dbPath = join(dataRoot, 'server/extensions/nanohost/state.sqlite');

    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      const writer = new Database(dbPath);
      try {
        migrate(drizzle(writer), { migrationsFolder });
      } finally {
        writer.close();
      }

      const reader = new Database(dbPath, { fileMustExist: true, readonly: true });
      try {
        expect(reader.prepare('SELECT hash, created_at FROM __drizzle_migrations').all()).toEqual([
          {
            hash: createHash('sha256').update(baselineBytes).digest('hex'),
            created_at: journal.entries[0]?.when,
          },
        ]);
        const tables = reader
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name"
          )
          .pluck()
          .all();
        expect(tables).toEqual(nanoHostStoreDescriptor.requiredTables);
        expect(tables).toHaveLength(14);
        const references = nanoHostStoreDescriptor.requiredTables
          .flatMap((table) => {
            const foreignKeys = reader.pragma(`foreign_key_list(${table})`) as Array<{
              table: string;
              on_delete: string;
            }>;
            return foreignKeys.map(
              (foreignKey) => `${table} → ${foreignKey.table} ${foreignKey.on_delete}`
            );
          })
          .sort();
        expect(references).toEqual([
          'agent_session_runtime_bindings → harness_instance_records CASCADE',
          'harness_instance_records → sandbox_runtime_records CASCADE',
          'sandbox_runtime_records → nanohost_runtime_targets RESTRICT',
          'worker_storage_bindings → nanohost_runtime_targets RESTRICT',
          'worker_storage_contributors → worker_storage_bindings CASCADE',
        ]);
        expect(reader.pragma('foreign_key_check')).toEqual([]);
        expect(reader.pragma('integrity_check', { simple: true })).toBe('ok');

        const columns = reader.pragma('table_info(worker_backend_sessions)') as Array<{
          name: string;
        }>;
        expect(columns.map(({ name }) => name)).not.toContain('gateway_name');
        expect(columns.map(({ name }) => name)).not.toContain('gateway_endpoint');
        expect(columns.map(({ name }) => name)).not.toContain('cell_target_id');
        const indexes = reader
          .prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL")
          .all() as Array<{ name: string; sql: string }>;
        expect(indexes).toHaveLength(27);
        expect(
          indexes.some(({ sql }) => /gateway_(?:name|endpoint)|cell_target_id/.test(sql))
        ).toBe(false);
        expect(indexes).toContainEqual(
          expect.objectContaining({
            name: 'agent_session_runtime_bindings_current_thread_idx',
            sql: expect.stringMatching(
              /CREATE UNIQUE INDEX[\s\S]+WHERE `lifecycle_state` NOT IN \('closed','failed'\)/
            ),
          })
        );
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('applies exact target generation and restart transitions using only the extension', () => {
    const sqlite = new Database(':memory:');
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      const owner = { sqlite };
      const target = {
        deploymentId: 'fixture-deployment',
        identityId: 'fixture-identity',
        targetId: 'fixture-target',
      };
      const allocated = sqlite.transaction(() =>
        allocateNanoHostRuntimeTargetConnectionGeneration(owner, {
          ...target,
          observedAt: '2026-11-20T00:00:00.000Z',
        })
      )();
      expect(allocated).toMatchObject({
        connectionGeneration: 1,
        physicalEpoch: null,
        ready: false,
      });
      const readiness = {
        ...target,
        connectionGeneration: allocated.connectionGeneration,
        freshEmpty: true,
        observedAt: '2026-11-20T00:00:01.000Z',
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
      };
      const publishReady = sqlite.transaction((input: typeof readiness) =>
        upsertNanoHostRuntimeTarget(owner, input)
      );
      expect(() => publishReady({ ...readiness, connectionGeneration: 2 })).toThrow(/generation/);
      expect(getNanoHostRuntimeTarget(owner, target.targetId)).toEqual(allocated);
      expect(publishReady(readiness)).toMatchObject({
        physicalEpoch: readiness.physicalEpoch,
        ready: true,
      });
      const stopped = sqlite.transaction(() =>
        fenceNanoHostRuntimeTargetAfterRestart(owner, '2026-11-20T00:00:02.000Z')
      )();
      expect(stopped).toMatchObject({ connectionGeneration: 1, physicalEpoch: null, ready: false });
      expect(() => publishReady(readiness)).toThrow(/stale/);
    } finally {
      sqlite.close();
    }
  });

  it('lists transport credentials from the extension with deterministic order and no hash', () => {
    const sqlite = new Database(':memory:');
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      const insert = sqlite.prepare(`
        INSERT INTO nanohost_transport_tokens (token_id, token_hash, owner_nanohost_identity_id,
          token_type, scope, deployment_id, status, issued_at, expires_at, responsible_server_admin_actor_id)
        VALUES (?, ?, 'fixture-identity', 'nanohost-transport', 'nanohost-transport', 'fixture-deployment',
          'active', '2026-11-20T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'fixture-admin')
      `);
      insert.run('one', 'fixture-hash-1');
      insert.run('two', 'fixture-hash-2');
      expect(() => insert.run('three', 'fixture-hash-1')).toThrowError(
        /UNIQUE constraint failed: nanohost_transport_tokens.token_hash/
      );

      const records = listNanoHostTransportTokenRecords({ sqlite });
      expect(records.map(({ tokenId }) => tokenId)).toEqual(['two', 'one']);
      expect(records[0]).toEqual({
        deploymentId: 'fixture-deployment',
        expiresAt: '2026-11-21T00:00:00.000Z',
        issuedAt: '2026-11-20T00:00:00.000Z',
        lastUsedAt: null,
        lastUsedChannel: null,
        lastUsedSource: null,
        ownerNanoHostIdentityId: 'fixture-identity',
        predecessorTokenId: null,
        responsibleServerAdminActorId: 'fixture-admin',
        revokedAt: null,
        rotationOverlapExpiresAt: null,
        scope: 'nanohost-transport',
        status: 'active',
        tokenId: 'two',
        tokenType: 'nanohost-transport',
      });
    } finally {
      sqlite.close();
    }
  });
});
