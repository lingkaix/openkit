import { allocateEntityId, formatReferenceUri, type KnowledgeOwnerScope } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  parseOkfDocument,
  REQUIRED_SCOPED_KNOWLEDGE_FEATURES,
  validateKnowledgePageCandidate,
} from './okf.js';

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
    requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
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
  it.each([
    0, 0.75, 1,
  ])('preserves numeric Claim confidence %s and descriptive extensions', (confidence) => {
    const content = page('Claim', {
      confidence,
      conflict_status: 'none',
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
  });

  it.each([
    undefined,
    null,
    '0.75',
    -0.01,
    1.01,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('refuses missing or invalid Claim confidence %s', (confidence) => {
    const report = validate(page('Claim', { confidence, conflict_status: 'none' }));
    expect(report.errors).toContainEqual(expect.objectContaining({ field: 'confidence' }));
  });

  it.each([
    undefined,
    'unrecognized',
  ])('refuses an absent or unknown Claim conflict state %s', (conflict_status) => {
    const report = validate(page('Claim', { confidence: 0.75, conflict_status }));
    expect(report.errors).toContainEqual(expect.objectContaining({ field: 'conflict_status' }));
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

  it('refuses nonnumeric Observation confidence when an assessment is present', () => {
    expect(validate(page('Observation', { confidence: 'high' })).errors).toContainEqual(
      expect.objectContaining({ field: 'confidence' })
    );
  });

  it.each(
    [undefined, [], [{}]].map((value) => [value])
  )('requires structured conflict subjects %j', (subject_refs) => {
    const report = validate(page('Observation', { conflict_status: 'conflicting', subject_refs }));
    expect(report.errors).toContainEqual(expect.objectContaining({ field: 'subject_refs' }));
  });

  it('retains a canonical conflict subject separately from supporting source evidence', () => {
    const content = page('Observation', {
      conflict_status: 'conflicting',
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
        conflict_status: 'conflicting',
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
