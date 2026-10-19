import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { OpenKitConfigSchema } from './server.js';
import { UserConfigSchema } from './user.js';
import { WorkspaceConfigSchema } from './workspace.js';

const knowledgeBaseId = allocateEntityId('kb');
const otherKnowledgeBaseId = allocateEntityId('kb');
const managed = {
  name: 'managed',
  backend: 'local',
  root: 'raw',
  default: true,
  knowledgeBaseId,
};
const additional = {
  name: 'archive',
  backend: 'local',
  root: 'archives',
  default: false,
  knowledgeBaseId,
};
const owners = [
  {
    name: 'User',
    schema: UserConfigSchema,
    input: (settings: Record<string, unknown>) => ({ schemaVersion: 1, ...settings }),
    mountPath: 'knowledgeMounts',
  },
  {
    name: 'Server',
    schema: OpenKitConfigSchema,
    input: (settings: Record<string, unknown>) => ({ schemaVersion: 1, ...settings }),
    mountPath: 'knowledgeMounts',
  },
  {
    name: 'Workspace',
    schema: WorkspaceConfigSchema,
    input: (settings: Record<string, unknown>) => ({
      schemaVersion: 1,
      workspace: { name: 'Mount declaration fixture', ...settings },
    }),
    mountPath: 'workspace.knowledgeMounts',
  },
];

describe('retained Knowledge mount declarations', () => {
  it.each(owners)('preserves exact declarations in the $name configuration owner', (owner) => {
    const knowledgeMounts = [
      managed,
      additional,
      {
        name: 'future-library',
        backend: 'unsupported-backend',
        root: 'future-library',
        default: false,
        knowledgeBaseId,
      },
    ];
    // Declaration parsing preserves an unsupported backend; activation must not infer a local one.
    expect(
      owner.schema.parse(owner.input({ defaultKnowledgeBaseId: knowledgeBaseId, knowledgeMounts }))
    ).toHaveProperty(owner.mountPath, knowledgeMounts);
  });

  it.each([
    ['empty mount array', []],
    ['no default mount', [{ ...managed, default: false }, additional]],
    ['two default mounts', [managed, { ...additional, default: true }]],
    ['duplicate mount names', [managed, { ...additional, name: managed.name }]],
    ['empty name', [{ ...managed, name: '' }]],
    ['empty backend', [{ ...managed, backend: '' }]],
    ['empty root', [{ ...managed, root: '' }]],
    ['nonboolean default', [{ ...managed, default: 'true' }]],
    ['foreign default Knowledge Base', [{ ...managed, knowledgeBaseId: otherKnowledgeBaseId }]],
    [
      'foreign additional Knowledge Base',
      [managed, { ...additional, knowledgeBaseId: otherKnowledgeBaseId }],
    ],
    ['nonarray declarations', managed],
    ...['name', 'backend', 'root', 'default', 'knowledgeBaseId'].map((field) => [
      `missing ${field}`,
      [Object.fromEntries(Object.entries(managed).filter(([key]) => key !== field))],
    ]),
  ])('rejects %s at every scope owner', (_name, knowledgeMounts) => {
    const accepted = owners.map(
      (owner) =>
        owner.schema.safeParse(
          owner.input({ defaultKnowledgeBaseId: knowledgeBaseId, knowledgeMounts })
        ).success
    );
    expect(accepted).toEqual([false, false, false]);
  });

  it('refuses declarations without the scope fixed Knowledge Base binding', () => {
    expect(
      owners.map(
        (owner) => owner.schema.safeParse(owner.input({ knowledgeMounts: [managed] })).success
      )
    ).toEqual([false, false, false]);
  });

  it('does not allocate declarations or a default binding while parsing an uncreated scope', () => {
    for (const owner of owners) {
      const config = owner.schema.parse(owner.input({}));
      expect(config).not.toHaveProperty(owner.mountPath);
      expect(config).not.toHaveProperty(
        owner.mountPath.replace('knowledgeMounts', 'defaultKnowledgeBaseId')
      );
    }
  });
});
