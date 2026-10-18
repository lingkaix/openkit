import { createHash } from 'node:crypto';
import { EMPTY_RESOURCE_CATALOG, stableJson } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { CatalogIntegrityError, validateLightAppDefinitionCatalog } from './resource-catalog.js';

/** Retained canonical definitions must carry their list, even when authored omission is allowed. */
it('refuses retained catalog definition bytes with an omitted meaning-reference list', () => {
  const catalog = structuredClone(EMPTY_RESOURCE_CATALOG);
  const definition = {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Retained definition',
    purpose: 'Label',
    collections: [
      {
        id: allocateEntityId('col'),
        name: 'notes',
        type: 'base',
        description: 'Local notes',
        fields: [
          {
            id: allocateEntityId('fld'),
            name: 'note',
            type: 'text',
            required: false,
            description: 'Note',
          },
        ],
        indexes: [],
      },
    ],
  };
  const definitionJson = stableJson(definition);
  catalog.lightApps.entries.push({
    id: 'meaning-notes',
    displayName: 'Notes',
    availability: 'available',
    currentDigest: null,
  });
  catalog.lightApps.versions.push({
    entryId: 'meaning-notes',
    digest: `sha256:${createHash('sha256').update(definitionJson).digest('hex')}`,
    parentDigest: null,
    producer: { kind: 'user', id: 'fixture-author' },
    createdAt: '2026-10-18T18:00:00.000Z',
    definitionJson,
  });
  expect(() => validateLightAppDefinitionCatalog(catalog)).toThrow(CatalogIntegrityError);
});
