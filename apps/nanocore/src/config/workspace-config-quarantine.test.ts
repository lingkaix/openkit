import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { loadRuntimeConfig } from './runtime-config.js';

const healthyId = 'ws_00000000-0000-7000-8000-000000000001';
const malformedId = 'ws_00000000-0000-7000-8000-000000000002';
const malformedBody = '{"schemaVersion":1,"workspace":\n';

describe('malformed Workspace config quarantine', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('loads healthy Workspaces and preserves the malformed Workspace bytes', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-workspace-config-'));
    roots.push(dataRoot);
    writeWorkspace(dataRoot, healthyId, '{"schemaVersion":1,"workspace":{"name":"Healthy"}}');
    writeWorkspace(dataRoot, malformedId, malformedBody);
    mkdirSync(join(dataRoot, 'workspaces', malformedId, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'workspaces', malformedId, 'config', 'data-sources.jsonc'), '{');

    const snapshot = loadRuntimeConfig(dataRoot, { quarantineMalformedWorkspaceConfig: true });

    expect(snapshot.workspaceConfigs.map((entry) => entry.workspaceId)).toEqual([healthyId]);
    expect(snapshot.workspaceDataSourceCatalogs.map((entry) => entry.workspaceId)).toEqual([]);
    expect(isScopeAdmitted(dataRoot, 'workspace', healthyId)).toBe(true);
    expect(isScopeAdmitted(dataRoot, 'workspace', malformedId)).toBe(false);
    expect(
      readFileSync(join(dataRoot, 'workspaces', malformedId, 'config', 'workspace.jsonc'), 'utf8')
    ).toBe(malformedBody);
  });
});

function writeWorkspace(dataRoot: string, workspaceId: string, body: string): void {
  const configRoot = join(dataRoot, 'workspaces', workspaceId, 'config');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'workspace.jsonc'), body);
}
