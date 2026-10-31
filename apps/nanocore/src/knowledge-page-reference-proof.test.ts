import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { formatReferenceUri } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  createPageReferenceFixture as fixture,
  referencePage as page,
} from './test-support/knowledge-page-reference.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const knowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';
const pageScopeId = `page/workspace/${workspaceId}/${knowledgeBaseId}`;
const targetId = 'group/note';

/** Independent digest oracle for the bytes used in the citation. */
function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

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
    const { proofs, admit } = await fixture([reference], true);
    expect(proofs().has('a')).toBe(false);
    expect(admit).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });

  it('pins the selected historical bytes and checks changed target bytes during admission', async () => {
    const reference = formatReferenceUri(
      { scopeId: pageScopeId, objectId: targetId },
      digest(page())
    );
    const { proofs, admit, notebook, revision, metadata, selectCorruptRevision } = await fixture([
      reference,
    ]);
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
    // Inject the changed retained-content fault through the exact existing SQL owner.
    selectCorruptRevision(candidate);
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
