import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION,
  knowledgeReferenceErrors,
  parseOkfDocument,
  parseWorkspaceKnowledgeSchema,
  validateOpenKitKnowledgeProfile,
  validateWorkspaceKnowledgeSchema,
} from './okf.js';

describe('parseOkfDocument', () => {
  it('parses a concept document frontmatter block and body', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/release.md',
      content: [
        '---',
        'type: "KnowledgePage"',
        'title: "Release notes"',
        'source_refs: ["source_1", "source_2"]',
        '---',
        'The release is ready.',
        '',
      ].join('\n'),
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.document).toMatchObject({
      body: 'The release is ready.\n',
      frontmatter: {
        type: 'KnowledgePage',
        title: 'Release notes',
        source_refs: ['source_1', 'source_2'],
      },
      conceptId: 'release',
    });
  });

  it('rejects non-reserved concept documents without a type field', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/no-type.md',
      content: ['---', 'title: "No type"', '---', 'Body'].join('\n'),
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({
        code: 'okf.missing_type',
        field: 'type',
      })
    );
  });
});

describe('knowledgeReferenceErrors', () => {
  it('requires digest-qualified local references to be verified as an exact closed reference', () => {
    const reference = `source:ks_123e4567-e89b-42d3-a456-426614174000@sha256:${'0'.repeat(64)}`;
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/digest-reference.md',
      content: [
        '---',
        'type: "KnowledgePage"',
        `source_refs: ${JSON.stringify([reference])}`,
        '---',
        'Body',
      ].join('\n'),
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(
      knowledgeReferenceErrors(
        parsed.document,
        new Set(['ks_123e4567-e89b-42d3-a456-426614174000']),
        new Set()
      )
    ).toContainEqual(expect.objectContaining({ code: 'reference.unresolved_source' }));
    expect(
      knowledgeReferenceErrors(parsed.document, new Set(), new Set(), new Set([reference]))
    ).toEqual([]);
  });
});

describe('validateOpenKitKnowledgeProfile', () => {
  it('marks a governed active knowledge page as OpenKit profile valid', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/project.md',
      content: [
        '---',
        'type: "KnowledgePage"',
        'title: "Project context"',
        `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'created_at: "2026-07-07T00:00:00.000Z"',
        'updated_at: "2026-07-07T00:00:00.000Z"',
        '---',
        'Project context body.',
        '',
      ].join('\n'),
    });

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    const report = validateOpenKitKnowledgeProfile(parsed.document);

    expect(report).toEqual({
      okfSnapshot: 'docs/okf-spec-v0.1-snapshot.md#v0.1',
      profileVersion: 'openkit-knowledge-profile-v1',
      conformance: 'OpenKit-profile-valid',
      errors: [],
    });
  });

  it('rejects missing required profile fields and secret-like fields', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/unsafe.md',
      content: [
        '---',
        'type: "KnowledgePage"',
        'title: "Unsafe page"',
        `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'api_token: "sk-secret"',
        '---',
        'Unsafe body.',
      ].join('\n'),
    });

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    const report = validateOpenKitKnowledgeProfile(parsed.document);

    expect(report.conformance).toBe('OKF-compatible');
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'profile.missing_required_field', field: 'created_at' }),
        expect.objectContaining({ code: 'profile.missing_required_field', field: 'updated_at' }),
        expect.objectContaining({ code: 'profile.secret_like_field', field: 'api_token' }),
      ])
    );
  });

  it('validates active pages against the default workspace schema', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/project.md',
      content: [
        '---',
        'type: "KnowledgePage"',
        'title: "Project context"',
        `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'created_at: "2026-07-07T00:00:00.000Z"',
        'updated_at: "2026-07-07T00:00:00.000Z"',
        '---',
        'Project context body.',
        '',
      ].join('\n'),
    });

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    expect(validateWorkspaceKnowledgeSchema(parsed.document)).toMatchObject({
      conformance: 'Workspace-schema-valid',
      errors: [],
    });
  });

  it('rejects unknown types when the workspace schema does not allow them', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/legacy.md',
      content: [
        '---',
        'type: "project-context"',
        'title: "Legacy page"',
        `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'status: "active"',
        'scope: "workspace"',
        'source_refs: []',
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'created_at: "2026-07-07T00:00:00.000Z"',
        'updated_at: "2026-07-07T00:00:00.000Z"',
        '---',
        'Legacy body.',
      ].join('\n'),
    });

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    expect(validateOpenKitKnowledgeProfile(parsed.document).conformance).toBe(
      'OpenKit-profile-valid'
    );
    expect(validateWorkspaceKnowledgeSchema(parsed.document)).toMatchObject({
      conformance: 'OpenKit-profile-valid',
      errors: [expect.objectContaining({ code: 'workspace_schema.type_not_allowed' })],
    });
  });

  it('allows extension types declared by the workspace schema', () => {
    const schema = parseWorkspaceKnowledgeSchema(
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
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/repo.md',
      content: [
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
        'Repo convention body.',
      ].join('\n'),
    });

    expect(schema.ok).toBe(true);
    expect(parsed.ok).toBe(true);

    if (!schema.ok || !parsed.ok) {
      return;
    }

    expect(validateWorkspaceKnowledgeSchema(parsed.document, schema.schema)).toMatchObject({
      conformance: 'Workspace-schema-valid',
      errors: [],
    });
  });
});
