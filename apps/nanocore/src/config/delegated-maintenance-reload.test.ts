import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRuntimeConfigManager } from './runtime-config.js';

const userId = 'usr_00000000-0000-7000-8000-000000000002';
const container = { owner: { kind: 'server' }, kind: 'agent', id: 'agent_worker' };
const assignment = {
  kind: 'permission',
  id: 'finite-git-read',
  state: 'active',
  author: { kind: 'human', id: userId },
  authority: { kind: 'human', userId },
  authoredAt: '2026-10-15T00:00:00.000Z',
  scope: {
    subjects: [{ kind: 'human', id: userId }],
    actions: ['administration.configuration.apply'],
    resources: [{ kind: 'container', container }],
  },
  lifetime: { anchor: container, notAfter: '2026-10-17T00:00:00.000Z' },
  effect: 'allow',
  grant: {
    kind: 'worker-git-read-maintenance',
    networkGrantId: 'repository-read',
    host: 'git.example.test',
    port: 443,
    protocol: 'rest',
    repositoryPaths: ['/team/project.git'],
    binaries: ['/usr/bin/git'],
    validFrom: '2026-10-15T00:00:00.000Z',
  },
};
const document = (statements: unknown) =>
  statements === undefined ? undefined : { schemaVersion: 1, statements };
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
      policy: { mediation: document(entries) },
    });
    writeFileSync(path, content);
    return content;
  };
  save([assignment]);
  return { path, save, manager: createRuntimeConfigManager({ dataRoot }) };
}

describe('loaded Worker Git-read maintenance assignments', () => {
  it.each([
    { change: 'disable', entries: [{ ...assignment, state: 'inactive' }] },
    { change: 'remove the entry', entries: [] },
    { change: 'omit the field', entries: undefined },
  ])('loads assignment changes only after a successful hot reload: $change', ({ entries }) => {
    const { path, save, manager } = fixture();
    const loaded = manager.current();
    expect(loaded.openKitConfig.policy?.mediation).toEqual(document([assignment]));

    const saved = save(entries);
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(manager.current()).toBe(loaded);
    expect(manager.current().openKitConfig.policy?.mediation).toEqual(document([assignment]));

    const result = manager.reload({ mode: 'safe', dryRun: false });
    expect(result.status).toBe('applied');
    expect(result.plan.requiresRestart).toEqual([]);
    expect(result.plan.applied).toContainEqual(
      expect.objectContaining({
        path: 'policy.mediation',
        category: 'hot-swappable',
        action: 'applied',
      })
    );
    expect(manager.current().version).toBe(loaded.version + 1);
    expect(manager.current().openKitConfig.policy?.mediation).toEqual(document(entries));
    expect(readFileSync(path, 'utf8')).toBe(saved);
  });

  it('retains the last loaded assignment and its original validity after an invalid reload', () => {
    const { path, save, manager } = fixture();
    const loaded = manager.current();
    expect(loaded.openKitConfig.policy?.mediation).toEqual(document([assignment]));

    const saved = save([
      {
        ...assignment,
        state: 'inactive',
        lifetime: { ...assignment.lifetime, notAfter: '2099-01-01T00:00:00.000Z' },
        grant: { ...assignment.grant, protocol: 'ftp' },
      },
    ]);
    const result = manager.reload({ mode: 'safe', dryRun: false });

    expect(result.status).toBe('failed');
    expect(result.plan.rejected).not.toEqual([]);
    expect(manager.current()).toBe(loaded);
    expect(manager.current().openKitConfig.policy?.mediation).toEqual(document([assignment]));
    expect(readFileSync(path, 'utf8')).toBe(saved);
  });
});
