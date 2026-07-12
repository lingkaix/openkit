import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  rebuildExistingWorkspaceDerivedIndexes,
  rebuildWorkspaceDerivedIndexes,
  retrieveWorkspaceKnowledge,
} from './index-rebuild.js';

/**
 * Creates a temporary NanoCore data root for index rebuild tests.
 *
 * @returns Temporary data root path.
 */
function createDataRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-index-rebuild-'));
}

describe('workspace derived index rebuild', () => {
  it('rebuilds the search index from file-backed workspace records', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Needle thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Find needle');
    store.createItem({
      id: 'it_search_needle',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Needle answer',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    store.createArtifact({
      id: 'ar_search_needle',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Needle artifact',
      status: 'ready',
      summary: 'Needle artifact summary',
      version: 1,
      content: { format: 'markdown', body: 'Needle artifact body' },
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    store.createArtifact({
      id: 'ar_without_summary',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'summary',
      title: 'Summary-less artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: 'Artifact without summary.' },
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const indexesRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'indexes');
    mkdirSync(indexesRoot, { recursive: true });
    writeFileSync(join(indexesRoot, 'stale.json'), '{}');

    const result = rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    expect(result).toEqual({
      workspaceId: 'ws_demo',
      indexPath: 'users/user_local/workspaces/ws_demo/indexes/search.json',
      itemCount: 8,
      removedEntries: ['stale.json'],
    });
    expect(existsSync(join(indexesRoot, 'stale.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(indexesRoot, 'search.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      items: expect.arrayContaining([
        expect.objectContaining({ kind: 'workspace', id: 'ws_demo', title: 'Demo Workspace' }),
        expect.objectContaining({ kind: 'thread', id: thread.id, title: 'Needle thread' }),
        expect.objectContaining({ kind: 'item', id: 'it_search_needle', title: 'Needle answer' }),
        expect.objectContaining({
          kind: 'artifact',
          id: 'ar_search_needle',
          title: 'Needle artifact',
        }),
        expect.objectContaining({
          kind: 'artifact',
          id: 'ar_without_summary',
          title: 'Summary-less artifact',
        }),
      ]),
    });
  });

  it('indexes only the latest revision of each append-only item record', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Revision thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Revise the answer');
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const firstRevision = store.createItem({
      id: 'it_revised_answer',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'Obsolete answer text',
      createdAt: timestamp,
      completedAt: null,
    });
    const latestRevision = {
      ...firstRevision,
      status: 'completed' as const,
      text: 'Current answer text',
      completedAt: timestamp,
    };
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');

    writeFileSync(
      join(workspaceRoot, 'threads', thread.id, 'turns', turn.id, 'items.jsonl'),
      `${JSON.stringify(firstRevision)}\n${JSON.stringify(latestRevision)}\n`
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const index = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'search.json'), 'utf8')
    ) as {
      items: Array<{ kind: string; id: string; title: string; searchText: string }>;
    };
    const indexedRevisions = index.items.filter(
      (item) => item.kind === 'item' && item.id === firstRevision.id
    );

    expect(indexedRevisions).toHaveLength(1);
    expect(indexedRevisions[0]).toMatchObject({
      title: latestRevision.text,
      searchText: latestRevision.text,
    });
    expect(indexedRevisions[0]?.searchText).not.toContain(firstRevision.text);
  });

  it('repairs an incomplete final item fragment before rebuilding the index', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const thread = store.createThread('ws_demo', 'Interrupted revision thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Keep the complete revision');
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const item = store.createItem({
      id: 'it_interrupted_index_rebuild',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Complete revision remains searchable.',
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const itemsPath = join(workspaceRoot, 'threads', thread.id, 'turns', turn.id, 'items.jsonl');
    const completeLog = readFileSync(itemsPath, 'utf8');

    appendFileSync(itemsPath, '{"id":"interrupted');
    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const index = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'search.json'), 'utf8')
    ) as { items: Array<{ kind: string; id: string; searchText: string }> };

    expect(readFileSync(itemsPath, 'utf8')).toBe(completeLog);
    expect(index.items).toContainEqual(
      expect.objectContaining({ kind: 'item', id: item.id, searchText: item.text })
    );
  });

  it('indexes only the artifact content file selected by metadata format', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const artifact = store.createArtifact({
      id: 'ar_exact_content_file',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'summary',
      title: 'Exact content file artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: 'Canonical text content.' },
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
    });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const artifactRoot = join(workspaceRoot, 'artifacts', artifact.id);

    writeFileSync(join(artifactRoot, 'files', 'content.md'), 'Stale Markdown content.');
    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const index = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'search.json'), 'utf8')
    ) as { items: Array<{ kind: string; id: string; searchText: string }> };
    const indexed = index.items.find(
      (entry) => entry.kind === 'artifact' && entry.id === artifact.id
    );

    expect(indexed?.searchText).toContain(artifact.content.body);
    expect(indexed?.searchText).not.toContain('Stale Markdown content.');
  });

  it('repairs an incomplete retrieval-trace tail before appending', () => {
    const dataRoot = createDataRoot();
    const workspace = new FsStore({ dataRoot }).createWorkspace('Retrieval trace recovery');
    const tracePath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'knowledge',
      'traces',
      '202607.jsonl'
    );
    const input = {
      dataRoot,
      userId: 'user_local',
      workspaceId: workspace.id,
      query: 'canonical recovery',
      now: () => '2026-07-12T00:00:00.000Z',
    };

    retrieveWorkspaceKnowledge({ ...input, traceId: 'krt_first' });
    appendFileSync(tracePath, '{"traceId":"interrupted');
    retrieveWorkspaceKnowledge({ ...input, traceId: 'krt_second' });

    const rows = readFileSync(tracePath, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => JSON.parse(row))).toHaveLength(2);
  });

  it('rejects a symlinked retrieval-trace ledger without writing outside', () => {
    const dataRoot = createDataRoot();
    const workspace = new FsStore({ dataRoot }).createWorkspace('Retrieval trace symlink');
    const tracePath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'knowledge',
      'traces',
      '202607.jsonl'
    );
    const outsideRoot = mkdtempSync(join(tmpdir(), 'openkit-index-trace-outside-'));
    const outsidePath = join(outsideRoot, 'sentinel.jsonl');
    const input = {
      dataRoot,
      userId: 'user_local',
      workspaceId: workspace.id,
      query: 'canonical symlink',
      now: () => '2026-07-12T00:00:00.000Z',
    };

    retrieveWorkspaceKnowledge({ ...input, traceId: 'krt_before_link' });
    rmSync(tracePath);
    writeFileSync(outsidePath, 'untouched\n');
    symlinkSync(outsidePath, tracePath);

    expect(() => retrieveWorkspaceKnowledge({ ...input, traceId: 'krt_after_link' })).toThrow();
    expect(readFileSync(outsidePath, 'utf8')).toBe('untouched\n');
  });

  it.each([
    'embedded body',
    'invalid format',
  ] as const)('rejects artifact metadata with an %s', (violation) => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const artifact = store.createArtifact({
      id: `ar_invalid_metadata_${violation.replace(' ', '_')}`,
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'summary',
      title: 'Invalid artifact metadata',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: 'Canonical artifact content.' },
      createdAt: '2026-07-07T00:00:00.000Z',
      updatedAt: '2026-07-07T00:00:00.000Z',
    });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const metadataPath = join(workspaceRoot, 'artifacts', artifact.id, 'artifact.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;

    metadata.content =
      violation === 'embedded body'
        ? { format: 'text', body: 'Duplicate embedded body.' }
        : { format: 'binary' };
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    expect(() =>
      rebuildWorkspaceDerivedIndexes({
        dataRoot,
        userId: 'user_local',
        workspaceId: 'ws_demo',
      })
    ).toThrow(/artifact|content/i);
  });

  it('fails closed when the workspace projection is missing', () => {
    const dataRoot = createDataRoot();

    expect(() =>
      rebuildWorkspaceDerivedIndexes({ dataRoot, userId: 'user_local', workspaceId: 'missing' })
    ).toThrow(
      'Workspace projection is missing: users/user_local/workspaces/missing/workspace.json'
    );
  });

  it('rejects a symlinked canonical subtree instead of reading external content', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const pagesRoot = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'knowledge',
      'pages'
    );
    const outsidePagesRoot = mkdtempSync(join(tmpdir(), 'openkit-outside-pages-'));

    writeFileSync(join(outsidePagesRoot, 'outside.md'), 'External content must not be indexed.\n');
    rmSync(pagesRoot, { recursive: true });
    symlinkSync(outsidePagesRoot, pagesRoot, 'dir');

    expect(() =>
      rebuildWorkspaceDerivedIndexes({
        dataRoot,
        userId: 'user_local',
        workspaceId: 'ws_demo',
      })
    ).toThrow();
  });

  it('rejects a symlinked indexes directory without deleting its external target', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const indexesRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'indexes');
    const outsideIndexesRoot = mkdtempSync(join(tmpdir(), 'openkit-outside-indexes-'));
    const sentinelPath = join(outsideIndexesRoot, 'sentinel.txt');

    writeFileSync(sentinelPath, 'outside sentinel\n');
    rmSync(indexesRoot, { recursive: true });
    symlinkSync(outsideIndexesRoot, indexesRoot, 'dir');

    let failure: unknown = null;
    try {
      rebuildWorkspaceDerivedIndexes({
        dataRoot,
        userId: 'user_local',
        workspaceId: 'ws_demo',
      });
    } catch (error) {
      failure = error;
    }

    expect({
      rejected: failure instanceof Error,
      sentinel: existsSync(sentinelPath) ? readFileSync(sentinelPath, 'utf8') : null,
    }).toEqual({ rejected: true, sentinel: 'outside sentinel\n' });
  });

  it('rebuilds knowledge search entries from file-backed pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'File-backed knowledge',
      content: 'Searchable knowledge page body.',
    });

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    expect(
      JSON.parse(
        readFileSync(
          join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'indexes', 'search.json'),
          'utf8'
        )
      )
    ).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'knowledge',
          id: knowledge.id,
          title: 'File-backed knowledge',
          searchText: expect.stringContaining('Searchable knowledge page body.'),
        }),
      ]),
    });
  });

  it('rebuilds a knowledge full-text term index from active file-backed pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';

    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Seed knowledge',
      content: 'Seed body.',
    });
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'release.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Release Cadence"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Weekly release cadence keeps Friday review predictable.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'blocked.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Blocked Cadence"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["source:ks_missing"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This blocked cadence text must not enter the FTS index.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const fullText = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-fts.json'), 'utf8')
    ) as {
      schemaVersion: number;
      workspaceId: string;
      tokenizer: string;
      terms: Array<{
        term: string;
        postings: Array<{ conceptId: string; fields: string[]; occurrences: number }>;
      }>;
    };

    expect(fullText).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      tokenizer: 'unicode-simple-v1',
      terms: expect.arrayContaining([
        {
          term: 'cadence',
          postings: [
            {
              conceptId: 'release',
              fields: ['body', 'title'],
              occurrences: 2,
            },
          ],
        },
        {
          term: 'weekly',
          postings: [
            {
              conceptId: 'release',
              fields: ['body'],
              occurrences: 1,
            },
          ],
        },
      ]),
    });
    expect(JSON.stringify(fullText)).not.toContain('blocked');
  });

  it('does not rebuild invalid active knowledge pages into search entries', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Valid knowledge',
      content: 'Searchable valid body.',
    });
    writeFileSync(
      join(
        dataRoot,
        'users',
        'user_local',
        'workspaces',
        'ws_demo',
        'knowledge',
        'pages',
        'invalid.md'
      ),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Invalid knowledge"',
        'schema_version: "openkit-knowledge-entry-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        '---',
        'This invalid active body should not be indexed.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const index = JSON.parse(
      readFileSync(
        join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'indexes', 'search.json'),
        'utf8'
      )
    ) as { items: Array<{ title: string; searchText: string }> };

    expect(index.items.map((item) => item.title)).toContain('Valid knowledge');
    expect(index.items.map((item) => item.title)).not.toContain('Invalid knowledge');
    expect(index.items.map((item) => item.searchText).join('\n')).not.toContain(
      'This invalid active body should not be indexed.'
    );
  });

  it('rebuilds validation reports for file-backed knowledge pages', () => {
    const dataRoot = createDataRoot();
    createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';

    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'valid.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Valid knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Valid body.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-field.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing field knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        '---',
        'Invalid body.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-source.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing source knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["source:ks_missing"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Missing source body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    expect(
      JSON.parse(readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8'))
    ).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      records: expect.arrayContaining([
        expect.objectContaining({
          conceptId: 'valid',
          conformance: 'Workspace-schema-valid',
          indexed: true,
          errors: [],
        }),
        expect.objectContaining({
          conceptId: 'missing-field',
          conformance: 'OKF-compatible',
          indexed: false,
          errors: expect.arrayContaining([
            expect.objectContaining({
              code: 'profile.missing_required_field',
              field: 'updated_at',
            }),
          ]),
        }),
        expect.objectContaining({
          conceptId: 'missing-source',
          conformance: 'Workspace-schema-valid',
          indexed: false,
          errors: expect.arrayContaining([
            expect.objectContaining({
              code: 'reference.unresolved_source',
              field: 'source_refs',
            }),
          ]),
        }),
      ]),
    });
  });

  it('uses the workspace schema when rebuilding extension knowledge pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Seed knowledge',
      content: 'Seed body.',
    });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'schema', 'workspace-schema.yaml'),
      [
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'allowed_types: ["KnowledgePage", "RepoConvention"]',
        'allowed_statuses: ["active"]',
        'allowed_review_states: ["accepted"]',
        'allowed_sensitivities: ["normal"]',
        'allowed_freshness: ["current"]',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'repo.md'),
      [
        '---',
        'type: "RepoConvention"',
        'title: "Repo convention"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'created_at: "2026-07-07T00:00:00.000Z"',
        'updated_at: "2026-07-07T00:00:00.000Z"',
        '---',
        'Extension schema body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const index = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'search.json'), 'utf8')
    ) as { items: Array<{ title: string; searchText: string }> };

    expect(index.items.map((item) => item.title)).toContain('Repo convention');
    expect(index.items.map((item) => item.searchText).join('\n')).toContain(
      'Extension schema body.'
    );
  });

  it('does not rebuild knowledge pages when the workspace schema is invalid', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Schema blocked knowledge',
      content: 'This body should not be indexed.',
    });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'schema', 'workspace-schema.yaml'),
      'schema_version: "openkit-workspace-knowledge-schema-v1"\n'
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const index = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'search.json'), 'utf8')
    ) as { items: Array<{ title: string; searchText: string }> };

    expect(index.items.map((item) => item.title)).not.toContain('Schema blocked knowledge');
    expect(index.items.map((item) => item.searchText).join('\n')).not.toContain(
      'This body should not be indexed.'
    );
  });

  it('requires active knowledge page source references to resolve to registered records', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Registered knowledge',
      content: 'Registered knowledge body.',
    });

    store.createKnowledgeSource({
      id: 'ks_registered',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Registered source',
      uri: null,
      contentDigest: 'sha256:registered',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'source-backed.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Source-backed knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["source:ks_registered"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This source-backed body should be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'knowledge-backed.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Knowledge-backed knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        `source_refs: ["knowledge:${knowledge.id}"]`,
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This knowledge-backed body should be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-source.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing source knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["source:ks_missing"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This missing-source body should not be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'missing-knowledge.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Missing knowledge source"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["knowledge:kn_missing"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This missing-knowledge body should not be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'external-url.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "External URL knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["https://example.com/source"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This external-url body should be indexed.',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'invalid-external.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Invalid external source"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: ["not-a-valid-external-reference"]',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'This invalid-external body should not be indexed.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const index = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'search.json'), 'utf8')
    ) as { items: Array<{ title: string; searchText: string }> };

    expect(index.items.map((item) => item.title)).toContain('Source-backed knowledge');
    expect(index.items.map((item) => item.title)).toContain('Knowledge-backed knowledge');
    expect(index.items.map((item) => item.title)).toContain('External URL knowledge');
    expect(index.items.map((item) => item.title)).not.toContain('Missing source knowledge');
    expect(index.items.map((item) => item.title)).not.toContain('Missing knowledge source');
    expect(index.items.map((item) => item.title)).not.toContain('Invalid external source');
    expect(index.items.map((item) => item.searchText).join('\n')).not.toContain(
      'This missing-source body should not be indexed.'
    );
    expect(index.items.map((item) => item.searchText).join('\n')).not.toContain(
      'This missing-knowledge body should not be indexed.'
    );
    expect(index.items.map((item) => item.searchText).join('\n')).not.toContain(
      'This invalid-external body should not be indexed.'
    );

    expect(
      JSON.parse(readFileSync(join(workspaceRoot, 'indexes', 'knowledge-validation.json'), 'utf8'))
    ).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          conceptId: 'invalid-external',
          indexed: false,
          errors: expect.arrayContaining([
            expect.objectContaining({
              code: 'reference.invalid_external',
              field: 'source_refs',
            }),
          ]),
        }),
      ]),
    });
  });

  it('rebuilds the knowledge source-reference index from file-backed pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';
    const knowledge = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Registered knowledge',
      content: 'Registered knowledge body.',
    });

    store.createKnowledgeSource({
      id: 'ks_registered',
      workspaceId: 'ws_demo',
      kind: 'document',
      title: 'Registered source',
      uri: null,
      contentDigest: 'sha256:registered',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'source-reference-index.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Source reference index"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        `source_refs: ["source:ks_registered", "knowledge:${knowledge.id}", "source:ks_missing", "knowledge:kn_missing", "https://example.com/source", "not-a-valid-external-reference"]`,
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Source reference body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const sourceReferenceIndex = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-source-refs.json'), 'utf8')
    ) as {
      schemaVersion: number;
      workspaceId: string;
      references: Array<{
        conceptId: string;
        path: string;
        reference: string;
        kind: string;
        targetId: string | null;
        resolved: boolean;
      }>;
    };

    expect(sourceReferenceIndex).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      references: expect.arrayContaining([
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'source:ks_registered',
          kind: 'registered-source',
          targetId: 'ks_registered',
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: `knowledge:${knowledge.id}`,
          kind: 'workspace-knowledge',
          targetId: knowledge.id,
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'source:ks_missing',
          kind: 'registered-source',
          targetId: 'ks_missing',
          resolved: false,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'knowledge:kn_missing',
          kind: 'workspace-knowledge',
          targetId: 'kn_missing',
          resolved: false,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'https://example.com/source',
          kind: 'external-reference',
          targetId: null,
          resolved: true,
        },
        {
          conceptId: 'source-reference-index',
          path: 'knowledge/pages/source-reference-index.md',
          reference: 'not-a-valid-external-reference',
          kind: 'external-reference',
          targetId: null,
          resolved: false,
        },
      ]),
    });
  });

  it('rebuilds the knowledge link graph from active file-backed pages', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
    const timestamp = '2026-07-07T00:00:00.000Z';

    store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Seed knowledge',
      content: 'Seed body.',
    });
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'alpha.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Alpha knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'See [Beta](/beta.md), [Missing](./missing.md), and [External](https://example.com).',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workspaceRoot, 'knowledge', 'pages', 'beta.md'),
      [
        '---',
        'type: "KnowledgePage"',
        'title: "Beta knowledge"',
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `created_at: "${timestamp}"`,
        `updated_at: "${timestamp}"`,
        '---',
        'Beta body.',
        '',
      ].join('\n')
    );

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    const graph = JSON.parse(
      readFileSync(join(workspaceRoot, 'indexes', 'knowledge-links.json'), 'utf8')
    ) as {
      schemaVersion: number;
      workspaceId: string;
      edges: Array<{ fromId: string; target: string; toId: string; resolved: boolean }>;
    };

    expect(graph).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'ws_demo',
      edges: expect.arrayContaining([
        {
          fromId: 'alpha',
          target: '/beta.md',
          toId: 'beta',
          resolved: true,
        },
        {
          fromId: 'alpha',
          target: './missing.md',
          toId: 'missing',
          resolved: false,
        },
      ]),
    });
    expect(graph.edges).toHaveLength(2);
  });

  it('rebuilds artifact search entries from file-backed content', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    const artifact = store.createArtifact({
      id: 'ar_file_backed',
      workspaceId: 'ws_demo',
      threadId: null,
      turnId: null,
      kind: 'report',
      title: 'File-backed artifact',
      status: 'ready',
      summary: 'Artifact summary',
      version: 1,
      content: { format: 'markdown', body: 'Artifact body from file.' },
      createdAt: '2026-07-05T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
    });

    rebuildWorkspaceDerivedIndexes({
      dataRoot,
      userId: 'user_local',
      workspaceId: 'ws_demo',
    });

    expect(
      JSON.parse(
        readFileSync(
          join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'indexes', 'search.json'),
          'utf8'
        )
      )
    ).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'artifact',
          id: artifact.id,
          title: 'File-backed artifact',
          searchText: expect.stringContaining('Artifact body from file.'),
        }),
      ]),
    });
  });

  it('rebuilds existing workspace indexes during boot scan', () => {
    const dataRoot = createDataRoot();
    const store = createDemoStore({ dataRoot });
    store.createThread('ws_demo', 'Boot rebuild thread');
    const indexesRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo', 'indexes');
    mkdirSync(indexesRoot, { recursive: true });
    writeFileSync(join(indexesRoot, 'stale.json'), '{}');

    const results = rebuildExistingWorkspaceDerivedIndexes(dataRoot, {
      now: () => '2026-07-05T00:00:00.000Z',
    });

    expect(results).toEqual(
      expect.arrayContaining([
        {
          workspaceId: 'ws_demo',
          indexPath: 'users/user_local/workspaces/ws_demo/indexes/search.json',
          itemCount: 4,
          removedEntries: ['stale.json'],
        },
      ])
    );
    expect(existsSync(join(indexesRoot, 'stale.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(indexesRoot, 'search.json'), 'utf8'))).toMatchObject({
      rebuiltAt: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws_demo',
    });
  });

  it('skips workspace directories without a canonical projection during boot scan', () => {
    const dataRoot = createDataRoot();
    mkdirSync(join(dataRoot, 'users', 'user_local', 'workspaces', 'half-built', 'indexes'), {
      recursive: true,
    });

    expect(rebuildExistingWorkspaceDerivedIndexes(dataRoot)).toEqual([]);
  });
});
