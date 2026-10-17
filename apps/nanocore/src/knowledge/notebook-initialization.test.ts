import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestIdSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { DEFAULT_NOTEBOOK_INDEX, KnowledgeNotebook } from './notebook.js';
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
  it('seeds no-argument disk-backed Workspace creation with only the exact service-owned index', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-empty-store-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Empty service seed');
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
    });
    const revision = notebook.publishedRevision();
    const retained = notebook.readRevision(revision);
    const systemProducer = {
      kind: 'system',
      id: 'notebook-initializer',
      responsibleUserId: null,
    };
    expect(retained.parentRevision).toBeNull();
    expect(retained.files).toEqual({ 'index.md': DEFAULT_NOTEBOOK_INDEX });
    expect(retained.metadata).toMatchObject({
      producer: systemProducer,
      authority: { kind: 'direct', instructionReference: 'workspace.create:empty-notebook-seed' },
      sourceReferences: [],
    });
    expect(RequestIdSchema.safeParse(retained.metadata.changeRequest.requestId).success).toBe(true);
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    try {
      const rows = workspaceDb.sqlite
        .prepare(
          'SELECT action, notebook_admission_json AS evidence FROM audit_events ORDER BY rowid'
        )
        .all() as Array<{ action: string; evidence: string }>;
      expect(rows.map(({ action }) => action)).toEqual([
        'knowledge.notebook.admit',
        'knowledge.notebook.initialize',
      ]);
      for (const row of rows)
        expect(JSON.parse(row.evidence)).toMatchObject({
          ownerScope: { kind: 'workspace', workspaceId: workspace.id },
          requestId: retained.metadata.changeRequest.requestId,
          inputDigest: retained.metadata.changeRequest.inputDigest,
          baseRevision: null,
          candidateRevision: revision,
          producer: systemProducer,
        });
    } finally {
      workspaceDb.sqlite.close();
    }
    const second = store.createWorkspace('Another empty service seed');
    const secondNotebook = new KnowledgeNotebook({
      repositoryPath: join(dataRoot, 'workspaces', second.id, 'knowledge', 'notebook.git'),
    });
    expect(
      secondNotebook.readRevision(secondNotebook.publishedRevision()).metadata.changeRequest
        .requestId
    ).not.toBe(retained.metadata.changeRequest.requestId);
    const explicit = store.createWorkspace('Explicit User', {
      requestId: randomUUID(),
      producer,
      instructionReference: 'workspace.create:actual-user',
    });
    const explicitNotebook = new KnowledgeNotebook({
      repositoryPath: join(dataRoot, 'workspaces', explicit.id, 'knowledge', 'notebook.git'),
    });
    expect(
      explicitNotebook.readRevision(explicitNotebook.publishedRevision()).metadata.producer
    ).toEqual(producer);
  });

  it('creates initial root navigation from imported files and preserves valid reserved bytes', () => {
    const f = fixture();
    const topicIndex = '# Topic\n\nKeep authored navigation.\n';
    const topicLog = '# Topic history\n\n## 2026-10-16\n* Keep authored history.\n';
    const revision = initializeWorkspaceNotebook({
      ...f,
      files: {
        'topic/index.md': topicIndex,
        'topic/log.md': topicLog,
      },
    });
    expect(f.notebook().readRevision(revision).files).toEqual({
      'index.md': '---\nokf_version: "0.2"\n---\n# Knowledge\n\n* [topic](<topic/>)\n',
      'topic/index.md': topicIndex,
      'topic/log.md': topicLog,
    });
  });

  it('adds only the required version block to a fresh body-only root index', () => {
    const f = fixture();
    const body = '# Human navigation\n\nKeep every original body byte.\n';
    const revision = initializeWorkspaceNotebook({ ...f, files: { 'index.md': body } });
    expect(f.notebook().readRevision(revision).files['index.md']).toBe(
      `---\nokf_version: "0.2"\n---\n${body}`
    );
  });

  it('refuses service attribution for authored initial content before creating Git or Audit evidence', () => {
    for (const files of [
      { 'index.md': '---\nokf_version: "0.2"\n---\n# Authored navigation\n' },
      {
        'index.md': DEFAULT_NOTEBOOK_INDEX,
        'note.md': `---
type: KnowledgePage
title: Authored note
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: {kind: workspace, workspaceId: ${workspaceId}}
source_refs: []
review_state: user-authored
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
---
User-authored note.
`,
      },
    ]) {
      const f = fixture();
      expect(() =>
        initializeWorkspaceNotebook({
          ...f,
          files,
          initialization: {
            requestId: randomUUID(),
            producer: { kind: 'system', id: 'notebook-initializer', responsibleUserId: null },
            instructionReference: 'workspace.create:empty-notebook-seed',
          },
        })
      ).toThrow('Notebook invalid request.');
      expect(existsSync(f.repositoryPath)).toBe(false);
      expect(f.rows()).toEqual([]);
    }
  });

  it('keeps import without native attribution refused before Workspace publication', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-unattributed-import-'));
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const source = new FsStore();
    const workspace = source.createWorkspace('Unattributed import');
    const target = new FsStore({ dataRoot });
    expect(() =>
      target.importWorkspaceSnapshot({
        workspace,
        threads: [],
        turns: [],
        knowledge: [],
        itemRevisions: [],
        artifacts: [],
        agentSessions: [],
        turnEvents: [],
        initialNotebookFiles: {
          'index.md': '---\nokf_version: "0.2"\n---\n# Authored imported index\n',
        },
      })
    ).toThrow('Fresh Workspace publication requires native notebook attribution.');
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(false);
    expect(target.listWorkspaces()).toEqual([]);
  });

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
