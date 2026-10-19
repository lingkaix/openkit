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

  it('ignores additive descriptive fields without changing the exact protected set', () => {
    expect(
      KnowledgeMaintenanceSchema.parse({
        enabled: true,
        reviewRequiredPageIds: ['protected'],
        note: 'Future description',
      })
    ).toEqual({
      enabled: true,
      reviewRequiredPageIds: ['protected'],
      schedule: { enabled: false },
    });
  });
});
