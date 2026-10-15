import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceConfigSchema } from '@openkit/config-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { importWorkspaceSkill } from '../catalog/resource-catalog.js';
import { parseJsoncObject } from './jsonc.js';
import { createRuntimeConfigManager, loadRuntimeConfig } from './runtime-config.js';

const dataRoots: string[] = [];

afterEach(() => {
  for (const root of dataRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates an isolated authored Workspace file with two existing catalog Skills. */
function createSelectionFixture(): { dataRoot: string; path: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-assistant-selection-'));
  dataRoots.push(dataRoot);
  let revision = 0;
  for (const id of ['skill-review', 'skill-research']) {
    const imported = importWorkspaceSkill({
      activate: true,
      createdAt: '2026-10-15T00:00:00.000Z',
      dataRoot,
      displayName: id,
      expectedRevision: revision,
      id,
      producer: { kind: 'user', id: 'user_local' },
      tree: [
        {
          kind: 'file',
          path: 'SKILL.md',
          contentBase64: Buffer.from(`# ${id}\n`).toString('base64'),
        },
      ],
      workspaceId: 'ws_selection',
    });
    revision = imported.catalog.revision;
  }
  const path = join(dataRoot, 'workspaces', 'ws_selection', 'config', 'workspace.jsonc');
  mkdirSync(join(path, '..'), { recursive: true });
  return { dataRoot, path };
}

/** Keeps comments and a harmless future field in authored bytes, outside authority objects. */
function authoredSelection(assistant?: unknown): string {
  return `// Workspace-owned Assistant selection\n${JSON.stringify(
    {
      schemaVersion: 1,
      futureDisplayHint: 'compact',
      workspace: {
        name: 'Resource selection',
        ...(assistant === undefined ? {} : { assistant }),
      },
    },
    null,
    2
  )}\n`;
}

describe('Assistant resource selection configuration seam', () => {
  it('carries real schema output through file load, reload and restart without rewriting source', () => {
    const { dataRoot, path } = createSelectionFixture();
    const inspection = { enabled: false, excludedPaths: ['private'] };
    const initialBytes = authoredSelection({
      repositoryInspection: inspection,
      resources: { skillIds: ['skill-review'] },
    });
    const produced = WorkspaceConfigSchema.parse(parseJsoncObject(initialBytes, path));
    writeFileSync(path, initialBytes);

    const manager = createRuntimeConfigManager({ dataRoot });
    const initial = manager.current();
    expect(initial.workspaceConfigs[0]?.config).toEqual(produced);
    expect(initial.workspaceConfigs[0]?.config.workspace.assistant).toEqual({
      repositoryInspection: inspection,
      resources: { skillIds: ['skill-review'] },
    });
    expect(readFileSync(path, 'utf8')).toBe(initialBytes);
    expect(initial.diagnostics).not.toContainEqual(expect.objectContaining({ severity: 'error' }));

    const nextBytes = authoredSelection({
      repositoryInspection: inspection,
      resources: { skillIds: ['skill-research', 'skill-review'] },
    });
    writeFileSync(path, nextBytes);
    expect(manager.reload({ mode: 'safe' }).status).toBe('applied');
    expect(manager.current().workspaceConfigs[0]?.config.workspace.assistant).toEqual({
      repositoryInspection: inspection,
      resources: { skillIds: ['skill-research', 'skill-review'] },
    });
    expect(initial.workspaceConfigs[0]?.config.workspace.assistant).toMatchObject({
      resources: { skillIds: ['skill-review'] },
    });
    expect(loadRuntimeConfig(dataRoot).workspaceConfigs).toEqual(
      manager.current().workspaceConfigs
    );
    expect(manager.current().contentHash).not.toBe(initial.contentHash);
    expect(manager.current().workspaceConfigs[0]?.config).not.toHaveProperty('futureDisplayHint');
    expect(manager.current().diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringContaining('futureDisplayHint'),
      })
    );
    expect(readFileSync(path, 'utf8')).toBe(nextBytes);
  });

  it.each([
    undefined,
    {},
    { resources: { skillIds: [] } },
  ])('loads an empty or omitted selection without selecting installed Skills: %j', (assistant) => {
    const { dataRoot, path } = createSelectionFixture();
    const bytes = authoredSelection(assistant);
    const produced = WorkspaceConfigSchema.parse(parseJsoncObject(bytes, path));
    writeFileSync(path, bytes);

    const snapshot = loadRuntimeConfig(dataRoot);
    expect(snapshot.workspaceConfigs[0]?.config).toEqual(produced);
    expect(snapshot.workspaceConfigs[0]?.config.workspace.assistant).not.toHaveProperty(
      'resources.skillIds.0'
    );
    expect(snapshot.workspaceConfigs[0]?.config.workspace.assistant).toMatchObject({
      repositoryInspection: { enabled: true, excludedPaths: [] },
    });
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('retains the last good snapshot after invalid selection and recovers from corrected source', () => {
    const { dataRoot, path } = createSelectionFixture();
    writeFileSync(path, authoredSelection());
    const manager = createRuntimeConfigManager({ dataRoot });
    const initial = manager.current();

    for (const resources of [
      { skillIds: ['skill-review', 'skill-review'] },
      { skillIds: [''] },
      { skillIds: ['skill-review'], command: 'sh' },
    ]) {
      const invalidBytes = authoredSelection({ resources });
      writeFileSync(path, invalidBytes);
      const failed = manager.reload({ mode: 'safe' });
      expect(failed.status).toBe('failed');
      expect(manager.current()).toBe(initial);
      expect(readFileSync(path, 'utf8')).toBe(invalidBytes);
    }

    const correctedBytes = authoredSelection({ resources: { skillIds: [] } });
    writeFileSync(path, correctedBytes);
    expect(manager.reload({ mode: 'safe' }).status).toBe('applied');
    expect(manager.current().workspaceConfigs[0]?.config.workspace.assistant).toMatchObject({
      resources: { skillIds: [] },
    });
    expect(readFileSync(path, 'utf8')).toBe(correctedBytes);

    const removedBytes = authoredSelection();
    writeFileSync(path, removedBytes);
    expect(manager.reload({ mode: 'safe' }).status).toBe('applied');
    expect(loadRuntimeConfig(dataRoot).workspaceConfigs).toEqual(
      manager.current().workspaceConfigs
    );
    expect(readFileSync(path, 'utf8')).toBe(removedBytes);
  });
});
