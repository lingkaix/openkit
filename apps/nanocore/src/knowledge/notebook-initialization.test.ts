import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { KnowledgeNotebook } from './notebook.js';
import { initializeWorkspaceNotebook } from './notebook-initialization.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const producer = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

/** Actual fresh-scope database and bare Git; the caller owns this unpublished staging directory. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-initialization-'));
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
  const initialization = {
    requestId: randomUUID(),
    producer,
    instructionReference: 'creation:test',
  };
  const revalidate = vi.fn(() => ({
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    reviewRequiredPageIds: [] as string[],
    registeredSources: new Map<string, string | null>(),
    resolvedReferences: new Map<string, ReadonlySet<string>>(),
  }));
  const input = { workspaceRoot, workspaceId, workspaceDb, initialization, revalidate };
  onTestFinished(() => {
    workspaceDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    ...input,
    repositoryPath,
    initialize: () => initializeWorkspaceNotebook(input),
    notebook: () => new KnowledgeNotebook({ repositoryPath }),
    rows: () =>
      workspaceDb.sqlite
        .prepare(
          'SELECT action, notebook_admission_json AS evidence FROM audit_events ORDER BY rowid'
        )
        .all() as Array<{ action: string; evidence: string }>,
  };
}

describe('Fresh Workspace notebook admission inside native staging', () => {
  it('publishes one parentless revision with exact responsible actor and both Audit facts', () => {
    const f = fixture();
    const revision = f.initialize();
    const retained = f.notebook().readRevision(revision);
    expect(retained.parentRevision).toBeNull();
    expect(retained.metadata).toMatchObject({
      producer,
      changeRequest: { requestId: f.initialization.requestId },
      authority: { kind: 'direct', instructionReference: f.initialization.instructionReference },
      sourceReferences: [],
    });
    expect(f.rows().map(({ action }) => action)).toEqual([
      'knowledge.notebook.admit',
      'knowledge.notebook.initialize',
    ]);
    for (const { evidence } of f.rows())
      expect(JSON.parse(evidence)).toMatchObject({
        ownerScope: { kind: 'workspace', workspaceId },
        requestId: f.initialization.requestId,
        producer,
        baseRevision: null,
        candidateRevision: revision,
        inputDigest: retained.metadata.changeRequest.inputDigest,
      });
    expect(f.notebook().publishedRevision()).toBe(revision);
    expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(() => f.initialize()).toThrow();
    expect(f.notebook().publishedRevision()).toBe(revision);
    expect(f.rows()).toHaveLength(2);
  });

  it('refuses publication when required admission Audit fails', () => {
    const f = fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER fail_notebook_admission BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.admit' BEGIN SELECT RAISE(ABORT, 'admission fault'); END"
    );
    expect(f.initialize).toThrow('admission fault');
    expect(f.rows()).toEqual([]);
    expect(() => f.notebook().publishedRevision()).toThrow();
    const refs = execFileSync(
      'git',
      ['--git-dir', f.repositoryPath, 'for-each-ref', '--format=%(refname)'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    expect(refs).toBe('');
  });

  it('does not fabricate completion after a post-ref Audit fault', () => {
    const f = fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER fail_notebook_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.initialize' BEGIN SELECT RAISE(ABORT, 'completion fault'); END"
    );
    expect(f.initialize).toThrow('completion fault');
    expect(f.notebook().publishedRevision()).toBe(
      f.rows().map(({ evidence }) => JSON.parse(evidence))[0].candidateRevision
    );
    expect(f.rows().map(({ action }) => action)).toEqual(['knowledge.notebook.admit']);
    expect(() => f.initialize()).toThrow();
    expect(f.rows()).toHaveLength(1);
  });

  it('rechecks current creation authority before publishing the first ref', () => {
    const f = fixture();
    f.revalidate
      .mockImplementationOnce(() => ({
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        reviewRequiredPageIds: [] as string[],
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      }))
      .mockImplementationOnce(() => {
        throw new Error('creation authority revoked');
      });
    expect(f.initialize).toThrow('creation authority revoked');
    expect(f.rows()).toEqual([]);
    expect(() => f.notebook().publishedRevision()).toThrow();
  });
});
