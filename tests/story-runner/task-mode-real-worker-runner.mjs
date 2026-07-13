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
const PROVENANCE_SUMMARY_PATTERN =
  /^Worker runtime provenance complete: (\d+) streams, (\d+) frames, (\d+) attributed, (\d+) unattributed, (\d+) roots?, (\d+) children, (\d+)\/(\d+) gateway calls reconciled, gateway complete, bundles (\S+) and (\S+)\.$/;

/**
 * @typedef {object} TaskModeRealWorkerRunnerConfig
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
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR ?? '',
    nanoCoreUrl: env.OPENKIT_L6_TASK_NANOCORE_URL ?? '',
    repositoryRoot: env.OPENKIT_L6_TASK_REPO_ROOT ?? '',
    storyPath,
    taskInput:
      env.OPENKIT_L6_TASK_INPUT ??
      'Delegate two independent repository inspections to at least two Codex sub-agents, then create docs/task-mode-runtime-provenance-proof.md with exactly three bullet points summarizing their findings.',
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
 * Asserts the public provenance evidence produced by one real Task Mode worker turn.
 *
 * @param {{ auditEvents: Array<Record<string, any>>, capabilityCalls: Array<Record<string, any>>, evidenceBundles: Array<Record<string, any>>, runtimeEvidence: Array<Record<string, any>>, threadItems: Array<Record<string, any>>, turnId: string, usageRecords: Array<Record<string, any>> }} input Public read models for the completed turn.
 * @returns {{ auditEventCount: number, backendType: string, backendVersion: string, cacheLineageCount: number, cachedInputTokens: number, capabilityCallCount: number, childOriginCount: number, indexBundleId: string, positiveCacheReadObserved: boolean, rawBundleId: string, runtimeOriginCount: number, runtimeRootCount: number, streamCount: number }} Product-safe assertion summary.
 */
export function assertTaskModeRuntimeProvenance(input) {
  assertNoRuntimeProvenanceLeak(input);
  const transcriptEvidence = input.runtimeEvidence.find(
    (record) =>
      record.turnId === input.turnId &&
      record.phase === 'transcript-collection' &&
      record.requiredFeatures?.includes('worker.runtime-provenance.v1')
  );
  assert(transcriptEvidence, 'Task Mode did not produce runtime provenance evidence.');
  assert(
    transcriptEvidence.outcome === 'succeeded',
    'Task Mode runtime provenance evidence did not succeed.'
  );
  assert(
    transcriptEvidence.backendType === 'openshell' &&
      transcriptEvidence.backendVersion === '0.0.80',
    'Runtime provenance did not come from the pinned OpenShell 0.0.80 target.'
  );
  const summary = PROVENANCE_SUMMARY_PATTERN.exec(transcriptEvidence.summary ?? '');
  assert(summary, 'Task Mode runtime provenance summary was incomplete.');
  const [
    streamCount,
    frameCount,
    attributedFrameCount,
    unattributedFrameCount,
    runtimeRootCount,
    childOriginCount,
    reconciledCallCount,
    gatewayCallCount,
  ] = summary.slice(1, 9).map(Number);
  const rawBundleId = summary[9];
  const indexBundleId = summary[10];
  assert(streamCount >= 4, 'Runtime provenance did not retain primary, root, and child streams.');
  assert(
    attributedFrameCount + unattributedFrameCount === frameCount,
    'Runtime provenance frame accounting was inconsistent.'
  );
  assert(
    runtimeRootCount >= 1 && childOriginCount >= 2,
    'Runtime provenance forest was incomplete.'
  );
  assert(
    gatewayCallCount >= 3 && reconciledCallCount === gatewayCallCount,
    'Runtime provenance did not reconcile every root and child Gateway call.'
  );

  const rawBundle = input.evidenceBundles.find((bundle) => bundle.id === rawBundleId);
  const indexBundle = input.evidenceBundles.find((bundle) => bundle.id === indexBundleId);
  assert(
    rawBundle?.turnId === input.turnId &&
      rawBundle.sourceKind === 'worker-runtime-provenance-raw' &&
      rawBundle.retentionClass === 'restricted-raw' &&
      rawBundle.sensitivityClass === 'restricted' &&
      rawBundle.importStatus === 'promoted' &&
      rawBundle.rawEvidenceRefs?.length === 0 &&
      rawBundle.redactedEvidenceRefs?.length === 0,
    'Restricted runtime provenance bundle was missing or exposed raw refs.'
  );
  assert(
    indexBundle?.turnId === input.turnId &&
      indexBundle.sourceKind === 'worker-runtime-provenance-index' &&
      indexBundle.retentionClass === 'turn-evidence' &&
      indexBundle.sensitivityClass === 'product-safe' &&
      indexBundle.importStatus === 'promoted' &&
      indexBundle.rawEvidenceRefs?.length === 0 &&
      indexBundle.redactedEvidenceRefs?.length === 1 &&
      indexBundle.redactedEvidenceRefs[0]?.kind === 'worker-runtime-provenance-index' &&
      indexBundle.redactedEvidenceRefs[0]?.ref === 'runtime-origin-index.jsonl',
    'Product-safe runtime provenance index bundle was missing.'
  );
  assert(
    transcriptEvidence.evidenceBundleIds?.length === 2 &&
      transcriptEvidence.evidenceBundleIds?.includes(rawBundleId) &&
      transcriptEvidence.evidenceBundleIds?.includes(indexBundleId),
    'RuntimeEvidence did not link both automatic provenance bundles.'
  );

  const calls = input.capabilityCalls.filter(
    (call) =>
      call.turnId === input.turnId &&
      call.family === 'llm' &&
      call.serviceRef === 'worker-inference-gateway' &&
      call.packageSnapshotId
  );
  assert(
    calls.length === gatewayCallCount,
    'Capability ledger did not match reconciled Gateway calls.'
  );
  assert(
    calls.every(
      (call) =>
        call.status === 'succeeded' &&
        /^rto_[a-f0-9]{24}$/.test(call.runtimeOriginRef ?? '') &&
        /^rcl_[a-f0-9]{24}$/.test(call.runtimeCacheLineageRef ?? '')
    ),
    'A worker Gateway call lacked trusted product-safe provenance or cache attribution.'
  );
  assert(
    new Set(calls.map((call) => call.packageSnapshotId)).size === 1,
    'Worker Gateway calls did not share one authoritative AEP snapshot.'
  );
  assert(
    calls.every(
      (call) =>
        call.threadId === transcriptEvidence.threadId &&
        call.agentSessionId === transcriptEvidence.agentSessionId
    ),
    'Worker Gateway calls did not match the authoritative runtime evidence lineage.'
  );
  assert(
    calls.every((call) => typeof call.requestId === 'string' && call.requestId.length > 0) &&
      new Set(calls.map((call) => call.requestId)).size === calls.length,
    'Worker Gateway calls reused a request id.'
  );
  const runtimeOriginCount = new Set(calls.map((call) => call.runtimeOriginRef)).size;
  const cacheLineageCount = new Set(calls.map((call) => call.runtimeCacheLineageRef)).size;
  assert(runtimeOriginCount >= 3, 'Root and child Gateway calls did not retain distinct origins.');
  assert(cacheLineageCount >= 2, 'Sibling Gateway calls collapsed onto one cache lineage.');

  const callIds = new Set(calls.map((call) => call.id));
  assert(
    calls.every((call) => input.usageRecords.some((record) => record.capabilityCallId === call.id)),
    'Worker Gateway calls were missing linked usage records.'
  );
  const cacheReadRows = input.usageRecords.filter(
    (record) =>
      callIds.has(record.capabilityCallId) &&
      record.source === 'llm-gateway-adapter-reported:cache_read'
  );
  assert(
    cacheReadRows.every((record) => typeof record.quantity === 'number' && record.quantity >= 0),
    'Cached-input token telemetry was invalid.'
  );
  const cachedInputTokens = cacheReadRows.reduce(
    (total, record) => total + (record.quantity ?? 0),
    0
  );
  const linkedAuditEvents = input.auditEvents.filter((event) =>
    callIds.has(event.capabilityCallId)
  );
  assert(
    calls.every((call) =>
      linkedAuditEvents.some(
        (event) =>
          event.action === 'capability.finish' &&
          event.capabilityCallId === call.id &&
          event.outcome === 'succeeded'
      )
    ),
    'Worker Gateway calls were missing successful audit linkage.'
  );
  const completedAssistantItems = input.threadItems.filter(
    (item) =>
      item.turnId === input.turnId &&
      item.type === 'assistant-message' &&
      item.status === 'completed'
  );
  assert(
    completedAssistantItems.length === 1,
    'Runtime-internal children did not collapse to one canonical outer assistant result.'
  );

  return {
    auditEventCount: linkedAuditEvents.length,
    backendType: transcriptEvidence.backendType,
    backendVersion: transcriptEvidence.backendVersion,
    cacheLineageCount,
    cachedInputTokens,
    capabilityCallCount: calls.length,
    childOriginCount,
    indexBundleId,
    positiveCacheReadObserved: cacheReadRows.length > 0,
    rawBundleId,
    runtimeOriginCount,
    runtimeRootCount,
    streamCount,
  };
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
  const nanoCore = createNanoCoreClient({
    baseUrl: prerequisites.config.nanoCoreUrl,
    ...(prerequisites.config.token ? { headers: authHeaders(prerequisites.config.token) } : {}),
  });
  const registry = createOpenKitAiInterface({ nanoCore });
  const tools = registry.listTools();

  assert(
    tools.some((tool) => tool.name === 'openkit.start_task'),
    'MCP tools/list did not include openkit.start_task.'
  );

  const [, diagnostics] = await Promise.all([
    registry.callTool('openkit.read_status', { workspaceId: prerequisites.config.workspaceId }),
    registry.callTool('openkit.read_runtime_diagnostics', {}),
  ]);
  assert(
    diagnostics.raw?.boot?.acceptingProductWork === true,
    'Target NanoCore is not accepting product work.'
  );

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
  const acceptedStates = new Set(['completed', 'needs-review']);
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
    completedAssistantItems.length === 1,
    'Task Mode thread did not include one canonical outer assistant message.'
  );

  const [usage, evidenceResource, runtimeEvidenceResource, auditResource] = await Promise.all([
    registry.callTool('openkit.read_capability_usage', {
      workspaceId: prerequisites.config.workspaceId,
    }),
    registry.readResource(
      `openkit://workspaces/${prerequisites.config.workspaceId}/evidence-bundles`
    ),
    registry.readResource(
      `openkit://workspaces/${prerequisites.config.workspaceId}/runtime-evidence`
    ),
    registry.readResource(`openkit://workspaces/${prerequisites.config.workspaceId}/audit/events`),
  ]);
  const evidence = JSON.parse(evidenceResource.text);
  const runtimeEvidence = JSON.parse(runtimeEvidenceResource.text);
  const audit = JSON.parse(auditResource.text);
  const provenance = assertTaskModeRuntimeProvenance({
    auditEvents: audit.auditEvents ?? [],
    capabilityCalls: usage.raw?.capabilityCalls ?? [],
    evidenceBundles: evidence.evidenceBundles ?? [],
    runtimeEvidence: runtimeEvidence.runtimeEvidence ?? [],
    threadItems: items,
    turnId: task.raw.turn.id,
    usageRecords: usage.raw?.usageRecords ?? [],
  });

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
    provenance,
    status: 'ok',
  };
  const redactionNotes = buildRedactionNotes(prerequisites.config, story.metadata);
  assertNoRuntimeProvenanceLeak({ redactionNotes, result });

  mkdirSync(prerequisites.config.evidenceDir, { recursive: true });
  writeFileSync(
    join(prerequisites.config.evidenceDir, RESULT_FILE),
    `${JSON.stringify(result, null, 2)}\n`
  );
  writeFileSync(join(prerequisites.config.evidenceDir, REDACTION_NOTES_FILE), redactionNotes);
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
    evidenceDir: config.evidenceDir,
    nanoCoreUrl: config.nanoCoreUrl,
    repositoryRoot: config.repositoryRoot,
    storyPath: config.storyPath,
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

## Required Redaction Checks

- Do not preserve raw OAuth tokens, bearer tokens, API keys, cookie values, authorization headers, or Codex auth JSON content.
- Preserve product-safe ids, counts, state names, worker target summaries, and git status only.
- Replace accidental secret-like values with \`[REDACTED]\` before preserving evidence.
- Record every scanned evidence source in the final acceptance report.
`;
}

/**
 * Fails when public provenance evidence contains runtime-native or secret-bearing fields.
 *
 * @param {unknown} value Public response or written evidence to scan.
 */
function assertNoRuntimeProvenanceLeak(value) {
  const text = JSON.stringify(value);
  const patterns = [
    /native(?:Thread|Session|Turn|CacheLineage)Id/i,
    /parentNativeThreadId/i,
    /prompt_cache_key/i,
    /x-codex-turn-metadata/i,
    /\b(?:thread_id|parent_thread_id|sender_thread_id|receiver_thread_ids)\b/i,
    /"(?:access_token|refresh_token|api_?key|client_?secret|authorization|cookie)"\s*:/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  ];
  assert(
    patterns.every((pattern) => !pattern.test(text)),
    'Public story evidence exposed runtime-native metadata or credential material.'
  );
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
