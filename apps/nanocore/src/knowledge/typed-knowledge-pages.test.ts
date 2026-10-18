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
const path = 'domain.md';

/** Uses the real final-tree publication validator over exact governed candidate bytes. */
function candidate(fields: Record<string, unknown>, scopeSchemaText?: string) {
  const content = [
    '---',
    ...Object.entries({
      type: 'Rule',
      title: 'Domain understanding',
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
      applies_to: ['tool:invoice.check', 'step:invoice-review'],
      ...fields,
    })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    '---',
    'Reusable domain context.\n',
  ].join('\n');
  const schemaText = scopeSchemaText ?? DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT;
  return {
    content,
    report: validateKnowledgePageCandidate({
      path,
      content,
      expectedOwnerScope: ownerScope,
      scopeSchemaText: schemaText,
      registeredSources: new Map(),
      knowledgeIds: new Set(['domain']),
    }),
    publication: validateNotebookCandidate({
      ownerScope,
      base: { files: {} },
      candidate: { files: { [path]: content } },
      scopeSchemaText: schemaText,
      registeredSources: new Map(),
      resolvedReferences: new Map(),
    }),
  };
}

describe('Governed typed Knowledge Page publication', () => {
  it.each(['Rule', 'Effect', 'Objective'])('admits a governed %s domain page', (type) => {
    const result = candidate({
      type,
      ...(type === 'Effect'
        ? { basis: 'Reviewed invoice outcomes.', last_checked_at: '2026-10-18T01:00:00+01:00' }
        : {}),
    });
    expect(result.report).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
    expect(result.publication.errors).toEqual([]);
  });

  it.each(['Rule', 'Effect', 'Objective'])(
    'refuses a %s with missing or malformed applicability even under an authored schema',
    (type) => {
      const schema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
        /allowed_types: .*/,
        `allowed_types: [${type}]`
      );
      for (const applies_to of [undefined, null, [], '', 'tool:invoice.check', [1], [''], ['  ']]) {
        const result = candidate(
          { type, applies_to, basis: 'Observed outcomes.', last_checked_at: '2026-10-18T00:00:00Z' },
          schema
        );
        expect(result.report.errors).toContainEqual(
          expect.objectContaining({ code: 'scope_schema.invalid_applies_to', field: 'applies_to' })
        );
        expect(result.publication.errors).toEqual([
          { pageId: 'domain', code: 'notebook.invalid_page' },
        ]);
      }
    }
  );

  it.each([undefined, null, '', '  ', 1, [], {}])('refuses an Effect without a basis: %j', (basis) => {
    const result = candidate({ type: 'Effect', basis, last_checked_at: '2026-10-18T00:00:00Z' });
    expect(result.report.errors).toContainEqual(
      expect.objectContaining({ code: 'scope_schema.invalid_effect_basis', field: 'basis' })
    );
    expect(result.publication.errors).toEqual([{ pageId: 'domain', code: 'notebook.invalid_page' }]);
  });

  it.each([undefined, null, '', 1, '2026-10-18', '2026-10-18T01:00:00', 'invalid'])(
    'refuses an Effect without an offset timestamp for its last check: %j',
    (last_checked_at) => {
      const result = candidate({ type: 'Effect', basis: 'Observed outcomes.', last_checked_at });
      expect(result.report.errors).toContainEqual(
        expect.objectContaining({ code: 'scope_schema.invalid_effect_last_check', field: 'last_checked_at' })
      );
      expect(result.publication.errors).toEqual([{ pageId: 'domain', code: 'notebook.invalid_page' }]);
    }
  );

  it('preserves descriptive extensions and common governance through an edit', () => {
    const extension = { labels: ['regional'], annotation: { retained: true } };
    const original = candidate({ type: 'Objective', extension });
    const edited = updateOkfFrontmatter({ path, content: original.content, updates: { title: 'Updated' } });
    const parsed = parseOkfDocument({ path, content: edited });
    expect(parsed.ok).toBe(true);
    expect(parsed.document?.frontmatter).toMatchObject({
      extension,
      applies_to: ['tool:invoice.check', 'step:invoice-review'],
      scope: ownerScope,
      source_refs: [],
      review_state: 'delegated',
      sensitivity: 'normal',
      freshness: 'current',
    });
    if (!parsed.ok) throw new Error('Fixture must parse.');
    expect(validateScopeKnowledgeSchema(parsed.document, undefined, ownerScope).errors).toEqual([]);
  });

  it('refuses Procedure publication with a Skill-owner diagnostic, including a custom schema bypass', () => {
    const custom = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(/allowed_types: .*/, 'allowed_types: [Procedure]');
    expect(parseScopeKnowledgeSchema(custom)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'scope_schema.procedure_owned_by_skill', field: 'allowed_types', message: expect.stringContaining('Skill') })],
    });
    for (const schema of [undefined, custom]) {
      const result = candidate({ type: 'Procedure' }, schema);
      expect(result.report.errors).toContainEqual(expect.objectContaining({ code: 'scope_schema.procedure_owned_by_skill', message: expect.stringContaining('Skill') }));
      expect(result.publication.errors).toEqual([{ pageId: 'domain', code: 'notebook.invalid_page' }]);
      const parsed = parseOkfDocument({ path, content: result.content });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('External OKF Procedure must remain parseable.');
      expect(validateScopeKnowledgeSchema(parsed.document, { ...DEFAULT_SCOPE_KNOWLEDGE_SCHEMA, allowedTypes: ['Procedure'] }).errors).toContainEqual(expect.objectContaining({ code: 'scope_schema.procedure_owned_by_skill', field: 'type' }));
    }
  });

  it('keeps descriptive Topic context and exact Skill references admissible', () => {
    const skill = `https://example.test/skills/invoice/${'a'.repeat(40)}/SKILL.md`;
    const result = candidate({ type: 'Topic', applies_to: undefined, source_refs: [skill] });
    expect(result.report).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
    expect(result.publication).toMatchObject({ errors: [], sourceReferences: [skill] });
  });
});
