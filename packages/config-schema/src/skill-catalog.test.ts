import { describe, expect, it } from 'vitest';
import {
  EMPTY_RESOURCE_CATALOG,
  parseResourceCatalogDocument,
  ResourceCatalogDocumentViewSchema,
  SkillVersionRecordSchema,
} from './resource-catalog.js';

/** Historical candidate metadata without current decision authority. */
function candidateCatalog() {
  return {
    ...EMPTY_RESOURCE_CATALOG,
    skills: {
      ...EMPTY_RESOURCE_CATALOG.skills,
      candidates: [
        {
          baseDigest: null,
          candidateDigest: `sha256:${'a'.repeat(64)}`,
          createdAt: '2026-10-16T00:00:00.000Z',
          disposition: 'rejected',
          entryId: 'alpha',
          evidenceRefs: [],
          id: 'candidate_fixture',
          producer: { id: 'agent_fixture', kind: 'agent' },
          summary: 'Historical candidate.',
        },
      ],
    },
  };
}

describe('Skill decision lineage', () => {
  it('defaults old version retention and refuses unknown content states', () => {
    const version = {
      createdAt: '2026-10-16T00:00:00.000Z',
      digest: `sha256:${'a'.repeat(64)}`,
      digestFormat: 'openkit-tree-v1',
      entryId: 'alpha',
      inventory: [],
      producer: { id: 'user_fixture', kind: 'user' },
      provenance: {},
    };
    expect(SkillVersionRecordSchema.parse(version).contentState).toBe('retained');
    expect(
      SkillVersionRecordSchema.safeParse({ ...version, contentState: 'unknown' }).success
    ).toBe(false);
  });

  it('reads old terminal metadata without inventing actor or Audit authority', () => {
    const retained = parseResourceCatalogDocument(candidateCatalog());
    expect(retained.skills.candidates[0]?.decision).toBeNull();
    expect(retained.skills.candidates[0]?.submitter).toBeNull();
    expect(retained.skills.candidates[0]?.disposition).toBe('rejected');
  });

  it('preserves decision annotations at the owner and strips them from public projections', () => {
    const input = candidateCatalog();
    const decision = {
      actor: { id: 'user_fixture', kind: 'user', futureAnnotation: 'actor description' },
      auditRef: 'audit_fixture',
      decidedAt: '2026-10-16T00:01:00.000Z',
      futureAnnotation: 'decision description',
    };
    Object.assign(input.skills.candidates[0]!, { decision });
    Object.assign(input.skills.candidates[0]!, {
      submitter: { id: 'user_submitter', kind: 'user', futureAnnotation: 'submitter description' },
    });
    const retained = parseResourceCatalogDocument(input);
    expect(retained.skills.candidates[0]?.decision).toEqual(decision);
    const view = ResourceCatalogDocumentViewSchema.parse(retained);
    expect(view.skills.candidates[0]?.decision).toEqual({
      actor: { id: 'user_fixture', kind: 'user' },
      auditRef: 'audit_fixture',
      decidedAt: '2026-10-16T00:01:00.000Z',
    });
    expect(view.skills.candidates[0]?.submitter).toEqual({ id: 'user_submitter', kind: 'user' });
    Object.assign(decision.actor, { kind: 'unknown-authority' });
    expect(() => parseResourceCatalogDocument(input)).toThrow();
    Object.assign(decision.actor, { kind: 'user' });
    decision.auditRef = '';
    expect(() => parseResourceCatalogDocument(input)).toThrow();
  });
});
