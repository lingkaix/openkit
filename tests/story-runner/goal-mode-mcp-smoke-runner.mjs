import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const storyRunnerRoot = dirname(fileURLToPath(import.meta.url));

/** Default deterministic Goal Mode MCP story artifact. */
export const DEFAULT_GOAL_MODE_MCP_SMOKE_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/goal-mode-mcp-smoke.story.md'
);

const EVIDENCE_FILE = 'goal-mode-mcp-smoke-result.json';

/**
 * Loads and validates the deterministic Goal Mode MCP story artifact.
 *
 * @param {{ readStoryFile?: (path: string) => string, storyPath?: string }} options Loader options.
 * @returns {import('./story-metadata.mjs').ParsedStoryDocument} Parsed story document.
 * @throws {Error} When metadata is invalid or requires real credentials.
 */
export function loadGoalModeMcpSmokeStory(options = {}) {
  const storyPath = options.storyPath ?? DEFAULT_GOAL_MODE_MCP_SMOKE_STORY_PATH;
  const readStoryFile = options.readStoryFile ?? ((path) => readFileSync(path, 'utf8'));
  const story = parseStoryDocument(readStoryFile(storyPath), storyPath);

  validateStoryMetadata(story.metadata, storyPath);

  if (story.metadata.requires_real_provider || story.metadata.requires_real_codex) {
    throw new Error(`${storyPath} must not require real provider or real Codex execution.`);
  }

  return story;
}

/**
 * Builds the environment used by the underlying MCP smoke.
 *
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Story metadata.
 * @param {NodeJS.ProcessEnv} baseEnv Base process environment.
 * @returns {NodeJS.ProcessEnv} Environment for the MCP smoke process.
 */
export function buildGoalModeMcpSmokeEnv(metadata, baseEnv = process.env) {
  return {
    ...baseEnv,
    OPENKIT_MCP_SMOKE_OBJECTIVE: baseEnv.OPENKIT_MCP_SMOKE_OBJECTIVE || String(metadata.title),
  };
}

/**
 * Runs the story-backed deterministic MCP smoke.
 *
 * @param {{ env?: NodeJS.ProcessEnv, spawnProcess?: typeof spawn, storyPath?: string, stdout?: (message: string) => void }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Parsed smoke result with story metadata.
 */
export async function runGoalModeMcpSmokeStory(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const story = loadGoalModeMcpSmokeStory({ storyPath: options.storyPath });
  const smokeResult = await runSmokeProcess(options.spawnProcess ?? spawn, {
    env: buildGoalModeMcpSmokeEnv(story.metadata, env),
  });
  const result = {
    story: {
      id: story.metadata.id,
      title: story.metadata.title,
    },
    smoke: smokeResult,
    status: 'ok',
  };

  writeEvidence(env.OPENKIT_L6_MCP_EVIDENCE_DIR, result);
  stdout(JSON.stringify(result, null, 2));

  return result;
}

/**
 * Spawns the existing MCP NanoCore smoke and parses its JSON result.
 *
 * @param {typeof spawn} spawnProcess Process spawner.
 * @param {{ env: NodeJS.ProcessEnv }} options Spawn options.
 * @returns {Promise<Record<string, unknown>>} Parsed smoke result.
 */
function runSmokeProcess(spawnProcess, options) {
  return new Promise((resolveSmoke, rejectSmoke) => {
    const child = spawnProcess('pnpm', ['--filter', '@openkit/mcp', 'smoke:nanocore'], {
      cwd: resolve(storyRunnerRoot, '../..'),
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      errors += chunk;
    });
    child.on('error', rejectSmoke);
    child.on('exit', (code) => {
      if (code !== 0) {
        rejectSmoke(new Error(`MCP Goal Mode smoke failed with ${code}: ${errors || output}`));
        return;
      }

      try {
        resolveSmoke(extractLastJsonObject(output));
      } catch (error) {
        rejectSmoke(error);
      }
    });
  });
}

/**
 * Extracts the final JSON object printed by the MCP smoke.
 *
 * @param {string} output Process stdout.
 * @returns {Record<string, unknown>} Parsed JSON object.
 */
function extractLastJsonObject(output) {
  const start = output.lastIndexOf('\n{');
  const jsonText = (start === -1 ? output : output.slice(start + 1)).trim();

  return JSON.parse(jsonText);
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
  runGoalModeMcpSmokeStory().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
