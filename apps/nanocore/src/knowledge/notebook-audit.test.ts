import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateEntityId, type KnowledgeNotebookAdmission } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  listServerAuditEvents,
  listWorkspaceAuditEvents,
  recordServerAuditEvent,
  recordUserAuditEvent,
  recordWorkspaceAuditEvent,
} from '../audit-events.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import {
  applyMigrations,
  applyNativeScopeMigrations,
  applyScopedMigrations,
} from '../storage/migrate.js';

const ownerUserId = allocateEntityId('usr');
const editorUserId = allocateEntityId('usr');
const otherUserId = allocateEntityId('usr');
const workspaceId = allocateEntityId('ws');
const otherWorkspaceId = allocateEntityId('ws');

/** Uses the existing three database owners; no notebook journal or content fixture substitutes for Audit. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-audit-'));
  const coreDb = openCoreDb(dataRoot);
  const userDb = openUserDb(dataRoot, ownerUserId);
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  onTestFinished(() => {
    for (const { sqlite } of [coreDb, userDb, workspaceDb]) if (sqlite.open) sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  applyScopedMigrations(userDb);
  applyScopedMigrations(workspaceDb);
  return { dataRoot, coreDb, userDb, workspaceDb };
}

/** Exact content-free facts of one admitted human publication, distinct from page bytes. */
function admission(
  ownerScope: KnowledgeNotebookAdmission['ownerScope']
): KnowledgeNotebookAdmission {
  const requestId = randomUUID();
  return {
    ownerScope,
    requestId,
    inputDigest: `sha256:${'1'.repeat(64)}`,
    baseRevision: null,
    candidateRevision: 'opaque-git-commit',
    producer: { kind: 'user', id: editorUserId },
    authority: { kind: 'direct', instructionReference: `request:${requestId}` },
    sourceReferences: ['source:registered@sha256:exact'],
  };
}

/** Supplies the same historical attribution to the existing Audit family. */
function event(notebookAdmission: KnowledgeNotebookAdmission) {
  return {
    action: 'knowledge.notebook.admit',
    category: 'knowledge' as const,
    actor: notebookAdmission.producer,
    requestId: notebookAdmission.requestId,
    notebookAdmission,
    outcome: 'succeeded' as const,
    summary: 'Notebook publication admitted.',
  };
}

describe('notebook publication admission in the existing Audit owners', () => {
  it.each([
    'core',
    'workspace',
    'app',
    'user',
  ] as const)('carries predecessor %s rows through its incremental native migration once', (scope) => {
    const predecessor = mkdtempSync(join(tmpdir(), 'notebook-audit-predecessor-'));
    const sqlite = new Database(':memory:');
    onTestFinished(() => {
      sqlite.close();
      rmSync(predecessor, { recursive: true, force: true });
    });
    const current = fileURLToPath(new URL(`../../drizzle/${scope}/`, import.meta.url));
    const journal = JSON.parse(readFileSync(join(current, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.at(-1)!.tag).toContain('notebook_admission');
    const previous = { ...journal, entries: journal.entries.slice(0, -1) };
    mkdirSync(join(predecessor, 'meta'));
    writeFileSync(join(predecessor, 'meta', '_journal.json'), JSON.stringify(previous));
    for (const entry of previous.entries)
      copyFileSync(join(current, `${entry.tag}.sql`), join(predecessor, `${entry.tag}.sql`));
    applyNativeScopeMigrations(sqlite, scope, predecessor);
    if (scope === 'user') {
      sqlite
        .prepare(
          `INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'retained',
          'retained.command',
          randomUUID(),
          '{}',
          'original-hash',
          'retained',
          'original-response',
          '2026-10-15T00:00:00.000Z',
          '2026-10-20T00:00:00.000Z'
        );
    } else {
      sqlite
        .prepare(
          `INSERT INTO audit_events (audit_event_id, workspace_id, category, action, outcome, severity, summary, created_at, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'aud_retained',
          scope === 'core' ? null : workspaceId,
          'knowledge',
          'retained.admission',
          'succeeded',
          'info',
          'Original retained summary.',
          '2026-10-15T00:00:00.000Z',
          '2026-10-15T00:00:00.000Z'
        );
    }
    const table = scope === 'user' ? 'idempotency_requests' : 'audit_events';
    const before = sqlite.prepare(`SELECT * FROM ${table}`).all();
    const previousCount = Number(
      (
        sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get() as {
          count: number;
        }
      ).count
    );
    applyNativeScopeMigrations(sqlite, scope, current);
    applyNativeScopeMigrations(sqlite, scope, current);
    expect(sqlite.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({
      count: previousCount + 1,
    });
    const after = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    expect(after.map(({ notebook_admission_json: _newField, ...row }) => row)).toEqual(before);
    expect(
      (sqlite.pragma('table_info(audit_events)') as Array<{ name: string }>).map(({ name }) => name)
    ).toContain('notebook_admission_json');
  });

  it('retains User facts in the original User database through reopen without changing the owner', () => {
    const f = fixture();
    const facts = admission({ kind: 'user', userId: f.userDb.userId });
    const stored = recordUserAuditEvent({ userDb: f.userDb, ...event(facts) });
    expect(stored).toMatchObject({
      workspaceId: null,
      actor: facts.producer,
      notebookAdmission: facts,
    });
    f.userDb.sqlite.close();
    const reopened = openUserDb(f.dataRoot, ownerUserId);
    try {
      applyScopedMigrations(reopened);
      const row = reopened.sqlite.prepare('SELECT * FROM audit_events').get() as Record<
        string,
        unknown
      >;
      expect(row.workspace_id).toBeNull();
      expect(JSON.parse(String(row.actor_json))).toEqual(facts.producer);
      expect(JSON.parse(String(row.notebook_admission_json))).toEqual(facts);
      expect(f.coreDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({
        count: 0,
      });
      expect(
        f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()
      ).toEqual({ count: 0 });
    } finally {
      reopened.sqlite.close();
    }
  });

  it('round-trips Workspace and Server admission facts without adding facts to ordinary events', () => {
    const f = fixture();
    const workspace = recordWorkspaceAuditEvent({
      workspaceDb: f.workspaceDb,
      workspaceId: f.workspaceDb.workspaceId,
      ...event(admission({ kind: 'workspace', workspaceId: f.workspaceDb.workspaceId })),
    });
    const server = recordServerAuditEvent({
      coreDb: f.coreDb,
      ...event(admission({ kind: 'server' })),
    });
    const ordinary = recordServerAuditEvent({
      coreDb: f.coreDb,
      action: 'ordinary.inspect',
      outcome: 'succeeded',
      summary: 'Inspected.',
    });
    expect(listWorkspaceAuditEvents(f.workspaceDb, f.workspaceDb.workspaceId)).toEqual([workspace]);
    expect(listServerAuditEvents(f.coreDb)).toEqual(expect.arrayContaining([server, ordinary]));
    expect(ordinary).not.toHaveProperty('notebookAdmission');
  });

  it('refuses a foreign User notebook before writing evidence', () => {
    const f = fixture();
    expect(() =>
      recordUserAuditEvent({
        userDb: f.userDb,
        ...event(admission({ kind: 'user', userId: otherUserId })),
      })
    ).toThrow();
    expect(f.userDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({
      count: 0,
    });
  });

  it('refuses a foreign Workspace notebook before writing evidence', () => {
    const f = fixture();
    expect(() =>
      recordWorkspaceAuditEvent({
        workspaceDb: f.workspaceDb,
        workspaceId: f.workspaceDb.workspaceId,
        ...event(admission({ kind: 'workspace', workspaceId: otherWorkspaceId })),
      })
    ).toThrow();
    expect(
      f.workspaceDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()
    ).toEqual({ count: 0 });
  });

  it('refuses User or Workspace admission in the Server Audit database', () => {
    const f = fixture();
    for (const scope of [
      { kind: 'user', userId: ownerUserId },
      { kind: 'workspace', workspaceId: workspaceId },
    ] as const) {
      expect(() =>
        recordServerAuditEvent({ coreDb: f.coreDb, ...event(admission(scope)) })
      ).toThrow();
    }
    expect(f.coreDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({
      count: 0,
    });
  });

  it('propagates a failed required Audit write without claiming admission', () => {
    const f = fixture();
    f.userDb.sqlite.exec(
      "CREATE TRIGGER refuse_admission BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'admission refused'); END;"
    );
    expect(() =>
      recordUserAuditEvent({
        userDb: f.userDb,
        ...event(admission({ kind: 'user', userId: f.userDb.userId })),
      })
    ).toThrow('admission refused');
    expect(f.userDb.sqlite.prepare('SELECT count(*) AS count FROM audit_events').get()).toEqual({
      count: 0,
    });
  });
});
