import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const storyRunnerRoot = dirname(fileURLToPath(import.meta.url));

/** Default real Codex Goal Mode story artifact. */
export const DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/goal-mode-real-codex-release.story.md'
);

/** Developer-machine default Codex OAuth account slot accepted by the v0.0.6 release plan. */
export const DEFAULT_CODEX_OAUTH_ACCOUNT_DIR =
  '/Users/m5pro/nano-data/server/files/oauth/openai-codex/accounts/default';

const PREFLIGHT_REPORT_FILE = 'goal-mode-real-codex-preflight.json';
const REDACTION_NOTES_FILE = 'goal-mode-real-codex-redaction-notes.md';

/**
 * @typedef {object} RealCodexRunnerConfig
 * @property {string} codexOAuthAccountDir Local Codex OAuth account directory.
 * @property {string} evidenceDir Directory where preflight evidence files are written.
 * @property {string} repositoryRoot Disposable local git repository root.
 * @property {string} storyPath Story artifact path.
 */

/**
 * @typedef {object} RealCodexPrerequisiteResult
 * @property {RealCodexRunnerConfig} config Resolved runner configuration.
 * @property {boolean} enabled Whether the real Codex path may run.
 * @property {string} reason Skip reason when disabled.
 */

/**
 * @typedef {object} RealCodexPreflightResult
 * @property {RealCodexRunnerConfig} config Resolved runner configuration.
 * @property {string} reason Skip reason when skipped.
 * @property {'ready' | 'skipped'} status Preflight status.
 */

/**
 * Evaluates whether the real Codex Goal Mode L6 runner has explicit opt-in and usable paths.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, storyPath?: string }} options Evaluation options.
 * @returns {RealCodexPrerequisiteResult} Resolved prerequisite result.
 */
export function evaluateRealCodexRunnerPrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const storyPath = options.storyPath ?? DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH;
  const config = {
    codexOAuthAccountDir: env.OPENKIT_L6_CODEX_OAUTH_ACCOUNT_DIR ?? DEFAULT_CODEX_OAUTH_ACCOUNT_DIR,
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR ?? '',
    repositoryRoot: env.OPENKIT_L6_GOAL_REPO_ROOT ?? '',
    storyPath,
  };

  if (env.OPENKIT_L6_REAL_CODEX !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_REAL_CODEX=1 to opt in to the real Codex L6 runner',
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

  if (!fileExists(config.codexOAuthAccountDir)) {
    return {
      config,
      enabled: false,
      reason: `Codex OAuth account directory not found: ${config.codexOAuthAccountDir}`,
    };
  }

  if (!config.repositoryRoot) {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_GOAL_REPO_ROOT to a disposable local git repository',
    };
  }

  if (!fileExists(join(config.repositoryRoot, '.git'))) {
    return {
      config,
      enabled: false,
      reason: `repository is not a git repository: ${config.repositoryRoot}`,
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
 * Runs the real Codex Goal Mode L6 preflight path and writes evidence files after explicit opt-in.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, now?: Date, stdout?: (message: string) => void, storyPath?: string }} options Preflight options.
 * @returns {Promise<RealCodexPreflightResult>} Preflight result.
 * @throws {Error} When the story metadata is invalid or a real-Codex-incompatible story is selected.
 */
export async function runRealCodexGoalModePreflight(options = {}) {
  const env = options.env ?? process.env;
  const storyPath = options.storyPath ?? DEFAULT_REAL_CODEX_GOAL_MODE_STORY_PATH;
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluateRealCodexRunnerPrerequisites({
    env,
    fileExists: options.fileExists,
    storyPath,
  });

  if (!prerequisites.enabled) {
    stdout(`SKIP real Codex Goal Mode L6 runner: ${prerequisites.reason}`);
    return { config: prerequisites.config, reason: prerequisites.reason, status: 'skipped' };
  }

  const storyText = await import('node:fs/promises').then((fs) =>
    fs.readFile(prerequisites.config.storyPath, 'utf8')
  );
  const story = parseStoryDocument(storyText, prerequisites.config.storyPath);

  validateStoryMetadata(story.metadata, prerequisites.config.storyPath);
  assertRealCodexStory(story.metadata, prerequisites.config.storyPath);

  mkdirSync(prerequisites.config.evidenceDir, { recursive: true });
  writeFileSync(
    join(prerequisites.config.evidenceDir, PREFLIGHT_REPORT_FILE),
    `${JSON.stringify(buildPreflightReport(prerequisites.config, story.metadata, options.now), null, 2)}\n`
  );
  writeFileSync(
    join(prerequisites.config.evidenceDir, REDACTION_NOTES_FILE),
    buildRedactionNotes(prerequisites.config, story.metadata)
  );

  stdout(`READY real Codex Goal Mode L6 runner evidence: ${prerequisites.config.evidenceDir}`);
  return { config: prerequisites.config, reason: '', status: 'ready' };
}

/**
 * Validates that the selected story explicitly opts in to real provider and real Codex usage.
 *
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Parsed story metadata.
 * @param {string} storyPath Story source path for diagnostics.
 * @throws {Error} When story metadata does not require real Codex and provider capabilities.
 */
function assertRealCodexStory(metadata, storyPath) {
  if (metadata.requires_real_provider !== true || metadata.requires_real_codex !== true) {
    throw new Error(`${storyPath} must require real provider and real Codex execution.`);
  }
}

/**
 * Builds the JSON preflight evidence report.
 *
 * @param {RealCodexRunnerConfig} config Resolved runner configuration.
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Parsed story metadata.
 * @param {Date | undefined} now Optional report timestamp.
 * @returns {Record<string, unknown>} Preflight report payload.
 */
function buildPreflightReport(config, metadata, now) {
  return {
    codexOAuthAccountDir: config.codexOAuthAccountDir,
    evidenceDir: config.evidenceDir,
    generatedAt: (now ?? new Date()).toISOString(),
    repositoryRoot: config.repositoryRoot,
    requiredOptIns: {
      OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
      OPENKIT_L6_REAL_CODEX: '1',
    },
    status: 'ready',
    story: {
      id: metadata.id,
      requiresRealCodex: metadata.requires_real_codex,
      requiresRealProvider: metadata.requires_real_provider,
      title: metadata.title,
    },
    storyPath: config.storyPath,
  };
}

/**
 * Builds redaction notes for the evidence bundle.
 *
 * @param {RealCodexRunnerConfig} config Resolved runner configuration.
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Parsed story metadata.
 * @returns {string} Markdown redaction notes.
 */
function buildRedactionNotes(config, metadata) {
  return `# Real Codex Goal Mode Redaction Notes

Story: ${metadata.id}

Evidence directory: ${config.evidenceDir}

Repository root: ${config.repositoryRoot}

Codex OAuth account directory: ${config.codexOAuthAccountDir}

## Required Redaction Checks

- Do not preserve raw OAuth tokens, bearer tokens, API keys, cookie values, authorization headers, or private account payloads.
- Replace accidental secret-like values with \`[REDACTED]\` before preserving evidence.
- Scan the agent transcript, browser trace, screenshots, server logs, item history, artifact references, verification output, and final git status before publication.
- Record every scanned evidence source in the final acceptance report.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealCodexGoalModePreflight().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
