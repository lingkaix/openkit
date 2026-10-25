import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GatewayConfigSchema,
  InternalRoleProfilesConfigSchema,
  OpenKitConfigSchema,
  ProviderProfileSchema,
} from '@openkit/config-schema';
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
    const providerConfig = readFileSync(
      join(dataRoot, 'config', 'providers', 'openrouter.provider.jsonc'),
      'utf8'
    );
    const gatewayConfig = readFileSync(join(dataRoot, 'config', 'gateway.jsonc'), 'utf8');
    const internalRoleProfiles = readFileSync(
      join(dataRoot, 'config', 'internal-role-profiles.jsonc'),
      'utf8'
    );
    expect(providerConfig).not.toContain('"apiKey"');
    expect(providerConfig).toContain('"secretRef": "env:OPENROUTER_API_KEY"');
    expect(providerConfig).toContain('"defaultModel": "z-ai/glm-4.5-air:free"');
    expect(() => OpenKitConfigSchema.parse(JSON.parse(serverConfig))).not.toThrow();
    expect(JSON.parse(serverConfig)).toMatchObject({ mode: 'server' });
    expect(() => ProviderProfileSchema.parse(JSON.parse(providerConfig))).not.toThrow();
    expect(() => GatewayConfigSchema.parse(JSON.parse(gatewayConfig))).not.toThrow();
    expect(() =>
      InternalRoleProfilesConfigSchema.parse(JSON.parse(internalRoleProfiles))
    ).not.toThrow();
  });

  it('does not copy a process-env provider secret into workspace-owned state', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001');
    const storePath = join(workspaceRoot, 'store.json');
    const secret = 'fake-provider-secret-from-process-env';
    mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify(
        {
          schemaVersion: 1,
        },
        null,
        2
      )
    );
    writeFileSync(
      join(dataRoot, 'config', 'providers', 'openrouter.provider.jsonc'),
      JSON.stringify({
        id: 'openrouter',
        displayName: 'OpenRouter',
        kind: 'custom',
        models: ['m'],
        secretRef: 'env:OPENROUTER_API_KEY',
      })
    );
    const persistedStore = `${JSON.stringify(
      {
        workspaceResources: [
          [
            'ws_00000000-0000-7000-8000-000000000001',
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
    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001');
    const secretsPath = join(dataRoot, 'secrets', 'openkit.env');
    const storePath = join(workspaceRoot, 'store.json');
    const secret = 'fake-provider-secret-from-env-file';
    const persistedSecrets = `OPENROUTER_API_KEY='${secret}'\n`;
    mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
    mkdirSync(join(dataRoot, 'secrets'), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify(
        {
          schemaVersion: 1,
        },
        null,
        2
      )
    );
    writeFileSync(
      join(dataRoot, 'config', 'providers', 'openrouter.provider.jsonc'),
      JSON.stringify({
        id: 'openrouter',
        displayName: 'OpenRouter',
        kind: 'custom',
        models: ['m'],
        secretRef: 'env:OPENROUTER_API_KEY',
      })
    );
    writeFileSync(secretsPath, persistedSecrets);
    const persistedStore = `${JSON.stringify(
      {
        workspaceResources: [
          [
            'ws_00000000-0000-7000-8000-000000000001',
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
    mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'providers', 'openrouter.provider.jsonc'),
      JSON.stringify(
        {
          id: 'openrouter',
          displayName: 'OpenRouter',
          kind: 'custom',
          models: ['m'],
          apiKey: 'sk-old-inline-secret',
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

  it.each([
    {
      label: 'valid process secret',
      source: 'process',
      secret: 'fixture-signing-secret-32-characters-long',
      launch: true,
    },
    {
      label: 'valid secrets-file secret',
      source: 'file',
      secret: 'fixture-signing-secret-32-characters-long',
      launch: true,
    },
    { label: 'missing signing secret', source: 'process', secret: '', launch: false },
    {
      label: 'short signing secret',
      source: 'process',
      secret: 'short-fixture-secret',
      launch: false,
    },
    { label: 'seed-only without signing secret', source: 'seed', secret: '', launch: false },
  ])('preserves safe app launch and backup mounts with $label', async ({
    source,
    secret,
    launch,
  }) => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-app-data-'));
    const bin = await mkdtemp(join(tmpdir(), 'openkit-app-bin-'));
    const argvPath = join(bin, 'docker-argv');
    const effectsPath = join(bin, 'docker-effects');
    const envFile = join(dataRoot, 'secrets', 'openkit.env');
    if (source === 'file') {
      mkdirSync(dirname(envFile), { recursive: true });
      writeFileSync(envFile, `BETTER_AUTH_SECRET='${secret}'\n`, { mode: 0o600 });
    }
    writeFileSync(
      join(bin, 'docker'),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >> "\${DOCKER_EFFECTS_FILE}"
if [[ "\${1:-}" == image && "\${2:-}" == inspect ]]; then
  exit 0
fi
if [[ "\${1:-}" == rm ]]; then
  exit 0
fi
if [[ "\${1:-}" == run ]]; then
  printf '%s\\0' "$@" > "\${DOCKER_ARGV_FILE}"
  [[ "\${BETTER_AUTH_SECRET:-}" == "\${OPENKIT_TEST_EXPECTED_AUTH_SECRET}" ]] || exit 98
  exit 0
fi
exit 99
`
    );
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'docker'), 0o755);
    chmodSync(join(bin, 'curl'), 0o755);

    const result = spawnSync('bash', [appRunScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        DOCKER_ARGV_FILE: argvPath,
        DOCKER_EFFECTS_FILE: effectsPath,
        BETTER_AUTH_SECRET: source === 'process' ? secret : '',
        OPENKIT_TEST_EXPECTED_AUTH_SECRET: secret,
        OPENKIT_APP_ENV_FILE: envFile,
        OPENKIT_APP_SEED_ONLY: source === 'seed' ? '1' : '0',
        OPENKIT_APP_DATA_ROOT: dataRoot,
        OPENKIT_APP_IMAGE: 'openkit/app:fixture',
        OPENKIT_APP_CONTAINER: 'openkit-app-fixture',
        OPENKIT_APP_PORT: '18099',
      },
    });

    const output = `${result.stderr}\n${result.stdout}`;
    if (secret) expect(output).not.toContain(secret);
    if (!launch) {
      if (source === 'seed') {
        expect(result.status, output).toBe(0);
        expect(result.stdout).toContain('Seed-only mode complete.');
      } else {
        expect(result.status, output).not.toBe(0);
        expect(output).toContain('BETTER_AUTH_SECRET');
      }
      expect(existsSync(effectsPath)).toBe(false);
      expect(existsSync(argvPath)).toBe(false);
      return;
    }
    expect(result.status, output).toBe(0);
    const args = readFileSync(argvPath, 'utf8').split('\0').filter(Boolean);
    expect(args).toContain('OPENKIT_CORE_MODE=server');
    const authOriginIndex = args.indexOf('BETTER_AUTH_URL=http://127.0.0.1:18099');
    expect(authOriginIndex).toBeGreaterThan(0);
    expect(args[authOriginIndex - 1]).toBe('--env');
    const signingNameIndex = args.indexOf('BETTER_AUTH_SECRET');
    expect(signingNameIndex).toBeGreaterThan(0);
    expect(args[signingNameIndex - 1]).toBe('--env');
    expect(args.join(' ')).not.toContain(secret);
    expect(args).toContain(`${dataRoot}:/data/openkit`);
    expect(args).toContain(`${dataRoot}.backups:/data/openkit.backups`);
    expect(existsSync(`${dataRoot}.backups`)).toBe(true);
  });
});
