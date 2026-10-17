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
    ).toEqual(selected);
    expect(
      WorkspaceConfigSchema.parse({ workspace: { name: 'Work', knowledgeMaintenance: selected } })
        .workspace.knowledgeMaintenance
    ).toEqual(selected);
    expect(
      OpenKitConfigSchema.parse({ knowledgeMaintenance: selected }).knowledgeMaintenance
    ).toEqual(selected);
    expect(UserConfigSchema.parse({ schemaVersion: 1 }).knowledgeMaintenance).toBeUndefined();
    expect(
      WorkspaceConfigSchema.parse({ workspace: { name: 'Work' } }).workspace.knowledgeMaintenance
    ).toBeUndefined();
    expect(OpenKitConfigSchema.parse({}).knowledgeMaintenance).toBeUndefined();
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
    ).toEqual({ enabled: true, reviewRequiredPageIds: ['protected'] });
  });
});
