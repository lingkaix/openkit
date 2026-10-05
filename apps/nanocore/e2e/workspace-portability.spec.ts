import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot,
} from '../../../tests/support/demo-data.mjs';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';
import { postJson } from './_lib/http.js';

let harnesses: NanoCoreHarness[] = [];

afterEach(async () => {
  const current = harnesses;
  harnesses = [];

  for (const harness of current.reverse()) {
    await harness.stop();
    await removeDataRoot(harness.dataRoot);
  }
});

describe('nanocore e2e workspace portability', () => {
  it('round-trips identical archive bytes through authenticated HTTP streams and administrator CLI local sinks', async () => {
    const sourceDataRoot = await mkdtemp(join(tmpdir(), 'openkit-admin-source-'));
    const targetDataRoot = await mkdtemp(join(tmpdir(), 'openkit-admin-target-'));
    const sourceToken = await seedArchiveAdministrator(sourceDataRoot);
    const targetToken = await seedArchiveAdministrator(targetDataRoot);
    const source = await startNanoCoreHarness({ coreMode: 'server', dataRoot: sourceDataRoot });
    harnesses.push(source);
    const target = await startNanoCoreHarness({ coreMode: 'server', dataRoot: targetDataRoot });
    harnesses.push(target);
    const localRoot = await mkdtemp(join(tmpdir(), 'openkit-admin-archive-'));
    try {
      const content = 'Exact archive round trip: café, 日本語, and trailing newline.\n';
      await expectJson(
        await fetch(`${source.baseUrl}/api/app/operations/knowledge.create`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${sourceToken}`,
            'content-type': 'application/json',
            'x-openkit-request-id': randomUUID(),
          },
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            title: 'Archive bytes',
            kind: 'project-context',
            content,
          }),
        }),
        {}
      );
      const exported = await expectJson(
        await fetch(`${source.baseUrl}/api/app/operations/workspace.export`, {
          method: 'POST',
          headers: { authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: 'ws_demo' }),
        }),
        {}
      );
      const web = await fetch(
        `${source.baseUrl}/api/app/workspaces/ws_demo/exports/${exported.exportId}/archive`,
        { headers: { authorization: `Bearer ${sourceToken}` } }
      );
      expect(
        (
          await fetch(
            `${source.baseUrl}/api/app/workspaces/ws_demo/exports/${exported.exportId}/archive`
          )
        ).status
      ).toBe(401);
      expect(web.status).toBe(200);
      const bytes = Buffer.from(await web.arrayBuffer());
      const destinationPath = join(localRoot, 'archive.openkit-workspace.tar.zst');
      expect(
        await administratorArchiveCall(source, String(sourceToken), 'workspace.archive-download', {
          workspaceId: 'ws_demo',
          exportId: exported.exportId,
          destinationPath,
        })
      ).toEqual({ downloaded: true });
      expect(await readFile(destinationPath)).toEqual(bytes);
      expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
      expect(
        await administratorArchiveCall(
          target,
          String(targetToken),
          'workspace.archive-import-dry-run',
          { sourcePath: destinationPath }
        )
      ).toMatchObject({ mode: 'dry-run', collision: { status: 'collides' } });
      const imported = await administratorArchiveCall(
        target,
        String(targetToken),
        'workspace.archive-import',
        { sourcePath: destinationPath, requestId: randomUUID() }
      );
      expect(imported).toMatchObject({ mode: 'imported' });
      expect(await readFile(destinationPath)).toEqual(bytes);
      const knowledge = (await expectJson(
        await fetch(`${target.baseUrl}/api/app/operations/knowledge.list`, {
          method: 'POST',
          headers: { authorization: `Bearer ${targetToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: imported.importedWorkspaceId }),
        }),
        {}
      )) as { items: { title: string; content: string }[] };
      expect(knowledge.items.find((item) => item.title === 'Archive bytes')?.content).toBe(content);
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  });

  it('imports a collision into a second fresh data root with lineage and preserved knowledge', async () => {
    const sourceHarness = await startNanoCoreHarness();
    harnesses.push(sourceHarness);

    const workspaceId = 'ws_demo';
    await expectJson(
      await postJson(`${sourceHarness.baseUrl}/api/app/operations/knowledge.create`, {
        workspaceId,
        content: 'L3 workspace portability knowledge survives import.',
        kind: 'project-context',
        requestId: randomUUID(),
        title: 'L3 portability knowledge',
      }),
      { title: 'L3 portability knowledge' }
    );

    const exported = await expectJson(
      await postJson(`${sourceHarness.baseUrl}/api/app/operations/workspace.export`, {
        workspaceId,
      }),
      { workspaceId }
    );
    const exportId = String(exported.exportId);
    const archiveResponse = await fetch(
      `${sourceHarness.baseUrl}/api/app/workspaces/${workspaceId}/exports/${exportId}/archive`
    );
    expect(archiveResponse.status).toBe(200);
    expect(archiveResponse.headers.get('content-type')).toBe(
      'application/vnd.openkit.workspace-export+tar.zstd'
    );
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const sourceArchiveDigest = createHash('sha256').update(archive).digest('hex');
    const targetDataRoot = await mkdtemp(join(tmpdir(), 'openkit-nanocore-portability-target-'));

    const targetHarness = await startNanoCoreHarness({
      dataRoot: targetDataRoot,
      seedDemoWorkspace: true,
    });
    harnesses.push(targetHarness);
    await expectJson(
      await postArchive(
        `${targetHarness.baseUrl}/api/app/workspace-archives/import-dry-run`,
        archive
      ),
      {
        collision: { status: 'collides', workspaceId },
        exportedWorkspaceId: workspaceId,
        mode: 'dry-run',
      }
    );

    const imported = await expectJson(
      await postArchive(`${targetHarness.baseUrl}/api/app/workspace-archives/import`, archive, {
        'x-openkit-request-id': randomUUID(),
      }),
      {
        collision: { status: 'collides', workspaceId },
        mode: 'imported',
      }
    );
    const importedWorkspaceId = String(imported.importedWorkspaceId);
    const knowledge = (await expectJson(
      await postJson(`${targetHarness.baseUrl}/api/app/operations/knowledge.list`, {
        workspaceId: importedWorkspaceId,
      }),
      {}
    )) as { items?: Array<{ title?: string }> };

    expect(importedWorkspaceId).not.toBe(workspaceId);
    expect(imported.workspace).toMatchObject({
      id: importedWorkspaceId,
      importedFrom: { sourceWorkspaceId: workspaceId },
    });
    expect(createHash('sha256').update(archive).digest('hex')).toBe(sourceArchiveDigest);
    expect(knowledge.items?.some((entry) => entry.title === 'L3 portability knowledge')).toBe(true);
  });

  it('fails closed on unsupported export features without creating a partial workspace', async () => {
    const harness = await startNanoCoreHarness();
    harnesses.push(harness);

    const workspaceId = 'ws_demo';
    const exported = await expectJson(
      await postJson(`${harness.baseUrl}/api/app/operations/workspace.export`, { workspaceId }),
      { workspaceId }
    );
    const exportId = String(exported.exportId);
    const manifestPath = join(
      harness.dataRoot,
      'server',
      'exports',
      'workspaces',
      workspaceId,
      exportId,
      'openkit-workspace-export.json'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      requiredFeatures?: string[];
    };

    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          requiredFeatures: [...(manifest.requiredFeatures ?? []), 'future.workspace.feature'],
        },
        null,
        2
      )}\n`
    );

    await expectErrorJson(
      await postJson(`${harness.baseUrl}/api/app/operations/workspace.import`, {
        exportId,
        requestId: randomUUID(),
        sourceWorkspaceId: workspaceId,
      }),
      'workspace_import_failed'
    );

    const workspaces = (await expectJson(
      await fetch(`${harness.baseUrl}/api/app/operations/workspace.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      {}
    )) as {
      items?: Array<{ id?: string }>;
    };

    expect(workspaces.items?.some((workspace) => workspace.id === 'ws_imported_ws_demo')).toBe(
      false
    );
  });

  it('rejects tampered export content without creating a partial workspace', async () => {
    const harness = await startNanoCoreHarness();
    harnesses.push(harness);

    const workspaceId = 'ws_demo';
    const exported = await expectJson(
      await postJson(`${harness.baseUrl}/api/app/operations/workspace.export`, { workspaceId }),
      { workspaceId }
    );
    const exportId = String(exported.exportId);
    const workspaceRecordPath = join(
      harness.dataRoot,
      'server',
      'exports',
      'workspaces',
      workspaceId,
      exportId,
      'records',
      'workspace-record.json'
    );

    await writeFile(workspaceRecordPath, '{"id":"tampered"}\n');

    await expectErrorJson(
      await postJson(`${harness.baseUrl}/api/app/operations/workspace.import`, {
        exportId,
        requestId: randomUUID(),
        sourceWorkspaceId: workspaceId,
      }),
      'workspace_import_failed'
    );

    const workspaces = (await expectJson(
      await fetch(`${harness.baseUrl}/api/app/operations/workspace.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      {}
    )) as {
      items?: Array<{ id?: string }>;
    };

    expect(workspaces.items?.some((workspace) => workspace.id === 'ws_imported_ws_demo')).toBe(
      false
    );
  });
});

/** Posts one exact portable archive body without JSON or base64 encoding. */
function postArchive(url: string, archive: Buffer, headers: HeadersInit = {}): Promise<Response> {
  return fetch(url, {
    body: archive,
    headers: {
      'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
      ...Object.fromEntries(new Headers(headers)),
    },
    method: 'POST',
  });
}

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

/**
 * Parses one JSON error response and asserts its stable code.
 *
 * @param response HTTP response returned by the black-box NanoCore process.
 * @param code Expected protocol error code.
 * @returns Parsed JSON object.
 */
async function expectErrorJson(response: Response, code: string): Promise<unknown> {
  const body = (await response.json()) as unknown;

  expect(response.status).toBe(400);
  expect(body).toMatchObject({ code });

  return body;
}

/** Executes the shipped CLI against the real local listener with an administrator bearer and local file inputs. */
function administratorArchiveCall(
  harness: NanoCoreHarness,
  token: string,
  operation: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve('../../skills/openkit-ops/scripts/openkit'),
        'ops',
        'call',
        operation,
        '--input',
        '-',
      ],
      {
        env: {
          ...process.env,
          OPENKIT_NANOCORE_URL: harness.baseUrl,
          OPENKIT_NANOCORE_TOKEN: token,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
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

/** Seeds explicit administrator authority before the process starts; transfer assertions use only public bindings. */
async function seedArchiveAdministrator(dataRoot: string): Promise<string> {
  seedDemoWorkspaceDataRoot(dataRoot);
  await seedDemoWorkspaceAuthority(dataRoot);
  const { openCoreDb } = await import('../dist/storage/db.js');
  const { createOpenKitAccessTokenRecord } = await import('../dist/auth/access-token-store.js');
  const coreDb = openCoreDb(dataRoot);
  try {
    return createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
  } finally {
    coreDb.sqlite.close();
  }
}
