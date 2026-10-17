import { describe, expect, it } from 'vitest';
import type { NotebookRevision } from './notebook.js';
import { validateNotebookCandidate } from './notebook-validation.js';

const ownerScope = {
  kind: 'workspace',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
} as const;
const schema =
  'schema_version: openkit-scope-knowledge-schema-v4\nstatus: active\nallowed_types: [KnowledgePage]\nallowed_statuses: [active, archived]\nallowed_review_states: [user-authored]\nallowed_sensitivities: [normal]\nallowed_freshness: [current]\n';

/** Exact proposed bytes remain caller-owned; validation must not rewrite them. */
function page(id: string, body = 'A stable note.', extra = ''): string {
  return `---
type: KnowledgePage
title: ${id}
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: ${JSON.stringify(ownerScope)}
source_refs: []
review_state: user-authored
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
${extra}---
${body}
`;
}

/** The content reader proves immutable Git integrity separately; this seam validates final page relationships. */
function revision(files: Record<string, string>): NotebookRevision {
  return {
    revision: 'a'.repeat(40),
    parentRevision: null,
    files: { 'index.md': '---\nokf_version: "0.2"\n---\n# Notebook\n', ...files },
    metadata: {
      summary: 'Validation fixture',
      changeRequest: { requestId: 'validation-fixture', inputDigest: `sha256:${'1'.repeat(64)}` },
      producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      authority: { kind: 'direct', instructionReference: 'request:validation-fixture' },
      sourceReferences: [],
    },
  };
}

/** No fixture map can stand in for current Source or admission proof in the eventual publisher. */
function validate(base: Record<string, string>, candidate: Record<string, string>) {
  return validateNotebookCandidate({
    ownerScope,
    base: revision(base),
    candidate: revision(candidate),
    scopeSchemaText: schema,
    registeredSources: new Map(),
    resolvedReferences: new Map(),
  });
}

describe('Notebook final immutable tree validation', () => {
  it('refuses a root-index edit that removes the required OKF version', () => {
    expect(validate({}, { 'index.md': '# Unversioned root\n' }).errors).toContainEqual({
      pageId: 'index',
      code: 'notebook.invalid_document',
    });
  });

  it('resolves joint multi-file edits and relative/reference Markdown links in the complete tree', () => {
    const a = page('group/a', '[Neighbor](../b.md#heading) and [reference][b].\n\n[b]: /b.md');
    const b = page('b', '[Back](/group/a.md)', 'custom: {preserve: [one, two]}\n');
    const proposed = { 'group/a.md': a, 'b.md': b };
    expect(validate({}, proposed)).toMatchObject({
      changedPaths: ['b.md', 'group/a.md'],
      removedPaths: [],
      sourceReferences: [],
      errors: [],
    });
    expect(proposed).toEqual({ 'group/a.md': a, 'b.md': b });
  });

  it('rejects removed targets referenced by an unchanged page', () => {
    const referrer = page('a', '[Keep the target](/b.md)');
    expect(validate({ 'a.md': referrer, 'b.md': page('b') }, { 'a.md': referrer })).toMatchObject({
      changedPaths: ['b.md'],
      removedPaths: ['b.md'],
      errors: [{ pageId: 'a', code: 'notebook.unresolved_page_link' }],
    });
  });

  it('permits joint repair and ignores code examples and pre-existing broken links on untouched pages', () => {
    const unchanged = page('a', '[Future note](/future.md)');
    const repaired = page('c', '`[example](/b.md)`\n\n```md\n[example](/b.md)\n```');
    expect(
      validate(
        { 'a.md': unchanged, 'b.md': page('b'), 'c.md': page('c', '[Old](/b.md)') },
        { 'a.md': unchanged, 'c.md': repaired }
      ).errors
    ).toEqual([]);
  });

  it('rejects local Markdown escapes and identity aliases on changed pages', () => {
    expect(
      validate({}, { 'a.md': page('a', '[Escape](../../outside.md)', 'openkit_entry_id: alias\n') })
        .errors
    ).toEqual(
      expect.arrayContaining([
        { pageId: 'a', code: 'notebook.page_identity_mismatch' },
        { pageId: 'a', code: 'notebook.unresolved_page_link' },
      ])
    );
  });

  it('rejects a foreign declared scope before it can become a publication input', () => {
    const foreign = page('a').replace(JSON.stringify(ownerScope), '{kind: server}');
    expect(validate({}, { 'a.md': foreign }).errors).toContainEqual({
      pageId: 'a',
      code: 'notebook.invalid_page',
    });
  });

  it('caps diagnostics without admitting a partially validated candidate', () => {
    const proposed = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => {
        const id = `page-${index}`;
        return [`${id}.md`, page(id, '[Missing](/missing.md)')];
      })
    );
    const result = validate({}, proposed);
    expect(result.errors).toHaveLength(100);
    expect(result.diagnosticsTruncated).toBe(true);
  });
});
