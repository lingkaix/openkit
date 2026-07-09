import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;
let repositoryRootToRemove: string | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }

  if (repositoryRootToRemove) {
    await rm(repositoryRootToRemove, { force: true, recursive: true });
    repositoryRootToRemove = null;
  }
});

describe('nanocore e2e repository linking', () => {
  it('links, reads, and rejects repository resources through the App API', async () => {
    harness = await startNanoCoreHarness();
    repositoryRootToRemove = await mkdtemp(join(tmpdir(), 'openkit-e2e-repository-root-'));
    const repositoryPath = join(repositoryRootToRemove, 'repo');
    const invalidPath = join(repositoryRootToRemove, 'not-a-git-repo');
    mkdirSync(join(repositoryPath, '.git'), { recursive: true });
    mkdirSync(invalidPath);

    const setResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/repositories/default`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'E2E Repository',
          localPath: repositoryPath,
        }),
      }
    );
    const setPayload = (await setResponse.json()) as Record<string, unknown>;
    const setJson = JSON.stringify(setPayload);

    expect(setResponse.status).toBe(200);
    expect(setPayload).toMatchObject({
      repository: {
        workspaceId: 'ws_demo',
        resourceId: 'repo_default',
        displayName: 'E2E Repository',
        diagnosticsStatus: 'ready',
        validation: {
          ok: true,
          status: 'ready',
        },
      },
    });
    expect(setJson).not.toContain(repositoryPath);

    const listResponse = await fetch(`${harness.baseUrl}/api/app/workspaces/ws_demo/repositories`);
    const listPayload = (await listResponse.json()) as Record<string, unknown>;

    expect(listResponse.status).toBe(200);
    expect(listPayload).toMatchObject({
      defaultResourceId: 'repo_default',
      defaultResource: {
        resourceId: 'repo_default',
        diagnosticsStatus: 'ready',
      },
      items: [
        {
          resourceId: 'repo_default',
          diagnosticsStatus: 'ready',
        },
      ],
    });

    const invalidResponse = await fetch(
      `${harness.baseUrl}/api/app/workspaces/ws_demo/repositories/default`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Invalid Repository',
          localPath: invalidPath,
        }),
      }
    );
    const invalidPayload = (await invalidResponse.json()) as Record<string, unknown>;
    const invalidJson = JSON.stringify(invalidPayload);

    expect(invalidResponse.status).toBe(200);
    expect(invalidPayload).toMatchObject({
      repository: {
        diagnosticsStatus: 'not_git',
        validation: {
          ok: false,
          status: 'not_git',
        },
      },
    });
    expect(invalidJson).not.toContain(invalidPath);
  });
});
