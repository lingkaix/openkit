import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  WorkerControlRelayClient,
  type WorkerControlRelayCommandPoll,
  type WorkerControlRelayFetch,
} from './control-client.js';
import { type WorkerLineage, WorkerTranscriptWriter } from './transcript.js';
import {
  prepareWorkspaceGitSnapshots,
  publishWorkspaceGitSnapshots,
  type WorkspaceGitInput,
} from './workspace-git.js';

/**
 * Parsed `openkit-codex-shim` arguments.
 */
export interface CodexShimArgs {
  /** Worker-visible Agent Environment Package path. */
  packagePath: string;
  /** Durable session transcript directory. */
  sessionDir: string;
  /** Worker artifact directory. */
  artifactDir: string;
  /** Whether to validate arguments and exit without launching Codex. */
  dryRun: boolean;
}

/**
 * Environment variables consumed by `openkit-codex-shim`.
 */
export interface CodexShimEnvironment extends WorkerSidecarEnvironment {
  /** Optional JSON-array or whitespace-separated Codex process command override. */
  OPENKIT_CODEX_COMMAND?: string | undefined;
}

/**
 * Input passed to the supervised Codex process runner.
 */
export interface CodexProcessRunInput {
  /** Command and arguments to execute. */
  argv: string[];
  /** Worker cwd for the Codex process. */
  cwd: string;
  /** Environment variables visible to the Codex process. */
  env: Record<string, string>;
}

/**
 * Result returned by a supervised Codex process runner.
 */
export interface CodexProcessRunResult {
  /** Process exit code, or null when the process ended by signal. */
  exitCode: number | null;
  /** Process signal, or null when the process exited normally. */
  signal: NodeJS.Signals | null;
  /** Captured stdout text. */
  stdout: string;
  /** Captured stderr text. */
  stderr: string;
}

/**
 * Process runner used by the Codex shim.
 */
export interface CodexProcessRunner {
  /**
   * Runs one Codex process.
   *
   * @param input Command, cwd, and environment.
   * @returns Completed process result.
   */
  run(input: CodexProcessRunInput): Promise<CodexProcessRunResult>;
}

/**
 * Options for running the Codex shim entrypoint.
 */
export interface CodexShimRunOptions {
  /** Parsed Codex shim arguments. */
  args: CodexShimArgs;
  /** Sandbox environment variables visible to the shim. */
  environment?: CodexShimEnvironment | undefined;
  /** Optional process runner for tests or alternate supervisors. */
  runner?: CodexProcessRunner | undefined;
}

/**
 * Result returned by the Codex shim after the supervised process exits.
 */
export interface CodexShimRunResult {
  /** Process exit code, or null when the process ended by signal. */
  exitCode: number | null;
  /** Process signal, or null when the process exited normally. */
  signal: NodeJS.Signals | null;
  /** Normalized worker terminal status. */
  status: 'completed' | 'failed';
}

/**
 * Parsed `openkit-worker-sidecar` arguments.
 */
export interface WorkerSidecarArgs {
  /** Worker-visible control endpoint URL. */
  controlBaseUrl: string;
  /** NanoCore relay upstream URL. */
  relayUpstream: string;
  /** Durable session transcript directory. */
  sessionDir: string;
  /** Whether to run one relay cycle and exit. */
  once: boolean;
}

/**
 * Environment variables consumed by `openkit-worker-sidecar`.
 */
export interface WorkerSidecarEnvironment {
  /** Sandbox bearer token registered by NanoCore. */
  OPENKIT_CONTROL_TOKEN?: string | undefined;
  /** Workspace id bound to the worker session. */
  OPENKIT_WORKSPACE_ID?: string | undefined;
  /** Thread id bound to the worker session. */
  OPENKIT_THREAD_ID?: string | undefined;
  /** Turn id bound to the worker session. */
  OPENKIT_TURN_ID?: string | undefined;
  /** Agent session id bound to the sandbox. */
  OPENKIT_AGENT_SESSION_ID?: string | undefined;
  /** Agent Environment Package snapshot id. */
  OPENKIT_PACKAGE_SNAPSHOT_ID?: string | undefined;
  /** Optional request id that started the worker turn. */
  OPENKIT_REQUEST_ID?: string | undefined;
}

/**
 * Options for running the worker sidecar entrypoint.
 */
export interface WorkerSidecarRunOptions {
  /** Parsed sidecar arguments. */
  args: WorkerSidecarArgs;
  /** Environment variables visible to the sidecar process. */
  environment?: WorkerSidecarEnvironment | undefined;
  /** Optional fetch implementation for tests. */
  fetch?: WorkerControlRelayFetch | undefined;
  /** Optional command runner for secondary terminal commands. */
  commandRunner?: WorkerSidecarCommandRunner | undefined;
}

/**
 * Result returned after one sidecar relay cycle.
 */
export interface WorkerSidecarRunResult {
  /** Commands returned by NanoCore during the poll. */
  commandPoll: WorkerControlRelayCommandPoll;
}

/**
 * Input passed to sandbox-local commands requested by NanoCore.
 */
export interface WorkerSidecarCommandRunInput {
  /** Command and arguments to execute. */
  argv: string[];
  /** Worker-local command cwd, or null to use the sidecar cwd. */
  cwd: string | null;
  /** Environment variables visible to the command process. */
  env: Record<string, string>;
}

/**
 * Result returned after running one sandbox-local command.
 */
export interface WorkerSidecarCommandRunResult {
  /** Process exit code normalized for Worker Control Gateway reporting. */
  exitCode: number;
  /** Captured stdout text. */
  stdout: string;
  /** Captured stderr text. */
  stderr: string;
  /** Command duration in milliseconds. */
  durationMs: number | null;
}

/**
 * Command runner used by the worker sidecar for secondary terminal commands.
 */
export interface WorkerSidecarCommandRunner {
  /**
   * Runs one sandbox-local command.
   *
   * @param input Command, cwd, and environment.
   * @returns Completed command result.
   */
  run(input: WorkerSidecarCommandRunInput): Promise<WorkerSidecarCommandRunResult>;
}

interface CodexShimPackageManifest {
  extensions?: {
    openkit?: {
      codexCommand?: unknown;
      resultMessagePath?: unknown;
      turnInput?: unknown;
    };
  };
  runtime?: {
    command?: {
      workingDirectory?: unknown;
    };
  };
  workspace?: {
    inputs?: unknown;
  };
  supply?: {
    skills?: unknown;
    mcpServers?: unknown;
  };
}

interface RuntimeSupplyMaterialization {
  kind: string;
  targetPath: string;
}

interface RuntimeSkillSupply {
  id: string;
  version?: string;
  sourceRef?: string;
  integrity?: unknown;
  materialization: RuntimeSupplyMaterialization;
  allowedRuntimeAdapters?: unknown;
  allowedWorkspaceScopes?: unknown;
  policyRefIds?: unknown;
  reviewStatus?: string;
  secretRefIds?: unknown;
}

interface RuntimeMcpSupply {
  id: string;
  version?: string;
  sourceRef?: string;
  transport?: string;
  command?: unknown;
  url?: string;
  allowedTools?: unknown;
  allowedPrompts?: unknown;
  materialization: RuntimeSupplyMaterialization;
  networkPolicyHints?: unknown;
  providerInstanceIds?: unknown;
  vaultGrantIds?: unknown;
  secretRefIds?: unknown;
  reviewStatus?: string;
}

/**
 * Parses `openkit-codex-shim` arguments.
 *
 * @param argv Argument vector after the binary name.
 * @returns Parsed arguments.
 */
export function parseCodexShimArgs(argv: string[]): CodexShimArgs {
  const values = parseFlagValues(argv, new Set(['--dry-run']));
  const packagePath = values.get('--package')?.at(0);

  if (!packagePath) {
    throw new Error('Missing required --package argument.');
  }

  return {
    artifactDir: values.get('--artifact-dir')?.at(0) ?? '/openkit/artifacts',
    dryRun: values.has('--dry-run'),
    packagePath,
    sessionDir: values.get('--session-dir')?.at(0) ?? '/openkit/session',
  };
}

/**
 * Parses `openkit-worker-sidecar` arguments.
 *
 * @param argv Argument vector after the binary name.
 * @returns Parsed arguments.
 */
export function parseWorkerSidecarArgs(argv: string[]): WorkerSidecarArgs {
  const values = parseFlagValues(argv, new Set(['--once']));
  const controlBaseUrl = values.get('--control-base-url')?.at(0);

  if (!controlBaseUrl) {
    throw new Error('Missing required --control-base-url argument.');
  }

  return {
    controlBaseUrl,
    once: values.has('--once'),
    relayUpstream: values.get('--relay-upstream')?.at(0) ?? '',
    sessionDir: values.get('--session-dir')?.at(0) ?? '/openkit/session',
  };
}

/**
 * Runs the Codex shim CLI entrypoint.
 *
 * @param argv Argument vector after the binary name.
 * @returns Promise that resolves when the command finishes.
 */
export async function runCodexShimCli(argv: string[]): Promise<void> {
  const args = parseCodexShimArgs(argv);

  if (args.dryRun) {
    return;
  }

  const result = await runCodexShim({
    args,
    environment: process.env,
  });

  if (result.status !== 'completed') {
    process.exitCode = result.exitCode ?? 1;
  }
}

/**
 * Runs the Codex shim supervisor.
 *
 * @param options Parsed args, environment, and optional runner.
 * @returns Supervised process outcome.
 */
export async function runCodexShim(options: CodexShimRunOptions): Promise<CodexShimRunResult> {
  if (options.args.dryRun) {
    return {
      exitCode: 0,
      signal: null,
      status: 'completed',
    };
  }

  const environment = options.environment ?? process.env;
  const packageManifest = await readCodexShimPackage(options.args.packagePath);
  await materializeRuntimeSupply(packageManifest);
  const cwd = resolveCodexWorkingDirectory(packageManifest);
  const resultMessagePath = resolveCodexResultMessagePath(packageManifest, options.args.sessionDir);
  const command = resolveCodexCommand(packageManifest, environment, cwd, resultMessagePath);
  const workspaceInputs = resolveWorkspaceInputs(packageManifest);
  const workspaceBases = await prepareWorkspaceGitSnapshots(
    workspaceInputs,
    options.args.sessionDir
  );
  const writer = new WorkerTranscriptWriter({
    lineage: workerLineageFromEnvironment(environment),
    sessionDir: options.args.sessionDir,
  });
  await writer.writeEvent({
    data: {
      argv: command,
      cwd,
      runtime: 'codex',
    },
    type: 'worker.ready',
  });
  const result = await (options.runner ?? new ChildProcessCodexProcessRunner()).run({
    argv: command,
    cwd,
    env: stringEnvironment(environment),
  });
  await publishWorkspaceGitSnapshots({
    bases: workspaceBases,
    inputs: workspaceInputs,
    lineage: workerLineageFromEnvironment(environment),
    sessionDir: options.args.sessionDir,
  });
  await writer.writeEvent({
    data: {
      exitCode: result.exitCode,
      runtime: 'codex',
      signal: result.signal,
      status: 'process.exited',
    },
    type: 'worker.heartbeat',
  });
  const status = result.exitCode === 0 ? 'completed' : 'failed';
  await writer.writeTerminalOutcome({
    ...(status === 'failed' ? { diagnostics: codexFailureDiagnostics(result) } : {}),
    ...(status === 'failed' ? { reason: codexExitReason(result) } : {}),
    status,
  });
  const assistantText = await readCodexResultMessage(resultMessagePath);

  if (assistantText) {
    await writer.writeAssistantMessage({
      status,
      text: assistantText,
    });
  }

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    status,
  };
}

/**
 * Runs the worker sidecar CLI entrypoint.
 *
 * @param argv Argument vector after the binary name.
 * @returns Promise that resolves when the command finishes.
 */
export async function runWorkerSidecarCli(argv: string[]): Promise<void> {
  await runWorkerSidecar({
    args: parseWorkerSidecarArgs(argv),
    environment: process.env,
  });
}

/**
 * Runs the worker sidecar relay.
 *
 * @param options Sidecar arguments, environment, and optional fetch implementation.
 * @returns Result from the first relay cycle.
 */
export async function runWorkerSidecar(
  options: WorkerSidecarRunOptions
): Promise<WorkerSidecarRunResult> {
  const environment = options.environment ?? process.env;
  const lineage = workerLineageFromEnvironment(environment);
  const client = new WorkerControlRelayClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    lineage,
    token: requireEnvironmentValue(environment, 'OPENKIT_CONTROL_TOKEN'),
    upstreamBaseUrl: requireRelayUpstream(options.args),
  });
  const transcript = new WorkerTranscriptWriter({
    lineage,
    sessionDir: options.args.sessionDir,
  });
  const commandRunner = options.commandRunner ?? new ChildProcessSidecarCommandRunner();
  let sequence = 0;
  const commandPoll = await runSidecarRelayCycle(
    client,
    transcript,
    commandRunner,
    sequence,
    environment
  );
  sequence += 1;

  if (options.args.once) {
    return { commandPoll };
  }

  while (true) {
    await delay(1000);
    await runSidecarRelayCycle(client, transcript, commandRunner, sequence, environment);
    sequence += 1;
  }
}

/**
 * Parses repeatable long flags into a map.
 *
 * @param argv Argument vector.
 * @param booleanFlags Flags that do not consume a following value.
 * @returns Flag value map.
 */
function parseFlagValues(argv: string[], booleanFlags = new Set<string>()): Map<string, string[]> {
  const values = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (!flag?.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${flag ?? ''}`);
    }

    if (booleanFlags.has(flag)) {
      values.set(flag, []);
      continue;
    }

    const value = argv[index + 1];

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}.`);
    }

    const existing = values.get(flag) ?? [];
    existing.push(value);
    values.set(flag, existing);
    index += 1;
  }

  return values;
}

/**
 * Child-process-backed Codex process runner.
 */
class ChildProcessCodexProcessRunner implements CodexProcessRunner {
  /**
   * Runs one child process and captures stdout and stderr.
   *
   * @param input Command, cwd, and environment.
   * @returns Completed process result.
   */
  public async run(input: CodexProcessRunInput): Promise<CodexProcessRunResult> {
    const [command, ...args] = input.argv;

    if (!command) {
      throw new Error('Codex shim requires a non-empty Codex command.');
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...input.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on('error', reject);
      child.on('close', (exitCode, signal) => {
        resolve({
          exitCode,
          signal,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        });
      });
    });
  }
}

/**
 * Child-process-backed runner for sandbox-local sidecar terminal commands.
 */
class ChildProcessSidecarCommandRunner implements WorkerSidecarCommandRunner {
  /**
   * Runs one sandbox-local command and captures stdout and stderr.
   *
   * @param input Command, cwd, and environment.
   * @returns Completed terminal command result.
   */
  public async run(input: WorkerSidecarCommandRunInput): Promise<WorkerSidecarCommandRunResult> {
    const [command, ...args] = input.argv;

    if (!command) {
      throw new Error('Worker sidecar terminal command requires a non-empty argv.');
    }

    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: {
          ...process.env,
          ...input.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        resolve({
          durationMs: Date.now() - startedAt,
          exitCode: exitCode ?? 1,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        });
      });
    });
  }
}

/**
 * Reads and parses the worker-visible Agent Environment Package file.
 *
 * @param packagePath Worker-visible package manifest path.
 * @returns Minimal package manifest used by the shim.
 */
async function readCodexShimPackage(packagePath: string): Promise<CodexShimPackageManifest> {
  return JSON.parse(await readFile(packagePath, 'utf8')) as CodexShimPackageManifest;
}

/**
 * Materializes catalog-resolved runtime supply from one AEP snapshot.
 *
 * @param packageManifest Parsed worker package manifest.
 */
async function materializeRuntimeSupply(packageManifest: CodexShimPackageManifest): Promise<void> {
  for (const skill of resolveSkillSupply(packageManifest.supply?.skills)) {
    await materializeSkillSupply(skill);
  }

  for (const mcpServer of resolveMcpSupply(packageManifest.supply?.mcpServers)) {
    await materializeMcpSupply(mcpServer);
  }
}

/**
 * Materializes one Skill supply entry as worker-local metadata.
 *
 * @param skill Catalog-resolved Skill supply entry.
 */
async function materializeSkillSupply(skill: RuntimeSkillSupply): Promise<void> {
  await mkdir(skill.materialization.targetPath, { recursive: true });
  await writeFile(
    join(skill.materialization.targetPath, 'openkit-supply.json'),
    `${JSON.stringify(
      {
        allowedRuntimeAdapters: skill.allowedRuntimeAdapters,
        allowedWorkspaceScopes: skill.allowedWorkspaceScopes,
        id: skill.id,
        integrity: skill.integrity,
        materialization: skill.materialization,
        policyRefIds: skill.policyRefIds,
        reviewStatus: skill.reviewStatus,
        secretRefIds: skill.secretRefIds,
        sourceRef: skill.sourceRef,
        version: skill.version,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

/**
 * Materializes one MCP supply entry as a worker-local runtime config file.
 *
 * @param mcpServer Catalog-resolved MCP supply entry.
 */
async function materializeMcpSupply(mcpServer: RuntimeMcpSupply): Promise<void> {
  await mkdir(dirname(mcpServer.materialization.targetPath), { recursive: true });
  await writeFile(
    mcpServer.materialization.targetPath,
    `${JSON.stringify(
      {
        allowedPrompts: mcpServer.allowedPrompts,
        allowedTools: mcpServer.allowedTools,
        command: mcpServer.command,
        id: mcpServer.id,
        networkPolicyHints: mcpServer.networkPolicyHints,
        providerInstanceIds: mcpServer.providerInstanceIds,
        reviewStatus: mcpServer.reviewStatus,
        schemaVersion: 1,
        secretRefIds: mcpServer.secretRefIds,
        sourceRef: mcpServer.sourceRef,
        transport: mcpServer.transport,
        url: mcpServer.url,
        vaultGrantIds: mcpServer.vaultGrantIds,
        version: mcpServer.version,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

/**
 * Resolves well-formed Skill supply records from untrusted package data.
 *
 * @param value Candidate supply array.
 * @returns Skill supply records that declare a worker-local materialization target.
 */
function resolveSkillSupply(value: unknown): RuntimeSkillSupply[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRuntimeSkillSupply);
}

/**
 * Resolves well-formed MCP supply records from untrusted package data.
 *
 * @param value Candidate supply array.
 * @returns MCP supply records that declare a worker-local materialization target.
 */
function resolveMcpSupply(value: unknown): RuntimeMcpSupply[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRuntimeMcpSupply);
}

/**
 * Checks whether a value is a materializable Skill supply entry.
 *
 * @param value Candidate package value.
 * @returns True when the value can be safely materialized as Skill supply metadata.
 */
function isRuntimeSkillSupply(value: unknown): value is RuntimeSkillSupply {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRuntimeSupplyMaterialization(value.materialization) &&
    value.materialization.kind === 'filesystem-copy'
  );
}

/**
 * Checks whether a value is a materializable MCP supply entry.
 *
 * @param value Candidate package value.
 * @returns True when the value can be safely materialized as MCP runtime config.
 */
function isRuntimeMcpSupply(value: unknown): value is RuntimeMcpSupply {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRuntimeSupplyMaterialization(value.materialization) &&
    value.materialization.kind === 'generated-config'
  );
}

/**
 * Checks whether a value is a supply materialization hint.
 *
 * @param value Candidate package value.
 * @returns True when the value carries a materialization kind and target path.
 */
function isRuntimeSupplyMaterialization(value: unknown): value is RuntimeSupplyMaterialization {
  return isRecord(value) && typeof value.kind === 'string' && typeof value.targetPath === 'string';
}

/**
 * Checks whether a value is a non-array object record.
 *
 * @param value Candidate value.
 * @returns True when the value can be inspected as a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves the inner Codex command supervised by the shim.
 *
 * @param packageManifest Worker-visible package manifest.
 * @param environment Sandbox environment.
 * @returns Command argv.
 */
function resolveCodexCommand(
  packageManifest: CodexShimPackageManifest,
  environment: CodexShimEnvironment,
  workingDirectory: string,
  resultMessagePath: string
): string[] {
  if (environment.OPENKIT_CODEX_COMMAND) {
    return parseCodexCommandValue(environment.OPENKIT_CODEX_COMMAND);
  }

  const packageCommand = packageManifest.extensions?.openkit?.codexCommand;

  if (isStringArray(packageCommand)) {
    return packageCommand;
  }

  const turnInput = packageManifest.extensions?.openkit?.turnInput;

  if (typeof turnInput === 'string' && turnInput.trim().length > 0) {
    return [
      'codex',
      'exec',
      '--json',
      '--output-last-message',
      resultMessagePath,
      '--cd',
      workingDirectory,
      '--dangerously-bypass-approvals-and-sandbox',
      turnInput,
    ];
  }

  return ['codex', 'app-server', '--listen', 'stdio://'];
}

/**
 * Resolves the file path where `codex exec` writes its final answer.
 *
 * @param packageManifest Worker-visible package manifest.
 * @param sessionDir Durable session transcript directory.
 * @returns Worker-visible final-message path.
 */
function resolveCodexResultMessagePath(
  packageManifest: CodexShimPackageManifest,
  sessionDir: string
): string {
  const configured = packageManifest.extensions?.openkit?.resultMessagePath;

  return typeof configured === 'string' && configured.length > 0
    ? configured
    : join(sessionDir, 'final-message.txt');
}

/**
 * Reads the final Codex answer when one was written by the supervised process.
 *
 * @param resultMessagePath Worker-visible final-message path.
 * @returns Trimmed assistant text, or null when no final message exists.
 */
async function readCodexResultMessage(resultMessagePath: string): Promise<string | null> {
  try {
    const text = (await readFile(resultMessagePath, 'utf8')).trim();

    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the worker cwd for the inner Codex process.
 *
 * @param packageManifest Worker-visible package manifest.
 * @returns Codex cwd.
 */
function resolveCodexWorkingDirectory(packageManifest: CodexShimPackageManifest): string {
  const candidate = packageManifest.runtime?.command?.workingDirectory;

  return typeof candidate === 'string' && candidate.length > 0 ? candidate : process.cwd();
}

/**
 * Resolves Git-backed workspace inputs that should produce change-set manifests.
 *
 * @param packageManifest Worker-visible package manifest.
 * @returns Workspace inputs with Git materialization enabled.
 */
function resolveWorkspaceInputs(packageManifest: CodexShimPackageManifest): WorkspaceGitInput[] {
  const inputs = packageManifest.workspace?.inputs;

  if (!Array.isArray(inputs)) {
    return [];
  }

  return inputs
    .map((input) => readWorkspaceInput(input))
    .filter((input): input is WorkspaceGitInput => input !== null)
    .filter((input) => input.access === 'read-write' && input.materialization?.strategy === 'git');
}

/**
 * Reads one package workspace input into the shim's minimal manifest shape.
 *
 * @param value Candidate package workspace input.
 * @returns Parsed workspace input or null when unsupported.
 */
function readWorkspaceInput(value: unknown): WorkspaceGitInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const materialization =
    record.materialization &&
    typeof record.materialization === 'object' &&
    !Array.isArray(record.materialization)
      ? (record.materialization as Record<string, unknown>)
      : {};

  if (
    typeof record.id !== 'string' ||
    typeof record.target !== 'string' ||
    (record.access !== 'read-only' && record.access !== 'read-write')
  ) {
    return null;
  }

  return {
    access: record.access,
    id: record.id,
    materialization: {
      changeSetManifestPath: materialization.changeSetManifestPath,
      strategy: materialization.strategy,
    },
    target: record.target,
  };
}

/**
 * Parses a Codex command override.
 *
 * @param value JSON-array or whitespace-separated command value.
 * @returns Command argv.
 */
function parseCodexCommandValue(value: string): string[] {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error('OPENKIT_CODEX_COMMAND must not be empty.');
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;

    if (!isStringArray(parsed) || parsed.length === 0) {
      throw new Error('OPENKIT_CODEX_COMMAND JSON must be a non-empty string array.');
    }

    return parsed;
  }

  return trimmed.split(/\s+/);
}

/**
 * Checks whether a value is a string array.
 *
 * @param value Candidate value.
 * @returns True when every item is a string.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Converts a process environment-like object into plain string variables.
 *
 * @param environment Environment candidate.
 * @returns Plain environment map.
 */
function stringEnvironment(environment: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment as Record<string, unknown>).filter(
      (entry): entry is [string, string] => {
        return typeof entry[1] === 'string';
      }
    )
  );
}

/**
 * Builds a product-safe terminal failure reason.
 *
 * @param result Codex process result.
 * @returns Failure reason.
 */
function codexExitReason(result: CodexProcessRunResult): string {
  if (result.exitCode !== null) {
    return `Codex process exited with code ${result.exitCode}.`;
  }

  return `Codex process exited with signal ${result.signal ?? 'unknown'}.`;
}

/**
 * Builds redacted stdout and stderr summaries for failed Codex processes.
 *
 * @param result Codex process result.
 * @returns Product-safe diagnostics for transcript events.
 */
function codexFailureDiagnostics(result: CodexProcessRunResult): Record<string, string> {
  return Object.fromEntries(
    [
      ['stderr', summarizeProcessOutput(result.stderr)],
      ['stdout', summarizeProcessOutput(result.stdout)],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

/**
 * Redacts and bounds one process output stream for transcript diagnostics.
 *
 * @param output Raw process output.
 * @returns Redacted output summary, or an empty string when no output exists.
 */
function summarizeProcessOutput(output: string): string {
  return redactDiagnosticOutput(output).trim().slice(0, 1000);
}

/**
 * Removes common token-bearing fragments from process diagnostics.
 *
 * @param output Raw process output.
 * @returns Output with common secret shapes removed.
 */
function redactDiagnosticOutput(output: string): string {
  return output
    .replace(/\bAuthorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]')
    .replace(/\b(token|secret|password|api[ _-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)\b/g,
      '[redacted]'
    );
}

/**
 * Runs one heartbeat plus command-poll sidecar cycle.
 *
 * @param client Worker control relay client.
 * @param sequence Heartbeat sequence.
 * @returns Command poll response.
 */
async function runSidecarRelayCycle(
  client: WorkerControlRelayClient,
  transcript: WorkerTranscriptWriter,
  commandRunner: WorkerSidecarCommandRunner,
  sequence: number,
  environment: WorkerSidecarEnvironment
): Promise<WorkerControlRelayCommandPoll> {
  await transcript.writeEvent({
    data: {
      status: 'starting',
    },
    type: 'worker.heartbeat',
  });
  await client.recordHeartbeat({
    message: 'Worker sidecar started.',
    sequence,
    status: 'starting',
  });

  const commandPoll = await client.pollCommands();
  await handleSidecarCommands(client, transcript, commandRunner, commandPoll.commands, environment);

  return commandPoll;
}

/**
 * Handles commands delivered by NanoCore during one sidecar poll.
 *
 * @param client Worker control relay client.
 * @param transcript Durable transcript writer.
 * @param commandRunner Terminal command runner.
 * @param commands Polled commands.
 * @param environment Sidecar process environment.
 */
async function handleSidecarCommands(
  client: WorkerControlRelayClient,
  transcript: WorkerTranscriptWriter,
  commandRunner: WorkerSidecarCommandRunner,
  commands: Array<Record<string, unknown>>,
  environment: WorkerSidecarEnvironment
): Promise<void> {
  for (const command of commands) {
    if (isApprovalCommand(command)) {
      await transcript.writeEvent({
        data: {
          approvalRequestId: command.approvalRequestId,
          decision: command.decision,
          status: 'command.approval_result',
        },
        type: 'worker.heartbeat',
      });
    }

    if (isInterruptCommand(command)) {
      await transcript.writeEvent({
        data: {
          reason: command.reason,
          status: 'command.interrupt',
        },
        type: 'worker.heartbeat',
      });
    }
  }

  for (const command of commands) {
    if (!isTerminalCommand(command)) {
      continue;
    }

    const result = await commandRunner.run({
      argv: command.argv,
      cwd: command.cwd,
      env: stringEnvironment(environment),
    });
    await client.recordTerminalResult({
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      terminalCommandId: command.commandId,
    });
    await transcript.writeEvent({
      data: {
        commandId: command.commandId,
        exitCode: result.exitCode,
        status: 'command.terminal_result',
      },
      type: 'worker.heartbeat',
    });
  }
}

/**
 * Checks whether a command is an approval result.
 *
 * @param command Candidate command.
 * @returns True when the command is an approval result.
 */
function isApprovalCommand(command: Record<string, unknown>): command is {
  approvalRequestId: string;
  decision: string;
  kind: 'approval-result';
} {
  return (
    command.kind === 'approval-result' &&
    typeof command.approvalRequestId === 'string' &&
    typeof command.decision === 'string'
  );
}

/**
 * Checks whether a command is an interrupt command.
 *
 * @param command Candidate command.
 * @returns True when the command is an interrupt command.
 */
function isInterruptCommand(command: Record<string, unknown>): command is {
  kind: 'interrupt';
  reason: string | null;
} {
  return (
    command.kind === 'interrupt' &&
    (typeof command.reason === 'string' || command.reason === null || command.reason === undefined)
  );
}

/**
 * Checks whether a command is a terminal command.
 *
 * @param command Candidate command.
 * @returns True when the command can be executed as a terminal command.
 */
function isTerminalCommand(command: Record<string, unknown>): command is {
  argv: string[];
  commandId: string;
  cwd: string | null;
  kind: 'terminal-command';
} {
  return (
    command.kind === 'terminal-command' &&
    typeof command.commandId === 'string' &&
    Array.isArray(command.argv) &&
    command.argv.every((item) => typeof item === 'string') &&
    (typeof command.cwd === 'string' || command.cwd === null || command.cwd === undefined)
  );
}

/**
 * Builds worker lineage from sandbox environment variables.
 *
 * @param environment Sidecar environment.
 * @returns Worker lineage.
 */
function workerLineageFromEnvironment(environment: WorkerSidecarEnvironment): WorkerLineage {
  return {
    agentSessionId: requireEnvironmentValue(environment, 'OPENKIT_AGENT_SESSION_ID'),
    packageSnapshotId: requireEnvironmentValue(environment, 'OPENKIT_PACKAGE_SNAPSHOT_ID'),
    requestId: environment.OPENKIT_REQUEST_ID ?? null,
    threadId: requireEnvironmentValue(environment, 'OPENKIT_THREAD_ID'),
    turnId: requireEnvironmentValue(environment, 'OPENKIT_TURN_ID'),
    workspaceId: requireEnvironmentValue(environment, 'OPENKIT_WORKSPACE_ID'),
  };
}

/**
 * Reads a required environment variable.
 *
 * @param environment Sidecar environment.
 * @param key Environment variable key.
 * @returns Environment variable value.
 * @throws Error when the value is missing.
 */
function requireEnvironmentValue(
  environment: WorkerSidecarEnvironment,
  key: keyof WorkerSidecarEnvironment
): string {
  const value = environment[key];

  if (!value) {
    throw new Error(`Missing required ${key} environment variable.`);
  }

  return value;
}

/**
 * Resolves the NanoCore relay upstream URL.
 *
 * @param args Parsed sidecar arguments.
 * @returns Upstream base URL.
 * @throws Error when no upstream is configured.
 */
function requireRelayUpstream(args: WorkerSidecarArgs): string {
  if (!args.relayUpstream) {
    throw new Error('Missing required --relay-upstream argument.');
  }

  return args.relayUpstream;
}
