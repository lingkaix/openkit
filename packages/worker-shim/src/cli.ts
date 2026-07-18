import { spawn } from 'node:child_process';
import { closeSync, readSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerCanonicalTerminalEventDataSchema } from '@openkit/worker-protocol';
import { CodexRuntimeProvenanceCapture } from './codex-runtime-provenance.js';
import {
  WorkerControlClient,
  type WorkerControlCommandPoll,
  type WorkerControlFetch,
} from './control-client.js';
import {
  type WorkerLineage,
  type WorkerTerminalOutcomeInput,
  WorkerTranscriptWriter,
} from './transcript.js';
import {
  prepareWorkspaceGitSnapshots,
  publishWorkspaceGitSnapshots,
  type WorkspaceGitInput,
} from './workspace-git.js';

const WORKER_CONTROL_READINESS_TIMEOUT_MS = 10_000;
const WORKER_CONTROL_TOKEN_MAX_BYTES = 4096;
const CODEX_FINAL_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_WORKER_CHILD_ENVIRONMENT_KEYS = [
  'ALL_PROXY',
  'CODEX_HOME',
  'COLORTERM',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NODE_USE_ENV_PROXY',
  'NO_COLOR',
  'NO_PROXY',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

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
export interface CodexShimEnvironment {
  /** Optional all-protocol proxy URL inherited by child processes. */
  ALL_PROXY?: string | undefined;
  /** Optional Codex state root used to discover native rollout streams. */
  CODEX_HOME?: string | undefined;
  /** Worker home used for the default `.codex` state root. */
  HOME?: string | undefined;
  /** Optional HTTP proxy URL inherited by child processes. */
  HTTP_PROXY?: string | undefined;
  /** Optional HTTPS proxy URL inherited by child processes. */
  HTTPS_PROXY?: string | undefined;
  /** Optional uppercase proxy bypass list inherited by child processes. */
  NO_PROXY?: string | undefined;
  /** Enables environment-proxy support for Node child processes. */
  NODE_USE_ENV_PROXY?: string | undefined;
  /** NanoCore worker-control route base URL. */
  OPENKIT_CONTROL_BASE_URL?: string | undefined;
  /** Internal launcher descriptor containing the sandbox bearer token. */
  OPENKIT_CONTROL_TOKEN_FD?: string | undefined;
  /** Optional JSON-array or whitespace-separated Codex process command override. */
  OPENKIT_CODEX_COMMAND?: string | undefined;
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
  /** OpenShell provider placeholder resolved only when Codex calls trusted worker inference. */
  OPENKIT_WORKER_INFERENCE_TOKEN?: string | undefined;
  /** Optional lowercase HTTP proxy URL inherited by child processes. */
  http_proxy?: string | undefined;
  /** Optional lowercase HTTPS proxy URL inherited by child processes. */
  https_proxy?: string | undefined;
  /** Optional lowercase proxy bypass list inherited by child processes. */
  no_proxy?: string | undefined;
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
  /** Supervisor cancellation signal for the Codex process. */
  signal: AbortSignal;
  /** Optional backpressured sink for exact Codex stdout bytes. */
  writeStdout?: ((chunk: Uint8Array) => Promise<void>) | undefined;
}

/**
 * Result returned by a supervised Codex process runner.
 */
export interface CodexProcessRunResult {
  /** Process exit code, or null when the process ended by signal. */
  exitCode: number | null;
  /** Process signal, or null when the process exited normally. */
  signal: NodeJS.Signals | null;
  /** Diagnostic stdout prefix bounded to 16 KiB. */
  stdout: string;
  /** Diagnostic stderr prefix bounded to 16 KiB. */
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
  /** Sandbox bearer token supplied outside the supervisor process environment. */
  controlToken?: string | undefined;
  /** Sandbox environment variables visible to the shim. */
  environment?: CodexShimEnvironment | undefined;
  /** Optional process runner for tests or alternate supervisors. */
  runner?: CodexProcessRunner | undefined;
  /** Optional fetch implementation for the supervised control. */
  fetch?: WorkerControlFetch | undefined;
  /** Optional parent cancellation signal. */
  signal?: AbortSignal | undefined;
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
  status: 'completed' | 'failed' | 'interrupted';
}

/** Direct worker-control command accepted by the Codex supervisor. */
type DirectWorkerControlCommand = {
  /** NanoCore-issued command id. */
  commandId: string;
  /** Interrupt command discriminator. */
  kind: 'interrupt';
  /** Optional product-safe interrupt reason. */
  reason?: string | null;
};

interface CodexShimPackageManifest {
  control?: {
    mode?: unknown;
    transcript?: {
      runtimeProvenance?: unknown;
    };
  };
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

/** Fixed runtime provenance output declaration projected into a Codex AEP. */
interface CodexRuntimeProvenanceDeclaration {
  maxStreamCount: number;
  maxTotalBytes: number;
  nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl';
  rawStreamsRoot: '/openkit/session/runtime/raw';
  streamManifestPath: '/openkit/session/runtime/raw-streams.json';
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
 * Runs the Codex shim CLI entrypoint.
 *
 * @param argv Argument vector after the binary name.
 * @param write Output sink for command help.
 * @returns Promise that resolves when the command finishes.
 */
export async function runCodexShimCli(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(line)
): Promise<void> {
  if (argv.includes('--help')) {
    write(
      'Usage: openkit-codex-shim --package <path> [--session-dir <path>] [--artifact-dir <path>] [--dry-run]\n'
    );
    return;
  }

  const args = parseCodexShimArgs(argv);

  if (!args.dryRun && process.env.OPENKIT_CONTROL_TOKEN) {
    throw new Error('Worker control token must be supplied through launcher descriptor 3.');
  }
  const controlToken = args.dryRun
    ? undefined
    : readWorkerControlTokenFromFileDescriptor(process.env);
  const environment: CodexShimEnvironment = { ...process.env };
  delete environment.OPENKIT_CONTROL_TOKEN_FD;
  const controller = new AbortController();
  let receivedSignal: 'SIGINT' | 'SIGTERM' | null = null;
  /** Records SIGINT and cancels the supervised worker lifecycle. */
  const abortForInterrupt = () => {
    receivedSignal = 'SIGINT';
    controller.abort();
  };
  /** Records SIGTERM and cancels the supervised worker lifecycle. */
  const abortForTermination = () => {
    receivedSignal = 'SIGTERM';
    controller.abort();
  };
  process.once('SIGINT', abortForInterrupt);
  process.once('SIGTERM', abortForTermination);
  let result: CodexShimRunResult;

  try {
    result = await runCodexShim({
      args,
      controlToken,
      environment,
      signal: controller.signal,
    });
  } catch (error) {
    if (receivedSignal === 'SIGINT') {
      process.exitCode = 130;
      return;
    }
    if (receivedSignal === 'SIGTERM') {
      process.exitCode = 143;
      return;
    }
    throw error;
  } finally {
    process.off('SIGINT', abortForInterrupt);
    process.off('SIGTERM', abortForTermination);
  }

  if (receivedSignal === 'SIGINT') {
    process.exitCode = 130;
  } else if (receivedSignal === 'SIGTERM') {
    process.exitCode = 143;
  } else if (result.status !== 'completed') {
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
  const environment = options.environment ?? process.env;
  const packageManifest = await readCodexShimPackage(options.args.packagePath);

  if (packageManifest.control?.mode !== 'direct-nanocore') {
    throw new Error('Codex shim requires control.mode to be direct-nanocore.');
  }

  if (options.args.dryRun) {
    return {
      exitCode: 0,
      signal: null,
      status: 'completed',
    };
  }

  const controlBaseUrl = environment.OPENKIT_CONTROL_BASE_URL?.trim();

  if (!controlBaseUrl) {
    throw new Error('Missing required OPENKIT_CONTROL_BASE_URL environment variable.');
  }

  await materializeRuntimeSupply(packageManifest);
  const cwd = resolveCodexWorkingDirectory(packageManifest);
  const resultMessagePath = resolveCodexResultMessagePath(packageManifest, options.args.sessionDir);
  const command = resolveCodexCommand(packageManifest, environment, cwd, resultMessagePath);
  const workspaceInputs = resolveWorkspaceInputs(packageManifest);
  const workspaceBases = await prepareWorkspaceGitSnapshots(
    workspaceInputs,
    options.args.sessionDir
  );
  const lineage = workerLineageFromEnvironment(environment);
  let controlSession: WorkerControlClient | null = null;
  const writer = new WorkerTranscriptWriter({
    appendEvent: async (record) => {
      if (!controlSession) {
        throw new Error('Worker live event append requires initialized direct control.');
      }
      await controlSession.appendEvent(
        record,
        controlAbortController.signal.aborted ? undefined : controlAbortController.signal
      );
    },
    lineage,
    sessionDir: options.args.sessionDir,
  });
  let failureReason = 'worker-supervisor-failed';
  let terminalOutcomeAttempted = false;
  let workerControlReady = false;
  const controlAbortController = new AbortController();
  const codexAbortController = new AbortController();
  let interrupted = false;
  /** Cancels the control and Codex child under the shared supervisor lifecycle. */
  const abortChildren = (reason?: unknown) => {
    controlSession?.disablePostLaunchRecovery();
    controlAbortController.abort(reason);
    codexAbortController.abort(reason);
  };
  /** Propagates the exact parent cancellation reason to both supervised children. */
  const abortForParent = () => abortChildren(options.signal?.reason);

  if (options.signal?.aborted) {
    abortForParent();
  } else {
    options.signal?.addEventListener('abort', abortForParent, { once: true });
  }

  try {
    const controlToken = requireWorkerControlToken(options.controlToken);
    const session = new WorkerControlClient({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      lineage,
      token: controlToken,
      baseUrl: controlBaseUrl,
    });
    controlSession = session;
    const seenCommandIds = new Set<string>();
    /** Records a delivered interrupt and cancels both supervised child paths. */
    const interruptWorker = () => {
      interrupted = true;
      codexAbortController.abort();
    };

    failureReason = 'worker-control-readiness-failed';
    let initialCommandPoll: WorkerControlCommandPoll | null = null;
    try {
      initialCommandPoll = await waitForWorkerControlReadiness(
        () => pollWorkerControl(session, writer, 'starting', controlAbortController.signal),
        controlAbortController
      );
      workerControlReady = true;
    } catch (error) {
      if (!(options.signal?.aborted && error === options.signal.reason)) {
        throw error;
      }
    }

    failureReason = 'worker-control-runtime-failed';
    if (initialCommandPoll) {
      try {
        await handleWorkerControlCommands(
          session,
          writer,
          initialCommandPoll.commands,
          controlAbortController.signal,
          seenCommandIds,
          interruptWorker
        );
      } catch (error) {
        if (!interrupted && !(options.signal?.aborted && error === options.signal.reason)) {
          throw error;
        }
      }
    }

    if (interrupted || options.signal?.aborted) {
      terminalOutcomeAttempted = true;
      await writeAndReportTerminalOutcome(writer, workerControlReady ? session : null, {
        status: 'interrupted',
        stopReason: interrupted ? 'worker-interrupt-command' : 'worker-parent-aborted',
      });
      return {
        exitCode: null,
        signal: 'SIGTERM',
        status: 'interrupted',
      };
    }

    failureReason = 'worker-runtime-failed';
    await writer.writeAndAppendEvent({
      data: {
        argv: command,
        cwd,
        runtime: 'codex',
      },
      type: 'worker.ready',
    });
    const codexEnvironment = codexChildEnvironment(environment);
    const provenanceDeclaration = parseCodexRuntimeProvenanceDeclaration(
      packageManifest.control?.transcript?.runtimeProvenance
    );
    const codexHome =
      environment.CODEX_HOME || (environment.HOME ? join(environment.HOME, '.codex') : undefined);

    if (provenanceDeclaration && !codexHome) {
      throw new Error('Codex runtime provenance requires CODEX_HOME or HOME.');
    }

    const provenanceCapture =
      provenanceDeclaration && codexHome
        ? new CodexRuntimeProvenanceCapture({
            adapterVersion: '0.144.1',
            codexHome,
            lineage,
            maxStreamCount: provenanceDeclaration.maxStreamCount,
            maxTotalBytes: provenanceDeclaration.maxTotalBytes,
            nativeOriginIndexPath: mapWorkerSessionPath(
              provenanceDeclaration.nativeOriginIndexPath,
              options.args.sessionDir
            ),
            rawStreamsRoot: mapWorkerSessionPath(
              provenanceDeclaration.rawStreamsRoot,
              options.args.sessionDir
            ),
            streamManifestPath: mapWorkerSessionPath(
              provenanceDeclaration.streamManifestPath,
              options.args.sessionDir
            ),
          })
        : null;

    let result: CodexProcessRunResult;
    let controlPromise: Promise<void> | null = null;

    try {
      const processPromise = (options.runner ?? new ChildProcessCodexProcessRunner()).run({
        argv: command,
        cwd,
        env: codexEnvironment,
        signal: codexAbortController.signal,
        ...(provenanceCapture
          ? { writeStdout: (chunk: Uint8Array) => provenanceCapture.writePrimaryChunk(chunk) }
          : {}),
      });
      session.enablePostLaunchRecovery();
      controlPromise = runWorkerControlLoop(
        session,
        writer,
        controlAbortController.signal,
        seenCommandIds,
        interruptWorker
      );

      result = await superviseCodexProcess(processPromise, controlPromise, {
        codexAbortController,
        isInterrupted: () => interrupted || Boolean(options.signal?.aborted),
        onFailureOwner: (owner) => {
          failureReason =
            owner === 'control' ? 'worker-control-runtime-failed' : 'worker-runtime-failed';
        },
        controlAbortController,
      });
    } catch (error) {
      await provenanceCapture?.invalidate();
      throw error;
    }

    await writer.writeAndAppendEvent({
      data: {
        exitCode: result.exitCode,
        runtime: 'codex',
        signal: result.signal,
        status: 'process.exited',
      },
      type: 'worker.heartbeat',
    });
    failureReason = 'worker-final-message-collection-failed';
    const assistantText = await readCodexResultMessage(resultMessagePath);
    failureReason = 'worker-runtime-failed';
    let status: CodexShimRunResult['status'] =
      interrupted || options.signal?.aborted
        ? 'interrupted'
        : result.exitCode === 0
          ? 'completed'
          : 'failed';

    if (assistantText && status !== 'interrupted') {
      await writer.writeAssistantMessage({
        status,
        text: assistantText,
      });
    }

    status =
      interrupted || options.signal?.aborted
        ? 'interrupted'
        : result.exitCode === 0
          ? 'completed'
          : 'failed';
    await provenanceCapture?.finalize();
    await publishWorkspaceGitSnapshots({
      bases: workspaceBases,
      inputs: workspaceInputs,
      lineage,
      sessionDir: options.args.sessionDir,
    });
    terminalOutcomeAttempted = true;
    await writeAndReportTerminalOutcome(writer, session, {
      ...(status === 'failed' && !provenanceCapture
        ? { diagnostics: codexFailureDiagnostics(result) }
        : {}),
      status,
      stopReason:
        status === 'failed'
          ? codexExitReason(result)
          : status === 'interrupted'
            ? interrupted
              ? 'worker-interrupt-command'
              : 'worker-parent-aborted'
            : status,
    });
    controlAbortController.abort();
    await controlPromise.catch(() => undefined);

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      status,
    };
  } catch (error) {
    if (!terminalOutcomeAttempted) {
      terminalOutcomeAttempted = true;
      await writeAndReportTerminalOutcome(writer, workerControlReady ? controlSession : null, {
        status: 'failed',
        stopReason: failureReason,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortForParent);
    abortChildren();
  }
}

/**
 * Persists one terminal transcript record and reports its exact final sequence to NanoCore.
 *
 * @param writer Durable worker transcript writer.
 * @param client Live session coordinator, or null when control readiness never completed.
 * @param input Worker-local terminal outcome.
 */
async function writeAndReportTerminalOutcome(
  writer: WorkerTranscriptWriter,
  client: WorkerControlClient | null,
  input: WorkerTerminalOutcomeInput
): Promise<void> {
  const record = await writer.writeTerminalOutcome(input);
  const terminalData = WorkerCanonicalTerminalEventDataSchema.parse(record.event.data);

  await client?.recordFinalStatus({
    ...terminalData,
    sequence: record.sequence,
  });
}

/**
 * Keeps the Codex process and live control under one fail-closed lifecycle.
 *
 * @param processPromise Running Codex process outcome.
 * @param controlPromise Running periodic control.
 * @param supervision Abort controllers and optional parent signal.
 * @returns Completed Codex process result.
 * @throws The first process or control failure after the sibling has stopped.
 */
async function superviseCodexProcess(
  processPromise: Promise<CodexProcessRunResult>,
  controlPromise: Promise<void>,
  supervision: {
    /** Controller that terminates the Codex child. */
    codexAbortController: AbortController;
    /** Returns whether an external or worker interrupt owns cancellation. */
    isInterrupted: () => boolean;
    /** Records whether the process or control path owns a frozen failure. */
    onFailureOwner: (owner: 'runtime' | 'control') => void;
    /** Controller that terminates control polling and in-flight requests. */
    controlAbortController: AbortController;
  }
): Promise<CodexProcessRunResult> {
  const first = await Promise.race([
    processPromise.then(
      (result) => ({ kind: 'process-complete' as const, result }),
      (error: unknown) => ({ error, kind: 'process-failed' as const })
    ),
    controlPromise.then(
      () => ({ kind: 'control-stopped' as const }),
      (error: unknown) => ({ error, kind: 'control-failed' as const })
    ),
  ]);
  const interruptedAtWinner = supervision.isInterrupted();

  if (first.kind === 'process-complete') {
    return first.result;
  }

  if (first.kind === 'process-failed') {
    supervision.controlAbortController.abort();
    await controlPromise.catch(() => undefined);
    if (interruptedAtWinner) {
      return interruptedCodexProcessResult();
    }
    supervision.onFailureOwner('runtime');
    throw first.error;
  }

  supervision.codexAbortController.abort();
  supervision.controlAbortController.abort();
  const processOutcome = await processPromise.then(
    (result) => ({ kind: 'process-complete' as const, result }),
    (error: unknown) => ({ error, kind: 'process-failed' as const })
  );
  await controlPromise.catch(() => undefined);

  if (interruptedAtWinner) {
    return processOutcome.kind === 'process-complete'
      ? processOutcome.result
      : interruptedCodexProcessResult();
  }
  if (first.kind === 'control-failed') {
    supervision.onFailureOwner('control');
    throw first.error;
  }
  supervision.onFailureOwner('control');
  throw new Error('Worker control stopped before Codex completed.');
}

/**
 * Creates the normalized process result used after supervisor cancellation.
 *
 * @returns Signal-terminated Codex process result without child diagnostics.
 */
function interruptedCodexProcessResult(): CodexProcessRunResult {
  return {
    exitCode: null,
    signal: 'SIGTERM',
    stderr: '',
    stdout: '',
  };
}

/**
 * Bounds the initial worker-control heartbeat and command poll.
 *
 * @param readiness Starts the initial control cycle after the deadline is armed.
 * @param controller Control controller to abort on timeout.
 * @returns Completed initial control cycle.
 * @throws A stable readiness timeout when NanoCore does not respond in time.
 */
async function waitForWorkerControlReadiness<T>(
  readiness: () => Promise<T>,
  controller: AbortController
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Worker control readiness timed out.');
      controller.abort(error);
      reject(error);
    }, WORKER_CONTROL_READINESS_TIMEOUT_MS);
  });

  try {
    return await Promise.race([readiness(), timeoutFailure]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
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
   * Runs one child process and retains only bounded diagnostic output prefixes.
   *
   * @param input Command, cwd, and environment.
   * @returns Completed process result.
   * @throws When spawning, reading output, or the stdout sink fails.
   */
  public async run(input: CodexProcessRunInput): Promise<CodexProcessRunResult> {
    const [command, ...args] = input.argv;

    if (!command) {
      throw new Error('Codex shim requires a non-empty Codex command.');
    }

    return runChildProcessGroup({
      args,
      command,
      cwd: input.cwd,
      env: input.env,
      signal: input.signal,
      ...(input.writeStdout ? { writeStdout: input.writeStdout } : {}),
    });
  }
}

/**
 * Runs one detached child process group under bounded cancellation and output draining.
 *
 * @param input Validated command, environment, cancellation, and optional stdout sink.
 * @returns Completed process result with bounded diagnostic output.
 * @throws When spawning, process-group termination, output draining, or the stdout sink fails.
 */
async function runChildProcessGroup(input: {
  /** Command arguments after the executable. */
  args: string[];
  /** Executable path or name. */
  command: string;
  /** Optional child working directory. */
  cwd?: string | undefined;
  /** Explicit child environment. */
  env: Record<string, string>;
  /** Supervisor cancellation signal. */
  signal: AbortSignal;
  /** Optional backpressured sink for exact stdout bytes. */
  writeStdout?: ((chunk: Uint8Array) => Promise<void>) | undefined;
}): Promise<CodexProcessRunResult> {
  input.signal.throwIfAborted();
  const child = spawn(input.command, input.args, {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    detached: true,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const close = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    }
  );
  const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    }
  );
  const stdoutDrain = readChildProcessStream(child.stdout, input.writeStdout);
  const stderrDrain = readChildProcessStream(child.stderr);
  const drainFailure = firstRejectedDrain([stdoutDrain, stderrDrain]);
  let termination: Promise<void> | null = null;
  let rejectTermination: (reason: unknown) => void = () => undefined;
  const terminationFailure = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  /** Starts bounded child termination at most once. */
  const terminate = (graceful = true) => {
    if (!termination) {
      termination = terminateChildProcess(child, close, graceful);
      void termination.catch(rejectTermination);
    }
    return termination;
  };
  /** Starts graceful process-group termination after supervisor cancellation. */
  const terminateForAbort = () => void terminate();
  input.signal.addEventListener('abort', terminateForAbort, { once: true });
  if (input.signal.aborted) {
    terminateForAbort();
  }

  try {
    const outcome = await Promise.race([completion, drainFailure, terminationFailure]);
    await terminate(false);
    const [stdout, stderr] = await Promise.all([stdoutDrain, stderrDrain]);

    return { ...outcome, stderr, stdout };
  } catch (error) {
    await terminate().catch(() => undefined);
    await settleChildProcessDrains(child, [stdoutDrain, stderrDrain]);
    throw error;
  } finally {
    input.signal.removeEventListener('abort', terminateForAbort);
  }
}

const CHILD_PROCESS_DIAGNOSTIC_PREFIX_BYTES = 16 * 1024;

/**
 * Drains one process stream while retaining a bounded diagnostic prefix.
 *
 * @param stream Child output stream, when piped.
 * @param writeChunk Optional backpressured sink for exact stream chunks.
 * @returns UTF-8 diagnostic prefix containing at most 16 KiB.
 * @throws When stream reading or the optional sink fails.
 */
async function readChildProcessStream(
  stream: Readable | null,
  writeChunk?: ((chunk: Uint8Array) => Promise<void>) | undefined
): Promise<string> {
  if (!stream) {
    return '';
  }

  const prefix: Buffer[] = [];
  let prefixBytes = 0;

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await writeChunk?.(chunk);

    if (prefixBytes < CHILD_PROCESS_DIAGNOSTIC_PREFIX_BYTES) {
      const retained = chunk.subarray(0, CHILD_PROCESS_DIAGNOSTIC_PREFIX_BYTES - prefixBytes);
      prefix.push(retained);
      prefixBytes += retained.byteLength;
    }
  }

  return Buffer.concat(prefix, prefixBytes).toString('utf8');
}

/**
 * Rejects when any child output drain fails without settling on successful drains.
 *
 * @param drains Child output drains.
 * @returns Promise that rejects with the first drain failure.
 */
function firstRejectedDrain(drains: Array<Promise<string>>): Promise<never> {
  return new Promise((_resolve, reject) => {
    for (const drain of drains) {
      void drain.catch(reject);
    }
  });
}

/**
 * Stops a child process group with bounded TERM-to-KILL escalation and waits for closure.
 *
 * @param child Spawned child process.
 * @param close Child close promise that never rejects on process error.
 * @param graceful Whether to offer the live process group SIGTERM before SIGKILL.
 */
async function terminateChildProcess(
  child: ReturnType<typeof spawn>,
  close: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>,
  graceful = true
): Promise<void> {
  const groupId = child.pid;

  if (!groupId) {
    return;
  }

  if (graceful) {
    signalProcessGroup(groupId, 'SIGTERM');
  }
  if (!graceful || !(await waitForProcessGroupExit(groupId, 1000))) {
    signalProcessGroup(groupId, 'SIGKILL');
    await waitForProcessGroupExit(groupId, 1000);
  }

  const killed = await waitForChildProcessClose(close, 1000);
  if (!killed) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
}

/**
 * Signals one detached POSIX child process group.
 *
 * @param groupId Process-group leader id.
 * @param signal Signal delivered to every process in the group.
 */
function signalProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Waits until a detached POSIX process group no longer exists.
 *
 * @param groupId Process-group leader id.
 * @param timeoutMs Maximum wait in milliseconds.
 * @returns True when the process group exited before the deadline.
 */
async function waitForProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (processGroupExists(groupId)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(1);
  }

  return true;
}

/**
 * Checks whether a detached POSIX process group still has a live member.
 *
 * @param groupId Process-group leader id.
 * @returns True when signal zero can still address the group.
 */
function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Waits a bounded interval for one child close event.
 *
 * @param close Child close promise.
 * @param timeoutMs Maximum wait in milliseconds.
 * @returns True when the child closed before the deadline.
 */
async function waitForChildProcessClose(
  close: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number
): Promise<boolean> {
  return Promise.race([close.then(() => true), delay(timeoutMs).then(() => false)]);
}

/**
 * Waits a bounded interval for output drains, then destroys their source pipes.
 *
 * @param child Spawned child process that owns the output pipes.
 * @param drains Pending stdout and stderr drains.
 * @returns Promise that resolves after the drains settle or their pipes are destroyed.
 */
async function settleChildProcessDrains(
  child: ReturnType<typeof spawn>,
  drains: Array<Promise<string>>
): Promise<void> {
  const settled = await Promise.race([
    Promise.allSettled(drains).then(() => true),
    delay(1000).then(() => false),
  ]);
  if (!settled) {
    child.stdout?.destroy();
    child.stderr?.destroy();
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
 * Validates the fixed runtime provenance declaration before process launch or file creation.
 *
 * @param value Untrusted package manifest value.
 * @returns Valid declaration, or null when runtime provenance is not requested.
 * @throws When a present declaration differs from the canonical AEP projection.
 */
function parseCodexRuntimeProvenanceDeclaration(
  value: unknown
): CodexRuntimeProvenanceDeclaration | null {
  if (value === undefined) {
    return null;
  }
  if (
    !isRecord(value) ||
    value.rawStreamsRoot !== '/openkit/session/runtime/raw' ||
    value.streamManifestPath !== '/openkit/session/runtime/raw-streams.json' ||
    value.nativeOriginIndexPath !== '/openkit/session/runtime/native-origin-index.jsonl' ||
    !Number.isSafeInteger(value.maxTotalBytes) ||
    Number(value.maxTotalBytes) <= 0 ||
    !Number.isSafeInteger(value.maxStreamCount) ||
    Number(value.maxStreamCount) <= 0
  ) {
    throw new Error('Invalid runtime provenance declaration.');
  }

  return value as unknown as CodexRuntimeProvenanceDeclaration;
}

/**
 * Maps one fixed worker-visible session output into the mounted host session directory.
 *
 * @param workerPath Worker-visible path rooted at `/openkit/session`.
 * @param sessionDir Mounted host session directory.
 * @returns Host path for the declared output.
 * @throws When the declaration escapes the fixed session root.
 */
function mapWorkerSessionPath(workerPath: string, sessionDir: string): string {
  const prefix = '/openkit/session/';

  if (!workerPath.startsWith(prefix)) {
    throw new Error(`Runtime provenance path must be rooted at ${prefix}`);
  }

  return join(sessionDir, workerPath.slice(prefix.length));
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
 * @throws When the final message is not a readable regular file or exceeds the fixed size bound.
 */
async function readCodexResultMessage(resultMessagePath: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>>;

  try {
    file = await open(resultMessagePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const metadata = await file.stat();

    if (!metadata.isFile()) {
      throw new Error('Codex final message path is not a regular file.');
    }
    if (metadata.size > CODEX_FINAL_MESSAGE_MAX_BYTES) {
      throw new Error(`Codex final message exceeds ${CODEX_FINAL_MESSAGE_MAX_BYTES} bytes.`);
    }

    const raw = Buffer.allocUnsafe(CODEX_FINAL_MESSAGE_MAX_BYTES + 1);
    let length = 0;
    while (length < raw.length) {
      const { bytesRead } = await file.read(raw, length, raw.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > CODEX_FINAL_MESSAGE_MAX_BYTES) {
      throw new Error(`Codex final message exceeds ${CODEX_FINAL_MESSAGE_MAX_BYTES} bytes.`);
    }
    const text = raw.toString('utf8', 0, length).trim();

    return text.length > 0 ? text : null;
  } finally {
    await file.close();
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
 * Builds the environment visible only to the supervised Codex process.
 *
 * @param environment Supervisor environment candidate.
 * @returns Safe runtime environment including the trusted inference placeholder.
 */
function codexChildEnvironment(environment: CodexShimEnvironment): Record<string, string> {
  const source = environment as Record<string, unknown>;
  const selected: Record<string, string> = {};

  for (const key of [...SAFE_WORKER_CHILD_ENVIRONMENT_KEYS, 'OPENKIT_WORKER_INFERENCE_TOKEN']) {
    const value = source[key];

    if (typeof value === 'string' && value.length > 0) {
      selected[key] = value;
    }
  }

  return selected;
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
 * Records one heartbeat and polls NanoCore for worker commands.
 *
 * @param client Session-level worker-control coordinator.
 * @param transcript Shared worker transcript writer.
 * @param status Logical worker heartbeat status.
 * @param signal Supervisor cancellation signal.
 * @returns Commands returned by NanoCore after the heartbeat is accepted.
 */
async function pollWorkerControl(
  client: WorkerControlClient,
  transcript: WorkerTranscriptWriter,
  status: 'running' | 'starting',
  signal: AbortSignal
): Promise<WorkerControlCommandPoll> {
  await recordWorkerHeartbeat(client, transcript, status, signal);
  return client.pollCommands(signal);
}

/**
 * Runs periodic worker-control cycles until the supervisor cancels them.
 *
 * @param client Session-level worker-control coordinator.
 * @param transcript Shared transcript writer owned by the worker supervisor.
 * @param signal Supervisor cancellation signal.
 * @param seenCommandIds Command ids already queued or handled.
 * @param onInterrupt Optional worker interrupt callback.
 */
async function runWorkerControlLoop(
  client: WorkerControlClient,
  transcript: WorkerTranscriptWriter,
  signal: AbortSignal,
  seenCommandIds: Set<string>,
  onInterrupt?: () => void
): Promise<void> {
  while (!signal.aborted) {
    try {
      await delay(1000, undefined, { signal });
      if (signal.aborted) {
        return;
      }
      const commandPoll = await pollWorkerControl(client, transcript, 'running', signal);
      if (transcript.eventTranscriptSealed) {
        continue;
      }
      await handleWorkerControlCommands(
        client,
        transcript,
        commandPoll.commands,
        signal,
        seenCommandIds,
        onInterrupt
      );
    } catch (error) {
      if (isSupervisorAbort(error, signal)) {
        return;
      }
      throw error;
    }
  }
}

/**
 * Handles commands delivered by NanoCore during one control poll.
 *
 * @param client Session-level worker-control coordinator.
 * @param transcript Durable transcript writer.
 * @param commands Polled commands.
 * @param signal Supervisor cancellation signal.
 * @param seenCommandIds Command ids already queued or handled.
 * @param onInterrupt Optional worker interrupt callback.
 */
async function handleWorkerControlCommands(
  client: WorkerControlClient,
  transcript: WorkerTranscriptWriter,
  commands: Array<Record<string, unknown>>,
  signal: AbortSignal,
  seenCommandIds: Set<string>,
  onInterrupt?: () => void
): Promise<void> {
  const [interrupt] = takeNewWorkerCommands(commands, seenCommandIds);

  if (interrupt) {
    onInterrupt?.();
    await recordWorkerInterrupt(client, transcript, interrupt, signal);
  }
}

/**
 * Filters one poll to commands not already accepted by this supervisor.
 *
 * @param commands Raw commands returned by NanoCore.
 * @param seenCommandIds Command ids already queued or handled.
 * @returns Newly accepted commands in delivery order.
 */
function takeNewWorkerCommands(
  commands: Array<Record<string, unknown>>,
  seenCommandIds: Set<string>
): DirectWorkerControlCommand[] {
  const accepted: DirectWorkerControlCommand[] = [];

  for (const command of commands) {
    const commandId = typeof command.commandId === 'string' ? command.commandId : null;

    if (!commandId) {
      throw new Error('Unsupported worker control command: missing commandId.');
    }
    if (seenCommandIds.has(commandId)) {
      continue;
    }
    if (!isInterruptCommand(command)) {
      throw new Error(`Unsupported worker control command: ${commandId}`);
    }
    seenCommandIds.add(commandId);
    accepted.push(command);
  }

  return accepted;
}

/**
 * Persists and acknowledges one authenticated worker interrupt.
 *
 * @param client Session-level worker-control coordinator.
 * @param transcript Shared worker transcript writer.
 * @param command Valid interrupt command.
 * @param signal Supervisor cancellation signal.
 */
async function recordWorkerInterrupt(
  client: WorkerControlClient,
  transcript: WorkerTranscriptWriter,
  command: Extract<DirectWorkerControlCommand, { kind: 'interrupt' }>,
  signal: AbortSignal
): Promise<void> {
  await transcript.writeAndAppendEvent({
    data: {
      reason: command.reason ?? null,
      status: 'command.interrupt',
    },
    type: 'worker.heartbeat',
  });
  await client.acknowledgeCommand(command.commandId, signal);
}

/**
 * Records one accepted worker heartbeat and its durable transcript event.
 *
 * @param client Session-level worker-control coordinator.
 * @param transcript Shared worker transcript writer.
 * @param status Logical worker heartbeat status.
 * @param signal Supervisor cancellation signal.
 */
async function recordWorkerHeartbeat(
  client: WorkerControlClient,
  transcript: WorkerTranscriptWriter,
  status: 'running' | 'starting',
  signal: AbortSignal
): Promise<void> {
  await client.recordHeartbeat(
    {
      message: status === 'starting' ? 'Worker shim started.' : 'Worker shim running.',
      status,
    },
    signal
  );
  if (transcript.eventTranscriptSealed) {
    return;
  }
  await transcript.writeAndAppendEvent({
    data: { status },
    type: 'worker.heartbeat',
  });
}

/**
 * Returns whether a rejected operation was caused by the supervisor signal.
 *
 * @param error Rejected operation reason.
 * @param signal Supervisor cancellation signal.
 * @returns True only for cancellation owned by the supplied signal.
 */
function isSupervisorAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
  );
}

/**
 * Checks whether a command is an interrupt command.
 *
 * @param command Candidate command.
 * @returns True when the command is an interrupt command.
 */
function isInterruptCommand(
  command: Record<string, unknown>
): command is Extract<DirectWorkerControlCommand, { kind: 'interrupt' }> {
  return (
    command.kind === 'interrupt' &&
    typeof command.commandId === 'string' &&
    (typeof command.reason === 'string' || command.reason === null || command.reason === undefined)
  );
}

/**
 * Builds worker lineage from sandbox environment variables.
 *
 * @param environment Control environment.
 * @returns Worker lineage.
 */
function workerLineageFromEnvironment(environment: CodexShimEnvironment): WorkerLineage {
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
 * Reads the worker-control token from the inherited anonymous launcher descriptor.
 *
 * @param environment Supervisor environment containing the internal descriptor number.
 * @returns Sandbox bearer token held outside the supervisor process environment.
 * @throws Error when the descriptor is missing, invalid, unreadable, or empty.
 */
function readWorkerControlTokenFromFileDescriptor(environment: NodeJS.ProcessEnv): string {
  const rawDescriptor = environment.OPENKIT_CONTROL_TOKEN_FD;

  if (!rawDescriptor || !/^\d+$/.test(rawDescriptor)) {
    throw new Error('Worker control token descriptor is unavailable.');
  }
  const descriptor = Number.parseInt(rawDescriptor, 10);

  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    throw new Error('Worker control token descriptor is unavailable.');
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (totalBytes <= WORKER_CONTROL_TOKEN_MAX_BYTES) {
      const buffer = Buffer.allocUnsafe(
        Math.min(1024, WORKER_CONTROL_TOKEN_MAX_BYTES + 1 - totalBytes)
      );
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);

      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
  } catch {
    throw new Error('Worker control token descriptor is unavailable.');
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The stable read error above owns missing or already-closed descriptors.
    }
  }

  if (totalBytes > WORKER_CONTROL_TOKEN_MAX_BYTES) {
    throw new Error('Worker control token descriptor exceeds the maximum size.');
  }
  const encoded = Buffer.concat(chunks, totalBytes).toString('utf8');
  const token = encoded.endsWith('\n') ? encoded.slice(0, -1) : encoded;

  if (!token || token.includes('\n') || token.includes('\r')) {
    throw new Error('Worker control token descriptor is invalid.');
  }

  return token;
}

/**
 * Requires the out-of-environment worker-control token before network activity.
 *
 * @param token Token captured from the launcher descriptor.
 * @returns Non-empty sandbox bearer token.
 * @throws Error when the supervisor was not given a token.
 */
function requireWorkerControlToken(token: string | undefined): string {
  if (!token?.trim()) {
    throw new Error('Missing worker control token.');
  }

  return token;
}

/**
 * Reads a required environment variable.
 *
 * @param environment Control environment.
 * @param key Environment variable key.
 * @returns Environment variable value.
 * @throws Error when the value is missing.
 */
function requireEnvironmentValue(
  environment: CodexShimEnvironment,
  key: keyof CodexShimEnvironment
): string {
  const value = environment[key];

  if (!value) {
    throw new Error(`Missing required ${key} environment variable.`);
  }

  return value;
}
