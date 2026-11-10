import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri, RequestIdSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { closeTestCoreDb, createTestStore, createTestWorkspaceDb } from '../test-support/store.js';
import { DEFAULT_NOTEBOOK_INDEX } from './notebook.js';
import { initializeWorkspaceNotebook } from './notebook-initialization.js';
import { readWorkspaceNotebookSelection } from './notebook-workspace-selection.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT, parseScopeKnowledgeSchema } from './okf.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const producer = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const knowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';

/** Actual fresh-scope database and bare Git; the caller owns this unpublished staging directory. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-initialization-'));
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
  const initialization = {
    requestId: randomUUID(),
    producer,
    instructionReference: 'creation:test',
  };
  const revalidate = vi.fn(() => ({
    pageScopeId: `page/workspace/${workspaceId}/${knowledgeBaseId}`,
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    reviewRequiredPageIds: [] as string[],
    registeredSources: new Map<string, string | null>(),
    resolvedReferences: new Map<string, ReadonlySet<string>>(),
  }));
  const input = { workspaceRoot, workspaceId, workspaceDb, initialization, revalidate };
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    ...input,
    repositoryPath,
    initialize: () => initializeWorkspaceNotebook(input),
    notebook: () =>
      readWorkspaceNotebookSelection({ workspaceDb, workspaceRoot, knowledgeBaseId }).notebook,
    rows: () =>
      workspaceDb.sqlite
        .prepare(
          'SELECT action, notebook_admission_json AS evidence FROM audit_events ORDER BY rowid'
        )
        .all() as Array<{ action: string; evidence: string }>,
  };
}

describe('Fresh Workspace notebook admission inside native staging', () => {
  it('seeds no-argument disk-backed Workspace creation with only the exact service-owned index', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-empty-store-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      return rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = createTestStore({ dataRoot });
    const creationStarted = Date.now();
    const workspace = await store.createWorkspace('Empty service seed');
    const creationFinished = Date.now();
    const notebookFor = (id: string) => {
      const db = createTestWorkspaceDb(dataRoot, id);
      try {
        return readWorkspaceNotebookSelection({
          workspaceDb: db,
          workspaceRoot: join(dataRoot, 'workspaces', id),
          knowledgeBaseId: readDefaultKnowledgeBaseId({
            dataRoot,
            scope: { kind: 'workspace', workspaceId: id },
          }),
        }).notebook;
      } finally {
        closeTestCoreDb(db);
      }
    };
    const notebook = notebookFor(workspace.id);
    const revision = notebook.publishedRevision();
    const retained = notebook.readRevision(revision);
    const schemaPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'knowledge',
      'schema',
      'scope-schema.yaml'
    );
    const schemaText = readFileSync(schemaPath, 'utf8');
    const schema = parseScopeKnowledgeSchema(schemaText);
    expect(schema).toMatchObject({
      ok: true,
      schema: {
        status: 'active',
        maintainer: 'OpenKit',
        extensionPoints: [
          'allowed_types',
          'allowed_statuses',
          'allowed_review_states',
          'allowed_sensitivities',
          'allowed_freshness',
        ],
        validationRules: ['openkit-knowledge-profile-v4'],
        reviewRequirements: [
          'active_retrieval',
          'required_fields',
          'sensitivity',
          'source_reference_shape',
          'review_rules',
        ],
      },
    });
    if (!schema.ok) throw new Error('Fresh Workspace schema must parse.');
    expect(schema.schema.createdAt).toBe(schema.schema.updatedAt);
    expect(Date.parse(schema.schema.createdAt!)).toBeGreaterThanOrEqual(creationStarted);
    expect(Date.parse(schema.schema.createdAt!)).toBeLessThanOrEqual(creationFinished);
    notebook.readRevision(revision);
    expect(readFileSync(schemaPath, 'utf8')).toBe(schemaText);
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
      const selected = readWorkspaceNotebookSelection({
        workspaceDb,
        workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
        knowledgeBaseId: readDefaultKnowledgeBaseId({
          dataRoot,
          scope: { kind: 'workspace', workspaceId: workspace.id },
        }),
      });
      expect(
        execFileSync(
          'git',
          [
            '--git-dir',
            join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
            'for-each-ref',
          ],
          { encoding: 'utf8' }
        )
      ).toBe('');
      expect(selected.notebook.validateRetainedGraph()).toEqual({
        publishedRevision: revision,
        revisions: [revision],
      });
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
    const second = await store.createWorkspace('Another empty service seed');
    const secondNotebook = notebookFor(second.id);
    expect(
      secondNotebook.readRevision(secondNotebook.publishedRevision()).metadata.changeRequest
        .requestId
    ).not.toBe(retained.metadata.changeRequest.requestId);
    const explicit = await store.createWorkspace('Explicit User', {
      requestId: randomUUID(),
      producer,
      instructionReference: 'workspace.create:actual-user',
    });
    const explicitNotebook = notebookFor(explicit.id);
    expect(
      explicitNotebook.readRevision(explicitNotebook.publishedRevision()).metadata.producer
    ).toEqual(producer);
  });

  it('preserves supplied schema metadata and authored bytes during fresh initialization', async () => {
    const f = fixture();
    const schemaText = `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}maintainer: Imported author\ncreated_at: "2020-01-01T00:00:00.000Z"\nupdated_at: "2021-01-01T00:00:00.000Z"\n# Exact imported schema annotation.\n`;
    f.revalidate.mockReturnValue({ ...f.revalidate(), scopeSchemaText: schemaText });
    await f.initialize();
    expect(
      readFileSync(join(f.workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml'), 'utf8')
    ).toBe(schemaText);
  });

  it('keeps a non-commit retained ref recovery-required', async () => {
    const f = fixture();
    await f.initialize();
    const gitOptions = {
      encoding: 'utf8' as const,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['pipe', 'pipe', 'pipe'] as const,
    };
    const blob = execFileSync(
      'git',
      ['--git-dir', f.repositoryPath, 'hash-object', '-w', '--stdin'],
      { ...gitOptions, input: 'retained non-commit fault' }
    ).trim();
    execFileSync(
      'git',
      ['--git-dir', f.repositoryPath, 'update-ref', 'refs/tags/non-commit', blob],
      gitOptions
    );
    expect(() => f.notebook().validateRetainedGraph()).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });

  it('creates initial root navigation from imported files and preserves valid reserved bytes', async () => {
    const f = fixture();
    const topicIndex = '# Topic\n\nKeep authored navigation.\n';
    const topicLog = '# Topic history\n\n## 2026-10-16\n* Keep authored history.\n';
    const revision = await initializeWorkspaceNotebook({
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

  it.each([
    { name: 'heading', body: '# Human navigation\n\nKeep every original body byte.\n' },
    {
      name: 'horizontal rule',
      body: '----\n# Human navigation\n\nKeep every original body byte.\n',
    },
  ])(
    'adds only the required version block to a fresh body-only root index ($name)',
    async ({ body }) => {
      const f = fixture();
      const revision = await initializeWorkspaceNotebook({ ...f, files: { 'index.md': body } });
      expect(f.notebook().readRevision(revision).files['index.md']).toBe(
        `---\nokf_version: "0.2"\n---\n${body}`
      );
    }
  );

  it('refuses service attribution for authored initial content before creating Git or Audit evidence', async () => {
    for (const files of [
      { 'index.md': '---\nokf_version: "0.2"\n---\n# Authored navigation\n' },
      {
        'index.md': DEFAULT_NOTEBOOK_INDEX,
        'note.md': `---
type: KnowledgePage
title: Authored note
schema_version: openkit-scope-knowledge-schema-v4
required_features: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
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
      await expect(
        initializeWorkspaceNotebook({
          ...f,
          files,
          initialization: {
            requestId: randomUUID(),
            producer: { kind: 'system', id: 'notebook-initializer', responsibleUserId: null },
            instructionReference: 'workspace.create:empty-notebook-seed',
          },
        })
      ).rejects.toThrow('Notebook invalid request.');
      expect(existsSync(f.repositoryPath)).toBe(false);
      expect(f.rows()).toEqual([]);
    }
  });

  it('keeps import without native attribution refused before Workspace publication', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-unattributed-import-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      return rmSync(dataRoot, { recursive: true, force: true });
    });
    const sourceRoot = mkdtempSync(join(tmpdir(), 'notebook-unattributed-source-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(sourceRoot);
      rmSync(sourceRoot, { recursive: true, force: true });
    });
    const source = createTestStore({ dataRoot: sourceRoot });
    const workspace = await source.createWorkspace('Unattributed import');
    const target = createTestStore({ dataRoot });
    await expect(
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
    ).rejects.toThrow('Fresh Workspace publication requires native notebook attribution.');
    expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(false);
    expect(target.listWorkspaces()).toEqual([]);
  });

  it('validates imported initial page pins, OKF framing, and retained bytes before SQL publication', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'notebook-pin-import-target-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(dataRoot);
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const sourceRoot = mkdtempSync(join(tmpdir(), 'notebook-pin-import-source-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(sourceRoot);
      rmSync(sourceRoot, { recursive: true, force: true });
    });
    const source = createTestStore({ dataRoot: sourceRoot });
    const workspace = await source.createWorkspace('Imported pinned notebook');
    const target = createTestStore({ dataRoot });
    const targetScope = `page/workspace/${workspace.id}/${knowledgeBaseId}`;
    const otherScope = `page/workspace/${workspaceId}/${knowledgeBaseId}`;
    const digest = (content: string) =>
      `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const page = (
      title: string,
      sourceRefsYaml: string,
      body = 'Exact authored body: 漢字.\r\n\t  \n',
      extraFrontmatter = ''
    ) => `---
type: KnowledgePage
title: ${title}
schema_version: openkit-scope-knowledge-schema-v4
required_features: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: {kind: workspace, workspaceId: ${workspace.id}}
${sourceRefsYaml}review_state: user-authored
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
${extraFrontmatter}---
${body}`;
    const evidence = page(
      'Evidence page',
      'source_refs: []\n',
      'Exact evidence body: 漢字.\r\n\t  \n',
      'custom_retained: {nested: [exact, bytes]}\n'
    );
    const evidencePin = formatReferenceUri(
      { scopeId: targetScope, objectId: 'topic/evidence' },
      digest(evidence)
    );
    const foreignPin = formatReferenceUri(
      { scopeId: otherScope, objectId: 'topic/evidence' },
      digest(evidence)
    );
    const dependent = page('Dependent page', `source_refs: ["${evidencePin}"]\n`);
    const importWithFiles = (
      initialNotebookFiles: Readonly<Record<string, string>>,
      requestId = randomUUID(),
      initialNotebookSchemaText?: string
    ) =>
      target.importWorkspaceSnapshot({
        workspace,
        defaultKnowledgeBaseId: knowledgeBaseId,
        threads: [],
        turns: [],
        knowledge: [],
        itemRevisions: [],
        artifacts: [],
        agentSessions: [],
        turnEvents: [],
        notebookInitialization: {
          requestId,
          producer,
          instructionReference: 'workspace.import:pin-validation',
        },
        initialNotebookFiles,
        ...(initialNotebookSchemaText === undefined ? {} : { initialNotebookSchemaText }),
      });

    for (const [initialNotebookFiles, expectedError] of [
      [
        { 'dependent.md': dependent },
        'Portable Knowledge Page requires unavailable pinned source bytes.',
      ],
      [
        {
          'topic/evidence.md': page(
            'Evidence page',
            'source_refs: []\n',
            'Changed evidence bytes.\n'
          ),
          'dependent.md': dependent,
        },
        'Portable Knowledge Page requires unavailable pinned source bytes.',
      ],
      [
        {
          'topic/evidence.md': evidence,
          'dependent.md': page('Dependent page', `source_refs: ["${foreignPin}"]\n`),
        },
        'Notebook invalid request.',
      ],
      [{ 'broken.md': '---\ntitle: Unclosed frontmatter\n' }, 'Notebook invalid request.'],
      [
        { 'broken.md': page('Malformed source_refs', 'source_refs: [123]\n') },
        'Notebook invalid request.',
      ],
      [{ 'broken.md': page('Missing source_refs', '') }, 'Notebook invalid request.'],
    ] as const) {
      await expect(importWithFiles(initialNotebookFiles)).rejects.toThrow(expectedError);
      expect(existsSync(join(dataRoot, 'workspaces', workspace.id))).toBe(false);
      expect(target.listWorkspaces()).toEqual([]);
    }

    const topicIndex = '# Topic\n\nRetained reserved navigation.\n';
    const topicLog = '# Topic history\n\n## 2026-10-16\n* Retained reserved history.\n';
    const schemaText = `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}# Retained imported schema comment.\n`;
    const requestId = randomUUID();
    await importWithFiles(
      {
        'topic/index.md': topicIndex,
        'topic/log.md': topicLog,
        'topic/evidence.md': evidence,
        'dependent.md': dependent,
      },
      requestId,
      schemaText
    );
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    try {
      const selected = readWorkspaceNotebookSelection({
        workspaceDb,
        workspaceRoot,
        knowledgeBaseId,
      });
      const revision = selected.notebook.publishedRevision();
      expect(selected.head.notebookCommit).toBe(revision);
      expect(selected.scopeSchemaText).toBe(schemaText);
      expect(
        readFileSync(join(workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml'), 'utf8')
      ).toBe(schemaText);
      const retained = selected.notebook.readRevision(revision);
      expect(retained.parentRevision).toBeNull();
      expect(retained.files).toEqual({
        'index.md':
          '---\nokf_version: "0.2"\n---\n# Knowledge\n\n* [dependent](<dependent.md>)\n* [topic](<topic/>)\n',
        'topic/index.md': topicIndex,
        'topic/log.md': topicLog,
        'topic/evidence.md': evidence,
        'dependent.md': dependent,
      });
      expect(retained.metadata).toMatchObject({
        producer,
        changeRequest: { requestId },
        authority: { kind: 'direct', instructionReference: 'workspace.import:pin-validation' },
        sourceReferences: [evidencePin],
      });
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
          requestId,
          baseRevision: null,
          candidateRevision: revision,
          producer,
          sourceReferences: [evidencePin],
        });
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('publishes one parentless revision with exact responsible actor and both Audit facts', async () => {
    const f = fixture();
    const revision = await f.initialize();
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
    expect(f.revalidate).toHaveBeenCalledTimes(3);
    await expect(f.initialize()).rejects.toThrow();
    expect(f.notebook().publishedRevision()).toBe(revision);
    expect(f.rows()).toHaveLength(2);
  });

  it('refuses publication when required admission Audit fails', async () => {
    const f = fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER fail_notebook_admission BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.admit' BEGIN SELECT RAISE(ABORT, 'admission fault'); END"
    );
    await expect(f.initialize()).rejects.toMatchObject({
      code: 'migration_failed',
      message: expect.stringContaining('SQLITE_CONSTRAINT_TRIGGER'),
    });
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

  it('does not fabricate completion after a post-ref Audit fault', async () => {
    const f = fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER fail_notebook_completion BEFORE INSERT ON audit_events WHEN NEW.action = 'knowledge.notebook.initialize' BEGIN SELECT RAISE(ABORT, 'completion fault'); END"
    );
    // SQL selection and both Audits now commit together; no legacy partial ref is authority.
    await expect(f.initialize()).rejects.toMatchObject({
      code: 'migration_failed',
      message: expect.stringContaining('SQLITE_CONSTRAINT_TRIGGER'),
    });
    expect(() => f.notebook().publishedRevision()).toThrow();
    expect(f.rows().map(({ action }) => action)).toEqual([]);
    await expect(f.initialize()).rejects.toThrow();
    expect(f.rows()).toHaveLength(0);
  });

  it('rechecks current creation authority before publishing the first ref', async () => {
    const f = fixture();
    f.revalidate
      .mockImplementationOnce(() => ({
        pageScopeId: `page/workspace/${workspaceId}/${knowledgeBaseId}`,
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        reviewRequiredPageIds: [] as string[],
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      }))
      .mockImplementationOnce(() => {
        throw new Error('creation authority revoked');
      });
    await expect(f.initialize()).rejects.toThrow('creation authority revoked');
    expect(f.rows()).toEqual([]);
    expect(() => f.notebook().publishedRevision()).toThrow();
  });
});
