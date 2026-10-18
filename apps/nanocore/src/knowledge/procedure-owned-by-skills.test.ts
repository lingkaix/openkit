import { describe, expect, it } from 'vitest';
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
