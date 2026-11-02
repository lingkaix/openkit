import { createHash } from 'node:crypto';
import { formatReferenceUri } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT, updateOkfFrontmatter } from './okf.js';
import { previewSchemaIndexImpact, schemaCandidateTreeNeedsReview } from './scope-schema-impact.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const ownerScope = { kind: 'workspace', workspaceId } as const;
const pageScopeId = `page/workspace/${workspaceId}/kb_00000000-0000-7000-8000-000000000001`;
const sourceId = 'ks_00000000-0000-7000-8000-000000000001';
const sourceDigest = `sha256:${createHash('sha256').update('Exact captured Source.').digest('hex')}`;
const sourcePin = `source:${sourceId}@${sourceDigest}`;
const staleSourcePin = `source:${sourceId}@sha256:${'0'.repeat(64)}`;
const alpha = serializeKnowledgePageFixture(
  {
    title: 'Alpha',
    content: 'Exact target bytes.',
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  },
  ownerScope
);
const alphaDigest = `sha256:${createHash('sha256').update(alpha).digest('hex')}`;
const pagePin = formatReferenceUri({ scopeId: pageScopeId, objectId: 'alpha' }, alphaDigest);
const zeta = serializeKnowledgePageFixture(
  {
    title: 'Zeta',
    content: '[Alpha](alpha.md) [Missing](missing.md)',
    sourceReferences: [sourcePin, pagePin],
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  },
  ownerScope
);
const stale = serializeKnowledgePageFixture(
  {
    title: 'Stale',
    content: '[Alpha](alpha.md)',
    sourceReferences: [staleSourcePin],
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
  },
  ownerScope
);

it('classifies complete candidate trees against valid, restrictive and invalid schema content', () => {
  const files = {
    'index.md': '---\nokf_version: "0.2"\n---\n# Notebook\n',
    'alpha.md': alpha,
  };
  const input = { workspaceId, files, candidateSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT };
  expect(schemaCandidateTreeNeedsReview(input)).toBe(false);
  expect(
    schemaCandidateTreeNeedsReview({
      ...input,
      candidateSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
        /^allowed_types:.*$/m,
        'allowed_types: [Observation]'
      ),
    })
  ).toBe(true);
  expect(
    schemaCandidateTreeNeedsReview({ ...input, candidateSchemaText: 'schema_version: [broken' })
  ).toBe(true);
  expect(
    schemaCandidateTreeNeedsReview({
      ...input,
      files: { ...files, 'unchanged-malformed.md': '---\ntype: [broken\n---\n' },
    })
  ).toBe(true);
  expect(
    schemaCandidateTreeNeedsReview({
      ...input,
      files: { ...files, 'foreign.md': alpha.replace(workspaceId, `${workspaceId}-foreign`) },
    })
  ).toBe(true);
  expect(files['alpha.md']).toBe(alpha);
});

it('includes SourceSummary members and unchanged Pages in full candidate-tree eligibility', () => {
  const candidateSchemaText = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
    /^allowed_types:.*$/m,
    'allowed_types: [KnowledgePage]'
  );
  // These are pure schema inputs. Current Source descriptor/provenance admission stays with preview.
  const sourceSummary = updateOkfFrontmatter({
    path: `@sources/${sourceId}.md`,
    content: alpha,
    updates: { type: 'SourceSummary' },
  });
  const input = { workspaceId, candidateSchemaText, files: { 'alpha.md': alpha } };
  expect(schemaCandidateTreeNeedsReview(input)).toBe(false);
  expect(
    schemaCandidateTreeNeedsReview({
      ...input,
      candidateSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
      files: { ...input.files, [`@sources/${sourceId}.md`]: sourceSummary },
    })
  ).toBe(false);
  expect(
    schemaCandidateTreeNeedsReview({
      ...input,
      files: { ...input.files, [`@sources/${sourceId}.md`]: sourceSummary },
    })
  ).toBe(true);
  const unchangedObservation = updateOkfFrontmatter({
    path: 'unchanged-observation.md',
    content: alpha,
    updates: { type: 'Observation' },
  });
  expect(
    schemaCandidateTreeNeedsReview({
      ...input,
      files: { ...input.files, 'unchanged-observation.md': unchangedObservation },
    })
  ).toBe(true);
});

it('preserves the reserved-only and empty-tree predicate for an invalid schema', () => {
  const input = { workspaceId, candidateSchemaText: 'schema_version: [broken' };
  expect(schemaCandidateTreeNeedsReview({ ...input, files: {} })).toBe(false);
  expect(
    schemaCandidateTreeNeedsReview({
      ...input,
      files: { 'index.md': '---\nokf_version: "0.2"\n---\n# Notebook\n' },
    })
  ).toBe(false);
});

it('retains exact validation, source-reference and link facts for a comment-only schema change', () => {
  const files = {
    'zeta.md': zeta,
    'stale.md': stale,
    'alpha.md': alpha,
    // Source descriptor admission occurs before this content-only Page index projection.
    [`@sources/${sourceId}.md`]: 'Source members must not become indexed Pages.',
  };
  const registeredSources = new Map([[sourceId, sourceDigest]]);
  const originalFiles = { ...files };
  const originalSources = [...registeredSources];
  const impact = previewSchemaIndexImpact({
    files,
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    candidateSchemaText: `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}\n# Same constraints.\n`,
    pageScopeId,
    registeredSources,
  });
  expect(impact.map(({ id, needsReview }) => [id, needsReview])).toEqual([
    ['validation', false],
    ['source-references', false],
    ['links', false],
  ]);
  const [validation, references, links] = impact;
  expect(validation!.before).toEqual([
    expect.objectContaining({
      conceptId: 'alpha',
      path: 'knowledge/pages/alpha.md',
      contentDigest: alphaDigest,
      conformance: 'scope-schema-valid',
      active: true,
      indexed: true,
      errors: [],
    }),
    expect.objectContaining({ conceptId: 'stale', indexed: false }),
    expect.objectContaining({ conceptId: 'zeta', indexed: true, errors: [] }),
  ]);
  expect(references!.before).toEqual([
    {
      conceptId: 'stale',
      path: 'knowledge/pages/stale.md',
      reference: staleSourcePin,
      kind: 'registered-source',
      targetId: sourceId,
      resolved: false,
    },
    {
      conceptId: 'zeta',
      path: 'knowledge/pages/zeta.md',
      reference: pagePin,
      kind: 'workspace-knowledge',
      targetId: 'alpha',
      resolved: true,
    },
    {
      conceptId: 'zeta',
      path: 'knowledge/pages/zeta.md',
      reference: sourcePin,
      kind: 'registered-source',
      targetId: sourceId,
      resolved: true,
    },
  ]);
  expect(links!.before).toEqual([
    { fromId: 'zeta', target: 'alpha.md', toId: 'alpha', resolved: true },
    { fromId: 'zeta', target: 'missing.md', toId: 'missing', resolved: false },
  ]);
  for (const row of impact) expect(row.after).toEqual(row.before);
  expect(files).toEqual(originalFiles);
  expect([...registeredSources]).toEqual(originalSources);
});

it('keeps broad indexChanged review flags even when source-reference facts do not change', () => {
  const files = { 'zeta.md': zeta, 'alpha.md': alpha };
  const impact = previewSchemaIndexImpact({
    files,
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    candidateSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
      /^allowed_types:.*$/m,
      'allowed_types: [Observation]'
    ),
    pageScopeId,
    registeredSources: new Map([[sourceId, sourceDigest]]),
  });
  // Characterize the existing broad flag; this extraction must not introduce class admission.
  expect(impact.map(({ id, needsReview }) => [id, needsReview])).toEqual([
    ['validation', true],
    ['source-references', true],
    ['links', true],
  ]);
  const [validation, references, links] = impact;
  expect(validation!.after).toEqual([
    expect.objectContaining({
      conceptId: 'alpha',
      contentDigest: alphaDigest,
      active: true,
      indexed: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'scope_schema.type_not_allowed', field: 'type' }),
      ]),
    }),
    expect.objectContaining({ conceptId: 'zeta', indexed: false }),
  ]);
  expect(references!.after).toEqual(references!.before);
  expect(references!.before).toHaveLength(2);
  expect(links!.before).toHaveLength(2);
  expect(links!.after).toEqual([]);
});

it('marks each index for review under an invalid candidate even when all projections are empty', () => {
  const input = {
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    candidateSchemaText: 'schema_version: [broken',
    pageScopeId,
    registeredSources: new Map<string, string | null>(),
  };
  expect(previewSchemaIndexImpact({ ...input, files: {} })).toEqual([
    { id: 'validation', needsReview: true, before: [], after: [] },
    { id: 'source-references', needsReview: true, before: [], after: [] },
    { id: 'links', needsReview: true, before: [], after: [] },
  ]);
  const populated = previewSchemaIndexImpact({ ...input, files: { 'alpha.md': alpha } });
  expect(populated.map(({ needsReview }) => needsReview)).toEqual([true, true, true]);
  expect(populated[0]!.after).toEqual([
    expect.objectContaining({
      conceptId: 'alpha',
      contentDigest: alphaDigest,
      indexed: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'okf.invalid_yaml' })]),
    }),
  ]);
  expect(populated[2]!.after).toEqual([]);
});
