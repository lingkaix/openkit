import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeWorkspaceNotebook } from '../knowledge/notebook-initialization.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from '../knowledge/okf.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyNativeScopeMigrations, applyScopedMigrations } from './migrate.js';
import {
  abandonCapture,
  completeCapture,
  inspectCapture,
  protectCapture,
} from './workspace-capture-protection.js';

// DX5 T1–T6: lane-d-dx5-plan.md, with the coordinator's three-state/scope rulings.
// Owner: 20261019-durable_execution_and_control_store.md, "Snapshot Cut And Capture Protection".
// These checks cover retained lifecycle decisions, not snapshot closure or GC/Notebook exclusion.
const workspaceId = testEntityId('ws', 'dx5-workspace');
const otherWorkspaceId = testEntityId('ws', 'dx5-other-workspace');
let root: string;
let db: WorkspaceDb;
const handles: WorkspaceDb[] = [];

/** Opens a real scoped connection; each test owns and closes its handles. */
function openWorkspace(id = workspaceId): WorkspaceDb {
  const handle = openWorkspaceDb(root, id);
  handles.push(handle);
  return handle;
}

/** Reads retained values directly so a returned object cannot conceal a changed SQL row. */
function retainedRows(handle = db) {
  return handle.sqlite.prepare('SELECT * FROM workspace_capture_records ORDER BY capture_id').all();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dx5-capture-'));
  db = openWorkspace();
  applyScopedMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  for (const handle of handles.splice(0)) {
    if (handle.sqlite.open) handle.sqlite.close();
  }
  rmSync(root, { recursive: true, force: true });
});

describe('DX5 Workspace capture-record lifecycle', () => {
  it('T1 — "durably creates a Workspace SQL capture record": native migration owns the table', () => {
    expect(
      db.sqlite
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get('workspace_capture_records')
    ).toEqual({ name: 'workspace_capture_records' });
    const columns = db.sqlite.pragma('table_info(workspace_capture_records)') as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map((column) => column.name).sort()).toEqual([
      'capture_id',
      'created_at',
      'ended_at',
      'origin',
      'state',
      'workspace_id',
    ]);
    expect(columns.find((column) => column.name === 'capture_id')).toMatchObject({
      notnull: 1,
      pk: 1,
    });
    expect(
      columns.filter((column) => column.name !== 'ended_at').every((column) => column.notnull === 1)
    ).toBe(true);
  });

  it('T2 — "same active identity/scope retries return the unchanged row": create, inspect and scope isolation', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const captureId = randomUUID();
    const siblingId = randomUUID();
    const other = openWorkspace(otherWorkspaceId);
    applyScopedMigrations(other);
    const created = protectCapture(db, workspaceId, captureId);
    expect(created).toEqual({
      captureId,
      workspaceId,
      state: 'active',
      origin: 'manual',
      createdAt: expect.any(String),
      endedAt: null,
    });
    expect(Number.isFinite(Date.parse(created.createdAt))).toBe(true);
    protectCapture(db, workspaceId, siblingId);
    protectCapture(other, otherWorkspaceId, captureId);
    const rows = retainedRows();
    const otherRows = retainedRows(other);
    vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
    expect(protectCapture(db, workspaceId, captureId)).toEqual(created);
    expect(retainedRows()).toEqual(rows);
    const changes = db.sqlite.prepare('SELECT total_changes() AS n').get();
    db.sqlite.pragma('query_only = ON');
    try {
      expect(inspectCapture(db, workspaceId, captureId)).toEqual(created);
      expect(inspectCapture(db, workspaceId, randomUUID()) == null).toBe(true);
    } finally {
      db.sqlite.pragma('query_only = OFF');
    }
    expect(db.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(() => protectCapture(db, otherWorkspaceId, captureId)).toThrow();
    expect(retainedRows()).toEqual(rows);
    completeCapture(db, workspaceId, captureId);
    const terminalRows = retainedRows();
    expect(() => protectCapture(db, workspaceId, captureId)).toThrow();
    expect(retainedRows()).toEqual(terminalRows);
    expect(
      retainedRows().filter((row) => (row as { capture_id: string }).capture_id === siblingId)
    ).toEqual(rows.filter((row) => (row as { capture_id: string }).capture_id === siblingId));
    expect(retainedRows(other)).toEqual(otherRows);
  });

  it('T3 — "atomically change active" and "same-terminal retry preserves": two connections cannot both win', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const peer = openWorkspace();
    for (const [end, oppose, state] of [
      [completeCapture, abandonCapture, 'finished'],
      [abandonCapture, completeCapture, 'abandoned'],
    ] as const) {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
      const captureId = randomUUID();
      const active = protectCapture(db, workspaceId, captureId);
      // Both native handles observe active before either conditional terminal request.
      expect(inspectCapture(peer, workspaceId, captureId)).toEqual(active);
      vi.setSystemTime(new Date('2032-01-01T00:00:00.000Z'));
      const terminal = end(db, workspaceId, captureId);
      expect(terminal).toEqual({ ...active, state, endedAt: expect.any(String) });
      expect(Date.parse(terminal.endedAt as string)).toBeGreaterThanOrEqual(
        Date.parse(active.createdAt)
      );
      const rows = retainedRows();
      vi.setSystemTime(new Date('2033-01-01T00:00:00.000Z'));
      expect(end(peer, workspaceId, captureId)).toEqual(terminal);
      expect(() => oppose(peer, workspaceId, captureId)).toThrow();
      expect(() => protectCapture(peer, workspaceId, captureId)).toThrow();
      expect(inspectCapture(peer, workspaceId, captureId)).toEqual(terminal);
      expect(retainedRows()).toEqual(rows);
    }
  });

  it('T4 — "Restart ... and wall-clock passage cannot release protection": reopen retains active bytes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const captureId = randomUUID();
    const active = protectCapture(db, workspaceId, captureId);
    const rows = retainedRows();
    db.sqlite.close();
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    db = openWorkspace();
    const changes = db.sqlite.prepare('SELECT total_changes() AS n').get();
    expect(inspectCapture(db, workspaceId, captureId)).toEqual(active);
    expect(retainedRows()).toEqual(rows);
    expect(db.sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('T5 — "unknown retained state fails closed" and "unavailable authority ... cannot release": native refusals preserve rows', () => {
    const captureId = randomUUID();
    const active = protectCapture(db, workspaceId, captureId);
    const rows = retainedRows();
    for (const end of [completeCapture, abandonCapture]) {
      expect(() => end(db, workspaceId, randomUUID())).toThrow();
      expect(() => end(db, otherWorkspaceId, captureId)).toThrow();
    }
    for (const invalidUpdate of [
      "state = 'unknown'",
      "origin = 'unknown'",
      'origin = NULL',
      "ended_at = '2031-01-01T00:00:00.000Z'",
      "state = 'finished', ended_at = NULL",
      "state = 'abandoned', ended_at = NULL",
      'capture_id = NULL',
      'workspace_id = NULL',
      'state = NULL',
      'created_at = NULL',
    ]) {
      expect(() =>
        db.sqlite.exec(`UPDATE workspace_capture_records SET ${invalidUpdate}`)
      ).toThrow();
    }
    expect(() =>
      db.sqlite.exec(
        'INSERT INTO workspace_capture_records SELECT * FROM workspace_capture_records'
      )
    ).toThrow();
    expect(retainedRows()).toEqual(rows);
    // Fault injection bypasses only CHECK during fixture corruption; all calls still use native SQL.
    db.sqlite.pragma('ignore_check_constraints = ON');
    db.sqlite.prepare('UPDATE workspace_capture_records SET state = ?').run('unknown');
    db.sqlite.pragma('ignore_check_constraints = OFF');
    const corruptRows = retainedRows();
    for (const operation of [inspectCapture, protectCapture, completeCapture, abandonCapture]) {
      expect(() => operation(db, workspaceId, captureId)).toThrow();
      expect(retainedRows()).toEqual(corruptRows);
    }
    db.sqlite.prepare('UPDATE workspace_capture_records SET state = ?').run('active');
    db.sqlite.pragma('query_only = ON');
    try {
      expect(() => protectCapture(db, workspaceId, randomUUID())).toThrow();
      expect(() => completeCapture(db, workspaceId, captureId)).toThrow();
      expect(() => abandonCapture(db, workspaceId, captureId)).toThrow();
      expect(inspectCapture(db, workspaceId, captureId)).toEqual(active);
    } finally {
      db.sqlite.pragma('query_only = OFF');
    }
    expect(retainedRows()).toEqual(rows);
    db.sqlite.close();
    for (const operation of [inspectCapture, protectCapture, completeCapture, abandonCapture]) {
      expect(() => operation(db, workspaceId, captureId)).toThrow();
    }
    db = openWorkspace();
    expect(inspectCapture(db, workspaceId, captureId)).toEqual(active);
    expect(retainedRows()).toEqual(rows);
  });
});

// Online Snapshot Policy requires positive automatic origin; default and predecessor data stay manual.
describe('C-b capture origin authority', () => {
  it('retains original origin on replay and refuses a different origin without mutation', () => {
    const manualId = randomUUID();
    const automaticId = randomUUID();
    const manual = protectCapture(db, workspaceId, manualId);
    const automatic = protectCapture(db, workspaceId, automaticId, { origin: 'automatic' });
    expect(manual).toMatchObject({ origin: 'manual', state: 'active' });
    expect(automatic).toMatchObject({ origin: 'automatic', state: 'active' });
    const rows = retainedRows();
    expect(protectCapture(db, workspaceId, automaticId, { origin: 'automatic' })).toEqual(
      automatic
    );
    expect(() => protectCapture(db, workspaceId, manualId, { origin: 'automatic' })).toThrow();
    expect(() => protectCapture(db, workspaceId, automaticId)).toThrow();
    expect(retainedRows()).toEqual(rows);
    expect(inspectCapture(db, workspaceId, manualId)).toEqual(manual);
    expect(inspectCapture(db, workspaceId, automaticId)).toEqual(automatic);
  });

  it('fails closed on an unsupported retained origin and preserves its exact record', () => {
    const captureId = randomUUID();
    protectCapture(db, workspaceId, captureId);
    // Damage an owner-created record; do not manufacture automatic publication authority.
    db.sqlite.pragma('ignore_check_constraints = ON');
    db.sqlite.prepare('UPDATE workspace_capture_records SET origin = ?').run('unknown');
    db.sqlite.pragma('ignore_check_constraints = OFF');
    const rows = retainedRows();
    for (const operation of [inspectCapture, protectCapture, completeCapture, abandonCapture]) {
      expect(() => operation(db, workspaceId, captureId)).toThrow();
      expect(retainedRows()).toEqual(rows);
    }
  });
});
