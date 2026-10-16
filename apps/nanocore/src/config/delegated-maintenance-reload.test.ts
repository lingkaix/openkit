import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeConfigManager } from './runtime-config.js';

const assignment = {
  responsibleUserId: 'usr_00000000-0000-7000-8000-000000000002',
  agentId: 'agent_worker',
  networkGrantId: 'repository-read',
  host: 'git.example.test',
  port: 443,
  protocol: 'rest',
  repositoryPaths: ['/team/project.git'],
  binaries: ['/usr/bin/git'],
  validFrom: '2026-10-15T00:00:00.000Z',
  expiresAt: '2026-10-17T00:00:00.000Z',
  enabled: true,
};
const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/** Loads the real Server file and keeps later authored edits separate from activation. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-maintenance-reload-'));
  dataRoots.push(dataRoot);
  mkdirSync(join(dataRoot, 'config'));
  const path = join(dataRoot, 'config', 'server.jsonc');
  const save = (entries: unknown) => {
    const content = JSON.stringify({
      schemaVersion: 1,
      policy: { workerGitReadMaintenance: entries },
    });
    writeFileSync(path, content);
    return content;
  };
  save([assignment]);
  return { path, save, manager: createRuntimeConfigManager({ dataRoot }) };
}

describe('loaded Worker Git-read maintenance assignments', () => {
  it.each([
    { change: 'disable', entries: [{ ...assignment, enabled: false }] },
    { change: 'remove the entry', entries: [] },
    { change: 'omit the field', entries: undefined },
  ])('loads assignment changes only after a successful hot reload: $change', ({ entries }) => {
    const { path, save, manager } = fixture();
    const loaded = manager.current();
    expect(loaded.openKitConfig.policy?.workerGitReadMaintenance).toEqual([assignment]);

    const saved = save(entries);
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(manager.current()).toBe(loaded);
    expect(manager.current().openKitConfig.policy?.workerGitReadMaintenance).toEqual([assignment]);

    const result = manager.reload({ mode: 'safe', dryRun: false });
    expect(result.status).toBe('applied');
    expect(result.plan.requiresRestart).toEqual([]);
    expect(result.plan.applied).toContainEqual(
      expect.objectContaining({
        path: 'policy.workerGitReadMaintenance',
        category: 'hot-swappable',
        action: 'applied',
      })
    );
    expect(manager.current().version).toBe(loaded.version + 1);
    expect(manager.current().openKitConfig.policy?.workerGitReadMaintenance).toEqual(entries);
    expect(readFileSync(path, 'utf8')).toBe(saved);
  });

  it('retains the last loaded assignment and its original validity after an invalid reload', () => {
    const { path, save, manager } = fixture();
    const loaded = manager.current();
    expect(loaded.openKitConfig.policy?.workerGitReadMaintenance).toEqual([assignment]);

    const saved = save([
      { ...assignment, enabled: false, expiresAt: '2099-01-01T00:00:00.000Z', protocol: 'ftp' },
    ]);
    const result = manager.reload({ mode: 'safe', dryRun: false });

    expect(result.status).toBe('failed');
    expect(result.plan.rejected).not.toEqual([]);
    expect(manager.current()).toBe(loaded);
    expect(manager.current().openKitConfig.policy?.workerGitReadMaintenance).toEqual([assignment]);
    expect(readFileSync(path, 'utf8')).toBe(saved);
  });
});
