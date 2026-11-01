import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot,
} from '../../../tests/support/demo-data.mjs';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const cliEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../skills/openkit-ops/scripts/openkit'
);

let harnesses: NanoCoreHarness[] = [];

afterEach(async () => {
  const current = harnesses;
  harnesses = [];

  for (const harness of current.reverse()) {
    await harness.stop();
    await removeDataRoot(harness.dataRoot);
  }
});

describe('nanocore e2e workspace archive download', () => {
  it('downloads identical archive bytes through authenticated HTTP and the administrator CLI sink', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-admin-source-'));
    const token = await seedArchiveAdministrator(dataRoot);
    const source = await startNanoCoreHarness({ coreMode: 'server', dataRoot });
    harnesses.push(source);
    const localRoot = await mkdtemp(join(tmpdir(), 'openkit-admin-archive-'));
    try {
      const exported = (await expectJson(
        await fetch(`${source.baseUrl}/api/app/operations/workspace.export`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        }),
        {}
      )) as { exportId: string };
      const archiveUrl = `${source.baseUrl}/api/app/workspaces/${workspaceId}/exports/${exported.exportId}/archive`;
      expect((await fetch(archiveUrl)).status).toBe(401);
      const web = await fetch(archiveUrl, { headers: { authorization: `Bearer ${token}` } });
      expect(web.status).toBe(200);
      const bytes = Buffer.from(await web.arrayBuffer());
      const destinationPath = join(localRoot, 'archive.openkit-workspace.tar.zst');
      expect(
        await administratorArchiveCall(source, token, 'workspace.archive-download', {
          workspaceId,
          exportId: exported.exportId,
          destinationPath,
        })
      ).toEqual({ downloaded: true });
      expect(await readFile(destinationPath)).toEqual(bytes);
      expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Parses one JSON response and asserts a partial object match.
 *
 * @param response HTTP response returned by the black-box NanoCore process.
 * @param partial Expected partial response body.
 * @returns Parsed JSON object.
 */
async function expectJson(response: Response, partial: Record<string, unknown>): Promise<unknown> {
  const body = (await response.json()) as unknown;

  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  expect(body).toMatchObject(partial);

  return body;
}

/** Executes the shipped CLI against the real local listener with an administrator bearer and a local file destination. */
function administratorArchiveCall(
  harness: NanoCoreHarness,
  token: string,
  operation: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliEntry, 'ops', 'call', operation, '--input', '-'], {
      env: {
        ...process.env,
        OPENKIT_NANOCORE_URL: harness.baseUrl,
        OPENKIT_NANOCORE_TOKEN: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Administrator archive CLI failed with exit ${code}: ${stdout}`));
        return;
      }
      resolveResult(JSON.parse(stdout).data);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Seeds explicit administrator authority before the process starts. */
async function seedArchiveAdministrator(dataRoot: string): Promise<string> {
  await seedDemoWorkspaceDataRoot(dataRoot);
  await seedDemoWorkspaceAuthority(dataRoot);
  const { openCoreDb } = await import('../dist/storage/db.js');
  const { createOpenKitAccessTokenRecord } = await import('../dist/auth/access-token-store.js');
  const coreDb = openCoreDb(dataRoot);
  try {
    return createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
  } finally {
    coreDb.sqlite.close();
  }
}
