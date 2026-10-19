import { RETAINED_FORMAT_VERSION } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { OpenKitConfigSchema } from './server.js';
import { UserConfigSchema } from './user.js';
import { WorkspaceConfigSchema } from './workspace.js';

const knowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';

describe('retained default Knowledge Base configuration', () => {
  it('preserves the independently allocated ID at each scope owner', () => {
    expect(
      UserConfigSchema.parse({ schemaVersion: 1, defaultKnowledgeBaseId: knowledgeBaseId })
    ).toHaveProperty('defaultKnowledgeBaseId', knowledgeBaseId);
    expect(
      OpenKitConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        defaultKnowledgeBaseId: knowledgeBaseId,
      })
    ).toHaveProperty('defaultKnowledgeBaseId', knowledgeBaseId);
    expect(
      WorkspaceConfigSchema.parse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        workspace: { name: 'Work', defaultKnowledgeBaseId: knowledgeBaseId },
      }).workspace
    ).toHaveProperty('defaultKnowledgeBaseId', knowledgeBaseId);
  });

  it.each([
    'ws_00000000-0000-7000-8000-000000000001',
    'kb_00000000-0000-5000-8000-000000000001',
    'kb_00000000-0000-4000-8000-000000000001',
    'kb_00000000-0000-7000-0000-000000000001',
    'kb_not-a-uuid',
    '',
    null,
  ])('rejects a noncanonical Knowledge Base identity at every owner: %j', (id) => {
    expect(
      UserConfigSchema.safeParse({ schemaVersion: 1, defaultKnowledgeBaseId: id }).success
    ).toBe(false);
    expect(
      OpenKitConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        defaultKnowledgeBaseId: id,
      }).success
    ).toBe(false);
    expect(
      WorkspaceConfigSchema.safeParse({
        schemaVersion: RETAINED_FORMAT_VERSION,
        workspace: { name: 'Work', defaultKnowledgeBaseId: id },
      }).success
    ).toBe(false);
  });

  it('does not allocate or insert an omitted binding while parsing an uncreated scope', () => {
    const user = { schemaVersion: 1 };
    const server = { schemaVersion: RETAINED_FORMAT_VERSION };
    const workspace = { schemaVersion: RETAINED_FORMAT_VERSION, workspace: { name: 'Work' } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(UserConfigSchema.parse(user)).not.toHaveProperty('defaultKnowledgeBaseId');
      expect(OpenKitConfigSchema.parse(server)).not.toHaveProperty('defaultKnowledgeBaseId');
      expect(WorkspaceConfigSchema.parse(workspace).workspace).not.toHaveProperty(
        'defaultKnowledgeBaseId'
      );
    }
    expect(user).toEqual({ schemaVersion: 1 });
    expect(server).toEqual({ schemaVersion: RETAINED_FORMAT_VERSION });
    expect(workspace).toEqual({
      schemaVersion: RETAINED_FORMAT_VERSION,
      workspace: { name: 'Work' },
    });
  });
});
