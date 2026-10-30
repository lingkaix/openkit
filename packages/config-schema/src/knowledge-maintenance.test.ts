import { RETAINED_FORMAT_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { KnowledgeMaintenanceSchema } from './knowledge-maintenance.js';
import { OpenKitConfigSchema } from './server.js';
import { UserConfigSchema } from './user.js';
import { WorkspaceConfigSchema } from './workspace.js';

describe('Authored scoped notebook maintenance settings', () => {
  it('preserves each owner selection without enabling an omitted setting', () => {
    const selected = { enabled: false, reviewRequiredPageIds: ['rules/release', 'index'] };
    expect(
      UserConfigSchema.parse({ schemaVersion: 1, knowledgeMaintenance: selected })
        .knowledgeMaintenance
    ).toEqual({ ...selected, schedule: { enabled: false } });
    expect(
      WorkspaceConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        workspace: { name: 'Work', knowledgeMaintenance: selected },
      }).workspace.knowledgeMaintenance
    ).toEqual({ ...selected, schedule: { enabled: false } });
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        knowledgeMaintenance: selected,
      }).knowledgeMaintenance
    ).toEqual({ ...selected, schedule: { enabled: false } });
    expect(UserConfigSchema.parse({ schemaVersion: 1 }).knowledgeMaintenance).toBeUndefined();
    expect(
      WorkspaceConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        workspace: { name: 'Work' },
      }).workspace.knowledgeMaintenance
    ).toBeUndefined();
    expect(
      OpenKitConfigSchema.parse({ schemaVersion: RETAINED_FORMAT_VERSION }).knowledgeMaintenance
    ).toBeUndefined();
  });

  it('enables the daily schedule separately from publication delegation in each scope', () => {
    const selected = {
      enabled: false,
      reviewRequiredPageIds: [],
      schedule: { enabled: true },
    };
    expect(
      UserConfigSchema.parse({ schemaVersion: 1, knowledgeMaintenance: selected })
        .knowledgeMaintenance
    ).toEqual(selected);
    expect(
      WorkspaceConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        workspace: { name: 'Work', knowledgeMaintenance: selected },
      }).workspace.knowledgeMaintenance
    ).toEqual(selected);
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        knowledgeMaintenance: selected,
      }).knowledgeMaintenance
    ).toEqual(selected);
    expect(KnowledgeMaintenanceSchema.parse({ ...selected, schedule: {} }).schedule.enabled).toBe(
      false
    );
    expect(
      KnowledgeMaintenanceSchema.safeParse({ ...selected, schedule: { enabled: 'yes' } }).success
    ).toBe(false);
  });

  it.each([
    { enabled: 'yes', reviewRequiredPageIds: [] },
    { enabled: true },
    { reviewRequiredPageIds: [] },
    { enabled: false, reviewRequiredPageIds: ['rules', 'rules'] },
    { enabled: true, reviewRequiredPageIds: ['../rules'] },
    { enabled: true, reviewRequiredPageIds: ['/rules'] },
    { enabled: true, reviewRequiredPageIds: ['rules.md'] },
    { enabled: true, reviewRequiredPageIds: ['a\\b'] },
    { enabled: true, reviewRequiredPageIds: [''] },
  ])('rejects invalid authority-bearing fields: %j', (value) => {
    expect(KnowledgeMaintenanceSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    {
      scope: 'User',
      parse: (knowledgeMaintenance: unknown) =>
        UserConfigSchema.safeParse({ schemaVersion: 1, knowledgeMaintenance }),
    },
    {
      scope: 'Workspace',
      parse: (knowledgeMaintenance: unknown) =>
        WorkspaceConfigSchema.safeParse({
          schemaVersion: RETAINED_FORMAT_VERSION,
          workspace: { name: 'Work', knowledgeMaintenance },
        }),
    },
    {
      scope: 'Server',
      parse: (knowledgeMaintenance: unknown) =>
        OpenKitConfigSchema.safeParse({
          schemaVersion: RETAINED_FORMAT_VERSION,
          knowledgeMaintenance,
        }),
    },
  ])('rejects unknown maintenance authority in $scope configuration', ({ parse }) => {
    const selected = {
      enabled: true,
      reviewRequiredPageIds: ['protected'],
      schedule: { enabled: true },
    };
    expect(parse(selected).success).toBe(true);

    // NanoCore Config Identity Contract: strict authority replaces the prior tolerant note oracle.
    for (const unsupported of [
      { ...selected, note: 'Future description' },
      { ...selected, schedule: { enabled: true, futureAuthority: true } },
    ])
      expect.soft(parse(unsupported).success).toBe(false);
  });
});
