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
