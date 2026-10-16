import { allocateEntityId, KnowledgeOwnerScopeSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  isActiveOpenKitKnowledgePage,
  OPENKIT_KNOWLEDGE_PROFILE_VERSION,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  updateOkfFrontmatter,
  validateKnowledgePageCandidate,
  validateOpenKitKnowledgeProfile,
  validateScopeKnowledgeSchema,
} from './okf.js';

const features = ['openkit.knowledge-owner-scope.v1', 'openkit.knowledge-git-notebook.v1'];
const workspace = KnowledgeOwnerScopeSchema.options[1].parse({
  kind: 'workspace',
  workspaceId: allocateEntityId('ws'),
});
const user = KnowledgeOwnerScopeSchema.options[0].parse({
  kind: 'user',
  userId: allocateEntityId('usr'),
});

function page(fields: Record<string, unknown> = {}) {
  const frontmatter = {
    type: 'KnowledgePage',
    title: 'Scoped understanding',
    schema_version: 'openkit-scope-knowledge-schema-v4',
    openkit_status: 'active',
    scope: workspace,
    requiredFeatures: features,
    source_refs: [],
    review_state: 'delegated',
    sensitivity: 'normal',
    freshness: 'current',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    ...fields,
  };
  return [
    '---',
    ...Object.entries(frontmatter)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    '---',
    'Exact body.\n',
  ].join('\n');
}

function parsedPage(fields: Record<string, unknown> = {}) {
  const parsed = parseOkfDocument({ path: 'pages/scoped.md', content: page(fields) });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('Fixture must be valid generic OKF.');
  return parsed.document;
}

describe('OpenKit scoped profile v4', () => {
  it('names the accepted profile and default scope schema versions', () => {
    expect(OPENKIT_KNOWLEDGE_PROFILE_VERSION).toBe('openkit-knowledge-profile-v4');
    expect(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION).toBe('openkit-scope-knowledge-schema-v4');
  });

  it.each([user, workspace, { kind: 'server' }])('accepts complete owner %j', (scope) => {
    expect(validateOpenKitKnowledgeProfile(parsedPage({ scope }))).toMatchObject({
      conformance: 'OpenKit-profile-valid',
      errors: [],
    });
  });

  it.each(
    [
      'workspace',
      null,
      [],
      { kind: 'other' },
      { kind: 'user' },
      { kind: 'user', userId: '' },
      { kind: 'user', userId: 1 },
      { kind: 'workspace' },
      { kind: 'workspace', workspaceId: '' },
      { kind: 'workspace', workspaceId: 1 },
      { kind: 'server', userId: user.userId },
      { ...workspace, userId: user.userId },
    ].map((value) => [value])
  )('rejects an incomplete or contradictory owner %j', (scope) => {
    expect(validateOpenKitKnowledgeProfile(parsedPage({ scope })).errors).toContainEqual(
      expect.objectContaining({ code: 'profile.invalid_scope', field: 'scope' })
    );
  });

  it.each(
    [undefined, null, 'openkit.knowledge-owner-scope.v1', [1]].map((value) => [value])
  )('rejects missing or malformed required features %j', (requiredFeatures) => {
    expect(validateOpenKitKnowledgeProfile(parsedPage({ requiredFeatures })).errors).toContainEqual(
      expect.objectContaining({ field: 'requiredFeatures' })
    );
  });

  it.each(
    [[], [features[0]], [features[1]]].map((value) => [value])
  )('rejects an omitted v4 semantic %j', (requiredFeatures) => {
    expect(validateOpenKitKnowledgeProfile(parsedPage({ requiredFeatures })).errors).toContainEqual(
      expect.objectContaining({
        code: 'profile.missing_required_feature',
        field: 'requiredFeatures',
      })
    );
  });

  it('refuses unknown required semantics without rejecting the external OKF envelope', () => {
    const document = parsedPage({ requiredFeatures: [...features, 'openkit.future.v1'] });
    expect(validateOpenKitKnowledgeProfile(document)).toMatchObject({
      conformance: 'OKF-compatible',
      errors: [expect.objectContaining({ code: 'profile.unsupported_required_feature' })],
    });
  });

  it.each([
    { owner_scope: workspace },
    { openkit_revision: 1 },
    { openkit_revision: '1' },
  ])('refuses a second owner or page counter %j', (fields) => {
    expect(validateOpenKitKnowledgeProfile(parsedPage(fields)).errors).toContainEqual(
      expect.objectContaining({ code: 'profile.obsolete_authority_field' })
    );
  });

  it('retains unknown additive metadata through a governed edit', () => {
    const extension = { nested: [{ label: 'annotation', count: 3 }] };
    const content = page({ extension });
    const edited = updateOkfFrontmatter({
      path: 'pages/scoped.md',
      content,
      updates: { title: 'Edited' },
    });
    const parsed = parseOkfDocument({ path: 'pages/scoped.md', content: edited });
    expect(parsed.ok).toBe(true);
    expect(parsed.document?.body).toBe('Exact body.\n');
    expect(parsed.document?.frontmatter.extension).toEqual(extension);
    if (!parsed.ok) return;
    expect(validateOpenKitKnowledgeProfile(parsed.document).errors).toEqual([]);
  });

  it('validates delegated pages under the default v4 scope schema', () => {
    const document = parsedPage();
    expect(validateScopeKnowledgeSchema(document, undefined, workspace)).toMatchObject({
      conformance: 'scope-schema-valid',
      scopeSchemaVersion: 'openkit-scope-knowledge-schema-v4',
      errors: [],
    });
    expect(isActiveOpenKitKnowledgePage(document, undefined, workspace)).toBe(true);
  });

  it.each([
    [workspace, user],
    [workspace, { kind: 'server' }],
    [user, { ...user, userId: allocateEntityId('usr') }],
    [workspace, { ...workspace, workspaceId: allocateEntityId('ws') }],
    [{ kind: 'server' }, user],
  ])('refuses a valid page owned by another admitted notebook %j', (scope, expectedOwnerScope) => {
    const document = parsedPage({ scope });
    const expected = KnowledgeOwnerScopeSchema.parse(expectedOwnerScope);
    expect(validateScopeKnowledgeSchema(document, undefined, expected)).toMatchObject({
      conformance: 'OKF-compatible',
      errors: [expect.objectContaining({ code: 'profile.scope_mismatch', field: 'scope' })],
    });
    expect(isActiveOpenKitKnowledgePage(document, undefined, expected)).toBe(false);
    expect(
      validateKnowledgePageCandidate({
        path: 'pages/scoped.md',
        content: page({ scope }),
        expectedOwnerScope: expected,
        registeredSources: new Map(),
        knowledgeIds: new Set(),
      }).errors
    ).toContainEqual(expect.objectContaining({ code: 'profile.scope_mismatch' }));
  });

  it('compares normalized owner values independent of YAML key order', () => {
    expect(
      validateKnowledgePageCandidate({
        path: 'pages/scoped.md',
        content: page({ scope: { workspaceId: workspace.workspaceId, kind: 'workspace' } }),
        scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
        expectedOwnerScope: workspace,
        registeredSources: new Map(),
        knowledgeIds: new Set(),
      })
    ).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
  });

  it('does not admit old page/schema bytes through a v2 fallback', () => {
    const document = parsedPage({ schema_version: 'openkit-workspace-knowledge-schema-v2' });
    expect(validateScopeKnowledgeSchema(document)).toMatchObject({
      conformance: 'OpenKit-profile-valid',
      errors: [expect.objectContaining({ code: 'scope_schema.version_mismatch' })],
    });
    expect(
      validateOpenKitKnowledgeProfile(
        parsedPage({ scope: 'workspace', requiredFeatures: undefined })
      ).conformance
    ).toBe('OKF-compatible');
  });

  it.each(
    [['openkit.future.v1'], ['openkit.knowledge-owner-scope.v2'], [1], 'invalid'].map((value) => [
      value,
    ])
  )('refuses unsupported schema semantics %j', (requiredFeatures) => {
    const schema = parseScopeKnowledgeSchema(
      `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}requiredFeatures: ${JSON.stringify(requiredFeatures)}\n`
    );
    expect(schema.ok).toBe(false);
    expect(schema.errors).toContainEqual(expect.objectContaining({ field: 'requiredFeatures' }));
  });

  it('retains permissive external import for a minimal unknown type', () => {
    const parsed = parseOkfDocument({
      path: 'pages/external.md',
      content: '---\ntype: External Concept\nannotation: {nested: [1, true]}\n---\nBody',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.document?.frontmatter.annotation).toEqual({ nested: [1, true] });
    if (!parsed.ok) return;
    expect(validateOpenKitKnowledgeProfile(parsed.document).conformance).toBe('OKF-compatible');
  });

  it('accepts known schema features and rejects an explicitly empty schema', () => {
    expect(
      parseScopeKnowledgeSchema(
        `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}requiredFeatures: ${JSON.stringify(features)}\n`
      ).ok
    ).toBe(true);
    expect(
      validateKnowledgePageCandidate({
        path: 'pages/scoped.md',
        content: page(),
        scopeSchemaText: '',
        expectedOwnerScope: workspace,
        registeredSources: new Map(),
        knowledgeIds: new Set(),
      })
    ).toMatchObject({
      conformance: 'OpenKit-profile-valid',
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'scope_schema.missing_schema_version' }),
      ]),
    });
  });

  it.each(
    [[1], [null], [{ reference: 'https://example.test' }], 'https://example.test'].map((value) => [
      value,
    ])
  )('keeps source_refs strict %j', (source_refs) => {
    expect(validateOpenKitKnowledgeProfile(parsedPage({ source_refs })).errors).toContainEqual(
      expect.objectContaining({ code: 'profile.invalid_source_refs' })
    );
  });
});
