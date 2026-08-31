import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  seedDemoWorkspaceAuthority,
  seedDemoWorkspaceDataRoot as seedSharedDemoWorkspaceDataRoot,
} from '../../../../tests/support/demo-data.mjs';

/**
 * Writes the explicit Demo Workspace fixture used by local-mode Web e2e tests.
 *
 * @param dataRoot NanoCore data root to seed.
 * @param fixtureRoot Stack-owned fixture root outside the NanoCore data root.
 * @returns Resolves after the file records and Core membership authority are durable.
 * @throws When fixture files, Git initialization, or authority persistence fails.
 */
export async function seedDemoWorkspaceDataRoot(
  dataRoot: string,
  fixtureRoot: string
): Promise<void> {
  seedSharedDemoWorkspaceDataRoot(dataRoot);
  await seedSimulatorInferenceConfig(dataRoot);
  await seedSimulatorAgent(dataRoot);
  await seedDemoWorkspaceAuthority(dataRoot);
  await seedReadyRepository(dataRoot, await createDisposableGitRepository(fixtureRoot));
}

/**
 * Installs the secret-free provider profile and logical Gateway route resolved by the simulator Agent fixture.
 *
 * @param dataRoot NanoCore data root to seed.
 * @returns Resolves after the provider profile and Gateway route are durable.
 * @throws When the config directory, provider profile, or Gateway route cannot be written.
 */
async function seedSimulatorInferenceConfig(dataRoot: string): Promise<void> {
  const providersRoot = join(dataRoot, 'config', 'providers');
  await mkdir(providersRoot, { recursive: true });
  await writeFile(
    join(providersRoot, 'agent-openrouter.provider.jsonc'),
    `${JSON.stringify(
      {
        id: 'agent-openrouter',
        displayName: 'Agent OpenRouter test local',
        kind: 'local',
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(dataRoot, 'config', 'gateway.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            routes: [
              {
                id: 'simulator',
                providerProfileId: 'agent-openrouter',
                providerModel: 'openai/gpt-5.2',
              },
            ],
          },
        ],
        requiredFeatures: [],
        extensions: {},
      },
      null,
      2
    )}\n`
  );
}

/**
 * Creates the isolated disposable Git repository and initial HEAD required by real Turn admission.
 * Every Git subprocess shares one scrubbed execution context with empty system/global config,
 * disabled prompting and signing, and an empty fixture-owned hooks directory.
 *
 * @param fixtureRoot Stack-owned fixture root outside the NanoCore data root.
 * @returns Absolute repository path below the fixture root.
 * @throws When file creation or any local Git initialization, configuration, add, or commit fails.
 */
async function createDisposableGitRepository(fixtureRoot: string): Promise<string> {
  const repositoryPath = join(fixtureRoot, 'repository');
  const hooksPath = join(fixtureRoot, 'hooks');
  await Promise.all([
    mkdir(repositoryPath, { recursive: true }),
    mkdir(hooksPath, { recursive: true }),
  ]);
  const git = promisify(execFile);
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_CONFIG_'))
  );
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const gitOptions = {
    cwd: repositoryPath,
    env: {
      ...inheritedEnvironment,
      GIT_ASKPASS: '',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_KEY_1: 'commit.gpgSign',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: nullDevice,
      GIT_CONFIG_VALUE_0: hooksPath,
      GIT_CONFIG_VALUE_1: 'false',
      GIT_TERMINAL_PROMPT: '0',
      SSH_ASKPASS: '',
    },
  };
  await git('git', ['init', '--quiet'], gitOptions);
  await git('git', ['config', 'user.email', 'openkit@example.invalid'], gitOptions);
  await git('git', ['config', 'user.name', 'OpenKit'], gitOptions);
  await writeFile(join(repositoryPath, 'README.md'), '# Browser fixture\n');
  await git('git', ['add', 'README.md'], gitOptions);
  await git('git', ['commit', '--quiet', '-m', 'initial'], gitOptions);
  return repositoryPath;
}

/**
 * Records the disposable fixture Git repository as the ready default needed by real Turns.
 *
 * @param dataRoot NanoCore data root that owns the demo Workspace.
 * @param repositoryPath Disposable Git repository outside the NanoCore data root.
 * @returns Resolves after the ready repository authority is durable.
 * @throws When database migration, validation, or persistence fails.
 */
async function seedReadyRepository(dataRoot: string, repositoryPath: string): Promise<void> {
  const [{ openWorkspaceDb }, { applyScopedMigrations }, { upsertWorkspaceRepositoryResource }] =
    await Promise.all([
      import('../../../nanocore/dist/storage/db.js'),
      import('../../../nanocore/dist/storage/migrate.js'),
      import('../../../nanocore/dist/workspace/repository-store.js'),
    ]);
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');

  try {
    applyScopedMigrations(workspaceDb);
    upsertWorkspaceRepositoryResource(workspaceDb, {
      workspaceExists: (workspaceId) => workspaceId === 'ws_demo',
      workspaceId: 'ws_demo',
      displayName: 'OpenKit browser fixture',
      localPath: repositoryPath,
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Installs one resolvable non-simulator Agent manifest for the internal simulator executor.
 *
 * The simulator remains the executor; this authored identity only satisfies the same Agent setup
 * resolution boundary used by a production Turn.
 *
 * @param dataRoot NanoCore data root to seed.
 * @returns Resolves after the manifest is durable.
 * @throws When the config directory or manifest cannot be written.
 */
async function seedSimulatorAgent(dataRoot: string): Promise<void> {
  const agentsRoot = join(dataRoot, 'config', 'agents');
  await mkdir(agentsRoot, { recursive: true });
  await writeFile(
    join(agentsRoot, 'codex.agent.jsonc'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        requiredFeatures: [],
        id: 'agent_codex_host',
        displayName: 'Codex Agent',
        runtime: {
          kind: 'codex',
          adapter: 'codex',
          version: 'test',
          image: {
            kind: 'reference',
            ref: 'openkit/worker-codex:dev',
            pullPolicy: 'if-not-present',
          },
          binaries: [
            { id: 'openkit-worker-shim', path: '/usr/local/bin/openkit-worker-shim' },
            { id: 'node', path: '/usr/local/bin/node' },
            { id: 'codex', path: '/usr/local/bin/codex' },
          ],
        },
        models: {
          preferredLogicalModelId: 'reasoning',
          allowedLogicalModelIds: ['reasoning'],
        },
        profiles: [{ id: 'default', instructionsRef: 'codex', skills: [] }],
        defaultProfileId: 'default',
        skills: [],
        mcp: [],
        sandbox: {
          backend: {
            allowedKinds: ['openshell'],
            preferred: 'openshell',
            requiredCapabilities: ['trusted-worker-inference-relay'],
          },
          credentialDeclarations: [],
          filesystem: [],
          network: [],
        },
      },
      null,
      2
    )}\n`
  );
}
