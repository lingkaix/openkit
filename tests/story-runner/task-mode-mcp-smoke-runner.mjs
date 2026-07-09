import { execFileSync, spawn } from 'node:child_process';
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
const EVIDENCE_FILE = 'task-mode-mcp-smoke-result.json';

/** Default deterministic Task Mode MCP story artifact. */
export const DEFAULT_TASK_MODE_MCP_SMOKE_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/task-mode-mcp-smoke.story.md'
);

/**
 * Loads and validates the deterministic Task Mode MCP story artifact.
 *
 * @param {{ readStoryFile?: (path: string) => string, storyPath?: string }} options Loader options.
 * @returns {import('./story-metadata.mjs').ParsedStoryDocument} Parsed story document.
 */
export function loadTaskModeMcpSmokeStory(options = {}) {
  const storyPath = options.storyPath ?? DEFAULT_TASK_MODE_MCP_SMOKE_STORY_PATH;
  const readStoryFile = options.readStoryFile ?? ((path) => readFileSync(path, 'utf8'));
  const story = parseStoryDocument(readStoryFile(storyPath), storyPath);

  validateStoryMetadata(story.metadata, storyPath);

  if (story.metadata.requires_real_provider || story.metadata.requires_real_codex) {
    throw new Error(`${storyPath} must not require real provider or real Codex execution.`);
  }

  return story;
}

/**
 * Runs the story-backed deterministic Task Mode MCP smoke.
 *
 * @param {{ env?: NodeJS.ProcessEnv, spawnProcess?: typeof spawn, storyPath?: string, stdout?: (message: string) => void }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Parsed smoke result with story metadata.
 */
export async function runTaskModeMcpSmokeStory(options = {}) {
  assertBuilt(nanoCoreDist);
  assertBuilt(mcpRegistryDist);
  assertBuilt(mcpClientDist);

  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const story = loadTaskModeMcpSmokeStory({ storyPath: options.storyPath });
  const port = await findOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-mode-mcp-smoke-'));
  let nanoCore = null;

  try {
    seedDemoWorkspaceDataRoot(dataRoot);
    nanoCore = (options.spawnProcess ?? spawn)(process.execPath, [nanoCoreDist], {
      cwd: join(repoRoot, 'apps/nanocore'),
      env: {
        ...env,
        OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1',
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

    assert(
      tools.some((tool) => tool.name === 'openkit.start_task'),
      'MCP tools/list did not include openkit.start_task.'
    );

    const workspaceId = 'ws_demo';
    await registry.callTool('openkit.read_status', { workspaceId });
    const thread = await registry.callTool('openkit.create_thread', {
      workspaceId,
      title: 'Task Mode MCP smoke',
      requestId: '00000000-0000-4000-8000-00000000f001',
    });
    const threadId = thread.raw.id;

    assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

    const repositoryPath = createGitRepository('openkit-task-mode-mcp-smoke-repo-');
    await registry.callTool('openkit.link_repository', {
      workspaceId,
      displayName: 'Task Mode MCP smoke repository',
      localPath: repositoryPath,
      requestId: '00000000-0000-4000-8000-00000000f002',
    });

    const boundedThread = await registry.callTool('openkit.create_thread', {
      workspaceId,
      title: 'Task Mode bounded completion smoke',
      requestId: '00000000-0000-4000-8000-00000000f003',
    });
    const boundedThreadId = boundedThread.raw.id;

    assert(
      typeof boundedThreadId === 'string' && boundedThreadId.length > 0,
      'Bounded Task thread id was not returned.'
    );

    const boundedTask = await registry.callTool('openkit.start_task', {
      workspaceId,
      threadId: boundedThreadId,
      input: 'Implement the bounded Task Mode simulator fix.',
      requestId: '00000000-0000-4000-8000-00000000f004',
    });

    assert(
      boundedTask.raw.state === 'awaiting-human',
      'Bounded Task Mode did not pause on human attention.'
    );
    assert(
      boundedTask.raw.completion === null,
      'Paused bounded Task Mode returned a terminal completion.'
    );

    const boundedInitialRead = await registry.callTool('openkit.read_thread', {
      workspaceId,
      threadId: boundedThreadId,
    });
    const boundedInitialItems = threadItemsFromRead(boundedInitialRead.raw);
    const progressItem = boundedInitialItems.find((item) => item.type === 'assistant-message');
    const approvalItem = boundedInitialItems.find((item) => item.type === 'approval-request');

    assert(progressItem?.text?.includes('deterministic plan'), 'Task progress item was missing.');
    assert(approvalItem, 'Task approval item was missing.');

    const approvals = await registry.callTool('openkit.read_action_center', {
      workspaceId,
      kind: 'approval',
      limit: 20,
    });
    const approvalRow = approvals.raw.items.find(
      (item) => item.source?.turnId === boundedTask.raw.turn.id
    );

    assert(approvalRow, 'Action Center did not expose the Task approval gate.');

    await registry.callTool('openkit.resolve_action_center_item', {
      workspaceId,
      rowId: approvalRow.id,
      actionId: 'grant_approval',
      decision: 'granted',
      requestId: '00000000-0000-4000-8000-00000000f005',
    });

    const questions = await registry.callTool('openkit.read_action_center', {
      workspaceId,
      kind: 'question',
      limit: 20,
    });
    const questionRow = questions.raw.items.find(
      (item) => item.source?.turnId === boundedTask.raw.turn.id
    );

    assert(questionRow, 'Action Center did not expose the Task question gate.');

    await registry.callTool('openkit.resolve_action_center_item', {
      workspaceId,
      rowId: questionRow.id,
      actionId: 'answer_question',
      decision: 'answer_question',
      comment: 'concise',
      requestId: '00000000-0000-4000-8000-00000000f006',
    });

    const boundedCompletedRead = await registry.callTool('openkit.read_thread', {
      workspaceId,
      threadId: boundedThreadId,
    });
    const boundedCompletedItems = threadItemsFromRead(boundedCompletedRead.raw);
    const artifactItem = boundedCompletedItems.find((item) => item.type === 'artifact-reference');

    assert(artifactItem, 'Completed bounded Task did not create an artifact reference.');
    const boundedTurn = boundedCompletedRead.raw.dashboard?.turns?.find(
      (turn) => turn.id === boundedTask.raw.turn.id
    );

    assert(
      boundedTurn?.status === 'completed',
      'Bounded Task thread dashboard did not report completed work.'
    );

    const task = await registry.callTool('openkit.start_task', {
      workspaceId,
      threadId,
      input: 'Plan a multi-step release readiness project before any worker execution.',
      requestId: '00000000-0000-4000-8000-00000000f007',
    });

    assert(task.raw.state === 'escalated-to-goal', 'Task Mode did not escalate to Goal Mode.');
    assert(
      task.raw.escalation?.targetMode === 'goal',
      'Task Mode escalation did not target Goal Mode.'
    );
    assert(typeof task.raw.turn?.id === 'string', 'Task Mode response did not include a turn id.');

    const goal = await registry.callTool('openkit.read_goal', { workspaceId, threadId });
    assert(goal.raw.goal?.status === 'planning', 'Task escalation did not create a planning goal.');

    const threadRead = await registry.callTool('openkit.read_thread', { workspaceId, threadId });
    assert(
      Array.isArray(threadRead.raw.items?.items ?? threadRead.raw.items),
      'Thread read did not include thread items.'
    );

    const result = {
      story: {
        id: story.metadata.id,
        title: story.metadata.title,
      },
      smoke: {
        boundedArtifact: artifactItem.artifactId,
        boundedState: boundedTurn.status,
        escalationTarget: task.raw.escalation.targetMode,
        goalStatus: goal.raw.goal.status,
        state: task.raw.state,
        threadId,
        tools: tools.length,
        turnId: task.raw.turn.id,
      },
      status: 'ok',
    };

    writeEvidence(env.OPENKIT_L6_MCP_EVIDENCE_DIR, result);
    stdout(JSON.stringify(result, null, 2));

    return result;
  } finally {
    await stopProcess(nanoCore);
    rmSync(dataRoot, { force: true, recursive: true });
  }
}

/**
 * Creates a disposable local Git repository for Task Mode workspace binding.
 *
 * @param {string} prefix Temporary directory prefix.
 * @returns {string} Repository path.
 */
function createGitRepository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repository = join(root, 'repository');

  mkdirSync(repository);
  execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
  writeFileSync(join(repository, 'README.md'), '# Task Mode fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'chore: seed task mode fixture'], {
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
 * Extracts the thread item array from an MCP thread read response.
 *
 * @param {Record<string, unknown>} payload MCP read_thread payload.
 * @returns {Array<Record<string, unknown>>} Thread items.
 */
function threadItemsFromRead(payload) {
  return payload.items?.items ?? payload.items ?? [];
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
  runTaskModeMcpSmokeStory().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
