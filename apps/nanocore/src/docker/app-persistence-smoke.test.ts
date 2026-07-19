import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenKitConfigSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const smokeScript = join(repoRoot, 'scripts', 'docker', 'app-persistence-smoke.sh');

/**
 * Creates a host-mounted data-root fixture that matches the target persistence contract.
 *
 * @param workspaceId Workspace id to create under the canonical Workspace root.
 * @returns Temporary data-root path.
 */
async function createMountedDataRootFixture(workspaceId: string): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-smoke-'));
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);

  for (const directory of [
    join(dataRoot, 'config', 'providers'),
    join(dataRoot, 'config', 'agents'),
    join(dataRoot, 'server', 'files'),
    join(dataRoot, 'server', 'db'),
    join(dataRoot, 'server', 'evidence'),
    join(dataRoot, 'server', 'exports'),
    join(dataRoot, 'server', 'logs'),
    join(dataRoot, 'server', 'runtime', 'config'),
    join(dataRoot, 'server', 'runtime', 'agents', 'agent_codex_host', 'resolved'),
    join(dataRoot, 'server', 'runtime', 'sessions'),
    join(dataRoot, 'server', 'migrations'),
    join(dataRoot, 'server', 'vendor', 'models.dev'),
    join(dataRoot, 'users', 'user_local', 'files'),
    join(dataRoot, 'users', 'user_local', 'data'),
    join(dataRoot, 'users', 'user_local', 'db'),
    join(dataRoot, 'users', 'user_local', 'logs'),
    join(dataRoot, 'users', 'user_local', 'config'),
    join(workspaceRoot, 'files'),
    join(workspaceRoot, 'data'),
    join(workspaceRoot, 'db'),
    join(workspaceRoot, 'logs'),
    join(workspaceRoot, 'artifacts'),
    join(workspaceRoot, 'knowledge'),
    join(workspaceRoot, 'sources'),
    join(workspaceRoot, 'threads'),
    join(workspaceRoot, 'runtime'),
    join(workspaceRoot, 'reviews'),
    join(workspaceRoot, 'evidence'),
    join(workspaceRoot, 'indexes'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(join(dataRoot, 'server', 'db', 'core.sqlite'), '');
  writeFileSync(join(dataRoot, 'config', 'server.jsonc'), '{ "schemaVersion": 1 }\n');
  writeFileSync(join(workspaceRoot, 'workspace.json'), '{ "id": "ws_1" }\n');
  writeFileSync(
    join(dataRoot, 'server', 'runtime', 'agents', 'agent_codex_host', 'resolved', 'latest.json'),
    '{ "agentId": "agent_codex_host" }\n'
  );
  writeFileSync(join(dataRoot, 'server', 'logs', 'app-smoke.log'), 'ok\n');
  writeFileSync(join(workspaceRoot, 'logs', 'app-smoke.log'), 'ok\n');

  return dataRoot;
}

/**
 * Runs the app persistence smoke in assertion-only mode.
 *
 * @param dataRoot Data root for the assertion run.
 * @param workspaceId Workspace id expected under the canonical Workspace root.
 * @returns Completed child process result.
 */
function runAssertOnlySmoke(dataRoot: string, workspaceId: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [smokeScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENKIT_APP_SMOKE_ASSERT_ONLY: '1',
      OPENKIT_APP_SMOKE_DATA_ROOT: dataRoot,
      OPENKIT_APP_SMOKE_WORKSPACE_ID: workspaceId,
    },
  });
}

describe('app persistence smoke script', () => {
  it('seeds a server config accepted by the current strict schema', () => {
    const source = readFileSync(smokeScript, 'utf8');
    const seededConfig = source.match(/cat >"\$\{config_path\}" <<'JSON'\n([\s\S]*?)\nJSON/);

    expect(seededConfig?.[1]).toBeDefined();
    expect(() => OpenKitConfigSchema.parse(JSON.parse(seededConfig?.[1] ?? ''))).not.toThrow();
  });

  it('passes when the mounted data root contains the canonical layout', async () => {
    const workspaceId = 'ws_1';
    const dataRoot = await createMountedDataRootFixture(workspaceId);

    const result = runAssertOnlySmoke(dataRoot, workspaceId);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS data-root server/db/core.sqlite');
    expect(result.stdout).toContain('PASS data-root config/server.jsonc');
    expect(result.stdout).toContain('PASS data-root server/files');
    expect(result.stdout).toContain('PASS data-root server/runtime');
    expect(result.stdout).toContain('PASS data-root server/vendor');
    expect(result.stdout).toContain(`PASS data-root workspaces/${workspaceId}/runtime`);
    expect(result.stdout).toContain('OpenKit app persistence smoke PASS');
  });

  it('fails when a required canonical subtree is missing', async () => {
    const workspaceId = 'ws_1';
    const dataRoot = await createMountedDataRootFixture(workspaceId);
    rmSync(join(dataRoot, 'server', 'runtime'), { recursive: true });

    const result = runAssertOnlySmoke(dataRoot, workspaceId);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('FAIL data-root server/runtime');
    expect(output).toContain('OpenKit app persistence smoke FAIL');
  });
});
