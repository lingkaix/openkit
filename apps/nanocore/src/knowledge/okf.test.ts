import type { KnowledgeOwnerScope } from '@openkit/protocol';
import { allocateEntityId, formatReferenceUri, KnowledgeOwnerScopeSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';

import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  isActiveOpenKitKnowledgePage,
  knowledgeReferenceErrors,
  OPENKIT_KNOWLEDGE_PROFILE_VERSION,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  REQUIRED_SCOPED_KNOWLEDGE_FEATURES,
  resolveRegisteredKnowledgeSourceReference,
  stringListFrontmatterField,
  updateOkfFrontmatter,
  validateKnowledgePageCandidate,
  validateOpenKitKnowledgeProfile,
  validateScopeKnowledgeSchema,
} from './okf.js';

const workspace = KnowledgeOwnerScopeSchema.options[1].parse({
  kind: 'workspace',
  workspaceId: allocateEntityId('ws'),
});

describe('Scope schema descriptive metadata', () => {
  it('reads declared metadata without synthesizing absent retained fields', () => {
    const legacy = parseScopeKnowledgeSchema(
      DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(/^status:.*\n/m, '')
    );
    expect(legacy.ok).toBe(true);
    for (const field of [
      'status',
      'maintainer',
      'createdAt',
      'updatedAt',
      'extensionPoints',
      'validationRules',
      'reviewRequirements',
    ])
      expect(legacy.schema).not.toHaveProperty(field);
    const parsed = parseScopeKnowledgeSchema(`${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}
maintainer: OpenKit
created_at: "2026-10-31T00:00:00.000Z"
updated_at: "2026-10-31T00:00:00.000Z"
extension_points: [allowed_types, allowed_statuses, allowed_review_states, allowed_sensitivities, allowed_freshness]
validation_rules: [openkit-knowledge-profile-v4]
review_requirements: [active_retrieval, required_fields, sensitivity, source_reference_shape, review_rules]
future_description: {label: preserved authored annotation}
`);
    expect(parsed).toMatchObject({
      ok: true,
      schema: {
        status: 'active',
        maintainer: 'OpenKit',
        createdAt: '2026-10-31T00:00:00.000Z',
        updatedAt: '2026-10-31T00:00:00.000Z',
        extensionPoints: [
          'allowed_types',
          'allowed_statuses',
          'allowed_review_states',
          'allowed_sensitivities',
          'allowed_freshness',
        ],
        validationRules: ['openkit-knowledge-profile-v4'],
        reviewRequirements: [
          'active_retrieval',
          'required_fields',
          'sensitivity',
          'source_reference_shape',
          'review_rules',
        ],
      },
    });
    expect(parsed.schema).not.toHaveProperty('future_description');
  });

  it.each([
    'status: 7',
    'maintainer: 7',
    'created_at: not-a-timestamp',
    'updated_at: null',
    'extension_points: [required_fields]',
    'validation_rules: [unimplemented-rule]',
    'review_requirements: [active_retrieval, required_fields, sensitivity, source_reference_shape]',
    'review_requirements: []',
  ])('refuses malformed or unsupported declared schema metadata: %s', (declaration) => {
    const text = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(/^status:.*\n/m, '');
    expect(parseScopeKnowledgeSchema(`${text}\n${declaration}\n`).ok).toBe(false);
  });
});

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

describe('registered Knowledge Source identity', () => {
  const sourceId = 'ks_01890f3e-0000-7000-8000-000000000001';
  const digest = `sha256:${'a'.repeat(64)}`;
  const registered = new Map([[sourceId, digest]]);

  it('resolves canonical source ids and exact digest pins through the source owner', () => {
    expect(resolveRegisteredKnowledgeSourceReference(`source:${sourceId}`, registered)).toEqual({
      targetId: sourceId,
      resolved: true,
    });
    expect(
      resolveRegisteredKnowledgeSourceReference(`source:${sourceId}@${digest}`, registered)
    ).toEqual({
      targetId: sourceId,
      resolved: true,
    });
    expect(
      resolveRegisteredKnowledgeSourceReference(
        `source:${sourceId}@sha256:${'b'.repeat(64)}`,
        registered
      )
    ).toEqual({
      targetId: sourceId,
      resolved: false,
    });
  });

  it('refuses old versions, wrong kinds and malformed pins without unpinned fallback', () => {
    for (const reference of [
      `source:${sourceId.replace('-7000-', '-4000-')}`,
      `source:${sourceId.replace('ks_', 'ws_')}`,
      `source:${sourceId}@sha256:short`,
      `source:${sourceId}@${digest}\n`,
      `source:${sourceId}%40${digest}`,
    ]) {
      expect(resolveRegisteredKnowledgeSourceReference(reference, registered)).toEqual({
        targetId: null,
        resolved: false,
      });
    }
  });
});

describe('knowledgeReferenceErrors', () => {
  const pageScopeId = `page/workspace/${workspace.workspaceId}/${allocateEntityId('kb')}`;
  const objectId = 'group/日本語 % note';
  const local = formatReferenceUri({ scopeId: pageScopeId, objectId });
  const pin = `sha256:${'1'.repeat(64)}`;

  /** Validates one exact page reference with independently supplied scope and pin evidence. */
  function errors(reference: string, verified = false, scopeId: string | undefined = pageScopeId) {
    const parsed = parseOkfDocument({
      path: 'a.md',
      content: `---\ntype: KnowledgePage\nsource_refs: ${JSON.stringify([reference])}\n---\nBody`,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Invalid reference fixture.');
    return knowledgeReferenceErrors(
      parsed.document,
      new Map(),
      new Set([objectId]),
      new Set(verified ? [reference] : []),
      scopeId
    );
  }

  it('resolves canonical nested page identities only in the admitted owner and base', () => {
    expect(errors(local)).toEqual([]);
    for (const scopeId of [
      `page/workspace/${allocateEntityId('ws')}/${pageScopeId.split('/').at(-1)}`,
      `page/workspace/${workspace.workspaceId}/${allocateEntityId('kb')}`,
      pageScopeId.replace('page/', 'raw/'),
    ]) {
      expect(errors(formatReferenceUri({ scopeId, objectId }), true)).toContainEqual(
        expect.objectContaining({ code: 'reference.unresolved_knowledge' })
      );
    }
    expect(errors(local, true, '')).not.toEqual([]);
  });

  it('does not infer a page scope from a verified-reference set', () => {
    const parsed = parseOkfDocument({
      path: 'a.md',
      content: `---\ntype: KnowledgePage\nsource_refs: ${JSON.stringify([local])}\n---\nBody`,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Invalid reference fixture.');
    expect(
      knowledgeReferenceErrors(parsed.document, new Map(), new Set([objectId]), new Set([local]))
    ).toContainEqual(expect.objectContaining({ code: 'reference.unresolved_knowledge' }));
    expect(
      knowledgeReferenceErrors(parsed.document, new Map(), new Set(), new Set([local]), pageScopeId)
    ).toContainEqual(expect.objectContaining({ code: 'reference.unresolved_knowledge' }));
  });

  it('requires exact page pin proof and rejects legacy or malformed page strings', () => {
    const pinned = formatReferenceUri({ scopeId: pageScopeId, objectId }, pin);
    expect(errors(pinned)).not.toEqual([]);
    expect(errors(pinned, true)).toEqual([]);
    for (const reference of [`knowledge:${objectId}`, `${local}@sha256:bad`]) {
      expect(errors(reference, true)).not.toEqual([]);
    }
  });

  it('checks registered-source pins against the registry even when a closed proof is supplied', () => {
    const reference = `source:ks_00000000-0000-7e28-9211-1f67fd14ca84@sha256:${'0'.repeat(64)}`;
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
        new Map([['ks_00000000-0000-7e28-9211-1f67fd14ca84', null]]),
        new Set()
      )
    ).toContainEqual(expect.objectContaining({ code: 'reference.unresolved_source' }));
    expect(
      knowledgeReferenceErrors(parsed.document, new Map(), new Set(), new Set([reference]))
    ).toContainEqual(expect.objectContaining({ code: 'reference.unresolved_source' }));
    expect(
      knowledgeReferenceErrors(
        parsed.document,
        new Map([['ks_00000000-0000-7e28-9211-1f67fd14ca84', `sha256:${'0'.repeat(64)}`]]),
        new Set()
      )
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
        `schema_version: ${JSON.stringify(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'openkit_status: "active"',
        'status: "stable"',
        `scope: ${JSON.stringify(workspace)}`,
        `required_features: ${JSON.stringify(REQUIRED_SCOPED_KNOWLEDGE_FEATURES)}`,
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
      profileVersion: 'openkit-knowledge-profile-v4',
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
        `schema_version: ${JSON.stringify(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'openkit_status: "active"',
        'status: "stable"',
        `scope: ${JSON.stringify(workspace)}`,
        `required_features: ${JSON.stringify(REQUIRED_SCOPED_KNOWLEDGE_FEATURES)}`,
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
    ['scope', {}, 'profile.invalid_scope'],
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
    expect(knowledgeReferenceErrors(parsed.document, new Map(), new Set())).toEqual([]);
  });

  // Governance permits ordinary values while retaining recursive structural exclusions.
  it('accepts ordinary frontmatter values without changing their content', () => {
    const parsed = governedPage({
      title: 'Token budget',
      extra: [
        'metadata:',
        '  description: "Password reset instructions"',
        '  provenance:',
        '    - label: "Private key cryptography"',
        '    - notes:',
        '        - "API key documentation"',
        '        - "Secret sharing research"',
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const original = structuredClone(parsed.document);
    expect(parsed.document.frontmatter).toMatchObject({
      title: 'Token budget',
      metadata: {
        description: 'Password reset instructions',
        provenance: [
          { label: 'Private key cryptography' },
          { notes: ['API key documentation', 'Secret sharing research'] },
        ],
      },
    });
    expect(parsed.document.body).toBe('Status body.\n');
    expect(validateScopeKnowledgeSchema(parsed.document)).toMatchObject({
      conformance: 'scope-schema-valid',
      errors: [],
    });
    expect(parsed.document).toEqual(original);
  });

  it('rejects secret-like field names recursively through mappings and arrays', () => {
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
        '    - details:',
        '        password: concealed',
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const errors = validateOpenKitKnowledgeProfile(parsed.document).errors;
    expect(errors).toHaveLength(2);
    expect(errors).toEqual([
      expect.objectContaining({ code: 'profile.secret_like_field', field: 'frontmatter' }),
      expect.objectContaining({ code: 'profile.secret_like_field', field: 'frontmatter' }),
    ]);
    expect(JSON.stringify(errors)).not.toContain(secretFieldCanary);
    expect(JSON.stringify(errors)).not.toContain(secretValuePathCanary);
  });

  it('validates active pages against the default scope schema', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/project.md',
      content: [
        '---',
        'type: "KnowledgePage"',
        'title: "Project context"',
        `schema_version: ${JSON.stringify(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'openkit_status: "active"',
        'status: "stable"',
        `scope: ${JSON.stringify(workspace)}`,
        `required_features: ${JSON.stringify(REQUIRED_SCOPED_KNOWLEDGE_FEATURES)}`,
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

    expect(validateScopeKnowledgeSchema(parsed.document)).toMatchObject({
      conformance: 'scope-schema-valid',
      errors: [],
    });
  });

  it('rejects unknown types when the scope schema does not allow them', () => {
    const parsed = parseOkfDocument({
      path: 'knowledge/pages/legacy.md',
      content: [
        '---',
        'type: "project-context"',
        'title: "Legacy page"',
        `schema_version: ${JSON.stringify(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'openkit_status: "active"',
        'status: "stable"',
        `scope: ${JSON.stringify(workspace)}`,
        `required_features: ${JSON.stringify(REQUIRED_SCOPED_KNOWLEDGE_FEATURES)}`,
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
    expect(validateScopeKnowledgeSchema(parsed.document)).toMatchObject({
      conformance: 'OpenKit-profile-valid',
      errors: [expect.objectContaining({ code: 'scope_schema.type_not_allowed' })],
    });
  });

  it('allows extension types declared by the scope schema', () => {
    const schema = parseScopeKnowledgeSchema(
      [
        'schema_version: "openkit-scope-knowledge-schema-v4"',
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
        'schema_version: "openkit-scope-knowledge-schema-v4"',
        'openkit_status: "active"',
        'status: "stable"',
        `scope: ${JSON.stringify(workspace)}`,
        `required_features: ${JSON.stringify(REQUIRED_SCOPED_KNOWLEDGE_FEATURES)}`,
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

    expect(validateScopeKnowledgeSchema(parsed.document, schema.schema)).toMatchObject({
      conformance: 'scope-schema-valid',
      errors: [],
    });
  });
});

function governedPage(input: {
  title?: string;
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
      `title: ${JSON.stringify(input.title ?? 'Status page')}`,
      `schema_version: ${JSON.stringify(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION)}`,
      `openkit_status: ${JSON.stringify(input.openkitStatus ?? 'active')}`,
      ...(input.status ? [`status: ${JSON.stringify(input.status)}`] : []),
      `scope: ${JSON.stringify(workspace)}`,
      `required_features: ${JSON.stringify(REQUIRED_SCOPED_KNOWLEDGE_FEATURES)}`,
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

describe('governed core semantics', () => {
  it.each([
    ['review_state', 'allowedReviewStates'],
    ['sensitivity', 'allowedSensitivities'],
    ['freshness', 'allowedFreshness'],
  ] as const)('rejects unknown %s even when a custom schema permits it', (field, schemaField) => {
    const parsed = governedPage({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected a valid generic fixture.');
    const document = {
      ...parsed.document,
      frontmatter: { ...parsed.document.frontmatter, [field]: 'future-authority' },
    };
    expect(
      parseOkfDocument({
        path: 'external.md',
        content: `---\ntype: DomainNote\n${field}: future-authority\n---\nExternal body.`,
      }).ok
    ).toBe(true);
    expect(validateOpenKitKnowledgeProfile(document).errors).toContainEqual(
      expect.objectContaining({ code: `profile.invalid_${field}`, field })
    );
    const report = validateScopeKnowledgeSchema(document, {
      ...DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
      [schemaField]: ['future-authority'],
    });
    expect(report.conformance).not.toBe('scope-schema-valid');
  });

  it.each([
    'allowed_review_states',
    'allowed_sensitivities',
    'allowed_freshness',
    'allowed_statuses',
  ])('rejects unknown configured governance values in %s before using a schema', (field) => {
    const content = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
      new RegExp(`${field}:.*`),
      `${field}: [future-authority]`
    );
    expect(parseScopeKnowledgeSchema(content).ok).toBe(false);
  });

  it('recognizes restricted sensitivity without widening an existing schema allowlist', () => {
    const parsed = governedPage({});
    if (!parsed.ok) throw new Error('Expected a valid generic fixture.');
    const document = {
      ...parsed.document,
      frontmatter: { ...parsed.document.frontmatter, sensitivity: 'restricted' },
    };
    expect(validateOpenKitKnowledgeProfile(document).errors).toEqual([]);
    expect(validateScopeKnowledgeSchema(document).errors).toContainEqual(
      expect.objectContaining({ code: 'scope_schema.sensitivity_not_allowed' })
    );
    expect(
      validateScopeKnowledgeSchema(document, {
        ...DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
        allowedSensitivities: ['restricted'],
      }).conformance
    ).toBe('scope-schema-valid');
  });
});

const scopes: KnowledgeOwnerScope[] = [
  { kind: 'user', userId: 'usr_00000000-0000-7000-8000-000000000001' },
  { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  { kind: 'server' },
];

describe('direct human page bytes at the scoped profile boundary', () => {
  it.each(scopes)(
    'serializes exact complete owner $kind with required semantics and no counter',
    (ownerScope) => {
      const content = serializeKnowledgePageFixture(
        {
          title: 'Human note',
          content: 'Exact human text.',
          createdAt: '2026-10-16T00:00:00.000Z',
          updatedAt: '2026-10-16T00:00:00.000Z',
        },
        ownerScope
      );
      const parsed = parseOkfDocument({ path: 'human-note.md', content });
      expect(parsed.ok).toBe(true);
      expect(parsed.document?.frontmatter.scope).toEqual(ownerScope);
      expect(parsed.document?.frontmatter.required_features).toEqual(
        REQUIRED_SCOPED_KNOWLEDGE_FEATURES
      );
      expect(parsed.document?.frontmatter).not.toHaveProperty('openkit_entry_kind');
      expect(parsed.document?.frontmatter).not.toHaveProperty('owner_scope');
      expect(parsed.document?.frontmatter).not.toHaveProperty('openkit_revision');
      expect(parsed.document?.body).toBe('Exact human text.\n');
      expect(
        validateKnowledgePageCandidate({
          path: 'human-note.md',
          content,
          expectedOwnerScope: ownerScope,
          registeredSources: new Map(),
          knowledgeIds: new Set(['human-note']),
        })
      ).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
    }
  );
});

const workspaceId = allocateEntityId('ws');
const owner: KnowledgeOwnerScope = { kind: 'workspace', workspaceId };
const subjectUri = formatReferenceUri({
  scopeId: `page/workspace/${workspaceId}/${allocateEntityId('kb')}`,
  objectId: 'facts/release',
});

/** Build canonical input bytes independently from the validator under test. */
function page(type: 'Claim' | 'Observation', fields: Record<string, unknown> = {}): string {
  const frontmatter = {
    type,
    title: 'Reusable release understanding',
    schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
    required_features: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
    scope: owner,
    openkit_status: type === 'Observation' ? 'draft' : 'active',
    status: type === 'Observation' ? 'draft' : 'stable',
    source_refs: [],
    review_state: type === 'Observation' ? 'unreviewed' : 'user-authored',
    sensitivity: 'normal',
    freshness: 'current',
    created_at: '2026-10-18T00:00:00Z',
    updated_at: '2026-10-18T00:00:00Z',
    ...fields,
  };
  const defined = Object.fromEntries(
    Object.entries(frontmatter).filter(([, value]) => value !== undefined)
  );
  return `---\n${stringify(defined)}---\nThe release cadence is fortnightly.\n`;
}

/** Exercise the public governed-page boundary, with no source or permission substitute. */
function validate(content: string) {
  return validateKnowledgePageCandidate({
    path: 'facts/release.md',
    content,
    expectedOwnerScope: owner,
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    registeredSources: new Map(),
    knowledgeIds: new Set(),
  });
}

describe('governed Claim and reusable Observation fields', () => {
  it.each([0, 0.75, 1])(
    'preserves numeric Claim confidence %s and descriptive extensions',
    (confidence) => {
      const content = page('Claim', {
        confidence,
        custom_annotation: { confidence: 'not an assessment', retained: true },
      });
      expect(validate(content)).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
      const parsed = parseOkfDocument({ path: 'facts/release.md', content });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('The canonical fixture must parse.');
      expect(parsed.document.frontmatter.confidence).toBe(confidence);
      expect(parsed.document.frontmatter.custom_annotation).toEqual({
        confidence: 'not an assessment',
        retained: true,
      });
    }
  );

  it.each([undefined, null, '0.75', -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses missing or invalid Claim confidence %s',
    (confidence) => {
      const report = validate(page('Claim', { confidence }));
      expect(report.errors).toContainEqual(expect.objectContaining({ field: 'confidence' }));
    }
  );

  it.each(['unresolved', 'resolved'])(
    'retains only conflict-specific Claim state %s',
    (conflict_status) => {
      expect(validate(page('Claim', { confidence: 0.75, conflict_status }))).toMatchObject({
        conformance: 'scope-schema-valid',
        errors: [],
      });
    }
  );

  it.each([
    'none',
    'conflicting',
    'weak_evidence',
    'stale',
    'needs_review',
    'superseded',
    'partially_superseded',
    'unrecognized',
  ])('refuses overloaded or unsupported conflict state %s', (conflict_status) => {
    for (const type of ['Claim', 'Observation'] as const) {
      const report = validate(
        page(type, { confidence: 0.75, conflict_status, subject_refs: [subjectUri] })
      );
      expect(report.errors).toContainEqual(expect.objectContaining({ field: 'conflict_status' }));
    }
  });

  it('keeps freshness, Review, lifecycle and confidence independent from actual conflicts', () => {
    const content = page('Claim', {
      confidence: 0.1,
      freshness: 'stale',
      review_state: 'needs-review',
      openkit_status: 'superseded',
      status: 'deprecated',
    });
    expect(validate(content)).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
    const parsed = parseOkfDocument({ path: 'facts/release.md', content });
    if (!parsed.ok) throw new Error('The canonical fixture must parse.');
    expect(parsed.document.frontmatter).not.toHaveProperty('conflict_status');
    expect(parsed.document.frontmatter).toMatchObject({
      confidence: 0.1,
      freshness: 'stale',
      review_state: 'needs-review',
      openkit_status: 'superseded',
    });
  });

  it('keeps a reusable Observation non-active without inventing confidence or conflict state', () => {
    const content = page('Observation');
    expect(validate(content)).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
    const parsed = parseOkfDocument({ path: 'facts/release.md', content });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('The canonical fixture must parse.');
    expect(parsed.document.frontmatter.openkit_status).toBe('draft');
    expect(parsed.document.frontmatter).not.toHaveProperty('confidence');
    expect(parsed.document.frontmatter).not.toHaveProperty('conflict_status');
  });

  it('keeps subject-bound review and freshness without inventing an actual conflict', () => {
    const content = page('Observation', {
      subject_refs: [subjectUri],
      review_state: 'needs-review',
      freshness: 'stale',
    });
    expect(validate(content)).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
    const parsed = parseOkfDocument({ path: 'facts/release.md', content });
    if (!parsed.ok) throw new Error('The canonical fixture must parse.');
    expect(parsed.document.frontmatter).not.toHaveProperty('conflict_status');
    expect(parsed.document.frontmatter.subject_refs).toEqual([subjectUri]);
  });

  it('does not assign core assessment meaning to an Observation confidence annotation', () => {
    expect(validate(page('Observation', { confidence: 'author annotation' }))).toMatchObject({
      conformance: 'scope-schema-valid',
      errors: [],
    });
  });

  it.each([undefined, [], [{}]].map((value) => [value]))(
    'requires structured conflict subjects %j',
    (subject_refs) => {
      const report = validate(page('Observation', { conflict_status: 'unresolved', subject_refs }));
      expect(report.errors).toContainEqual(expect.objectContaining({ field: 'subject_refs' }));
    }
  );

  it('retains a canonical conflict subject separately from supporting source evidence', () => {
    const content = page('Observation', {
      conflict_status: 'unresolved',
      subject_refs: [subjectUri],
    });
    expect(validate(content)).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
    const parsed = parseOkfDocument({ path: 'facts/release.md', content });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('The canonical fixture must parse.');
    expect(parsed.document.frontmatter.subject_refs).toEqual([subjectUri]);
    expect(parsed.document.frontmatter.source_refs).toEqual([]);
  });

  it('refuses a plain string in place of an owner-qualified subject URI', () => {
    const report = validate(
      page('Observation', {
        conflict_status: 'unresolved',
        subject_refs: ['not-an-owner-reference'],
      })
    );
    expect(report.errors).toContainEqual(expect.objectContaining({ field: 'subject_refs' }));
  });

  it('refuses an unknown Observation conflict state', () => {
    const report = validate(
      page('Observation', { conflict_status: 'unrecognized', subject_refs: [] })
    );
    expect(report.errors).toContainEqual(expect.objectContaining({ field: 'conflict_status' }));
  });
});

function registerOkfScopedProfileTests() {
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
      required_features: features,
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

    // Generated scope IDs are inputs; collected case names must agree across separate processes.
    it.each([user, workspace, { kind: 'server' }])('accepts complete owner (case %#)', (scope) => {
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
    )('rejects an incomplete or contradictory owner (case %#)', (scope) => {
      expect(validateOpenKitKnowledgeProfile(parsedPage({ scope })).errors).toContainEqual(
        expect.objectContaining({ code: 'profile.invalid_scope', field: 'scope' })
      );
    });

    it.each([undefined, null, 'openkit.knowledge-owner-scope.v1', [1]].map((value) => [value]))(
      'rejects missing or malformed required features %j',
      (requiredFeatures) => {
        expect(
          validateOpenKitKnowledgeProfile(parsedPage({ required_features: requiredFeatures }))
            .errors
        ).toContainEqual(expect.objectContaining({ field: 'required_features' }));
      }
    );

    it.each([[], [features[0]], [features[1]]].map((value) => [value]))(
      'rejects an omitted v4 semantic %j',
      (requiredFeatures) => {
        expect(
          validateOpenKitKnowledgeProfile(parsedPage({ required_features: requiredFeatures }))
            .errors
        ).toContainEqual(
          expect.objectContaining({
            code: 'profile.missing_required_feature',
            field: 'required_features',
          })
        );
      }
    );

    it.each([
      ['absent', undefined],
      ['present', features],
    ] as const)('refuses the old key when the canonical key is %s', (_case, canonical) => {
      const document = parsedPage({
        required_features: canonical,
        requiredFeatures: ['openkit.future.v1'],
      });
      expect(validateOpenKitKnowledgeProfile(document).errors).toContainEqual(
        expect.objectContaining({
          code: 'profile.obsolete_authority_field',
          field: 'requiredFeatures',
        })
      );
      expect(isActiveOpenKitKnowledgePage(document)).toBe(false);
    });

    it('refuses unknown required semantics without rejecting the external OKF envelope', () => {
      const document = parsedPage({ required_features: [...features, 'openkit.future.v1'] });
      expect(validateOpenKitKnowledgeProfile(document)).toMatchObject({
        conformance: 'OKF-compatible',
        errors: [expect.objectContaining({ code: 'profile.unsupported_required_feature' })],
      });
    });

    it.each([{ owner_scope: workspace }, { openkit_revision: 1 }, { openkit_revision: '1' }])(
      'refuses a second owner or page counter (case %#)',
      (fields) => {
        expect(validateOpenKitKnowledgeProfile(parsedPage(fields)).errors).toContainEqual(
          expect.objectContaining({ code: 'profile.obsolete_authority_field' })
        );
      }
    );

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
    ])(
      'refuses a valid page owned by another admitted notebook (case %#)',
      (scope, expectedOwnerScope) => {
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
      }
    );

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
          parsedPage({ scope: 'workspace', required_features: undefined })
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
      [[1], [null], [{ reference: 'https://example.test' }], 'https://example.test'].map(
        (value) => [value]
      )
    )('keeps source_refs strict %j', (source_refs) => {
      expect(validateOpenKitKnowledgeProfile(parsedPage({ source_refs })).errors).toContainEqual(
        expect.objectContaining({ code: 'profile.invalid_source_refs' })
      );
    });
  });
}
registerOkfScopedProfileTests();
