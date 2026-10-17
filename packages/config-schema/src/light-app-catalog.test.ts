import { describe, expect, it } from 'vitest';
import {
  EMPTY_RESOURCE_CATALOG,
  LightAppDefinitionVersionRecordSchema,
  parseResourceCatalogDocument,
  ResourceCatalogDocumentSchema,
  ResourceCatalogDocumentViewSchema,
} from './resource-catalog.js';

const digest = `sha256:${'1'.repeat(64)}`;
const version = {
  createdAt: '2026-10-17T00:00:00.000Z',
  definitionJson: '{"collections":[]}',
  digest,
  entryId: 'admissions',
  parentDigest: null,
  producer: { id: 'user-1', kind: 'user' },
};

describe('Light App resource catalog records', () => {
  it('loads existing documents with an empty additive definition group', () => {
    const { lightApps: _lightApps, ...prior } = EMPTY_RESOURCE_CATALOG;
    expect(parseResourceCatalogDocument(prior).lightApps).toEqual({
      entries: [],
      pins: [],
      versions: [],
    });
  });

  it('keeps stable catalog IDs and bounded inline definition strings exact', () => {
    expect(LightAppDefinitionVersionRecordSchema.safeParse(version).success).toBe(true);
    expect(
      LightAppDefinitionVersionRecordSchema.safeParse({ ...version, entryId: 'Bad_ID' }).success
    ).toBe(false);
    expect(
      LightAppDefinitionVersionRecordSchema.safeParse({
        ...version,
        definitionJson: 'x'.repeat(262_145),
      }).success
    ).toBe(false);
    expect(
      LightAppDefinitionVersionRecordSchema.safeParse({ ...version, script: 'run()' }).success
    ).toBe(false);
  });

  it('preserves same-owner history annotations and drops them from public projections', () => {
    const document = {
      ...EMPTY_RESOURCE_CATALOG,
      lightApps: {
        entries: [
          {
            availability: 'available',
            currentDigest: digest,
            displayName: 'Admissions',
            id: 'admissions',
            annotation: 'entry',
          },
        ],
        pins: [{ digest, entryId: 'admissions', annotation: 'pin' }],
        versions: [
          {
            ...version,
            annotation: 'history',
            producer: { ...version.producer, annotation: 'actor' },
          },
        ],
        annotation: 'group',
      },
    };
    expect(ResourceCatalogDocumentSchema.safeParse(document).success).toBe(false);
    const retained = parseResourceCatalogDocument(document);
    expect(retained.lightApps).toEqual(document.lightApps);
    expect(ResourceCatalogDocumentViewSchema.parse(retained).lightApps.versions[0]).toEqual(
      version
    );
  });
});
