import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const storyRunnerRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(storyRunnerRoot, '../..');
const mcpRegistryDist = join(repoRoot, 'mcp/dist/registry.js');
const mcpClientDist = join(repoRoot, 'mcp/dist/nanocore-client.js');

/** Default real-worker Task Mode story artifact. */
export const DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/task-mode-real-worker-release.story.md'
);

const RESULT_FILE = 'task-mode-real-worker-result.json';
const REDACTION_NOTES_FILE = 'task-mode-real-worker-redaction-notes.md';

/**
 * @typedef {object} TaskModeRealWorkerRunnerConfig
 * @property {string} codexAuthJsonPath Operator-owned Codex auth JSON path used by deployment setup.
 * @property {string} evidenceDir Directory where redacted evidence files are written.
 * @property {string} nanoCoreUrl Existing NanoCore endpoint.
 * @property {string} repositoryRoot Disposable repository path visible to NanoCore.
 * @property {string} storyPath Story artifact path.
 * @property {string} taskInput Task Mode input.
 * @property {string | undefined} token Optional NanoCore bearer token.
 * @property {string} workspaceId Workspace to use for the run.
 */

/**
 * Evaluates whether the real Task Mode runner has explicit opt-in and usable paths.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, storyPath?: string }} options Evaluation options.
 * @returns {{ config: TaskModeRealWorkerRunnerConfig, enabled: boolean, reason: string }} Prerequisite result.
 */
export function evaluateTaskModeRealWorkerPrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const storyPath = options.storyPath ?? DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH;
  const config = {
    codexAuthJsonPath:
      env.OPENKIT_L6_TASK_CODEX_AUTH_JSON ?? join(env.HOME ?? '', '.codex/auth.json'),
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR ?? '',
    nanoCoreUrl: env.OPENKIT_L6_TASK_NANOCORE_URL ?? '',
    repositoryRoot: env.OPENKIT_L6_TASK_REPO_ROOT ?? '',
    storyPath,
    taskInput:
      env.OPENKIT_L6_TASK_INPUT ??
      'Create docs/task-mode-real-worker-proof.md with one sentence proving Task Mode real worker ran.',
    token: env.OPENKIT_NANOCORE_TOKEN,
    workspaceId: env.OPENKIT_L6_TASK_WORKSPACE_ID ?? 'ws_demo',
  };

  if (env.OPENKIT_L6_TASK_REAL_WORKER !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_REAL_WORKER=1 to opt in to the real Task Mode runner',
    };
  }

  if (env.OPENKIT_L6_ALLOW_PROVIDER_QUOTA !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 to acknowledge provider usage',
    };
  }

  if (!fileExists(storyPath)) {
    return { config, enabled: false, reason: `story artifact not found: ${storyPath}` };
  }

  if (!config.nanoCoreUrl) {
    return { config, enabled: false, reason: 'set OPENKIT_L6_TASK_NANOCORE_URL' };
  }

  if (!config.repositoryRoot) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_TASK_REPO_ROOT to a disposable git repository',
    };
  }

  if (!fileExists(join(config.repositoryRoot, '.git'))) {
    return {
      config,
      enabled: false,
      reason: `repository is not a git repository: ${config.repositoryRoot}`,
    };
  }

  if (!fileExists(config.codexAuthJsonPath)) {
    return {
      config,
      enabled: false,
      reason: `Codex auth JSON path not found: ${config.codexAuthJsonPath}`,
    };
  }

  if (!config.evidenceDir) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_EVIDENCE_DIR to a writable evidence directory',
    };
  }

  return { config, enabled: true, reason: '' };
}

/**
 * Runs the opt-in real OpenShell/Codex Task Mode MCP story.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, now?: Date, stdout?: (message: string) => void, storyPath?: string }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Runner result.
 */
export async function runTaskModeRealWorkerStory(options = {}) {
  const env = options.env ?? process.env;
  const storyPath = options.storyPath ?? DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateTaskModeRealWorkerPrerequisites({
    env,
    fileExists: options.fileExists,
    storyPath,
  });

  if (!prerequisites.enabled) {
    stdout(`SKIP real Task Mode worker runner: ${prerequisites.reason}`);
    return {
      config: redactedConfig(prerequisites.config),
      reason: prerequisites.reason,
      status: 'skipped',
    };
  }

  const storyText = await import('node:fs/promises').then((fs) =>
    fs.readFile(prerequisites.config.storyPath, 'utf8')
  );
  const story = parseStoryDocument(storyText, prerequisites.config.storyPath);

  validateStoryMetadata(story.metadata, prerequisites.config.storyPath);
  assertRealTaskModeStory(story.metadata, prerequisites.config.storyPath);
  assertBuilt(mcpRegistryDist);
  assertBuilt(mcpClientDist);

  const [{ createOpenKitAiInterface }, { createNanoCoreClient }] = await Promise.all([
    import(pathToFileURL(mcpRegistryDist).href),
    import(pathToFileURL(mcpClientDist).href),
  ]);
  const registry = createOpenKitAiInterface({
    nanoCore: createNanoCoreClient({
      baseUrl: prerequisites.config.nanoCoreUrl,
      ...(prerequisites.config.token ? { headers: authHeaders(prerequisites.config.token) } : {}),
    }),
  });
  const tools = registry.listTools();

  assert(
    tools.some((tool) => tool.name === 'openkit.start_task'),
    'MCP tools/list did not include openkit.start_task.'
  );

  await registry.callTool('openkit.read_status', { workspaceId: prerequisites.config.workspaceId });

  const thread = await registry.callTool('openkit.create_thread', {
    requestId: randomUUID(),
    title: 'Task Mode real worker release',
    workspaceId: prerequisites.config.workspaceId,
  });
  const threadId = thread.raw.id;

  assert(typeof threadId === 'string' && threadId.length > 0, 'Thread id was not returned.');

  await registry.callTool('openkit.link_repository', {
    displayName: 'Task Mode real worker repository',
    localPath: prerequisites.config.repositoryRoot,
    requestId: randomUUID(),
    workspaceId: prerequisites.config.workspaceId,
  });

  const task = await registry.callTool('openkit.start_task', {
    input: prerequisites.config.taskInput,
    requestId: randomUUID(),
    threadId,
    workspaceId: prerequisites.config.workspaceId,
  });

  assert(
    task.raw?.state !== 'escalated-to-goal',
    'Task Mode escalated a bounded real-worker task.'
  );
  assert(typeof task.raw?.turn?.id === 'string', 'Task Mode response did not include a turn id.');
  assert(
    task.raw?.decision?.mode === 'task',
    'Task Mode response did not include a task decision.'
  );
  const acceptedStates = new Set(['running', 'completed', 'needs-review', 'awaiting-human']);
  assert(
    acceptedStates.has(task.raw?.state),
    `Task Mode returned a non-acceptance state: ${task.raw?.state}`
  );

  const threadRead = await registry.callTool('openkit.read_thread', {
    threadId,
    workspaceId: prerequisites.config.workspaceId,
  });
  const actionCenter = await registry.callTool('openkit.read_action_center', {
    limit: 20,
    workspaceId: prerequisites.config.workspaceId,
  });
  const items = threadRead.raw.items?.items ?? threadRead.raw.items ?? [];
  assert(items.length > 0, 'Task Mode thread did not include visible items.');
  const completedAssistantItems = items.filter(
    (item) => item.type === 'assistant-message' && item.status === 'completed'
  );
  assert(
    completedAssistantItems.length > 0,
    'Task Mode thread did not include a completed assistant message.'
  );

  const gitStatus = gitStatusShort(prerequisites.config.repositoryRoot);
  const result = {
    config: redactedConfig(prerequisites.config),
    generatedAt: (options.now ?? new Date()).toISOString(),
    story: {
      id: story.metadata.id,
      title: story.metadata.title,
    },
    task: {
      artifactIds: task.raw.evidence?.artifactIds ?? [],
      itemIds: task.raw.evidence?.itemIds ?? [],
      reviewIds: task.raw.evidence?.reviewIds ?? [],
      state: task.raw.state,
      turnId: task.raw.turn.id,
      worker: task.raw.decision.worker,
    },
    thread: {
      completedAssistantItemCount: completedAssistantItems.length,
      itemCount: items.length,
      threadId,
    },
    actionCenter: {
      itemCount: actionCenter.raw.items?.length ?? 0,
    },
    git: {
      statusShort: gitStatus,
    },
    status: 'ok',
  };

  mkdirSync(prerequisites.config.evidenceDir, { recursive: true });
  writeFileSync(
    join(prerequisites.config.evidenceDir, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`
  );
  writeFileSync(
    join(prerequisites.config.evidenceDir, REDACTION_NOTES_FILE),
    buildRedactionNotes(prerequisites.config, story.metadata)
  );
  stdout(JSON.stringify(result, null, 2));

  return result;
}

/**
 * Validates that the story explicitly opts in to real provider and Codex usage.
 *
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Story metadata.
 * @param {string} storyPath Story source path for diagnostics.
 */
function assertRealTaskModeStory(metadata, storyPath) {
  if (metadata.requires_real_provider !== true || metadata.requires_real_codex !== true) {
    throw new Error(`${storyPath} must require real provider and real Codex execution.`);
  }
}

/**
 * Creates redacted NanoCore auth headers.
 *
 * @param {string} token OpenKit bearer token.
 * @returns {HeadersInit} Static request headers.
 */
function authHeaders(token) {
  return {
    authorization: `Bearer ${token.trim()}`,
    'x-openkit-client-channel': 'mcp',
    'x-openkit-client-source': 'desktop-agent',
  };
}

/**
 * Removes secret-bearing values from the runner config before evidence is written.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner config.
 * @returns {Record<string, unknown>} Redacted config.
 */
function redactedConfig(config) {
  return {
    codexAuthJsonPath: config.codexAuthJsonPath,
    evidenceDir: config.evidenceDir,
    nanoCoreUrl: config.nanoCoreUrl,
    repositoryRoot: config.repositoryRoot,
    storyPath: config.storyPath,
    taskInput: config.taskInput,
    tokenProvided: Boolean(config.token),
    workspaceId: config.workspaceId,
  };
}

/**
 * Reads a short git status from the disposable repository.
 *
 * @param {string} repositoryRoot Repository root.
 * @returns {string} Short git status output.
 */
function gitStatusShort(repositoryRoot) {
  return execFileSync('git', ['status', '--short'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Fails the runner when a required build output is missing.
 *
 * @param {string} filePath Build output path.
 */
function assertBuilt(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required build output is missing: ${filePath}`);
  }
}

/**
 * Builds redaction notes for the evidence bundle.
 *
 * @param {TaskModeRealWorkerRunnerConfig} config Runner config.
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Story metadata.
 * @returns {string} Redaction notes.
 */
function buildRedactionNotes(config, metadata) {
  return `# Task Mode Real Worker Redaction Notes

Story: ${metadata.id}

Evidence directory: ${config.evidenceDir}

Repository root: ${config.repositoryRoot}

Codex auth JSON path: ${config.codexAuthJsonPath}

## Required Redaction Checks

- Do not preserve raw OAuth tokens, bearer tokens, API keys, cookie values, authorization headers, or Codex auth JSON content.
- Preserve product-safe ids, counts, state names, worker target summaries, and git status only.
- Replace accidental secret-like values with \`[REDACTED]\` before preserving evidence.
- Record every scanned evidence source in the final acceptance report.
`;
}

/**
 * Ensures one condition is truthy.
 *
 * @param {unknown} condition Condition to assert.
 * @param {string} message Failure message.
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTaskModeRealWorkerStory().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
