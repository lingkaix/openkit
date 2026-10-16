import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeNotebook, type NotebookCommitMetadata } from './notebook.js';
import {
  importPortableNotebookTree,
  readPortableNotebookTree,
  verifyNotebookPageProof,
} from './notebook-portability.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  parseOkfDocument,
} from './okf.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const sourceScope = { kind: 'workspace' as const, workspaceId: 'ws_source' };
const targetScope = { kind: 'workspace' as const, workspaceId: 'ws_target' };
const sourceId = 'ks_123e4567-e89b-42d3-a456-426614174000';
const targetId = 'ks_123e4567-e89b-42d3-a456-426614174001';
const pin = `sha256:${'0'.repeat(64)}`;
const sourceReference = `source:${sourceId}@${pin}`;
const targetReference = `source:${targetId}@${pin}`;
const index = '---\nokf_version: "0.2"\n---\n# Human navigation\n\n[Entry](entry.md)\n';
const log = '# Human log\n\n## 2026-10-16\n* Exact retained note.\n';
const body =
  'Human body with a source id left as prose: ks_123e4567-e89b-42d3-a456-426614174000.\r\n\t  ';
/** Independent byte oracle; do not reuse the production proof builder. */
function digest(content: string) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
/** Fresh target command evidence is independent of the archived source commit. */
function metadata(requestId: string, sourceReferences: string[] = []): NotebookCommitMetadata {
  return {
    summary: 'Explicit target import',
    changeRequest: { requestId, inputDigest: pin },
    producer: { kind: 'user', id: 'user_local' },
    authority: { kind: 'direct', instructionReference: `item:${requestId}` },
    sourceReferences,
  };
}
/** Unknown metadata and exact body bytes must survive reference-only import reminting. */
function page() {
  const fields = {
    type: 'KnowledgePage',
    title: 'Portable',
    schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
    openkit_status: 'active',
    scope: sourceScope,
    requiredFeatures: ['openkit.knowledge-owner-scope.v1', 'openkit.knowledge-git-notebook.v1'],
    source_refs: [sourceReference],
    review_state: 'accepted',
    sensitivity: 'normal',
    freshness: 'current',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    extension: { nested: [{ note: 'original annotation', count: 3 }] },
  };
  return `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')}\n---\n${body}`;
}
/** Each case owns separate real source and initially absent target repositories. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-notebook-portability-'));
  roots.push(root);
  const sourcePath = join(root, 'source', 'notebook.git');
  const notebook = new KnowledgeNotebook({ repositoryPath: sourcePath });
  const sourceRevision = notebook.initialize({
    files: { 'index.md': index, 'log.md': log, 'entry.md': page() },
    metadata: metadata('source', [sourceReference]),
  });
  const targetPath = join(root, 'target', 'notebook.git');
  const target = new KnowledgeNotebook({ repositoryPath: targetPath });
  const input = {
    ...readPortableNotebookTree({ notebook }),
    notebook: target,
    sourceOwnerScope: sourceScope,
    targetOwnerScope: targetScope,
    rewriteSourceReferences: (references: readonly string[]) =>
      references.map((reference) => reference.replace(sourceId, targetId)),
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    registeredSources: new Map([[targetId, pin]]),
    resolvedReferences: new Map<string, ReadonlySet<string>>(),
    metadata: metadata('target', [targetReference]),
  };
  return { root, sourcePath, source: notebook, sourceRevision, target, targetPath, input };
}

describe('Notebook ordinary archive remint', () => {
  it('checks original bytes, remints scope/references, then creates one new target commit', () => {
    const state = fixture();
    const imported = importPortableNotebookTree(state.input);
    expect(imported.sourceRevision).toBe(state.sourceRevision);
    expect(imported.revision).not.toBe(state.sourceRevision);
    const reopened = new KnowledgeNotebook({ repositoryPath: state.targetPath });
    const current = reopened.readRevision(reopened.publishedRevision());
    expect(current.parentRevision).toBeNull();
    expect(current.metadata).toEqual(state.input.metadata);
    expect(reopened.history().revisions).toHaveLength(1);
    expect(current.files['index.md']).toBe(index);
    expect(current.files['log.md']).toBe(log);
    const parsed = parseOkfDocument({ path: 'entry.md', content: current.files['entry.md']! });
    expect(parsed.ok).toBe(true);
    expect(parsed.document?.body).toBe(body);
    expect(parsed.document?.frontmatter).toMatchObject({
      scope: targetScope,
      source_refs: [targetReference],
      review_state: 'accepted',
      extension: { nested: [{ note: 'original annotation', count: 3 }] },
    });
    expect(imported.pageProofs.get('entry')).toEqual({
      revision: imported.revision,
      contentDigest: digest(current.files['entry.md']!),
    });
    expect(state.input.pageProofs.get('entry')?.contentDigest).not.toBe(
      imported.pageProofs.get('entry')?.contentDigest
    );
    expect(state.source.readRevision(state.sourceRevision).files['entry.md']).toBe(page());
  });

  it('does not import retained Proposal refs, source decisions or source command metadata', () => {
    const state = fixture();
    const proposalId = `kp_${'4'.repeat(64)}`;
    const proposal = state.source.prepare({
      baseRevision: state.sourceRevision,
      changes: { 'private.md': page() },
      metadata: { ...metadata('source-proposal'), authority: { kind: 'proposal', proposalId } },
    });
    state.source.retainCandidate({ proposalId, candidateRevision: proposal });
    mkdirSync(join(state.root, 'source', 'reviews'));
    writeFileSync(
      join(state.root, 'source', 'reviews', `${proposalId}.json`),
      '{"historical":"review decision canary"}'
    );
    const exported = readPortableNotebookTree({ notebook: state.source });
    expect([...exported.nativeKnowledgePages.keys()].sort()).toEqual([
      'knowledge/pages/entry.md',
      'knowledge/pages/index.md',
      'knowledge/pages/log.md',
    ]);
    expect('metadata' in exported).toBe(false);
    const imported = importPortableNotebookTree({ ...state.input, ...exported });
    expect(state.target.readRevision(imported.revision).metadata.authority).toEqual(
      state.input.metadata.authority
    );
    expect(() => state.target.inspectRevision(proposal)).toThrow();
    expect(existsSync(join(state.root, 'target', 'reviews'))).toBe(false);
    expect(existsSync(join(state.targetPath, 'refs', 'proposals'))).toBe(false);
    expect(
      readFileSync(join(state.root, 'source', 'reviews', `${proposalId}.json`), 'utf8')
    ).toContain('review decision canary');
  });

  it.each([
    'digest',
    'revision',
    'missing-proof',
    'extra-proof',
    'bad-prefix',
    'body-corruption',
  ] as const)('rejects %s before initializing a target', (fault) => {
    const state = fixture();
    const pageProofs = new Map(state.input.pageProofs);
    const nativeKnowledgePages = new Map(state.input.nativeKnowledgePages);
    if (fault === 'digest')
      pageProofs.set('entry', { revision: state.sourceRevision, contentDigest: pin });
    if (fault === 'revision')
      pageProofs.set('entry', { revision: 'a'.repeat(40), contentDigest: digest(page()) });
    if (fault === 'missing-proof') pageProofs.delete('entry');
    if (fault === 'extra-proof') pageProofs.set('other', pageProofs.get('entry')!);
    if (fault === 'bad-prefix') {
      nativeKnowledgePages.delete('knowledge/pages/entry.md');
      nativeKnowledgePages.set('knowledge/notebook.git/config', page());
    }
    if (fault === 'body-corruption')
      nativeKnowledgePages.set('knowledge/pages/entry.md', `${page()}changed`);
    expect(() =>
      importPortableNotebookTree({ ...state.input, nativeKnowledgePages, pageProofs })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(existsSync(state.targetPath)).toBe(false);
  });

  it('rejects foreign source ownership and missing target sources without creating Git state', () => {
    const state = fixture();
    expect(() =>
      importPortableNotebookTree({ ...state.input, sourceOwnerScope: targetScope })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      importPortableNotebookTree({ ...state.input, registeredSources: new Map() })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      importPortableNotebookTree({ ...state.input, metadata: metadata('target-wrong') })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(existsSync(state.targetPath)).toBe(false);
  });

  it('refuses an existing target and preserves its exact published revision', () => {
    const state = fixture();
    const first = importPortableNotebookTree(state.input);
    expect(() => importPortableNotebookTree(state.input)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(state.target.publishedRevision()).toBe(first.revision);
  });
});

describe('Exact Git page proof', () => {
  it('refuses corrupt source Git objects instead of exporting new hashes under an old commit', () => {
    const state = fixture();
    const blob = execFileSync(
      'git',
      ['--git-dir', state.sourcePath, 'rev-parse', `${state.sourceRevision}:pages/entry.md`],
      { encoding: 'utf8' }
    ).trim();
    const objectPath = join(state.sourcePath, 'objects', blob.slice(0, 2), blob.slice(2));
    chmodSync(objectPath, 0o600);
    const corrupt = Buffer.from(`${page()}corrupt`);
    writeFileSync(
      objectPath,
      deflateSync(Buffer.concat([Buffer.from(`blob ${corrupt.length}\0`), corrupt]))
    );
    expect(() => readPortableNotebookTree({ notebook: state.source })).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(() =>
      verifyNotebookPageProof({
        notebook: state.source,
        revision: state.sourceRevision,
        pageId: 'entry',
        contentDigest: digest(page()),
      })
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(existsSync(state.targetPath)).toBe(false);
  });

  it('checks the historical commit/path/digest, not the current page or materialization', () => {
    const state = fixture();
    const next = state.source.prepare({
      baseRevision: state.sourceRevision,
      changes: { 'entry.md': `${page()}later` },
      metadata: metadata('later', [sourceReference]),
    });
    state.source.publish({ baseRevision: state.sourceRevision, candidateRevision: next });
    expect(
      verifyNotebookPageProof({
        notebook: state.source,
        revision: state.sourceRevision,
        pageId: 'entry',
        contentDigest: digest(page()),
      })
    ).toBe(page());
    expect(() =>
      verifyNotebookPageProof({
        notebook: state.source,
        revision: next,
        pageId: 'entry',
        contentDigest: digest(page()),
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    const exported = readPortableNotebookTree({ notebook: state.source });
    expect(exported.sourceRevision).toBe(next);
    expect(exported.nativeKnowledgePages.get('knowledge/pages/entry.md')).toBe(`${page()}later`);
  });

  it('does not turn an unpublished candidate or archive commit claim into history authority', () => {
    const state = fixture();
    const candidate = state.source.prepare({
      baseRevision: state.sourceRevision,
      changes: { 'entry.md': `${page()}unpublished` },
      metadata: metadata('candidate', [sourceReference]),
    });
    expect(() =>
      verifyNotebookPageProof({
        notebook: state.source,
        revision: candidate,
        pageId: 'entry',
        contentDigest: digest(`${page()}unpublished`),
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() =>
      verifyNotebookPageProof({
        notebook: state.target,
        revision: state.sourceRevision,
        pageId: 'entry',
        contentDigest: digest(page()),
      })
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });
});
