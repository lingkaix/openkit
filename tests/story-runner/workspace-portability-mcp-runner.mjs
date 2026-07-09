import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { seedDemoWorkspaceDataRoot } from '../support/demo-data.mjs';
import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const storyRunnerRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(storyRunnerRoot, '../..');
const nanoCoreDist = join(repoRoot, 'apps/nanocore/dist/index.js');
const mcpRegistryDist = join(repoRoot, 'mcp/dist/registry.js');
const mcpClientDist = join(repoRoot, 'mcp/dist/nanocore-client.js');
const EVIDENCE_FILE = 'workspace-portability-mcp-result.json';

/** Default deterministic workspace portability MCP story artifact. */
export const DEFAULT_WORKSPACE_PORTABILITY_MCP_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/workspace-portability-release.story.md'
);

/**
 * Loads and validates the workspace portability MCP story artifact.
 *
 * @param {{ readStoryFile?: (path: string) => string, storyPath?: string }} options Loader options.
 * @returns {import('./story-metadata.mjs').ParsedStoryDocument} Parsed story document.
 */
export function loadWorkspacePortabilityMcpStory(options = {}) {
  const storyPath = options.storyPath ?? DEFAULT_WORKSPACE_PORTABILITY_MCP_STORY_PATH;
  const readStoryFile = options.readStoryFile ?? ((path) => readFileSync(path, 'utf8'));
  const story = parseStoryDocument(readStoryFile(storyPath), storyPath);

  validateStoryMetadata(story.metadata, storyPath);

  if (story.metadata.requires_real_provider || story.metadata.requires_real_codex) {
    throw new Error(`${storyPath} must not require real provider or real Codex execution.`);
  }

  return story;
}

/**
 * Runs the deterministic workspace portability MCP story subset.
 *
 * @param {{ env?: NodeJS.ProcessEnv, spawnProcess?: typeof spawn, storyPath?: string, stdout?: (message: string) => void }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Parsed story result.
 */
export async function runWorkspacePortabilityMcpStory(options = {}) {
  assertBuilt(nanoCoreDist);
  assertBuilt(mcpRegistryDist);
  assertBuilt(mcpClientDist);

  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const story = loadWorkspacePortabilityMcpStory({ storyPath: options.storyPath });
  const source = await startNanoCore('openkit-workspace-portability-source-', options, env);
  const target = await startNanoCore('openkit-workspace-portability-target-', options, env);
  const sourceRepo = createGitRepository('openkit-portability-source-repo-');
  const targetRepo = createGitRepository('openkit-portability-target-repo-');

  try {
    const workspaceId = 'ws_demo';
    const sourceRegistry = await createRegistry(source.baseUrl);
    const targetRegistry = await createRegistry(target.baseUrl);
    const tools = sourceRegistry.listTools().map((tool) => tool.name);

    for (const tool of [
      'openkit.export_workspace',
      'openkit.dry_run_workspace_import',
      'openkit.import_workspace',
      'openkit.link_repository',
    ]) {
      assert(tools.includes(tool), `MCP tools/list did not include ${tool}.`);
    }

    await postJson(`${source.baseUrl}/api/workspaces/${workspaceId}/knowledge`, {
      content: 'Workspace portability MCP story knowledge must survive import.',
      kind: 'project-context',
      requestId: '00000000-0000-4000-8000-00000000f901',
      title: 'Workspace portability MCP story knowledge',
    });
    await sourceRegistry.callTool('openkit.link_repository', {
      displayName: 'Source portability repository',
      localPath: sourceRepo,
      requestId: '00000000-0000-4000-8000-00000000f902',
      workspaceId,
    });

    const exported = await sourceRegistry.callTool('openkit.export_workspace', {
      requestId: '00000000-0000-4000-8000-00000000f903',
      workspaceId,
    });
    const exportId = exported.raw.exportId;

    assert(typeof exportId === 'string' && exportId.length > 0, 'Export id was not returned.');
    assert(Array.isArray(exported.raw.checkedFiles), 'Export did not return checked files.');
    assert(
      !JSON.stringify(exported.raw).includes(source.dataRoot),
      'Export leaked source data root.'
    );

    copyExportHandle(source.dataRoot, target.dataRoot, workspaceId, exportId);

    const beforeDryRun = await readWorkspaces(target.baseUrl);
    const dryRun = await targetRegistry.callTool('openkit.dry_run_workspace_import', {
      exportId,
      sourceWorkspaceId: workspaceId,
    });
    const afterDryRun = await readWorkspaces(target.baseUrl);

    assert(dryRun.raw.mode === 'dry-run', 'Import dry-run did not return dry-run mode.');
    assert(
      workspaceIds(afterDryRun).join(',') === workspaceIds(beforeDryRun).join(','),
      'Import dry-run mutated target workspaces.'
    );

    const imported = await targetRegistry.callTool('openkit.import_workspace', {
      exportId,
      requestId: '00000000-0000-4000-8000-00000000f904',
      sourceWorkspaceId: workspaceId,
    });
    const importedWorkspaceId = imported.raw.importedWorkspaceId;

    assert(
      typeof importedWorkspaceId === 'string' && importedWorkspaceId.length > 0,
      'Import did not return an imported workspace id.'
    );
    assert(
      imported.raw.workspace?.importedFrom?.sourceWorkspaceId === workspaceId,
      'Imported workspace lineage did not preserve source workspace id.'
    );
    assert(
      /^sha256:[a-f0-9]{64}$/.test(imported.raw.workspace?.importedFrom?.manifestDigest ?? ''),
      'Imported workspace lineage did not include a manifest digest.'
    );

    const knowledge = await getJson(
      `${target.baseUrl}/api/workspaces/${importedWorkspaceId}/knowledge`
    );
    assert(
      knowledge.items?.some((entry) => entry.title === 'Workspace portability MCP story knowledge'),
      'Imported workspace knowledge did not include the seeded entry.'
    );

    const importedRepositories = await targetRegistry.callTool('openkit.read_repositories', {
      workspaceId: importedWorkspaceId,
    });

    assert(
      importedRepositories.raw.repositories?.items?.some(
        (item) => item.resourceId === 'repo_default' && item.diagnosticsStatus === 'missing'
      ),
      'Imported repository metadata was missing or unexpectedly ready.'
    );
    assert(
      !JSON.stringify(importedRepositories.raw).includes(sourceRepo),
      'Imported repository metadata leaked source repository path.'
    );

    await targetRegistry.callTool('openkit.link_repository', {
      displayName: 'Target portability repository',
      localPath: targetRepo,
      requestId: '00000000-0000-4000-8000-00000000f905',
      workspaceId: importedWorkspaceId,
    });
    const reboundRepositories = await targetRegistry.callTool('openkit.read_repositories', {
      workspaceId: importedWorkspaceId,
    });

    assert(
      reboundRepositories.raw.diagnostics?.defaultResource?.diagnosticsStatus === 'ready',
      'Target repository rebind did not become ready.'
    );
    assert(
      !JSON.stringify({ exported, imported, importedRepositories, reboundRepositories }).includes(
        targetRepo
      ),
      'Repository responses leaked target repository path.'
    );

    const result = {
      story: {
        id: story.metadata.id,
        title: story.metadata.title,
      },
      smoke: {
        checkedFiles: exported.raw.checkedFiles.length,
        dryRunMode: dryRun.raw.mode,
        importedWorkspaceId,
        knowledgeItems: knowledge.items?.length ?? 0,
        repositoryStatus: reboundRepositories.raw.diagnostics.defaultResource.diagnosticsStatus,
        tools: tools.length,
      },
      status: 'ok',
    };

    writeEvidence(env.OPENKIT_L6_MCP_EVIDENCE_DIR, result);
    stdout(JSON.stringify(result, null, 2));

    return result;
  } finally {
    await Promise.all([stopProcess(source.process), stopProcess(target.process)]);
    rmSync(source.dataRoot, { force: true, recursive: true });
    rmSync(target.dataRoot, { force: true, recursive: true });
    rmSync(sourceRepo, { force: true, recursive: true });
    rmSync(targetRepo, { force: true, recursive: true });
  }
}

/**
 * Starts one temporary NanoCore process.
 *
 * @param {string} dataRootPrefix Temporary data-root prefix.
 * @param {{ spawnProcess?: typeof spawn }} options Runner options.
 * @param {NodeJS.ProcessEnv} env Base process environment.
 * @returns {Promise<{ baseUrl: string, dataRoot: string, process: ReturnType<typeof spawn> }>} Started process context.
 */
async function startNanoCore(dataRootPrefix, options, env) {
  const port = await findOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = mkdtempSync(join(tmpdir(), dataRootPrefix));
  seedDemoWorkspaceDataRoot(dataRoot);
  const child = (options.spawnProcess ?? spawn)(process.execPath, [nanoCoreDist], {
    cwd: join(repoRoot, 'apps/nanocore'),
    env: {
      ...env,
      OPENKIT_CORE_MODE: 'local',
      OPENKIT_DATA_ROOT: dataRoot,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForHealth(baseUrl, child);

  return { baseUrl, dataRoot, process: child };
}

/**
 * Creates an OpenKit MCP interface bound to one NanoCore base URL.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @returns {Promise<ReturnType<import('../../mcp/src/registry.js').createOpenKitAiInterface>>} MCP registry.
 */
async function createRegistry(baseUrl) {
  const [{ createOpenKitAiInterface }, { createNanoCoreClient }] = await Promise.all([
    import(pathToFileURL(mcpRegistryDist).href),
    import(pathToFileURL(mcpClientDist).href),
  ]);

  return createOpenKitAiInterface({
    nanoCore: createNanoCoreClient({ baseUrl }),
  });
}

/**
 * Creates a disposable local Git repository.
 *
 * @param {string} prefix Temporary directory prefix.
 * @returns {string} Repository path.
 */
function createGitRepository(prefix) {
  const repository = mkdtempSync(join(tmpdir(), prefix));

  execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
  writeFileSync(join(repository, 'README.md'), '# Portable fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'chore: seed portable fixture'], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'openkit@example.com',
      GIT_AUTHOR_NAME: 'OpenKit Story',
      GIT_COMMITTER_EMAIL: 'openkit@example.com',
      GIT_COMMITTER_NAME: 'OpenKit Story',
    },
    stdio: 'ignore',
  });

  return repository;
}

/**
 * Copies one server-managed export handle from source data root to target data root.
 *
 * @param {string} sourceDataRoot Source NanoCore data root.
 * @param {string} targetDataRoot Target NanoCore data root.
 * @param {string} workspaceId Exported workspace id.
 * @param {string} exportId Export handle id.
 */
function copyExportHandle(sourceDataRoot, targetDataRoot, workspaceId, exportId) {
  const relative = join('server', 'exports', 'workspaces', workspaceId, exportId);
  const sourceRoot = join(sourceDataRoot, relative);
  const targetRoot = join(targetDataRoot, relative);

  mkdirSync(dirname(targetRoot), { recursive: true });
  cpSync(sourceRoot, targetRoot, { recursive: true });
}

/**
 * Posts JSON and parses a successful response.
 *
 * @param {string} url Request URL.
 * @param {Record<string, unknown>} body JSON request body.
 * @returns {Promise<unknown>} Parsed JSON response.
 */
async function postJson(url, body) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Fetches and parses one successful JSON response.
 *
 * @param {string} url Request URL.
 * @returns {Promise<Record<string, any>>} Parsed JSON response.
 */
async function getJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

/**
 * Reads all workspaces from one NanoCore instance.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @returns {Promise<Record<string, any>>} Workspace list response.
 */
async function readWorkspaces(baseUrl) {
  return await getJson(`${baseUrl}/api/workspaces`);
}

/**
 * Extracts workspace ids from a workspace list response.
 *
 * @param {Record<string, any>} response Workspace list response.
 * @returns {string[]} Sorted workspace ids.
 */
function workspaceIds(response) {
  return (response.items ?? []).map((workspace) => workspace.id).sort();
}

/**
 * Fails the runner when a required build output is missing.
 *
 * @param {string} filePath Build output path.
 */
function assertBuilt(filePath) {
  try {
    readFileSync(filePath);
  } catch {
    throw new Error(`Required build output is missing: ${filePath}`);
  }
}

/**
 * Allocates an available local TCP port.
 *
 * @returns {Promise<number>} Free localhost port.
 */
async function findOpenPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address !== 'object') {
        reject(new Error('Failed to allocate a local port.'));
        return;
      }

      server.close(() => resolvePort(address.port));
    });
  });
}

/**
 * Waits until one NanoCore endpoint responds to `/api/health`.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @param {ReturnType<typeof spawn>} child Spawned NanoCore process.
 */
async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`NanoCore exited before health check passed: ${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      await sleep(100);
    }
  }

  throw new Error('Timed out waiting for NanoCore health check.');
}

/**
 * Stops one spawned process.
 *
 * @param {ReturnType<typeof spawn> | null} child Process to stop.
 */
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  child.kill('SIGTERM');

  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    sleep(2_000).then(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

/**
 * Sleeps for the requested number of milliseconds.
 *
 * @param {number} ms Delay in milliseconds.
 */
async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Ensures the runner saw a truthy condition.
 *
 * @param {unknown} condition Condition to assert.
 * @param {string} message Failure message.
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Writes optional story evidence when an evidence directory is configured.
 *
 * @param {string | undefined} evidenceDir Evidence directory from the environment.
 * @param {Record<string, unknown>} result Story result payload.
 */
function writeEvidence(evidenceDir, result) {
  if (!evidenceDir) {
    return;
  }

  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, EVIDENCE_FILE), `${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkspacePortabilityMcpStory().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
