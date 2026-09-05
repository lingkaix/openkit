import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION,
  knowledgeReferenceErrors,
  parseOkfDocument,
  parseWorkspaceKnowledgeSchema,
  stringListFrontmatterField,
  updateOkfFrontmatter,
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

  it('preserves nested v0.2 metadata and both native verified shapes', () => {
    const content = [
      '---',
      'type: Attested Computation',
      'sources:',
      '  - id: policy',
      '    resource: https://example.com/policy',
      'generated: { by: reference_agent/model, at: 2026-09-06T00:00:00Z }',
      'verified: { by: human:reviewer, at: 2026-09-06T01:00:00Z }',
      'parameters:',
      '  - { name: year, type: integer, required: true }',
      'executor:',
      '  resource: references/run.md',
      '  receipt: [job_id, result]',
      'attester:',
      '  resource: references/attest.ts',
      'unknown_metadata:',
      '  confidence: 0.75',
      '  enabled: true',
      '---',
      '# Computation',
      '',
      '```sql',
      'SELECT 1',
      '```',
      '',
    ].join('\n');
    const parsed = parseOkfDocument({ path: 'knowledge/pages/computation.md', content });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.frontmatter).toMatchObject({
      sources: [{ id: 'policy', resource: 'https://example.com/policy' }],
      generated: { by: 'reference_agent/model', at: '2026-09-06T00:00:00Z' },
      parameters: [{ name: 'year', type: 'integer', required: true }],
      executor: { resource: 'references/run.md', receipt: ['job_id', 'result'] },
      unknown_metadata: { confidence: 0.75, enabled: true },
    });
    expect(parsed.document.frontmatter.verified).toEqual({
      by: 'human:reviewer',
      at: '2026-09-06T01:00:00Z',
    });

    const verificationList = parseOkfDocument({
      path: 'knowledge/pages/verified-list.md',
      content: [
        '---',
        'type: KnowledgePage',
        'verified:',
        '  - { by: process:first, at: 2026-09-06T01:00:00Z }',
        '  - { by: human:second, at: 2026-09-06T02:00:00Z }',
        '---',
        'Body',
      ].join('\n'),
    });
    expect(verificationList.ok).toBe(true);
    expect(verificationList.document?.frontmatter.verified).toEqual([
      { by: 'process:first', at: '2026-09-06T01:00:00Z' },
      { by: 'human:second', at: '2026-09-06T02:00:00Z' },
    ]);

    const updated = updateOkfFrontmatter({
      path: 'knowledge/pages/computation.md',
      content,
      updates: { title: 'Revenue computation' },
    });
    const reparsed = parseOkfDocument({ path: 'knowledge/pages/computation.md', content: updated });
    expect(reparsed.ok && reparsed.document.frontmatter).toMatchObject({
      title: 'Revenue computation',
      unknown_metadata: { confidence: 0.75, enabled: true },
    });
    expect(reparsed.document?.body).toBe(parsed.document.body);

    const bodyUpdated = updateOkfFrontmatter({
      path: 'knowledge/pages/computation.md',
      content,
      updates: { title: 'Replacement body' },
      body: '# Replacement\n',
    });
    expect(
      parseOkfDocument({ path: 'knowledge/pages/computation.md', content: bodyUpdated }).document
        ?.body
    ).toBe('# Replacement\n');
  });

  it('accepts a type-only unknown concept as base OKF-compatible input', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/external.md',
      content: ['---', 'type: Vendor Extension', '---', 'External body.'].join('\n'),
    });

    expect(parsed).toMatchObject({
      ok: true,
      document: { frontmatter: { type: 'Vendor Extension' } },
    });
  });

  it.each([
    ['malformed YAML', ['---', 'type: [broken', '---', 'Body'].join('\n'), 'okf.invalid_yaml'],
    ['duplicate keys', ['---', 'type: A', 'type: B', '---', 'Body'].join('\n'), 'okf.invalid_yaml'],
    [
      'non-string mapping keys',
      ['---', 'type: KnowledgePage', '? [nested, key]', ': value', '---', 'Body'].join('\n'),
      'okf.non_string_key',
    ],
    [
      'cyclic aliases',
      ['---', 'type: KnowledgePage', 'cycle: &cycle', '  self: *cycle', '---', 'Body'].join('\n'),
      'okf.cyclic_frontmatter',
    ],
  ])('rejects %s', (_name, content, code) => {
    const parsed = parseOkfDocument({ path: 'knowledge/pages/invalid.md', content });

    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toContainEqual(expect.objectContaining({ code }));
  });

  it('does not echo malformed YAML source content in diagnostics', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/malformed-secret.md',
      content: ['---', 'type: [sk-sensitive-canary', '---', 'Body'].join('\n'),
    });

    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed.errors)).not.toContain('sk-sensitive-canary');
    expect(parsed.errors).toContainEqual({
      code: 'okf.invalid_yaml',
      message: 'OKF YAML is invalid.',
    });
  });

  it('bounds YAML alias expansion', () => {
    const aliases = Array.from({ length: 101 }, () => '*value').join(', ');
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/aliases.md',
      content: [
        '---',
        'type: KnowledgePage',
        'value: &value [one, two]',
        `copies: [${aliases}]`,
        '---',
        'Body',
      ].join('\n'),
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toContainEqual(expect.objectContaining({ code: 'okf.alias_limit' }));
  });

  it('validates index and log reserved-file structures at any depth', () => {
    expect(
      parseOkfDocument({
        path: 'knowledge/pages/index.md',
        content: ['---', 'okf_version: "0.2"', '---', '# Knowledge', '', '* [Area](area/)'].join(
          '\n'
        ),
      }).ok
    ).toBe(true);
    expect(
      parseOkfDocument({
        path: 'knowledge/pages/area/index.md',
        content: ['# Area', '', '* [Concept](concept.md)'].join('\n'),
      }).ok
    ).toBe(true);
    expect(
      parseOkfDocument({
        path: 'knowledge/pages/area/log.md',
        content: [
          '# Directory Update Log',
          '',
          '## 2026-09-06',
          '* **Update**: Added a concept.',
        ].join('\n'),
      }).ok
    ).toBe(true);

    expect(
      parseOkfDocument({
        path: 'knowledge/pages/area/index.md',
        content: ['---', 'okf_version: "0.2"', '---', '# Area'].join('\n'),
      }).errors
    ).toContainEqual(expect.objectContaining({ code: 'okf.reserved_frontmatter' }));
    expect(
      parseOkfDocument({
        path: 'area/index.md',
        content: ['---', 'okf_version: "0.2"', '---', '# Area'].join('\n'),
      }).errors
    ).toContainEqual(expect.objectContaining({ code: 'okf.reserved_frontmatter' }));
    expect(
      parseOkfDocument({
        path: 'area\\index.md',
        content: ['---', 'okf_version: "0.2"', '---', '# Area'].join('\n'),
      }).errors
    ).toContainEqual(expect.objectContaining({ code: 'okf.reserved_frontmatter' }));
    expect(
      parseOkfDocument({
        path: 'knowledge/pages/log.md',
        content: ['# Directory Update Log', '', '## September 6', '* Updated.'].join('\n'),
      }).errors
    ).toContainEqual(expect.objectContaining({ code: 'okf.invalid_log_structure' }));
    expect(
      parseOkfDocument({
        path: 'knowledge/pages/log.md',
        content: [
          '# Directory Update Log',
          '',
          '## 2026-09-06',
          '* Updated.',
          '## 2026-09-05',
        ].join('\n'),
      }).errors
    ).toContainEqual(expect.objectContaining({ code: 'okf.invalid_log_structure' }));
    expect(
      parseOkfDocument({ path: 'knowledge/pages/empty/index.md', content: '# Empty section' }).ok
    ).toBe(true);
    expect(
      parseOkfDocument({ path: 'knowledge/pages/broken/index.md', content: 'No section heading' })
        .errors
    ).toContainEqual(expect.objectContaining({ code: 'okf.invalid_index_structure' }));
    expect(
      parseOkfDocument({
        path: 'knowledge/pages/index.md',
        content: ['---', 'okf_version: "0.1"', '---', '# Knowledge', '', '* [Area](area/)'].join(
          '\n'
        ),
      }).errors
    ).toContainEqual(expect.objectContaining({ code: 'okf.invalid_index_frontmatter' }));
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
        'openkit_status: "active"',
        'status: "stable"',
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
      okfSnapshot: 'docs/okf-spec-v0.2-snapshot.md#v0.2',
      profileVersion: 'openkit-knowledge-profile-v2',
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
        'openkit_status: "active"',
        'status: "stable"',
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
        expect.objectContaining({ code: 'profile.secret_like_field', field: 'frontmatter' }),
      ])
    );
  });

  it.each([
    ['draft', 'draft'],
    ['active', 'stable'],
    ['archived', 'deprecated'],
    ['superseded', 'deprecated'],
    ['invalid', 'deprecated'],
    ['deleted', 'deprecated'],
  ] as const)('accepts openkit_status %s with standard status %s', (openkitStatus, status) => {
    const parsed = governedPage({ openkitStatus, status });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateOpenKitKnowledgeProfile(parsed.document).errors).toEqual([]);
  });

  it('treats missing standard status as stable and rejects conflicting projections', () => {
    const active = governedPage({ openkitStatus: 'active' });
    const archived = governedPage({ openkitStatus: 'archived' });
    const mismatch = governedPage({ openkitStatus: 'active', status: 'draft' });

    expect(active.ok && validateOpenKitKnowledgeProfile(active.document).errors).toEqual([]);
    expect(archived.ok && validateOpenKitKnowledgeProfile(archived.document).errors).toContainEqual(
      expect.objectContaining({ code: 'profile.status_projection_mismatch' })
    );
    expect(mismatch.ok && validateOpenKitKnowledgeProfile(mismatch.document).errors).toContainEqual(
      expect.objectContaining({ code: 'profile.status_projection_mismatch' })
    );
  });

  it.each([
    ['type', null, 'profile.invalid_string_field'],
    ['title', [], 'profile.invalid_string_field'],
    ['schema_version', 2, 'profile.invalid_string_field'],
    ['openkit_status', null, 'profile.invalid_string_field'],
    ['openkit_status', 'paused', 'profile.invalid_openkit_status'],
    ['scope', {}, 'profile.invalid_string_field'],
    ['review_state', false, 'profile.invalid_string_field'],
    ['sensitivity', 1, 'profile.invalid_string_field'],
    ['freshness', [], 'profile.invalid_string_field'],
    ['created_at', {}, 'profile.invalid_string_field'],
    ['updated_at', null, 'profile.invalid_string_field'],
    ['created_at', 'not-a-timestamp', 'profile.invalid_timestamp'],
    ['updated_at', 'still-not-a-timestamp', 'profile.invalid_timestamp'],
    ['created_at', '2026-07-07T00:00:00', 'profile.invalid_timestamp'],
    ['status', null, 'profile.status_projection_mismatch'],
  ] as const)('rejects invalid governed scalar %s', (field, value, code) => {
    const parsed = governedPage({});

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const document = {
      ...parsed.document,
      frontmatter: { ...parsed.document.frontmatter, [field]: value },
    };
    expect(validateOpenKitKnowledgeProfile(document).errors).toContainEqual(
      expect.objectContaining({ code, field })
    );
  });

  it('requires every source_refs member to be a string before reference traversal', () => {
    const parsed = governedPage({ sourceRefsYaml: '["https://example.com", { resource: nope }]' });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(stringListFrontmatterField(parsed.document, 'source_refs')).toBeNull();
    expect(validateOpenKitKnowledgeProfile(parsed.document).errors).toContainEqual(
      expect.objectContaining({ code: 'profile.invalid_source_refs' })
    );
    expect(knowledgeReferenceErrors(parsed.document, new Set(), new Set())).toEqual([]);
  });

  it('rejects secret-like fields and values recursively through mappings and arrays', () => {
    const secretFieldCanary = 'api_token_canary_do_not_echo';
    const secretValuePathCanary = 'value_path_canary_do_not_echo';
    const parsed = governedPage({
      extra: [
        'metadata:',
        '  provenance:',
        '    - label: safe',
        `    - ${secretFieldCanary}: concealed`,
        `  ${secretValuePathCanary}:`,
        '    - ordinary',
        '    - "contains sk-secret material"',
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const errors = validateOpenKitKnowledgeProfile(parsed.document).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'profile.secret_like_field' }),
        expect.objectContaining({ code: 'profile.secret_like_value' }),
      ])
    );
    expect(JSON.stringify(errors)).not.toContain(secretFieldCanary);
    expect(JSON.stringify(errors)).not.toContain(secretValuePathCanary);
  });

  it('validates active pages against the default workspace schema', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/project.md',
      content: [
        '---',
        'type: "KnowledgePage"',
        'title: "Project context"',
        `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'openkit_status: "active"',
        'status: "stable"',
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
        'openkit_status: "active"',
        'status: "stable"',
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
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
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
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
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

function governedPage(input: {
  openkitStatus?: 'draft' | 'active' | 'archived' | 'superseded' | 'invalid' | 'deleted';
  status?: 'draft' | 'stable' | 'deprecated';
  sourceRefsYaml?: string;
  extra?: readonly string[];
}) {
  return parseOkfDocument({
    path: 'knowledge/pages/status.md',
    content: [
      '---',
      'type: "KnowledgePage"',
      'title: "Status page"',
      `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
      `openkit_status: ${JSON.stringify(input.openkitStatus ?? 'active')}`,
      ...(input.status ? [`status: ${JSON.stringify(input.status)}`] : []),
      'scope: "workspace"',
      `source_refs: ${input.sourceRefsYaml ?? '[]'}`,
      'review_state: "accepted"',
      'sensitivity: "normal"',
      'freshness: "current"',
      'created_at: "2026-07-07T00:00:00.000Z"',
      'updated_at: "2026-07-07T00:00:00.000Z"',
      ...(input.extra ?? []),
      '---',
      'Status body.',
      '',
    ].join('\n'),
  });
}
