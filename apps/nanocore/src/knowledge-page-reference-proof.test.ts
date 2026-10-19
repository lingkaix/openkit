import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatReferenceUri, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { readWorkspaceNotebookAdmission } from './knowledge/notebook-workspace-admission.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './knowledge/okf.js';
import { resolveWorkspaceKnowledgeReferenceProofs } from './knowledge-source-authority.js';
import type { FsStore } from './lib/store.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const userId = 'usr_00000000-0000-7000-8000-000000000001';
const knowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';
const pageScopeId = `page/workspace/${workspaceId}/${knowledgeBaseId}`;
const targetId = 'group/note';
const roots: string[] = [];

/** Exact fixture bytes are stored in real immutable Git objects. */
function page(references: readonly string[] = [], body = 'Selected page bytes.'): string {
  return `---\ntype: KnowledgePage\nsensitivity: normal\nsource_refs: ${JSON.stringify(references)}\n---\n${body}\n`;
}

/** Independent digest oracle for the bytes used in the citation. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Existing product handles supply no page proof; the real Notebook owns content and history. */
async function fixture(references: readonly string[]) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-page-reference-'));
  roots.push(dataRoot);
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const configPath = join(workspaceRoot, 'config', 'workspace.jsonc');
  mkdirSync(join(workspaceRoot, 'config'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      writeRetainedV1({ workspace: { name: 'Research', defaultKnowledgeBaseId: knowledgeBaseId } })
    )
  );
  mkdirSync(join(workspaceRoot, 'knowledge', 'schema'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml'),
    DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT
  );
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
  });
  const metadata = {
    summary: 'Page reference fixture',
    changeRequest: { requestId: 'fixture', inputDigest: `sha256:${'1'.repeat(64)}` },
    producer: { kind: 'user' as const, id: userId },
    authority: { kind: 'direct' as const, instructionReference: 'test:page-reference' },
    sourceReferences: [],
  };
  const revision = await notebook.initialize({
    metadata,
    files: {
      'index.md': '---\nokf_version: "0.2"\n---\n# Notebook\n',
      'a.md': page(references),
      [`${targetId}.md`]: page(),
    },
  });
  const store = {
    getDataRoot: () => dataRoot,
    getWorkspace: () => ({ kind: 'shared' }),
    listKnowledgeSources: () => [],
  } as unknown as FsStore;
  const proofs = (selected = revision) =>
    resolveWorkspaceKnowledgeReferenceProofs({
      coreDb: undefined,
      workspaceDb: undefined,
      store,
      workspaceId,
      notebookRevision: selected,
      pageIds: ['a'],
    });
  const admit = (changes = [{ path: 'a.md', content: page(references) }]) =>
    readWorkspaceNotebookAdmission({
      store,
      coreDb: { dataRoot } as Parameters<typeof readWorkspaceNotebookAdmission>[0]['coreDb'],
      workspaceDb: {} as Parameters<typeof readWorkspaceNotebookAdmission>[0]['workspaceDb'],
      currentAuthority: () => {},
      actor: { kind: 'user', id: userId },
      runtimeConfigManager: { current: () => ({ workspaceConfigs: [] }) } as unknown as Parameters<
        typeof readWorkspaceNotebookAdmission
      >[0]['runtimeConfigManager'],
      workspaceMutationAdmission: { isClosed: () => false } as unknown as Parameters<
        typeof readWorkspaceNotebookAdmission
      >[0]['workspaceMutationAdmission'],
      notebook,
      request: {
        workspaceId,
        requestId: 'fixture',
        baseRevision: revision,
        changes,
        summary: 'Reference edit',
      },
    });
  return { proofs, admit, notebook, revision, configPath, metadata };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Workspace canonical page source proof', () => {
  it.each([
    undefined,
    digest(page()),
  ])('uses the exact retained owner and base with pin %s', async (contentDigest) => {
    const reference = formatReferenceUri(
      { scopeId: pageScopeId, objectId: targetId },
      contentDigest
    );
    const { proofs, admit } = await fixture([reference]);
    expect(proofs().get('a')?.sourceReferences).toEqual([reference]);
    expect(proofs().get('a')?.resolvedReferences.has(reference)).toBe(true);
    expect(admit()).toMatchObject({
      pageScopeId,
      resolvedReferences: new Map([
        ['a', new Set([reference])],
        [targetId, new Set()],
      ]),
    });
  });

  it.each([
    formatReferenceUri({
      scopeId: `page/workspace/ws_00000000-0000-7000-8000-000000000002/${knowledgeBaseId}`,
      objectId: targetId,
    }),
    formatReferenceUri({
      scopeId: pageScopeId.replace(knowledgeBaseId, 'kb_00000000-0000-7000-8000-000000000002'),
      objectId: targetId,
    }),
    formatReferenceUri({ scopeId: pageScopeId, objectId: targetId }, `sha256:${'0'.repeat(64)}`),
    `${formatReferenceUri({ scopeId: pageScopeId, objectId: targetId })}@sha256:bad`,
    `knowledge:${targetId}`,
  ])('withholds proof and admission for %s', async (reference) => {
    const { proofs, admit } = await fixture([reference]);
    expect(proofs().has('a')).toBe(false);
    expect(admit).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('pins the selected historical bytes and checks changed target bytes during admission', async () => {
    const reference = formatReferenceUri(
      { scopeId: pageScopeId, objectId: targetId },
      digest(page())
    );
    const { proofs, admit, notebook, revision, metadata } = await fixture([reference]);
    const changed = page([], 'New target bytes.');
    expect(() =>
      admit([
        { path: 'a.md', content: page([reference]) },
        { path: `${targetId}.md`, content: changed },
      ])
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    const candidate = await notebook.prepare({
      baseRevision: revision,
      metadata: { ...metadata, changeRequest: { ...metadata.changeRequest, requestId: 'edit' } },
      changes: { [`${targetId}.md`]: changed },
    });
    notebook.publish({ baseRevision: revision, candidateRevision: candidate });
    expect(proofs(revision).has('a')).toBe(true);
    expect(proofs(candidate).has('a')).toBe(false);
  });

  it('fails closed without allocating when the retained base binding is missing', async () => {
    const { proofs, admit, configPath } = await fixture([]);
    const source = '{"schemaVersion":1,"workspace":{"name":"Research"}}';
    writeFileSync(configPath, source);
    expect(proofs).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(admit).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(readFileSync(configPath, 'utf8')).toBe(source);
  });
});
