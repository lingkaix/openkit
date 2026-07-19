import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenKitConfigSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const appRunScript = join(repoRoot, 'scripts', 'docker', 'run-app.sh');

/**
 * Runs the app helper without starting Docker.
 *
 * @param dataRoot Mounted data root to seed.
 * @param args Additional script arguments.
 * @param extraEnv Additional environment variables for the child process.
 * @returns Completed script process.
 */
function runSeedOnly(
  dataRoot: string,
  args: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {}
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [appRunScript, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      OPENKIT_APP_DATA_ROOT: dataRoot,
      OPENKIT_APP_SEED_ONLY: '1',
    },
  });
}

/**
 * Lists data-root files containing one resolved fake secret value.
 *
 * @param dataRoot Mounted data root to inspect.
 * @param secret Fake secret value that must not be copied into persisted state.
 * @returns Sorted data-root-relative paths containing the value.
 */
function findSecretCopies(dataRoot: string, secret: string): string[] {
  return readdirSync(dataRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => readFileSync(path).includes(secret))
    .map((path) => relative(dataRoot, path))
    .sort();
}

describe('app run script', () => {
  it('accepts --rebuild in seed-only mode without starting Docker', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));

    const result = runSeedOnly(dataRoot, ['--rebuild']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Seed-only mode complete.');
    expect(existsSync(join(dataRoot, 'config', 'server.jsonc'))).toBe(true);
  });

  it('accepts the pnpm argument separator before --rebuild', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));

    const result = runSeedOnly(dataRoot, ['--', '--rebuild']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Seed-only mode complete.');
    expect(existsSync(join(dataRoot, 'config', 'server.jsonc'))).toBe(true);
  });

  it('seeds server config and leaves AgentManifest seeding to NanoCore templates', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));

    const result = runSeedOnly(dataRoot);

    expect(result.status).toBe(0);
    expect(existsSync(join(dataRoot, 'config', 'server.jsonc'))).toBe(true);
    expect(existsSync(join(dataRoot, 'config', 'agents', 'codex.agent.jsonc'))).toBe(false);
    expect(existsSync(join(dataRoot, 'config', 'agents', 'opencode-server.agent.jsonc'))).toBe(
      false
    );
    expect(existsSync(join(dataRoot, 'config', 'agents', 'codex-home', 'config.toml'))).toBe(false);

    const serverConfig = readFileSync(join(dataRoot, 'config', 'server.jsonc'), 'utf8');
    expect(serverConfig).toContain('"id": "nanocore-openrouter"');
    expect(serverConfig).toContain('"id": "nano-agent-openrouter"');
    expect(serverConfig).not.toContain('"apiKey"');
    expect(serverConfig).toContain('"secretRef": "env:OPENROUTER_API_KEY"');
    expect(serverConfig).toContain('"defaultModel": "z-ai/glm-4.5-air:free"');
    expect(() => OpenKitConfigSchema.parse(JSON.parse(serverConfig))).not.toThrow();
  });

  it('does not copy a process-env provider secret into workspace-owned state', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const storePath = join(workspaceRoot, 'store.json');
    const secret = 'fake-provider-secret-from-process-env';
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify(
        {
          schemaVersion: 1,
          providers: [
            { id: 'nanocore-openrouter', displayName: 'core', kind: 'custom', models: ['m'] },
            {
              id: 'nano-agent-openrouter',
              displayName: 'agent',
              kind: 'custom',
              models: ['m'],
              secretRef: 'env:OPENROUTER_API_KEY',
            },
          ],
        },
        null,
        2
      )
    );
    const persistedStore = `${JSON.stringify(
      {
        workspaceResources: [
          [
            'ws_demo',
            {
              agents: [
                {
                  id: 'agent_codex_host',
                  config: { adapterType: 'codex', environment: {} },
                },
                {
                  id: 'agent_opencode_server',
                  config: { adapterType: 'opencode', environment: {} },
                },
              ],
            },
          ],
        ],
      },
      null,
      2
    )}\n`;
    writeFileSync(storePath, persistedStore);

    const result = runSeedOnly(dataRoot, [], { OPENROUTER_API_KEY: secret });

    expect(result.status).toBe(0);
    expect(readFileSync(storePath, 'utf8')).toBe(persistedStore);
    expect(findSecretCopies(dataRoot, secret)).toEqual([]);
  });

  it('does not copy a secrets-file provider secret into workspace-owned state', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const secretsPath = join(dataRoot, 'secrets', 'openkit.env');
    const storePath = join(workspaceRoot, 'store.json');
    const secret = 'fake-provider-secret-from-env-file';
    const persistedSecrets = `OPENROUTER_API_KEY='${secret}'\n`;
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    mkdirSync(join(dataRoot, 'secrets'), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify(
        {
          schemaVersion: 1,
          providers: [
            {
              id: 'nano-agent-openrouter',
              displayName: 'agent',
              kind: 'custom',
              models: ['m'],
              secretRef: 'env:OPENROUTER_API_KEY',
            },
          ],
        },
        null,
        2
      )
    );
    writeFileSync(secretsPath, persistedSecrets);
    const persistedStore = `${JSON.stringify(
      {
        workspaceResources: [
          [
            'ws_demo',
            {
              agents: [
                {
                  id: 'agent_codex_host',
                  config: { adapterType: 'codex', environment: {} },
                },
              ],
            },
          ],
        ],
      },
      null,
      2
    )}\n`;
    writeFileSync(storePath, persistedStore);

    const result = runSeedOnly(dataRoot, [], { OPENROUTER_API_KEY: '' });

    expect(result.status).toBe(0);
    expect(readFileSync(storePath, 'utf8')).toBe(persistedStore);
    expect(readFileSync(secretsPath, 'utf8')).toBe(persistedSecrets);
    expect(findSecretCopies(dataRoot, secret)).toEqual(['secrets/openkit.env']);
  });

  it('rejects existing app provider config that still contains inline api keys', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify(
        {
          schemaVersion: 1,
          providers: [
            {
              id: 'nano-agent-openrouter',
              displayName: 'agent',
              kind: 'custom',
              models: ['m'],
              apiKey: 'sk-old-inline-secret',
            },
          ],
        },
        null,
        2
      )
    );

    const result = runSeedOnly(dataRoot);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('apiKey is not supported in app provider config');
    expect(output).toContain('secretRef');
  });
});
