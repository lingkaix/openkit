import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('seeds a first-run nano-data config with env secret references', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));

    const result = runSeedOnly(dataRoot);

    expect(result.status).toBe(0);
    expect(existsSync(join(dataRoot, 'config', 'server.jsonc'))).toBe(true);
    expect(existsSync(join(dataRoot, 'config', 'agents', 'codex.agent.jsonc'))).toBe(true);
    expect(existsSync(join(dataRoot, 'config', 'agents', 'opencode-server.agent.jsonc'))).toBe(
      true
    );

    const serverConfig = readFileSync(join(dataRoot, 'config', 'server.jsonc'), 'utf8');
    expect(serverConfig).toContain('"id": "nanocore-openrouter"');
    expect(serverConfig).toContain('"id": "nano-agent-openrouter"');
    expect(serverConfig).not.toContain('"apiKey"');
    expect(serverConfig).toContain('"secretRef": "env:OPENROUTER_API_KEY"');
    expect(serverConfig).toContain('"defaultModel": "z-ai/glm-4.5-air:free"');
  });

  it('patches persisted agent environments from the agent provider secretRef env value', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
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
    writeFileSync(
      join(workspaceRoot, 'store.json'),
      `${JSON.stringify(
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
      )}\n`
    );

    const result = runSeedOnly(dataRoot, [], { OPENROUTER_API_KEY: 'sk-agent-test' });

    expect(result.status).toBe(0);
    const store = JSON.parse(readFileSync(join(workspaceRoot, 'store.json'), 'utf8'));
    const agents = store.workspaceResources[0][1].agents;
    expect(agents[0].config.environment).toMatchObject({
      CODEX_HOME: '/data/openkit/config/agents/codex-home',
      OPENROUTER_API_KEY: 'sk-agent-test',
    });
    expect(agents[1].config.environment).toMatchObject({
      OPENAI_API_KEY: 'sk-agent-test',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'z-ai/glm-4.5-air:free',
      OPENROUTER_API_KEY: 'sk-agent-test',
    });
  });

  it('loads provider secrets from the data-root secrets env file', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));
    const workspaceRoot = join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo');
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
    writeFileSync(join(dataRoot, 'secrets', 'openkit.env'), "OPENROUTER_API_KEY='sk-env-file'\n");
    writeFileSync(
      join(workspaceRoot, 'store.json'),
      `${JSON.stringify(
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
      )}\n`
    );

    const result = runSeedOnly(dataRoot, [], { OPENROUTER_API_KEY: '' });

    expect(result.status).toBe(0);
    const store = JSON.parse(readFileSync(join(workspaceRoot, 'store.json'), 'utf8'));
    expect(store.workspaceResources[0][1].agents[0].config.environment).toMatchObject({
      CODEX_HOME: '/data/openkit/config/agents/codex-home',
      OPENROUTER_API_KEY: 'sk-env-file',
    });
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
