import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const EVIDENCE_FILE = 'recovery-mcp-smoke-result.json';

/** Default deterministic Recovery MCP story artifact. */
export const DEFAULT_RECOVERY_MCP_SMOKE_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/recovery-mcp-smoke.story.md'
);

/**
 * Loads and validates the deterministic Recovery MCP story artifact.
 *
 * @param {{ readStoryFile?: (path: string) => string, storyPath?: string }} options Loader options.
 * @returns {import('./story-metadata.mjs').ParsedStoryDocument} Parsed story document.
 */
export function loadRecoveryMcpSmokeStory(options = {}) {
  const storyPath = options.storyPath ?? DEFAULT_RECOVERY_MCP_SMOKE_STORY_PATH;
  const readStoryFile = options.readStoryFile ?? ((path) => readFileSync(path, 'utf8'));
  const story = parseStoryDocument(readStoryFile(storyPath), storyPath);

  validateStoryMetadata(story.metadata, storyPath);

  if (story.metadata.requires_real_provider || story.metadata.requires_real_codex) {
    throw new Error(`${storyPath} must not require real provider or real Codex execution.`);
  }

  return story;
}

/**
 * Verifies build outputs required by the deterministic Recovery MCP runner.
 *
 * @param {{ mcpClientDist?: string, mcpRegistryDist?: string, nanoCoreDist?: string }} paths Optional build output paths.
 */
export function assertRecoveryMcpSmokeBuildOutputs(paths = {}) {
  assertBuilt(paths.nanoCoreDist ?? nanoCoreDist);
  assertBuilt(paths.mcpRegistryDist ?? mcpRegistryDist);
  assertBuilt(paths.mcpClientDist ?? mcpClientDist);
}

/**
 * Runs the story-backed deterministic Recovery MCP smoke.
 *
 * @param {{ env?: NodeJS.ProcessEnv, spawnProcess?: typeof spawn, storyPath?: string, stdout?: (message: string) => void }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Parsed smoke result with story metadata.
 */
export async function runRecoveryMcpSmokeStory(options = {}) {
  assertRecoveryMcpSmokeBuildOutputs();

  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const story = loadRecoveryMcpSmokeStory({ storyPath: options.storyPath });
  const port = await findOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-recovery-mcp-smoke-'));
  let nanoCore = null;

  try {
    seedDemoWorkspaceDataRoot(dataRoot);
    nanoCore = (options.spawnProcess ?? spawn)(process.execPath, [nanoCoreDist], {
      cwd: join(repoRoot, 'apps/nanocore'),
      env: {
        ...env,
        OPENKIT_CORE_MODE: 'local',
        OPENKIT_DATA_ROOT: dataRoot,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth(baseUrl, nanoCore);

    const [{ createOpenKitAiInterface }, { createNanoCoreClient }] = await Promise.all([
      import(pathToFileURL(mcpRegistryDist).href),
      import(pathToFileURL(mcpClientDist).href),
    ]);
    const registry = createOpenKitAiInterface({
      nanoCore: createNanoCoreClient({ baseUrl }),
    });
    const tools = registry.listTools();

    for (const toolName of [
      'openkit.list_interrupted_workers',
      'openkit.list_recovery_pending_user_turns',
      'openkit.edit_recovery_pending_user_turn',
      'openkit.convert_recovery_pending_user_turn_to_follow_up',
      'openkit.cancel_recovery_pending_user_turn',
      'openkit.retry_interrupted_worker_checkpoint',
    ]) {
      assert(
        tools.some((tool) => tool.name === toolName),
        `MCP tools/list did not include ${toolName}.`
      );
    }

    const workspaceId = 'ws_demo';
    await registry.callTool('openkit.read_status', { workspaceId });
    const thread = await registry.callTool('openkit.create_thread', {
      workspaceId,
      title: 'Recovery MCP smoke',
      requestId: '00000000-0000-4000-8000-00000000a001',
    });
    const threadId = thread.raw.id;

    assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

    const seeded = await seedInterruptedRecovery(baseUrl, workspaceId, threadId);
    const turnId = seeded.checkpoint?.turnId;
    const requestId = seeded.pendingUserTurn?.requestId;

    assert(typeof turnId === 'string' && turnId.length > 0, 'Seeded turn id was not returned.');
    assert(
      typeof requestId === 'string' && requestId.length > 0,
      'Seeded pending request id was not returned.'
    );

    const interruptedBefore = await registry.callTool('openkit.list_interrupted_workers', {});
    const interruptedRow = interruptedBefore.raw.items.find((item) => item.turnId === turnId);

    assert(interruptedRow, 'Interrupted worker row was missing before retry.');

    const pendingBefore = await registry.callTool('openkit.list_recovery_pending_user_turns', {
      workspaceId,
      threadId,
    });
    const pendingRow = pendingBefore.raw.items.find((item) => item.requestId === requestId);

    assert(pendingRow, 'Pending user turn was missing before mutation.');

    const edited = await registry.callTool('openkit.edit_recovery_pending_user_turn', {
      workspaceId,
      threadId,
      requestId,
      text: 'Edited deterministic recovery input.',
    });

    assert(edited.raw.edited === true, 'Pending user turn edit did not report edited=true.');
    assert(
      edited.raw.item?.text === 'Edited deterministic recovery input.',
      'Pending user turn edit did not return the edited item text.'
    );

    const followUp = await registry.callTool(
      'openkit.convert_recovery_pending_user_turn_to_follow_up',
      {
        workspaceId,
        threadId,
        requestId,
      }
    );

    assert(followUp.raw.converted === true, 'Pending user turn conversion failed.');
    assert(
      followUp.raw.pendingUserTurn?.queueMode === 'follow_up',
      'Pending user turn conversion did not set follow_up queue mode.'
    );

    const cancelled = await registry.callTool('openkit.cancel_recovery_pending_user_turn', {
      workspaceId,
      threadId,
      requestId,
    });

    assert(cancelled.raw.cancelled === true, 'Pending user turn cancellation failed.');

    const pendingAfter = await registry.callTool('openkit.list_recovery_pending_user_turns', {
      workspaceId,
      threadId,
    });

    assert(
      !pendingAfter.raw.items.some((item) => item.requestId === requestId),
      'Pending user turn was still listed after cancellation.'
    );

    const retried = await registry.callTool('openkit.retry_interrupted_worker_checkpoint', {
      workspaceId,
      threadId,
      turnId,
    });

    assert(retried.raw.retried === true, 'Interrupted worker retry failed.');
    assert(retried.raw.turn?.id === turnId, 'Interrupted worker retry returned the wrong turn.');

    const interruptedAfter = await registry.callTool('openkit.list_interrupted_workers', {});

    assert(
      !interruptedAfter.raw.items.some((item) => item.turnId === turnId),
      'Interrupted worker row was still listed after retry.'
    );

    const result = {
      story: {
        id: story.metadata.id,
        title: story.metadata.title,
      },
      smoke: {
        cancelled: cancelled.raw.cancelled,
        edited: edited.raw.edited,
        interruptedRowsAfter: interruptedAfter.raw.items.length,
        pendingRowsAfter: pendingAfter.raw.items.length,
        queueMode: followUp.raw.pendingUserTurn.queueMode,
        retried: retried.raw.retried,
        requestId,
        threadId,
        tools: tools.length,
        turnId,
        workspaceId,
      },
      status: 'ok',
    };

    assertNoSecretMarkers(result);
    writeEvidence(env.OPENKIT_L6_MCP_EVIDENCE_DIR, result);
    stdout(JSON.stringify(result, null, 2));

    return result;
  } finally {
    await stopProcess(nanoCore);
    rmSync(dataRoot, { force: true, recursive: true });
  }
}

/**
 * Seeds deterministic recovery state through NanoCore's public setup route.
 *
 * @param {string} baseUrl NanoCore base URL.
 * @param {string} workspaceId Workspace id.
 * @param {string} threadId Thread id.
 * @returns {Promise<Record<string, unknown>>} Seeded recovery state.
 */
async function seedInterruptedRecovery(baseUrl, workspaceId, threadId) {
  const response = await fetch(
    `${baseUrl}/api/app/workspaces/${workspaceId}/threads/${threadId}/recovery/interrupted-worker`,
    { method: 'POST' }
  );
  const body = await response.json();

  if (!response.ok) {
    throw new Error(`Recovery seed failed with ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

/**
 * Fails the smoke script when a required build output is missing.
 *
 * @param {string} filePath Build output path.
 */
function assertBuilt(filePath) {
  if (!readFileExists(filePath)) {
    throw new Error(`Required build output is missing: ${filePath}`);
  }
}

/**
 * Checks whether a file can be read.
 *
 * @param {string} filePath File path.
 * @returns {boolean} Whether the file exists.
 */
function readFileExists(filePath) {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
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
 * @param {ReturnType<typeof spawn> | null} child Spawned NanoCore process.
 */
async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
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
 * Ensures the smoke script saw a truthy condition.
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
 * Checks story evidence for obvious fake secret markers.
 *
 * @param {Record<string, unknown>} result Story result payload.
 */
function assertNoSecretMarkers(result) {
  const text = JSON.stringify(result);

  for (const marker of ['sk-', 'ghp_', 'OPENKIT_FAKE_SECRET']) {
    assert(!text.includes(marker), `Recovery MCP evidence contained secret marker ${marker}.`);
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
  runRecoveryMcpSmokeStory().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
