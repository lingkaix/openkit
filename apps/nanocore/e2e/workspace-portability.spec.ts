import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('imports a collision into a second fresh data root with lineage and preserved knowledge', async () => {
    const sourceHarness = await startNanoCoreHarness();
    harnesses.push(sourceHarness);

    const workspaceId = 'ws_demo';
    await expectJson(
      await postJson(`${sourceHarness.baseUrl}/api/workspaces/${workspaceId}/knowledge`, {
        content: 'L3 workspace portability knowledge survives import.',
        kind: 'project-context',
        requestId: randomUUID(),
        title: 'L3 portability knowledge',
      }),
      { title: 'L3 portability knowledge' }
    );

    const exported = await expectJson(
      await postJson(`${sourceHarness.baseUrl}/api/app/workspaces/${workspaceId}/export`, {}),
      { workspaceId }
    );
    const exportId = String(exported.exportId);
    const targetDataRoot = await mkdtemp(join(tmpdir(), 'openkit-nanocore-portability-target-'));
    const targetExportRoot = join(
      targetDataRoot,
      'server',
      'exports',
      'workspaces',
      workspaceId,
      exportId
    );

    await mkdir(dirname(targetExportRoot), { recursive: true });
    await cp(
      join(sourceHarness.dataRoot, 'server', 'exports', 'workspaces', workspaceId, exportId),
      targetExportRoot,
      { recursive: true }
    );

    const targetHarness = await startNanoCoreHarness({
      dataRoot: targetDataRoot,
      seedDemoWorkspace: true,
    });
    harnesses.push(targetHarness);
    await expectJson(
      await postJson(`${targetHarness.baseUrl}/api/app/workspace-imports/dry-run`, {
        exportId,
        sourceWorkspaceId: workspaceId,
      }),
      {
        collision: { status: 'collides', workspaceId },
        exportedWorkspaceId: workspaceId,
        mode: 'dry-run',
      }
    );

    const imported = await expectJson(
      await postJson(`${targetHarness.baseUrl}/api/app/workspace-imports`, {
        exportId,
        requestId: randomUUID(),
        sourceWorkspaceId: workspaceId,
      }),
      {
        collision: { status: 'collides', workspaceId },
        mode: 'imported',
      }
    );
    const importedWorkspaceId = String(imported.importedWorkspaceId);
    const knowledge = (await expectJson(
      await fetch(`${targetHarness.baseUrl}/api/workspaces/${importedWorkspaceId}/knowledge`),
      {}
    )) as { items?: Array<{ title?: string }> };

    expect(importedWorkspaceId).not.toBe(workspaceId);
    expect(imported.workspace).toMatchObject({
      id: importedWorkspaceId,
      importedFrom: { sourceWorkspaceId: workspaceId },
    });
    expect(knowledge.items?.some((entry) => entry.title === 'L3 portability knowledge')).toBe(true);
  });

  it('fails closed on unsupported export features without creating a partial workspace', async () => {
    const harness = await startNanoCoreHarness();
    harnesses.push(harness);

    const workspaceId = 'ws_demo';
    const exported = await expectJson(
      await postJson(`${harness.baseUrl}/api/app/workspaces/${workspaceId}/export`, {}),
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
      await postJson(`${harness.baseUrl}/api/app/workspace-imports`, {
        exportId,
        requestId: randomUUID(),
        sourceWorkspaceId: workspaceId,
      }),
      'workspace_import_failed'
    );

    const workspaces = (await expectJson(await fetch(`${harness.baseUrl}/api/workspaces`), {})) as {
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
      await postJson(`${harness.baseUrl}/api/app/workspaces/${workspaceId}/export`, {}),
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
      'workspace.json'
    );

    await writeFile(workspaceRecordPath, '{"id":"tampered"}\n');

    await expectErrorJson(
      await postJson(`${harness.baseUrl}/api/app/workspace-imports`, {
        exportId,
        requestId: randomUUID(),
        sourceWorkspaceId: workspaceId,
      }),
      'workspace_import_failed'
    );

    const workspaces = (await expectJson(await fetch(`${harness.baseUrl}/api/workspaces`), {})) as {
      items?: Array<{ id?: string }>;
    };

    expect(workspaces.items?.some((workspace) => workspace.id === 'ws_imported_ws_demo')).toBe(
      false
    );
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
