import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { KernelCommandError } from './errors.js';
import { admitLightAppDefinition, admitLightAppSchema } from './schema.js';

const workspaceId = allocateEntityId('ws');
const knowledgeBaseId = allocateEntityId('kb');
const digest = `sha256:${'ab'.repeat(32)}`;
const page = {
  scopeId: `page/workspace/${workspaceId}/${knowledgeBaseId}`,
  objectId: 'entities/customer',
};
const references = [
  formatReferenceUri(page, digest),
  formatReferenceUri(
    { scopeId: `raw/server/${knowledgeBaseId}`, objectId: 'source evidence' },
    digest
  ),
];
const definition = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Customers',
  purpose: 'Track customer records.',
  collections: [
    {
      name: 'customers',
      type: 'base',
      description: 'Customer records.',
      fields: [{ name: 'name', type: 'text', required: false, description: 'Display name.' }],
      indexes: [],
    },
  ],
};
const appId = '0190f4c8-0000-7000-8000-000000000001';

describe('C03 definition admission', () => {
  it('preserves exact reference strings and order in reusable and live definitions', () => {
    const reusable = admitLightAppDefinition(JSON.stringify({ ...definition, references }));
    expect(reusable.references).toEqual(references);
    expect(admitLightAppSchema(reusable, appId, 1).references).toEqual(references);
  });

  it('writes an explicit empty list when the authored definition omits references', () => {
    expect(admitLightAppDefinition(definition).references).toEqual([]);
    expect(admitLightAppSchema(definition, appId, 1).references).toEqual([]);
  });

  it('changes only reference metadata when revising its list', () => {
    const first = admitLightAppSchema({ ...definition, references }, appId, 1);
    const reusable = admitLightAppDefinition({ ...definition, references });
    const nextReferences = [...references].reverse();
    const next = admitLightAppSchema(
      { ...reusable, collections: first.collections, references: nextReferences },
      appId,
      2,
      first
    );
    expect(next.references).toEqual(nextReferences);
    expect(next.collections).toEqual(first.collections);
    expect(next.purpose).toBe(first.purpose);
  });

  it.each([
    'not-a-reference',
    formatReferenceUri(page),
  ])('refuses an invalid exact target at writer admission: %s', (reference) => {
    expect(() => admitLightAppDefinition({ ...definition, references: [reference] })).toThrow(
      KernelCommandError
    );
  });
});
