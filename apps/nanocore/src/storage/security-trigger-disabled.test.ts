import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { drainSecurityNotices } from '../security/publication.js';
import { SecurityTriggerStore } from '../security/trigger.js';
import { createTestCoreDb } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { SECURITY_CONTAINMENT_LIMITS } from './core-journal-codecs.js';
import { SecurityTriggerRefusal } from './security-trigger-codecs.js';
import {
  applySecurityTriggerInDb,
  enqueueE12NoticeInDb,
  readSecurityAlarmNoticeInDb,
  SECURITY_TRIGGER_DISABLED_SNAPSHOT,
} from './security-trigger-native.js';
import { SECURITY_TRIGGER_OWNER } from './security-trigger-port.js';

const TABLES = SECURITY_TRIGGER_OWNER.requiredTables;

function dropTriggerTables(sqlite: Database.Database): void {
  for (const table of [
    'security_thread_destinations',
    'security_trigger_outbox',
    'security_trigger_alarms',
    'security_trigger_audit_assessments',
    'security_trigger_audit_progress',
    'security_trigger_state',
  ])
    sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
}

describe('security trigger service journal and off gate', () => {
  it('installs six tables, a command receipt, and an off seed', () => {
    const folder = new URL('../../drizzle/services/security-trigger/', import.meta.url);
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', folder), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    assert.deepEqual(
      journal.entries.map((entry) => entry.tag),
      ['0000_baseline']
    );
    assert.equal(journal.entries[0]?.idx, 0);
    assert.equal(typeof journal.entries[0]?.when, 'number');
    const sql = readFileSync(new URL('0000_baseline.sql', folder), 'utf8');
    assert.equal(sql.includes('attention_id'), false);
    assert.equal(sql.includes('notification_attention'), false);
    assert.equal(sql.includes('command_receipt'), true);
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    try {
      for (const statement of sql.split('--> statement-breakpoint')) {
        const text = statement.trim();
        if (text) sqlite.exec(text);
      }
      const present = (
        sqlite
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(',')})`
          )
          .all(...TABLES) as Array<{ name: string }>
      ).map((row) => row.name);
      assert.deepEqual(present.sort(), [...TABLES].sort());
      assert.deepEqual(
        sqlite.prepare('SELECT state, schema_version FROM security_trigger_state').all(),
        [{ state: 'off', schema_version: 1 }]
      );
      sqlite
        .prepare(
          `INSERT INTO security_trigger_outbox
           (request_id, key_json, recipient_user_id, occurrence_kind, occurrence_n, created_at)
           VALUES ('req', '{}', 'user', 'initial', 1, '2026-11-21T00:00:00.000Z')`
        )
        .run();
      assert.throws(() =>
        sqlite
          .prepare('UPDATE security_trigger_outbox SET raised = 1 WHERE request_id = ?')
          .run('req')
      );
      sqlite
        .prepare(
          'UPDATE security_trigger_outbox SET raised = 1, command_receipt = ? WHERE request_id = ?'
        )
        .run('{}', 'req');
    } finally {
      sqlite.close();
    }
  });

  it('refuses while the trigger tables and the service file are absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'security-trigger-disabled-'));
    const coreDb = createTestCoreDb(root);
    try {
      dropTriggerTables(coreDb.sqlite);
      const present = coreDb.sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(',')})`
        )
        .all(...TABLES);
      assert.deepEqual(present, []);
      const trigger = new SecurityTriggerStore(coreDb);
      assert.deepEqual(trigger.status(), {
        state: 'unavailable',
        owner: 'security-trigger',
        reason: 'disabled',
      });
      assert.deepEqual(await trigger.current(), SECURITY_TRIGGER_DISABLED_SNAPSHOT);
      await assert.rejects(() => trigger.enable({ kind: 'local', userId: 'user_test' }), {
        code: 'forbidden',
      });
      assert.deepEqual(await trigger.detectAudit(), {
        cursor: null,
        scanned: 0,
        detected: 0,
        unsupported: 0,
      });
      await trigger.advanceContainment({} as never, {} as never, {} as never);
      await drainSecurityNotices({ coreDb, store: {} as never });
      enqueueE12NoticeInDb(coreDb, 'audit_event');
      assert.equal(readSecurityAlarmNoticeInDb(coreDb, 'request'), null);
      assert.deepEqual(
        applySecurityTriggerInDb(coreDb, {
          action: 'current',
          timestamp: '2026-11-21T00:00:00.000Z',
        }),
        { kind: 'state', snapshot: SECURITY_TRIGGER_DISABLED_SNAPSHOT }
      );
      assert.throws(
        () =>
          applySecurityTriggerInDb(coreDb, {
            action: 'enable',
            actor: { kind: 'local', userId: 'user_test' },
            timestamp: '2026-11-21T00:00:00.000Z',
          }),
        (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
      );
      assert.equal(existsSync(join(root, SECURITY_TRIGGER_OWNER.databasePath)), false);
    } finally {
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not read a separately built stale on row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'security-trigger-stale-'));
    const sqlite = new Database(':memory:');
    sqlite.exec(
      `CREATE TABLE security_trigger_state (
         singleton integer PRIMARY KEY,
         state text NOT NULL,
         enable_generation integer NOT NULL,
         enabling_user_id text
       )`
    );
    sqlite
      .prepare(
        `INSERT INTO security_trigger_state
         (singleton, state, enable_generation, enabling_user_id)
         VALUES (1, 'on', 1, 'user_test')`
      )
      .run();
    const coreDb = {
      scope: 'core' as const,
      canInitializeLocalUser: false,
      dataRoot: root,
      db: {} as never,
      sqlite: new Proxy(sqlite, {
        get(target, property) {
          if (property === 'close') return () => target.close();
          throw new Error('security trigger touched a stale database handle');
        },
      }),
    } as unknown as ReturnType<typeof createTestCoreDb>;
    try {
      const trigger = new SecurityTriggerStore(coreDb);
      assert.deepEqual(await trigger.current(), SECURITY_TRIGGER_DISABLED_SNAPSHOT);
      await assert.rejects(() => trigger.enable({ kind: 'local', userId: 'user_test' }), {
        code: 'forbidden',
      });
      enqueueE12NoticeInDb(coreDb, 'audit_event');
      assert.equal(readSecurityAlarmNoticeInDb(coreDb, 'request'), null);
      assert.deepEqual(
        sqlite.prepare('SELECT state, enable_generation FROM security_trigger_state').get(),
        { state: 'on', enable_generation: 1 }
      );
      assert.equal(existsSync(join(root, SECURITY_TRIGGER_OWNER.databasePath)), false);
    } finally {
      sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps containment inspection available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'security-trigger-inspect-'));
    const coreDb = createTestCoreDb(root);
    try {
      const manager = createRuntimeConfigManager({ dataRoot: root });
      await manager.bindNativePolicyPublication(coreDb);
      const policy = manager.current().openKitConfig.policy?.mediation ?? {
        schemaVersion: 1 as const,
        statements: [],
      };
      const observed = await new SecurityTriggerStore(coreDb).containmentUsage(policy);
      assert.deepEqual(observed.limits, SECURITY_CONTAINMENT_LIMITS);
      const { windowStart, ...counts } = observed.usage;
      assert.equal(Number.isFinite(Date.parse(windowStart)), true);
      assert.deepEqual(counts, {
        currentServer: 0,
        currentWorkspace: 0,
        cumulativeServer: 0,
        cumulativeWorkspace: 0,
        pendingServer: 0,
        pendingWorkspace: 0,
        workspaces: [],
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
