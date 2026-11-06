import { describe, expect, it } from 'vitest';
import type { NotebookRevision } from './notebook.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  updateOkfFrontmatter,
  validateKnowledgePageCandidate,
  validateScopeKnowledgeSchema,
} from './okf.js';

const ownerScope = {
  kind: 'workspace',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
} as const;
const pageScopeId = `page/workspace/${ownerScope.workspaceId}/kb_00000000-0000-7000-8000-000000000001`;
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
    pageScopeId,
    base: revision(base),
    candidate: revision(candidate),
    scopeSchemaText: schema,
    registeredSources: new Map(),
    resolvedReferences: new Map(),
  });
}

describe('Notebook final immutable tree validation', () => {
  it('accepts canonical page references in the exact local base', () => {
    const referrer = page('a').replace(
      'source_refs: []',
      `source_refs: ["openkit:${pageScopeId}/b"]`
    );
    expect(validate({}, { 'a.md': referrer, 'b.md': page('b') }).errors).toEqual([]);
  });

  it('rejects removal of a page named by an unchanged canonical source reference', () => {
    const referrer = page('a').replace(
      'source_refs: []',
      `source_refs: ["openkit:${pageScopeId}/b"]`
    );
    expect(
      validate({ 'a.md': referrer, 'b.md': page('b') }, { 'a.md': referrer }).errors
    ).toContainEqual({ pageId: 'a', code: 'notebook.unresolved_page_reference' });
  });

  it('rejects foreign-base and legacy source references despite a matching local path', () => {
    for (const reference of [
      `openkit:page/workspace/${ownerScope.workspaceId}/kb_00000000-0000-7000-8000-000000000002/b`,
      'knowledge:b',
    ]) {
      const referrer = page('a').replace('source_refs: []', `source_refs: ["${reference}"]`);
      expect(validate({}, { 'a.md': referrer, 'b.md': page('b') }).errors).toContainEqual({
        pageId: 'a',
        code: 'notebook.invalid_page',
      });
    }
  });

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

  it('Final-Tree Validation: identifies every authored bad target per referrer before normalization', () => {
    const first = page(
      'group/a',
      [
        '[First](../missing.md?draft=1#one)',
        '[Second](../missing.md#two)',
        '[Reference][lost]',
        '',
        '[lost]: /notebook/missing.md',
      ].join('\n')
    );
    const second = page('group/b', '[Raw](/sources/original.md)');
    expect(validate({}, { 'group/b.md': second, 'group/a.md': first }).errors).toEqual([
      {
        code: 'notebook.unresolved_page_link',
        pageId: 'group/a',
        target: '../missing.md?draft=1#one',
      },
      { code: 'notebook.unresolved_page_link', pageId: 'group/a', target: '../missing.md#two' },
      { code: 'notebook.unresolved_page_link', pageId: 'group/a', target: '/notebook/missing.md' },
      { code: 'notebook.unresolved_page_link', pageId: 'group/b', target: '/sources/original.md' },
    ]);
  });

  it('Current link rules: resolves decoded relative and root Page paths, not editor or raw-byte paths', () => {
    const referrer = page(
      'group/a',
      [
        '[Relative](../tar%67et.md?draft=1#heading)',
        '[Root](/target.md#heading)',
        '`[Example](/notebook/target.md)`',
        '[External](https://example.test/missing.md)',
      ].join('\n')
    );
    expect(validate({}, { 'group/a.md': referrer, 'target.md': page('target') }).errors).toEqual(
      []
    );
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
        { pageId: 'a', code: 'notebook.unresolved_page_link', target: '../../outside.md' },
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

function registerProcedureOwnedBySkillsTests() {
  const ownerScope = {
    kind: 'workspace',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  } as const;
  const path = 'context.md';

  /** Complete governed bytes exercise publication admission without classifying the body. */
  function page(type: string, fields: Record<string, unknown> = {}): string {
    return [
      '---',
      ...Object.entries({
        type,
        title: 'Reusable context',
        schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA.schemaVersion,
        scope: ownerScope,
        requiredFeatures: ['openkit.knowledge-owner-scope.v1', 'openkit.knowledge-git-notebook.v1'],
        openkit_status: 'active',
        source_refs: [],
        review_state: 'delegated',
        sensitivity: 'normal',
        freshness: 'current',
        created_at: '2026-10-18T00:00:00Z',
        updated_at: '2026-10-18T00:00:00Z',
        ...fields,
      }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
      '---',
      'Descriptive context and a reference to the selected Skill.\n',
    ].join('\n');
  }

  /** Uses the real shared candidate and final-tree publication validators. */
  function validate(content: string, scopeSchemaText = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT) {
    return {
      page: validateKnowledgePageCandidate({
        path,
        content,
        expectedOwnerScope: ownerScope,
        scopeSchemaText,
        registeredSources: new Map(),
        knowledgeIds: new Set(['context']),
      }),
      publication: validateNotebookCandidate({
        ownerScope,
        base: { files: {} },
        candidate: { files: { [path]: content } },
        scopeSchemaText,
        registeredSources: new Map(),
        resolvedReferences: new Map(),
      }),
    };
  }

  describe('Skills own reusable procedures', () => {
    it('excludes Procedure from the governed default schema', () => {
      expect(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA.allowedTypes).not.toContain('Procedure');
      const parsed = parseScopeKnowledgeSchema(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('The default schema must parse.');
      expect(parsed.schema.allowedTypes).not.toContain('Procedure');
    });

    it('refuses Procedure publication with a Skill-owner diagnostic', () => {
      const result = validate(page('Procedure'));
      expect(result.page.errors).toContainEqual(
        expect.objectContaining({
          code: 'scope_schema.procedure_owned_by_skill',
          field: 'type',
          message: expect.stringContaining('Skill'),
        })
      );
      expect(result.publication.errors).toEqual([
        { pageId: 'context', code: 'notebook.invalid_page' },
        { pageId: 'context', code: 'scope_schema.procedure_owned_by_skill' },
        { pageId: 'context', code: 'scope_schema.type_not_allowed' },
      ]);
    });

    it('refuses an authored schema that tries to admit competing Procedure authority', () => {
      const schema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
        /allowed_types: .*/,
        'allowed_types: [Procedure]'
      );
      expect(parseScopeKnowledgeSchema(schema)).toMatchObject({
        ok: false,
        errors: [
          expect.objectContaining({
            code: 'scope_schema.procedure_owned_by_skill',
            field: 'allowed_types',
            message: expect.stringContaining('Skill'),
          }),
        ],
      });
      const result = validate(page('Procedure'), schema);
      expect(result.page.errors).toContainEqual(
        expect.objectContaining({ code: 'scope_schema.procedure_owned_by_skill' })
      );
      expect(result.publication.errors).toEqual([
        { pageId: 'context', code: 'notebook.invalid_page' },
        { pageId: 'context', code: 'scope_schema.procedure_owned_by_skill' },
      ]);
    });

    it('refuses a direct in-memory schema bypass', () => {
      const parsed = parseOkfDocument({ path, content: page('Procedure') });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('The complete external OKF document must parse.');
      expect(
        validateScopeKnowledgeSchema(parsed.document, {
          ...DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
          allowedTypes: ['Procedure'],
        }).errors
      ).toContainEqual(
        expect.objectContaining({ code: 'scope_schema.procedure_owned_by_skill', field: 'type' })
      );
    });

    it('keeps generic external Procedure parsing permissive', () => {
      expect(
        parseOkfDocument({ path, content: '---\ntype: Procedure\n---\nExternal procedure.\n' })
      ).toMatchObject({ ok: true, document: { frontmatter: { type: 'Procedure' } } });
    });

    it('preserves descriptive Topic context, exact Skill references and extensions through edits', () => {
      const skill = `https://example.test/skills/invoice/${'a'.repeat(40)}/SKILL.md`;
      const extension = { labels: ['regional'], annotation: { retained: true } };
      const content = page('Topic', { source_refs: [skill], extension });
      const edited = updateOkfFrontmatter({ path, content, updates: { title: 'Updated context' } });
      const parsed = parseOkfDocument({ path, content: edited });
      expect(parsed.ok).toBe(true);
      expect(parsed.document?.frontmatter).toMatchObject({ extension, source_refs: [skill] });
      expect(parsed.document?.body).toBe(
        'Descriptive context and a reference to the selected Skill.\n'
      );
      const result = validate(edited);
      expect(result.page).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
      expect(result.publication).toMatchObject({ errors: [], sourceReferences: [skill] });
    });
  });
}
registerProcedureOwnedBySkillsTests();
