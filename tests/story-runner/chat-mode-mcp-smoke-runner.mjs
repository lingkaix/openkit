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
const EVIDENCE_FILE = 'chat-mode-mcp-smoke-result.json';

/** Default deterministic Chat Mode MCP story artifact. */
export const DEFAULT_CHAT_MODE_MCP_SMOKE_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/chat-mode-mcp-smoke.story.md'
);

/**
 * Loads and validates the deterministic Chat Mode MCP story artifact.
 *
 * @param {{ readStoryFile?: (path: string) => string, storyPath?: string }} options Loader options.
 * @returns {import('./story-metadata.mjs').ParsedStoryDocument} Parsed story document.
 */
export function loadChatModeMcpSmokeStory(options = {}) {
  const storyPath = options.storyPath ?? DEFAULT_CHAT_MODE_MCP_SMOKE_STORY_PATH;
  const readStoryFile = options.readStoryFile ?? ((path) => readFileSync(path, 'utf8'));
  const story = parseStoryDocument(readStoryFile(storyPath), storyPath);

  validateStoryMetadata(story.metadata, storyPath);

  if (story.metadata.requires_real_provider || story.metadata.requires_real_codex) {
    throw new Error(`${storyPath} must not require real provider or real Codex execution.`);
  }

  return story;
}

/**
 * Runs the story-backed deterministic Chat Mode MCP smoke.
 *
 * @param {{ env?: NodeJS.ProcessEnv, spawnProcess?: typeof spawn, storyPath?: string, stdout?: (message: string) => void }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Parsed smoke result with story metadata.
 */
export async function runChatModeMcpSmokeStory(options = {}) {
  assertBuilt(nanoCoreDist);
  assertBuilt(mcpRegistryDist);
  assertBuilt(mcpClientDist);

  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const story = loadChatModeMcpSmokeStory({ storyPath: options.storyPath });
  const port = await findOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-chat-mode-mcp-smoke-'));
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
      tools.some((tool) => tool.name === 'openkit.start_chat'),
      'MCP tools/list did not include openkit.start_chat.'
    );

    const workspaceId = 'ws_demo';
    await registry.callTool('openkit.read_status', { workspaceId });
    const thread = await registry.callTool('openkit.create_thread', {
      workspaceId,
      title: 'Chat Mode MCP smoke',
      requestId: '00000000-0000-4000-8000-00000000e001',
    });
    const threadId = thread.raw.id;

    assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

    await postJson(`${baseUrl}/api/workspaces/${workspaceId}/knowledge`, {
      requestId: '00000000-0000-4000-8000-00000000e002',
      kind: 'project-context',
      title: 'Launch cadence',
      content: 'OpenKit ships release candidates only after NanoCore smoke passes on a1.',
    });

    const answer = await registry.callTool('openkit.start_chat', {
      workspaceId,
      threadId,
      input: 'What is the Launch cadence?',
      requestId: '00000000-0000-4000-8000-00000000e003',
    });
    assert(answer.raw.outcome === 'answered', 'Chat Mode knowledge question was not answered.');
    assert(
      String(answer.raw.item?.text ?? '').includes('Sources: Launch cadence'),
      'Chat Mode answer did not cite seeded knowledge.'
    );

    const clarification = await registry.callTool('openkit.start_chat', {
      workspaceId,
      threadId,
      input: 'Help',
      requestId: '00000000-0000-4000-8000-00000000e004',
    });
    assert(
      clarification.raw.outcome === 'clarification-needed',
      'Chat Mode vague input did not ask for clarification.'
    );
    assert(
      clarification.raw.turn?.status === 'awaiting_human',
      'Chat Mode clarification turn did not wait for human input.'
    );

    const actionCenter = await registry.callTool('openkit.read_action_center', {
      workspaceId,
      kind: 'question',
      limit: 20,
    });
    const clarificationRow = actionCenter.raw.items.find(
      (item) => item.source?.itemId === clarification.raw.item?.id
    );

    assert(clarificationRow, 'Action Center did not expose the Chat Mode clarification.');

    const repositoryPath = createGitRepository('openkit-chat-mode-mcp-smoke-repo-');
    await registry.callTool('openkit.link_repository', {
      workspaceId,
      displayName: 'Chat Mode MCP smoke repository',
      localPath: repositoryPath,
      requestId: '00000000-0000-4000-8000-00000000e005',
    });

    const repositoryFiles = await registry.callTool('openkit.start_chat', {
      workspaceId,
      threadId,
      input: 'List repository files.',
      requestId: '00000000-0000-4000-8000-00000000e009',
    });

    assert(
      repositoryFiles.raw.outcome === 'answered',
      'Chat Mode repository file-list question was not answered.'
    );
    assert(
      String(repositoryFiles.raw.item?.text ?? '').includes('README.md'),
      'Chat Mode repository file-list answer did not include README.md.'
    );

    const repositoryFileRead = await registry.callTool('openkit.start_chat', {
      workspaceId,
      threadId,
      input: 'Read repository file docs/guide.md.',
      requestId: '00000000-0000-4000-8000-00000000e00a',
    });

    assert(
      repositoryFileRead.raw.outcome === 'answered',
      'Chat Mode repository file-read question was not answered.'
    );
    assert(
      String(repositoryFileRead.raw.item?.text ?? '').includes('Story repository guide'),
      'Chat Mode repository file-read answer did not include docs/guide.md content.'
    );
    assert(
      !String(repositoryFileRead.raw.item?.text ?? '').includes(repositoryPath),
      'Chat Mode repository file-read answer leaked the local repository path.'
    );

    const taskThread = await registry.callTool('openkit.create_thread', {
      workspaceId,
      title: 'Chat Mode Task handoff smoke',
      requestId: '00000000-0000-4000-8000-00000000e006',
    });
    const taskThreadId = taskThread.raw.id;

    assert(typeof taskThreadId === 'string' && taskThreadId.length > 0, 'Task thread id missing.');

    const taskHandoff = await registry.callTool('openkit.start_chat', {
      workspaceId,
      threadId: taskThreadId,
      input: 'Implement the bounded Task Mode simulator fix.',
      requestId: '00000000-0000-4000-8000-00000000e007',
    });

    assert(taskHandoff.raw.outcome === 'task-handoff', 'Chat Mode did not create a Task handoff.');
    assert(
      taskHandoff.raw.handoff?.targetMode === 'task',
      'Chat Mode Task handoff did not target Task Mode.'
    );

    const taskThreadRead = await registry.callTool('openkit.read_thread', {
      workspaceId,
      threadId: taskThreadId,
    });
    const taskItems = threadItemsFromRead(taskThreadRead.raw);

    assert(
      taskItems.some((item) => item.type === 'status' && item.title === 'Task Mode handoff'),
      'Chat Mode Task handoff status item was missing.'
    );
    assert(
      taskItems.some(
        (item) => item.type === 'assistant-message' && item.text?.includes('deterministic plan')
      ),
      'Chat Mode Task handoff did not start bounded worker progress.'
    );

    const taskApprovals = await registry.callTool('openkit.read_action_center', {
      workspaceId,
      kind: 'approval',
      limit: 20,
    });

    assert(
      taskApprovals.raw.items.some((item) => item.source?.threadId === taskThreadId),
      'Action Center did not expose the Chat-to-Task worker approval gate.'
    );

    const handoff = await registry.callTool('openkit.start_chat', {
      workspaceId,
      threadId,
      input: 'Plan a multi-step release readiness project for this workspace.',
      requestId: '00000000-0000-4000-8000-00000000e008',
    });
    assert(handoff.raw.outcome === 'goal-handoff', 'Chat Mode did not create a Goal Mode handoff.');

    const goal = await registry.callTool('openkit.read_goal', { workspaceId, threadId });
    assert(goal.raw.goal?.status === 'planning', 'Goal Mode handoff did not create planning goal.');

    const result = {
      story: {
        id: story.metadata.id,
        title: story.metadata.title,
      },
      smoke: {
        actionCenterQuestion: true,
        answerOutcome: answer.raw.outcome,
        clarificationOutcome: clarification.raw.outcome,
        goalStatus: goal.raw.goal?.status,
        handoffOutcome: handoff.raw.outcome,
        repositoryFileReadOutcome: repositoryFileRead.raw.outcome,
        repositoryFilesOutcome: repositoryFiles.raw.outcome,
        taskHandoffOutcome: taskHandoff.raw.outcome,
        threadId,
        tools: tools.length,
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
 * Creates a disposable local Git repository for Chat-to-Task workspace binding.
 *
 * @param {string} prefix Temporary directory prefix.
 * @returns {string} Repository path.
 */
function createGitRepository(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repository = join(root, 'repository');

  mkdirSync(repository);
  mkdirSync(join(repository, 'docs'));
  execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' });
  writeFileSync(join(repository, 'README.md'), '# Chat Mode fixture\n');
  writeFileSync(join(repository, 'docs', 'guide.md'), '# Story repository guide\n');
  execFileSync('git', ['add', 'README.md', 'docs/guide.md'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'chore: seed chat mode fixture'], {
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
 * Posts JSON to one HTTP endpoint.
 *
 * @param {string} url Request URL.
 * @param {Record<string, unknown>} body JSON body.
 */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${await response.text()}`);
  }
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
  runChatModeMcpSmokeStory().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
