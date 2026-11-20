import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverWorkStorageDescriptor } from './server-work-schema.js';

const journalFolder = new URL('../../drizzle/services/server-work/', import.meta.url);
const migrationsFolder = fileURLToPath(journalFolder);

describe('Server work baseline', () => {
  let root: string;
  let statePath: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openkit-server-work-baseline-'));
    statePath = join(root, 'server/services/server-work/state.sqlite');
    mkdirSync(dirname(statePath), { recursive: true });
    sqlite = new Database(statePath);
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder });
  });

  afterEach(() => {
    if (sqlite?.open) sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('ships and applies one baseline with exactly the seven Server tables', () => {
    expect(readdirSync(journalFolder).filter((name) => name.endsWith('.sql'))).toEqual([
      '0000_baseline.sql',
    ]);
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', journalFolder), 'utf8'));
    expect(journal.entries).toEqual([expect.objectContaining({ idx: 0, tag: '0000_baseline' })]);
    const ledger = readMigrationFiles({ migrationsFolder }).map(({ hash, folderMillis }) => ({
      hash,
      created_at: folderMillis,
    }));

    sqlite.close();
    sqlite = new Database(statePath, { fileMustExist: true });
    migrate(drizzle(sqlite), { migrationsFolder });

    expect(sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations').all()).toEqual(
      ledger
    );
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table'
         AND name NOT GLOB 'sqlite_*' AND name != '__drizzle_migrations' ORDER BY name`
      )
      .pluck()
      .all();
    expect(tables).toEqual([
      'capability_calls',
      'control_product_entries',
      'control_threads',
      'control_turns',
      'control_work_observations',
      'evidence_bundles',
      'usage_records',
    ]);
    expect(serverWorkStorageDescriptor.owner).toBe('server-work');
    expect([...serverWorkStorageDescriptor.requiredTables].sort()).toEqual(tables);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps Turn lineage, single-flight, version and transcript ordering local', () => {
    const insertTurn = sqlite.prepare(
      `INSERT INTO control_turns (id, thread_id, status, schema_version, revision, record_json)
       VALUES (?, ?, ?, ?, 1, '{}')`
    );
    expect(() => insertTurn.run('orphan', 'missing', 'pending', 1)).toThrow(/FOREIGN KEY/);
    expect(() =>
      sqlite.exec(
        `INSERT INTO control_threads (id, workspace_id, status, schema_version, revision, record_json)
         VALUES ('foreign', 'workspace', 'active', 1, 1, '{}')`
      )
    ).toThrow(/CHECK/);
    sqlite.exec(
      `INSERT INTO control_threads (id, status, schema_version, revision, record_json)
       VALUES ('thread', 'active', 1, 1, '{}')`
    );
    expect(() => insertTurn.run('unsupported', 'thread', 'pending', 2)).toThrow(/CHECK/);
    insertTurn.run('first', 'thread', 'running', 1);
    expect(() => insertTurn.run('busy', 'thread', 'pending', 1)).toThrow(/UNIQUE/);
    sqlite.exec("UPDATE control_turns SET status='completed' WHERE id='first'");
    insertTurn.run('second', 'thread', 'pending', 1);
    expect(() =>
      sqlite.exec("UPDATE control_turns SET admission_order=3 WHERE id='first'")
    ).toThrow(/admission order is immutable/);

    const insertItem = sqlite.prepare(
      `INSERT INTO control_product_entries
       (kind, turn_id, sequence, id, revision, schema_version, content_json, identity_json)
       VALUES ('item', 'second', ?, 'item', ?, 1, '{}', '{}')`
    );
    insertItem.run(1, 1);
    insertItem.run(2, 2);
    expect(
      sqlite
        .prepare(
          'SELECT revision, is_current, turn_admission_order, item_order FROM control_product_entries ORDER BY sequence'
        )
        .all()
    ).toEqual([
      { revision: 1, is_current: 0, turn_admission_order: 2, item_order: 1 },
      { revision: 2, is_current: 1, turn_admission_order: 2, item_order: 1 },
    ]);
    expect(() =>
      sqlite.exec(
        `INSERT INTO control_work_observations (turn_id, sequence, id, schema_version, record_json)
         VALUES ('missing', 1, 'observation', 1, '{}')`
      )
    ).toThrow(/FOREIGN KEY/);

    sqlite.exec("DELETE FROM control_turns WHERE id='first'");
    expect(
      sqlite.prepare("SELECT thread_read_order FROM control_turns WHERE id='second'").pluck().get()
    ).toBe(1);
  });

  it('restricts prompt digests to the LLM family and preserves original Call uniqueness', () => {
    const insertCall = sqlite.prepare(
      `INSERT INTO capability_calls
       (call_id, request_id, workspace_id, capability_id, family, operation, system_prompt_digest,
        status, redaction_class)
       VALUES (?, ?, ?, ?, ?, 'generate', ?, 'running', 'metadata-only')`
    );
    insertCall.run('call', 'request', null, 'llm.new-api', 'llm', 'digest');
    expect(() =>
      insertCall.run('duplicate-call', 'request', null, 'llm.new-api', 'llm', 'digest')
    ).toThrow(/UNIQUE/);
    expect(() =>
      insertCall.run('foreign-call', 'other-request', 'workspace', 'llm.new-api', 'llm', 'digest')
    ).toThrow(/CHECK/);
    expect(() =>
      insertCall.run('tool-call', 'other-request', null, 'mcp.tool', 'mcp', 'digest')
    ).toThrow(/capability_calls_system_prompt_digest_check/);
    insertCall.run('tool-call', 'other-request', null, 'mcp.tool', 'mcp', null);
    expect(
      sqlite
        .prepare("SELECT schema_version FROM capability_calls WHERE call_id='call'")
        .pluck()
        .get()
    ).toBe(1);
  });
});
