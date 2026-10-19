import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { LightAppAdmittedSchemaSchema, LightAppSchemaInputSchema } from './light-apps.js';

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
const skill = formatReferenceUri(
  { scopeId: `skill/workspace/${workspaceId}`, objectId: 'customer-process' },
  digest
);
const definition = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Customers',
  purpose: 'Track customer records.',
  collections: [
    {
      id: allocateEntityId('col'),
      name: 'customers',
      type: 'base',
      description: 'Customer records.',
      fields: [
        {
          id: allocateEntityId('fld'),
          name: 'name',
          type: 'text',
          required: false,
          description: 'Display name.',
        },
      ],
      indexes: [],
    },
  ],
};

describe('Light App meaning references', () => {
  it('preserves ordered canonical pinned page and raw references', () => {
    expect(LightAppSchemaInputSchema.parse({ ...definition, references }).references).toEqual(
      references
    );
  });

  it('preserves exact pinned Skill targets in authored and admitted definitions', () => {
    expect(
      LightAppSchemaInputSchema.parse({ ...definition, references: [skill] }).references
    ).toEqual([skill]);
    expect(
      LightAppAdmittedSchemaSchema.parse({
        ...definition,
        references: [skill],
        appId: '0190f4c8-0000-7000-8000-000000000001',
        schemaRevision: 1,
      }).references
    ).toEqual([skill]);
  });

  it('permits authored omission but requires an explicit admitted list', () => {
    expect(LightAppSchemaInputSchema.safeParse(definition).success).toBe(true);
    const admitted = {
      ...definition,
      appId: '0190f4c8-0000-7000-8000-000000000001',
      schemaRevision: 1,
    };
    expect(LightAppAdmittedSchemaSchema.safeParse(admitted).success).toBe(false);
    expect(LightAppAdmittedSchemaSchema.parse({ ...admitted, references: [] }).references).toEqual(
      []
    );
  });

  it.each([
    'not-a-reference',
    skill.replace(`@${digest}`, ''),
    formatReferenceUri(page),
    formatReferenceUri({ scopeId: `raw/server/${knowledgeBaseId}`, objectId: 'source evidence' }),
    formatReferenceUri(
      { scopeId: `artifact/workspace/${workspaceId}`, objectId: allocateEntityId('ar') },
      digest
    ),
  ])('refuses malformed, unpinned or non-meaning targets: %s', (reference) => {
    expect(
      LightAppSchemaInputSchema.safeParse({ ...definition, references: [reference] }).success
    ).toBe(false);
    expect(
      LightAppAdmittedSchemaSchema.safeParse({
        ...definition,
        references: [reference],
        appId: '0190f4c8-0000-7000-8000-000000000001',
        schemaRevision: 1,
      }).success
    ).toBe(false);
  });
});
