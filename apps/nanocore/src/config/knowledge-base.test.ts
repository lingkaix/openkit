import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEntityId, type KnowledgeOwnerScope } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDefaultKnowledgeBaseId, readDefaultKnowledgeBaseId } from './knowledge-base.js';
import { createRuntimeConfigManager } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const userId = 'usr_0190f4c8-0000-7000-8000-000000000001';
const workspaceId = 'ws_0190f4c8-0000-7000-8000-000000000002';
const roots: string[] = [];

function temporaryDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-default-kb-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('retained default Knowledge Base identity', () => {
  it.each([
    {
      scope: { kind: 'user', userId },
      path: `users/${userId}/config/user.jsonc`,
      content: '{"schemaVersion":1}',
    },
    {
      scope: { kind: 'workspace', workspaceId },
      path: `workspaces/${workspaceId}/config/workspace.jsonc`,
      content: '{"workspace":{"name":"Research"}}',
    },
    { scope: { kind: 'server' }, path: 'config/server.jsonc', content: '{}' },
  ] as const)('allocates once for $scope.kind and preserves the retained binding across fresh readers', ({
    scope,
    path,
    content,
  }) => {
    const dataRoot = temporaryDataRoot();
    const target = join(dataRoot, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `// Retain this authored comment.\n${content}\n`);
    const input = { dataRoot, scope };
    const id = initializeDefaultKnowledgeBaseId(input);
    expect(isEntityId('kb', id)).toBe(true);
    const retained = readFileSync(target, 'utf8');
    expect(retained).toContain('// Retain this authored comment.');
    expect(readDefaultKnowledgeBaseId({ dataRoot, scope: { ...scope } })).toBe(id);
    expect(initializeDefaultKnowledgeBaseId(input)).toBe(id);
    expect(readFileSync(target, 'utf8')).toBe(retained);
  });

  it.each([
    {
      scope: { kind: 'user', userId },
      path: `users/${userId}/config/user.jsonc`,
      id: `users/${userId}/user.jsonc`,
      kind: 'user',
      content: '{"schemaVersion":1}',
    },
    {
      scope: { kind: 'workspace', workspaceId },
      path: `workspaces/${workspaceId}/config/workspace.jsonc`,
      id: `workspaces/${workspaceId}/workspace.jsonc`,
      kind: 'workspace',
      content: '{"workspace":{"name":"Research"}}',
    },
    {
      scope: { kind: 'server' },
      path: 'config/server.jsonc',
      id: 'server.jsonc',
      kind: 'server',
      content: '{}',
    },
  ] as const)('refuses removal or replacement of the $kind binding through ordinary configuration editing', ({
    scope,
    path,
    id,
    kind,
    content,
  }) => {
    const dataRoot = temporaryDataRoot();
    const target = join(dataRoot, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
    const retainedId = initializeDefaultKnowledgeBaseId({ dataRoot, scope });
    const retained = readFileSync(target, 'utf8');
    const manager = createRuntimeConfigManager({ dataRoot });
    const service = new RuntimeConfigFileService({
      dataRoot,
      workspaceIds: [workspaceId],
      userId,
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const expectedRevision = service.readFile(id).file.revision;
    const replacement = retained.replace(retainedId, 'kb_0190f4c8-0000-7000-8000-0000000000ff');
    for (const draft of [replacement, content]) {
      expect(() => service.updateFile({ id, kind, content: draft, expectedRevision })).toThrow(
        'Default Knowledge Base identity is assigned at creation and cannot be edited.'
      );
      expect(readFileSync(target, 'utf8')).toBe(retained);
    }
    expect(service.updateFile({ id, kind, content: retained, expectedRevision }).file.exists).toBe(
      true
    );
  });

  it('does not create configuration or allocate on lookup', () => {
    const dataRoot = temporaryDataRoot();
    expect(() => readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'server' } })).toThrow(
      'recovery required'
    );
    expect(existsSync(join(dataRoot, 'config'))).toBe(false);
  });

  it('does not replace a missing established binding during initialization', () => {
    const dataRoot = temporaryDataRoot();
    mkdirSync(join(dataRoot, 'server', 'knowledge', 'notebook.git'), { recursive: true });
    expect(() => initializeDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'server' } })).toThrow(
      'recovery required'
    );
    expect(existsSync(join(dataRoot, 'config'))).toBe(false);
  });

  it.each([
    'kb_0190f4c8-0000-5000-8000-000000000001',
    'ws_0190f4c8-0000-7000-8000-000000000001',
    'malformed',
  ])('refuses invalid retained identity %s without rewriting its owner', (defaultKnowledgeBaseId) => {
    const dataRoot = temporaryDataRoot();
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    const target = join(dataRoot, 'config', 'server.jsonc');
    const source = JSON.stringify({ defaultKnowledgeBaseId });
    writeFileSync(target, source);
    const input = { dataRoot, scope: { kind: 'server' } as KnowledgeOwnerScope };
    expect(() => readDefaultKnowledgeBaseId(input)).toThrow('recovery required');
    expect(() => initializeDefaultKnowledgeBaseId(input)).toThrow('recovery required');
    expect(readFileSync(target, 'utf8')).toBe(source);
  });
});
