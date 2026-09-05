import { spawn } from 'node:child_process';
import { closeSync, readSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerCanonicalTerminalEventDataSchema } from '@openkit/worker-protocol';
import {
  WORKER_ADAPTERS,
  type WorkerAdapterLaunchPlan,
  type WorkerAdapterLlmRoute,
  type WorkerNativeProcessResult,
} from './adapter-registry.js';
import {
  WorkerControlClient,
  type WorkerControlCommandPoll,
  type WorkerControlFetch,
} from './control-client.js';
import { openSandboxIntegration, type SandboxIntegrationClient } from './integration-client.js';
import {
  type WorkerLineage,
  type WorkerTerminalOutcomeInput,
  WorkerTranscriptWriter,
} from './transcript.js';
import {
  materializeWorkspaceGitInputs,
  publishWorkspaceGitSnapshots,
  type WorkspaceGitInput,
} from './workspace-git.js';

const WORKER_CONTROL_READINESS_TIMEOUT_MS = 10_000;
const WORKER_CONTROL_TOKEN_MAX_BYTES = 4096;
const NATIVE_STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const WORKER_MCP_CAPABILITY_ROUTES = [
  'mcp.list_servers',
  'mcp.list_tools',
  'mcp.call_tool',
] as const;
/** Exact parent-cancellation reason used only for an MCP Approval Gate stop. */
export const WORKER_HUMAN_GATE_STOP = Symbol('openkit.worker.human-gate-stop');
const SAFE_WORKER_CHILD_ENVIRONMENT_KEYS = [
  'ALL_PROXY',
  'COLORTERM',
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
 * Parsed `openkit-worker-shim` arguments.
 */
export interface WorkerShimArgs {
  /** Worker-visible Agent Environment Package path. */
  packagePath: string;
  /** Durable session transcript directory. */
  sessionDir: string;
  /** Whether to validate arguments and exit without launching a native runtime. */
  dryRun: boolean;
}

/**
 * Environment variables consumed by `openkit-worker-shim`.
 */
export interface WorkerShimEnvironment {
  /** Optional all-protocol proxy URL inherited by child processes. */
  ALL_PROXY?: string | undefined;
  /** Optional HTTP proxy URL inherited by child processes. */
  HTTP_PROXY?: string | undefined;
  /** Optional HTTPS proxy URL inherited by child processes. */
  HTTPS_PROXY?: string | undefined;
  /** Optional uppercase proxy bypass list inherited by child processes. */
  NO_PROXY?: string | undefined;
  /** Enables environment-proxy support for Node child processes. */
  NODE_USE_ENV_PROXY?: string | undefined;
  /** Internal launcher descriptor containing the sandbox bearer token. */
  OPENKIT_CONTROL_TOKEN_FD?: string | undefined;
  /** Retired Codex command override rejected before native launch. */
  OPENKIT_CODEX_COMMAND?: string | undefined;
  /** Workspace id bound to the worker session. */
  OPENKIT_WORKSPACE_ID?: string | undefined;
  /** Thread id bound to the worker session. */
  OPENKIT_THREAD_ID?: string | undefined;
  /** Turn id bound to the worker session. */
  OPENKIT_TURN_ID?: string | undefined;
  /** AgentSession id bound to the sandbox. */
  OPENKIT_AGENT_SESSION_ID?: string | undefined;
  /** Agent Environment Package snapshot id. */
  OPENKIT_PACKAGE_SNAPSHOT_ID?: string | undefined;
  /** Optional request id that started the worker turn. */
  OPENKIT_REQUEST_ID?: string | undefined;
  /** OpenShell placeholder resolved only when a relay adapter calls trusted worker inference. */
  OPENKIT_WORKER_INFERENCE_TOKEN?: string | undefined;
  /** Turn-scoped bearer token for the worker-local MCP capability route. */
  OPENKIT_WORKER_CAPABILITY_TOKEN?: string | undefined;
  /** Optional lowercase HTTP proxy URL inherited by child processes. */
  http_proxy?: string | undefined;
  /** Optional lowercase HTTPS proxy URL inherited by child processes. */
  https_proxy?: string | undefined;
  /** Optional lowercase proxy bypass list inherited by child processes. */
  no_proxy?: string | undefined;
}

/**
 * Input passed to the supervised native process runner.
 */
export interface WorkerProcessRunInput {
  /** Command and arguments to execute. */
  argv: string[];
  /** Worker cwd for the native process. */
  cwd: string;
  /** Environment variables visible to the native process. */
  env: Record<string, string>;
  /** Supervisor cancellation signal for the native process. */
  signal: AbortSignal;
  /** Reports that the native child process has started successfully. */
  onStart?: (() => void) | undefined;
  /** Optional backpressured sink for exact native stdout bytes. */
  writeStdout?: ((chunk: Uint8Array) => Promise<void>) | undefined;
}

/**
 * Result returned by a supervised native process runner.
 */
export interface WorkerProcessRunResult {
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
 * Process runner used by the worker shim.
 */
export interface WorkerProcessRunner {
  /**
   * Runs one native process.
   *
   * @param input Command, cwd, and environment.
   * @returns Completed process result.
   */
  run(input: WorkerProcessRunInput): Promise<WorkerProcessRunResult>;
}

/**
 * Options for running the worker shim entrypoint.
 */
export interface WorkerShimRunOptions {
  /** Parsed worker shim arguments. */
  args: WorkerShimArgs;
  /** Sandbox bearer token supplied outside the supervisor process environment. */
  controlToken?: string | undefined;
  /** Sandbox environment variables visible to the shim. */
  environment?: WorkerShimEnvironment | undefined;
  /** Optional process runner for tests or alternate supervisors. */
  runner?: WorkerProcessRunner | undefined;
  /** Optional fetch implementation for the supervised control. */
  fetch?: WorkerControlFetch | undefined;
  /** Optional parent cancellation signal. */
  signal?: AbortSignal | undefined;
  /** Existing Harness-lifetime Integration client. */
  integration?: SandboxIntegrationClient | undefined;
  /** AgentSession-private native state root retained across sequential Turns. */
  sessionStateRoot?: string | undefined;
  /** Adapter already fixed by the owning Harness instance. */
  expectedAdapterId?: string | undefined;
  /** Turn-private native output directory removed after collection. */
  nativeTurnDirectory?: string | undefined;
  /** Notification after the native child is supervised and Turn routes are bound. */
  onNativeStart?: (() => void) | undefined;
  /** Notification after child absence, collection, publication, and route revocation. */
  onTurnBarrier?: (() => void) | undefined;
}

/**
 * Result returned by the worker shim after the supervised process exits.
 */
export interface WorkerShimRunResult {
  /** Process exit code, or null when the process ended by signal. */
  exitCode: number | null;
  /** Process signal, or null when the process exited normally. */
  signal: NodeJS.Signals | null;
  /** Normalized worker terminal status. */
  status: 'blocked' | 'completed' | 'failed' | 'interrupted';
}

/** Direct worker-control command accepted by the worker supervisor. */
type DirectWorkerControlCommand = {
  /** NanoCore-issued command id. */
  commandId: string;
  /** Interrupt command discriminator. */
  kind: 'interrupt';
  /** Optional product-safe interrupt reason. */
  reason?: string | null;
};

/** Minimal immutable AEP projection consumed by the worker shim. */
interface WorkerShimPackageManifest {
  /** Package-owned lineage fields consumed by the worker supervisor. */
  scope?: {
    /** Request that owns this worker Turn, when present. */
    requestId?: unknown;
  };
  /** Sandbox Integration bindings and selected adapter declaration. */
  control?: {
    /** Static worker-side adapter selector. */
    adapter?: {
      /** Generic shim discriminator. */
      kind?: unknown;
      /** Opaque static registry key. */
      targetRuntime?: unknown;
    };
    /** Fixed sandbox-local Integration route bindings. */
    bindings?: unknown;
    /** Required Sandbox Integration control mode. */
    mode?: unknown;
    /** Durable transcript and optional provenance declaration. */
    transcript?: {
      /** Optional fixed native provenance outputs. */
      runtimeProvenance?: unknown;
    };
  };
  /** Resolved environment credential declarations. */
  credentials?: {
    /** Backend-materialized credential targets. */
    declarations?: unknown;
  };
  /** Private OpenKit extension payload. */
  extensions?: {
    /** Turn input plus explicitly retired native overrides. */
    openkit?: {
      /** Retired native command override. */
      codexCommand?: unknown;
      /** Retired native final-message override. */
      resultMessagePath?: unknown;
      /** Private per-turn worker input. */
      turnInput?: unknown;
    };
  };
  /** Resolved worker inference declaration. */
  llm?: {
    /** Exactly one already resolved route. */
    routes?: unknown;
  };
  /** Generic shim process declaration. */
  runtime?: {
    /** Fixed generic shim command and worker cwd. */
    command?: {
      /** Exact generic shim argv. */
      argv?: unknown;
      /** Worker-visible native cwd. */
      workingDirectory?: unknown;
    };
  };
  /** Static inert supply declarations. */
  supply?: {
    /** Catalog-resolved MCP server declarations. */
    mcpServers?: unknown;
    /** Skill metadata supplied by NanoCore. */
    skills?: unknown;
  };
  /** Worker-local capability route declaration. */
  capabilities?: {
    /** Whether the worker capability route is callable. */
    mode?: unknown;
    /** Fixed worker capability protocol. */
    protocol?: unknown;
    /** Exact enabled operation set. */
    routes?: unknown;
  };
  /** Worker-visible workspace declarations. */
  workspace?: {
    /** Materialized worker inputs. */
    inputs?: unknown;
    /** Declared worker workspace root. */
    root?: unknown;
  };
}

/** Fixed runtime provenance output declaration projected into an AEP. */
interface RuntimeProvenanceDeclaration {
  /** Maximum native streams retained. */
  maxStreamCount: number;
  /** Maximum aggregate native bytes retained. */
  maxTotalBytes: number;
  /** Fixed native-origin index path. */
  nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl';
  /** Fixed raw-stream output root. */
  rawStreamsRoot: '/openkit/session/runtime/raw';
  /** Fixed raw-stream manifest path. */
  streamManifestPath: '/openkit/session/runtime/raw-streams.json';
}

/** Worker-local materialization metadata for static Skill supply. */
interface RuntimeSupplyMaterialization {
  /** Runtime-neutral materialization kind. */
  kind: string;
  /** Worker-local metadata directory. */
  targetPath: string;
}

/** Static Skill supply record materialized as inert metadata. */
interface RuntimeSkillSupply {
  /** Stable catalog id. */
  id: string;
  /** Optional pinned catalog version. */
  version?: string;
  /** Optional catalog source reference. */
  sourceRef?: string;
  /** Optional integrity declaration. */
  integrity?: unknown;
  /** Runtime-neutral materialization hint. */
  materialization: RuntimeSupplyMaterialization;
  /** Optional compatible adapter ids. */
  allowedRuntimeAdapters?: unknown;
  /** Optional compatible workspace scopes. */
  allowedWorkspaceScopes?: unknown;
  /** Optional policy references. */
  policyRefIds?: unknown;
  /** Optional review state. */
  reviewStatus?: string;
  /** Optional secret references, never values. */
  secretRefIds?: unknown;
}

/**
 * Parses `openkit-worker-shim` arguments.
 *
 * @param argv Argument vector after the binary name.
 * @returns Parsed arguments.
 */
export function parseWorkerShimArgs(argv: string[]): WorkerShimArgs {
  const values = parseFlagValues(argv, new Set(['--dry-run']));
  const allowedFlags = new Set(['--dry-run', '--package', '--session-dir']);
  for (const flag of values.keys()) {
    if (!allowedFlags.has(flag)) {
      throw new Error(`Unsupported worker shim argument: ${flag}`);
    }
  }
  const packagePath = values.get('--package')?.at(0);

  if (!packagePath) {
    throw new Error('Missing required --package argument.');
  }

  return {
    dryRun: values.has('--dry-run'),
    packagePath,
    sessionDir: values.get('--session-dir')?.at(0) ?? '/openkit/session',
  };
}

/**
 * Runs the worker shim CLI entrypoint.
 *
 * @param argv Argument vector after the binary name.
 * @param write Output sink for command help.
 * @returns Promise that resolves when the command finishes.
 */
export async function runWorkerShimCli(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(line)
): Promise<void> {
  if (argv.includes('--help')) {
    write('Usage: openkit-worker-shim --package <path> [--session-dir <path>] [--dry-run]\n');
    return;
  }

  const args = parseWorkerShimArgs(argv);

  if (!args.dryRun && process.env.OPENKIT_CONTROL_TOKEN) {
    throw new Error('Worker control token must be supplied through launcher descriptor 3.');
  }
  const controlToken = args.dryRun
    ? undefined
    : readWorkerControlTokenFromFileDescriptor(process.env);
  const environment: WorkerShimEnvironment = { ...process.env };
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
  let result: WorkerShimRunResult;

  try {
    result = await runWorkerShim({
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

  if (result.status === 'interrupted' && receivedSignal === 'SIGINT') {
    process.exitCode = 130;
  } else if (result.status === 'interrupted' && receivedSignal === 'SIGTERM') {
    process.exitCode = 143;
  } else if (result.status !== 'completed') {
    process.exitCode = result.exitCode ?? 1;
  }
}

/**
 * Runs the worker shim supervisor.
 *
 * @param options Parsed args, environment, and optional runner.
 * @returns Supervised process outcome.
 */
export async function runWorkerShim(options: WorkerShimRunOptions): Promise<WorkerShimRunResult> {
  const environment = options.environment ?? process.env;
  const packageManifest = await readWorkerShimPackage(options.args.packagePath);

  if (packageManifest.control?.mode !== 'sandbox-integration') {
    throw new Error('Worker shim requires control.mode to be sandbox-integration.');
  }
  validateSandboxIntegrationBindings(packageManifest.control.bindings);
  rejectRetiredWorkerOverrides(packageManifest, environment);
  validateWorkerShimCommand(packageManifest);
  const adapterId = resolveWorkerAdapterId(packageManifest);
  if (options.expectedAdapterId && adapterId !== options.expectedAdapterId) {
    throw new Error('Worker package adapter does not match its owning Harness.');
  }
  const adapter = WORKER_ADAPTERS[adapterId];
  if (!adapter) {
    throw new Error(`Unknown worker adapter: ${adapterId}`);
  }
  const llmRoute = resolveWorkerLlmRoute(packageManifest);
  const mcpServerIds = resolveWorkerMcpServerIds(packageManifest);
  const turnInput = resolveWorkerTurnInput(packageManifest);
  const cwd = resolveWorkerWorkingDirectory(packageManifest);
  const workspaceInputs = resolveWorkspaceInputs(packageManifest);

  if (options.args.dryRun) {
    const stateRoot = join(options.args.sessionDir, 'native-state');
    await rm(stateRoot, { force: true, recursive: true });
    try {
      await (adapter.mode === 'bounded-turn' ? adapter.prepare : adapter.prepareTurn)({
        childEnvironment: workerChildEnvironment(packageManifest, environment, llmRoute),
        llmRoute,
        mcpServerIds,
        sessionDirectory: options.args.sessionDir,
        stateRoot,
        turnInput,
        workingDirectory: cwd,
      });
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
    }
    return {
      exitCode: 0,
      signal: null,
      status: 'completed',
    };
  }

  await mkdir(options.args.sessionDir, { recursive: true });
  await writeFile(join(options.args.sessionDir, 'events.jsonl'), '', 'utf8');
  await writeFile(join(options.args.sessionDir, 'items.jsonl'), '', 'utf8');
  await writeFile(join(options.args.sessionDir, 'artifacts.jsonl'), '', 'utf8');
  await materializeRuntimeSupply(packageManifest);
  const workspaceRoot = packageManifest.workspace?.root;
  if (
    workspaceInputs.length > 0 &&
    (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0)
  ) {
    throw new Error('Git workspace materialization requires workspace.root.');
  }
  const workspaceBases = await materializeWorkspaceGitInputs(
    workspaceInputs,
    typeof workspaceRoot === 'string' ? workspaceRoot : cwd,
    options.args.sessionDir
  );
  const lineage = workerLineageFromEnvironment(environment, packageManifest.scope?.requestId);
  const provenanceDeclaration = parseRuntimeProvenanceDeclaration(
    packageManifest.control?.transcript?.runtimeProvenance
  );
  const childEnvironment = workerChildEnvironment(packageManifest, environment, llmRoute);
  const credentialValues = workerCredentialValues(packageManifest, childEnvironment, llmRoute);
  const stateRoot = options.sessionStateRoot ?? join(options.args.sessionDir, 'native-state');
  if (!options.sessionStateRoot) {
    await rm(stateRoot, { force: true, recursive: true });
  }
  let launchPlan: WorkerAdapterLaunchPlan;
  try {
    launchPlan = await (adapter.mode === 'bounded-turn' ? adapter.prepare : adapter.prepareTurn)({
      childEnvironment,
      llmRoute,
      mcpServerIds,
      ...(provenanceDeclaration
        ? { runtimeProvenance: { ...provenanceDeclaration, lineage } }
        : {}),
      sessionDirectory: options.args.sessionDir,
      ...(options.nativeTurnDirectory ? { nativeTurnDirectory: options.nativeTurnDirectory } : {}),
      stateRoot,
      turnInput,
      workingDirectory: cwd,
    });
  } catch (error) {
    if (!options.sessionStateRoot) {
      await rm(stateRoot, { force: true, recursive: true });
    }
    throw error;
  }
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
  let terminalOutcomeAttempted = false;
  let workerControlReady = false;
  const controlAbortController = new AbortController();
  const workerAbortController = new AbortController();
  let interrupted = false;
  let acceptsWorkerCommands = true;
  let integration = options.integration ?? null;
  const ownsIntegration = !options.integration;
  /** Cancels the control and native child under the shared supervisor lifecycle. */
  const abortChildren = (reason?: unknown) => {
    controlSession?.disablePostLaunchRecovery();
    controlAbortController.abort(reason);
    workerAbortController.abort(reason);
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
    let workerControlFetch = options.fetch;
    const inferenceToken = environment.OPENKIT_WORKER_INFERENCE_TOKEN?.trim();
    if (!workerControlFetch || inferenceToken) {
      integration ??= await openSandboxIntegration({
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await integration.ready;
      integration.bindTurnRouteTokens({
        ...(mcpServerIds.length > 0
          ? {
              capabilityToken: requireEnvironmentValue(
                environment,
                'OPENKIT_WORKER_CAPABILITY_TOKEN'
              ),
            }
          : {}),
        controlToken,
        inferenceToken:
          inferenceToken ?? requireEnvironmentValue(environment, 'OPENKIT_WORKER_INFERENCE_TOKEN'),
      });
      workerControlFetch ??= integration.workerControlFetch;
    }
    const session = new WorkerControlClient({
      fetch: workerControlFetch,
      lineage,
      token: controlToken,
      baseUrl: '/worker-control',
    });
    controlSession = session;
    const seenCommandIds = new Set<string>();
    /** Records a delivered interrupt and cancels both supervised child paths. */
    const interruptWorker = () => {
      interrupted = true;
      workerAbortController.abort();
    };

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
      const humanGateStop = options.signal?.reason === WORKER_HUMAN_GATE_STOP;
      terminalOutcomeAttempted = true;
      await writeAndReportTerminalOutcome(writer, workerControlReady ? session : null, {
        status: humanGateStop ? 'blocked' : 'interrupted',
        stopReason: humanGateStop ? 'ask_user' : 'aborted',
      });
      return {
        exitCode: null,
        signal: 'SIGTERM',
        status: humanGateStop ? 'blocked' : 'interrupted',
      };
    }

    let result: WorkerProcessRunResult;
    let processPromise: Promise<WorkerProcessRunResult> | null = null;
    let controlPromise: Promise<void> | null = null;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    /** Retains exact adapter stdout under the shared 16 MiB bound and forwards adapter-local sinks. */
    const writeStdout = async (chunk: Uint8Array) => {
      if (launchPlan.captureStdout) {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > NATIVE_STDOUT_MAX_BYTES) {
          throw new Error(`Native stdout exceeds ${NATIVE_STDOUT_MAX_BYTES} bytes.`);
        }
        stdoutChunks.push(Buffer.from(chunk));
      }
      await launchPlan.writeStdout?.(chunk);
    };

    try {
      let processStarted = false;
      let acknowledgeProcessStart: (() => void) | undefined;
      const processStart = new Promise<void>((resolve) => {
        acknowledgeProcessStart = () => {
          if (!processStarted) {
            processStarted = true;
            resolve();
          }
        };
      });
      processPromise = (options.runner ?? new ChildProcessWorkerProcessRunner()).run({
        argv: launchPlan.argv,
        cwd,
        env: launchPlan.environment,
        onStart: () => acknowledgeProcessStart?.(),
        signal: workerAbortController.signal,
        ...(launchPlan.captureStdout || launchPlan.writeStdout ? { writeStdout } : {}),
      });
      await Promise.race([
        processStart,
        processPromise.then(
          () => acknowledgeProcessStart?.(),
          (error: unknown) => Promise.reject(error)
        ),
      ]);
      options.onNativeStart?.();
      session.enablePostLaunchRecovery();
      await writer.writeAndAppendEvent({
        data: {
          adapter: adapterId,
          status: 'process.started',
        },
        type: 'worker.ready',
      });
      controlPromise = runWorkerControlLoop(
        session,
        writer,
        controlAbortController.signal,
        seenCommandIds,
        () => acceptsWorkerCommands,
        interruptWorker
      );

      result = await superviseWorkerProcess(processPromise, controlPromise, {
        workerAbortController,
        isInterrupted: () => interrupted || Boolean(options.signal?.aborted),
        controlAbortController,
      });
    } catch (error) {
      abortChildren(error);
      await processPromise?.catch(() => undefined);
      await controlPromise?.catch(() => undefined);
      await launchPlan.invalidate?.();
      throw error;
    }

    await writer.writeAndAppendEvent({
      data: {
        adapter: adapterId,
        exitCode: result.exitCode,
        signal: result.signal,
        status: 'process.exited',
      },
      type: 'worker.heartbeat',
    });
    const returnedStdout = Buffer.from(result.stdout, 'utf8');
    const stdout =
      stdoutChunks.length > 0 ? Buffer.concat(stdoutChunks, stdoutBytes) : returnedStdout;
    if (launchPlan.captureStdout && stdout.byteLength > NATIVE_STDOUT_MAX_BYTES) {
      await launchPlan.invalidate?.();
      throw new Error(`Native stdout exceeds ${NATIVE_STDOUT_MAX_BYTES} bytes.`);
    }
    const nativeResult: WorkerNativeProcessResult = {
      exitCode: result.exitCode,
      interrupted: interrupted || Boolean(options.signal?.aborted),
      signal: result.signal,
      stderr: result.stderr,
      stdout: launchPlan.captureStdout ? stdout : new Uint8Array(),
    };
    const adapterResult =
      adapter.mode === 'bounded-turn'
        ? await adapter.collect({ launchPlan, processResult: nativeResult })
        : await adapter.collectTurn({
            launchPlan,
            processResult: nativeResult,
            stateRoot,
          });
    await launchPlan.finalize?.();
    if (!options.sessionStateRoot) {
      await rm(stateRoot, { force: true, recursive: true });
    }
    await publishWorkspaceGitSnapshots({
      bases: workspaceBases,
      credentialValues,
      inputs: workspaceInputs,
      lineage,
      sessionDir: options.args.sessionDir,
    });
    acceptsWorkerCommands = false;
    controlAbortController.abort();
    await controlPromise;
    options.onTurnBarrier?.();
    options.signal?.removeEventListener('abort', abortForParent);
    const assistantOutputRejected = containsExactCredentialValue(
      adapterResult.assistantText,
      credentialValues
    );
    const humanGateStop = options.signal?.reason === WORKER_HUMAN_GATE_STOP;
    const status =
      interrupted || options.signal?.aborted
        ? humanGateStop
          ? 'blocked'
          : 'interrupted'
        : assistantOutputRejected
          ? 'failed'
          : adapterResult.status;

    if (
      adapterResult.assistantText &&
      status !== 'blocked' &&
      status !== 'interrupted' &&
      !assistantOutputRejected
    ) {
      await writer.writeAssistantMessage({
        status,
        text: adapterResult.assistantText,
      });
    }
    const adapterDiagnostics = sanitizeAdapterDiagnostics(
      adapterResult.diagnostics,
      credentialValues
    );

    const terminalInput: WorkerTerminalOutcomeInput = {
      ...(status === 'failed' && !launchPlan.suppressFailureDiagnostics
        ? {
            diagnostics: {
              ...workerFailureDiagnostics(result, credentialValues),
              ...adapterDiagnostics,
            },
          }
        : {}),
      status,
      stopReason:
        status === 'completed'
          ? 'completed'
          : status === 'blocked'
            ? 'ask_user'
            : status === 'interrupted'
              ? 'aborted'
              : 'error',
    };
    terminalOutcomeAttempted = true;
    const terminalRecord = await writer.writeTerminalOutcome(terminalInput);
    const terminalData = WorkerCanonicalTerminalEventDataSchema.parse(terminalRecord.event.data);
    const terminalControlController = new AbortController();
    const terminalHeartbeatPromise = runWorkerTerminalHeartbeatLoop(
      session,
      terminalControlController.signal
    );
    const finalStatusPromise = session.recordFinalStatus(
      {
        ...terminalData,
        sequence: terminalRecord.sequence,
      },
      terminalControlController.signal
    );
    try {
      await Promise.race([finalStatusPromise, terminalHeartbeatPromise]);
    } finally {
      terminalControlController.abort();
      await Promise.allSettled([finalStatusPromise, terminalHeartbeatPromise]);
    }

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
        stopReason: 'error',
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortForParent);
    abortChildren();
    integration?.clearTurnRouteTokens();
    if (ownsIntegration) {
      await integration?.close().catch(() => undefined);
    }
    if (!options.sessionStateRoot) {
      await rm(stateRoot, { force: true, recursive: true }).catch(() => undefined);
    }
    if (options.nativeTurnDirectory) {
      await rm(options.nativeTurnDirectory, { force: true, recursive: true }).catch(
        () => undefined
      );
    }
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
 * Keeps the native process and live control under one fail-closed lifecycle.
 *
 * @param processPromise Running native process outcome.
 * @param controlPromise Running periodic control.
 * @param supervision Abort controllers and optional parent signal.
 * @returns Completed native process result.
 * @throws The first process or control failure after the sibling has stopped.
 */
async function superviseWorkerProcess(
  processPromise: Promise<WorkerProcessRunResult>,
  controlPromise: Promise<void>,
  supervision: {
    /** Controller that terminates the native child. */
    workerAbortController: AbortController;
    /** Returns whether an external or worker interrupt owns cancellation. */
    isInterrupted: () => boolean;
    /** Controller that terminates control polling and in-flight requests. */
    controlAbortController: AbortController;
  }
): Promise<WorkerProcessRunResult> {
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
      return interruptedWorkerProcessResult();
    }
    throw first.error;
  }

  supervision.workerAbortController.abort();
  supervision.controlAbortController.abort();
  const processOutcome = await processPromise.then(
    (result) => ({ kind: 'process-complete' as const, result }),
    (error: unknown) => ({ error, kind: 'process-failed' as const })
  );
  await controlPromise.catch(() => undefined);

  if (interruptedAtWinner) {
    return processOutcome.kind === 'process-complete'
      ? processOutcome.result
      : interruptedWorkerProcessResult();
  }
  if (first.kind === 'control-failed') {
    throw first.error;
  }
  throw new Error('Worker control stopped before the native process completed.');
}

/**
 * Creates the normalized process result used after supervisor cancellation.
 *
 * @returns Signal-terminated native process result without child diagnostics.
 */
function interruptedWorkerProcessResult(): WorkerProcessRunResult {
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
 * Child-process-backed worker process runner.
 */
class ChildProcessWorkerProcessRunner implements WorkerProcessRunner {
  /**
   * Runs one child process and retains only bounded diagnostic output prefixes.
   *
   * @param input Command, cwd, and environment.
   * @returns Completed process result.
   * @throws When spawning, reading output, or the stdout sink fails.
   */
  public async run(input: WorkerProcessRunInput): Promise<WorkerProcessRunResult> {
    const [command, ...args] = input.argv;

    if (!command) {
      throw new Error('Worker shim requires a non-empty native command.');
    }

    return runChildProcessGroup({
      args,
      command,
      cwd: input.cwd,
      env: input.env,
      ...(input.onStart ? { onStart: input.onStart } : {}),
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
  /** Optional callback fired only after successful native spawn. */
  onStart?: (() => void) | undefined;
  /** Optional backpressured sink for exact stdout bytes. */
  writeStdout?: ((chunk: Uint8Array) => Promise<void>) | undefined;
}): Promise<WorkerProcessRunResult> {
  input.signal.throwIfAborted();
  const child = spawn(input.command, input.args, {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    detached: true,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('spawn', () => input.onStart?.());
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
    if (!(await waitForProcessGroupExit(groupId, 1000))) {
      throw new Error('Worker process group remained addressable after SIGKILL.');
    }
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
async function readWorkerShimPackage(packagePath: string): Promise<WorkerShimPackageManifest> {
  return JSON.parse(await readFile(packagePath, 'utf8')) as WorkerShimPackageManifest;
}

/**
 * Validates the three fixed local Integration route families and distinct token references.
 *
 * @param value Untrusted AEP control bindings.
 * @throws When any route or token reference differs from the closed local contract.
 */
function validateSandboxIntegrationBindings(value: unknown): void {
  const expected = {
    capabilities: '/capabilities/',
    inference: '/inference/',
    workerControl: '/worker-control/',
  } as const;

  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw new Error('Worker shim requires the three Sandbox Integration bindings.');
  }
  const declaredTokenRefs = Object.keys(expected).map((family) => {
    const binding = value[family];
    return isRecord(binding) && typeof binding.tokenRef === 'string' ? binding.tokenRef : null;
  });
  if (new Set(declaredTokenRefs).size !== 3) {
    throw new Error('Worker shim requires distinct Integration token references.');
  }
  const tokenRefs = new Set<string>();
  for (const [family, pathPrefix] of Object.entries(expected)) {
    const binding = value[family];
    if (
      !isRecord(binding) ||
      binding.pathPrefix !== pathPrefix ||
      typeof binding.tokenRef !== 'string' ||
      !binding.tokenRef.startsWith('runtime://openkit/') ||
      Object.keys(binding).length !== 2
    ) {
      throw new Error(`Worker shim requires the fixed ${family} Integration binding.`);
    }
    tokenRefs.add(binding.tokenRef);
  }
  if (tokenRefs.size !== 3) {
    throw new Error('Worker shim requires distinct Integration token references.');
  }
}

/**
 * Resolves the exact catalog-selected MCP server ids exposed to the native adapter.
 *
 * @param packageManifest Worker-visible AEP.
 * @returns Stable MCP server ids, or an empty list when capability access is disabled.
 * @throws When an enabled capability declaration or server id is malformed.
 */
function resolveWorkerMcpServerIds(packageManifest: WorkerShimPackageManifest): string[] {
  const capabilities = packageManifest.capabilities;
  if (!capabilities || capabilities.mode === 'disabled') {
    if (capabilities?.routes !== undefined && JSON.stringify(capabilities.routes) !== '[]') {
      throw new Error('Disabled worker capabilities cannot declare routes.');
    }
    return [];
  }
  if (
    capabilities.mode !== 'enabled' ||
    capabilities.protocol !== 'openkit-worker-capability-v1' ||
    !Array.isArray(capabilities.routes) ||
    capabilities.routes.length !== WORKER_MCP_CAPABILITY_ROUTES.length ||
    capabilities.routes.some((route, index) => route !== WORKER_MCP_CAPABILITY_ROUTES[index])
  ) {
    throw new Error('Worker shim requires the exact enabled MCP capability routes.');
  }
  const servers = packageManifest.supply?.mcpServers;
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new Error('Enabled worker MCP capabilities require selected server supply.');
  }
  const ids = servers.map((server) =>
    isRecord(server) && typeof server.id === 'string' ? server.id : ''
  );
  if (ids.some((id) => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id))) {
    throw new Error('Worker MCP server supply contains an invalid id.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('Worker MCP server supply contains duplicate ids.');
  }
  return ids;
}

/**
 * Validates the fixed runtime provenance declaration before process launch or file creation.
 *
 * @param value Untrusted package manifest value.
 * @returns Valid declaration, or null when runtime provenance is not requested.
 * @throws When a present declaration differs from the canonical AEP projection.
 */
function parseRuntimeProvenanceDeclaration(value: unknown): RuntimeProvenanceDeclaration | null {
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

  return value as unknown as RuntimeProvenanceDeclaration;
}

/**
 * Materializes catalog-resolved runtime supply from one AEP snapshot.
 *
 * @param packageManifest Parsed worker package manifest.
 */
async function materializeRuntimeSupply(packageManifest: WorkerShimPackageManifest): Promise<void> {
  for (const skill of resolveSkillSupply(packageManifest.supply?.skills)) {
    await materializeSkillSupply(skill);
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
 * Rejects every retired native command or final-message override before adapter preparation.
 *
 * @param packageManifest Worker-visible AEP.
 * @param environment Sandbox environment.
 * @throws Error when a retired override is present.
 */
function rejectRetiredWorkerOverrides(
  packageManifest: WorkerShimPackageManifest,
  environment: WorkerShimEnvironment
): void {
  if (
    environment.OPENKIT_CODEX_COMMAND !== undefined ||
    packageManifest.extensions?.openkit?.codexCommand !== undefined
  ) {
    throw new Error('Retired worker command override is not supported.');
  }
  if (packageManifest.extensions?.openkit?.resultMessagePath !== undefined) {
    throw new Error('Retired worker result-message override is not supported.');
  }
}

/**
 * Validates the fixed generic shim command carried by the AEP.
 *
 * @param packageManifest Worker-visible AEP.
 * @throws Error when the command is missing or runtime-native.
 */
function validateWorkerShimCommand(packageManifest: WorkerShimPackageManifest): void {
  const argv = packageManifest.runtime?.command?.argv;

  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== 'openkit-worker-shim') {
    throw new Error('Worker shim requires the fixed AEP runtime.command.argv.');
  }
}

/**
 * Resolves the sole opaque adapter selector from the AEP.
 *
 * @param packageManifest Worker-visible AEP.
 * @returns Static registry key.
 * @throws Error when the selector is missing or uses another shim kind.
 */
function resolveWorkerAdapterId(packageManifest: WorkerShimPackageManifest): string {
  const adapter = packageManifest.control?.adapter;

  if (adapter?.kind !== 'openkit-worker-shim' || typeof adapter.targetRuntime !== 'string') {
    throw new Error('Worker shim requires one AEP control.adapter.targetRuntime selector.');
  }

  return adapter.targetRuntime;
}

/**
 * Resolves the package's single already selected LLM route.
 *
 * @param packageManifest Worker-visible AEP.
 * @returns Valid runtime-neutral route.
 * @throws Error when the route count or shape is invalid.
 */
function resolveWorkerLlmRoute(packageManifest: WorkerShimPackageManifest): WorkerAdapterLlmRoute {
  const routes = packageManifest.llm?.routes;

  if (!Array.isArray(routes) || routes.length !== 1 || !isRecord(routes[0])) {
    throw new Error('Worker shim requires exactly one resolved LLM route.');
  }
  const route = routes[0];
  const endpoint = route.endpoint;
  if (
    typeof route.id !== 'string' ||
    typeof route.model !== 'string' ||
    typeof route.providerInstanceId !== 'string' ||
    !['none', 'placeholder', 'environment'].includes(String(route.credentialVisibility)) ||
    !isRecord(endpoint) ||
    !['openai-compatible', 'provider-compatible', 'backend-local'].includes(
      String(endpoint.kind)
    ) ||
    (endpoint.upstream !== undefined && !isRecord(endpoint.upstream))
  ) {
    throw new Error('Worker shim received an invalid resolved LLM route.');
  }
  const upstream = isRecord(endpoint.upstream) ? endpoint.upstream : undefined;
  if (
    upstream &&
    !['nanocore-gateway', 'backend-local', 'direct-provider'].includes(String(upstream.kind))
  ) {
    throw new Error('Worker shim received an invalid resolved LLM route.');
  }

  return {
    credentialVisibility:
      route.credentialVisibility as WorkerAdapterLlmRoute['credentialVisibility'],
    endpoint: {
      kind: endpoint.kind as WorkerAdapterLlmRoute['endpoint']['kind'],
      ...(typeof endpoint.workerBaseUrl === 'string'
        ? { workerBaseUrl: endpoint.workerBaseUrl }
        : {}),
      ...(upstream
        ? {
            upstream: {
              kind: upstream.kind as NonNullable<
                WorkerAdapterLlmRoute['endpoint']['upstream']
              >['kind'],
              ...(typeof upstream.baseUrlRef === 'string'
                ? { baseUrlRef: upstream.baseUrlRef }
                : {}),
            },
          }
        : {}),
    },
    id: route.id,
    model: route.model,
    providerInstanceId: route.providerInstanceId,
  };
}

/**
 * Resolves the private per-turn worker input.
 *
 * @param packageManifest Worker-visible AEP.
 * @returns Non-empty turn input.
 * @throws Error when the AEP omits its private turn input.
 */
function resolveWorkerTurnInput(packageManifest: WorkerShimPackageManifest): string {
  const turnInput = packageManifest.extensions?.openkit?.turnInput;

  if (typeof turnInput !== 'string' || turnInput.trim().length === 0) {
    throw new Error('Worker shim requires extensions.openkit.turnInput.');
  }

  return turnInput;
}

/**
 * Resolves the fixed worker-visible native cwd.
 *
 * @param packageManifest Worker-visible AEP.
 * @returns Native worker cwd.
 * @throws Error when the AEP omits its working directory.
 */
function resolveWorkerWorkingDirectory(packageManifest: WorkerShimPackageManifest): string {
  const cwd = packageManifest.runtime?.command?.workingDirectory;

  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('Worker shim requires runtime.command.workingDirectory.');
  }

  return cwd;
}

/**
 * Resolves Git-backed workspace inputs that should produce change-set manifests.
 *
 * @param packageManifest Worker-visible package manifest.
 * @returns Workspace inputs with Git materialization enabled.
 */
function resolveWorkspaceInputs(packageManifest: WorkerShimPackageManifest): WorkspaceGitInput[] {
  const inputs = packageManifest.workspace?.inputs;

  if (!Array.isArray(inputs)) {
    return [];
  }

  return inputs
    .map((input) => readWorkspaceInput(input))
    .filter((input): input is WorkspaceGitInput => input !== null);
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

  if (materialization.strategy !== 'git') {
    return null;
  }

  if (
    typeof record.id !== 'string' ||
    typeof record.target !== 'string' ||
    record.access !== 'read-write'
  ) {
    throw new Error('Git workspace input requires id, target, and read-write access.');
  }

  const source = readRemoteGitWorkspaceSource(record.source);

  return {
    access: record.access,
    id: record.id,
    materialization: {
      changeSetManifestPath: materialization.changeSetManifestPath,
      strategy: materialization.strategy,
    },
    source,
    target: record.target,
  };
}

/** Reads the one exact remote Git source shape accepted by the worker materializer. */
function readRemoteGitWorkspaceSource(value: unknown): WorkspaceGitInput['source'] {
  if (!isRecord(value)) {
    throw new Error('Git workspace input requires one resolved remote source.');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'catalogEntryDigest',
    'commit',
    'kind',
    'sensitivity',
    'sourceId',
    'sourceRef',
    'url',
  ];
  const sensitivity = value.sensitivity;
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof value.catalogEntryDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.catalogEntryDigest) ||
    typeof value.commit !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.commit) ||
    value.kind !== 'git' ||
    (sensitivity !== 'public' &&
      sensitivity !== 'internal' &&
      sensitivity !== 'confidential' &&
      sensitivity !== 'restricted') ||
    typeof value.sourceId !== 'string' ||
    value.sourceId.length === 0 ||
    typeof value.sourceRef !== 'string' ||
    value.sourceRef.length === 0 ||
    typeof value.url !== 'string'
  ) {
    throw new Error('Git workspace input source shape is invalid.');
  }

  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error('Git workspace input URL must be valid HTTPS.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Git workspace input URL must be credential-free HTTPS without query or hash.');
  }

  return {
    catalogEntryDigest: value.catalogEntryDigest,
    commit: value.commit,
    kind: 'git',
    sensitivity,
    sourceId: value.sourceId,
    sourceRef: value.sourceRef,
    url: value.url,
  };
}

/**
 * Builds the AEP-derived environment visible only to the selected native process.
 *
 * @param packageManifest Worker-visible AEP.
 * @param environment Supervisor environment candidate.
 * @param route The package's single resolved LLM route.
 * @returns Safe base environment plus only route-authorized credential bindings.
 */
function workerChildEnvironment(
  packageManifest: WorkerShimPackageManifest,
  environment: WorkerShimEnvironment,
  route: WorkerAdapterLlmRoute
): Record<string, string> {
  const source = environment as Record<string, unknown>;
  const selected: Record<string, string> = {};
  const credentialNames = workerCredentialNames(packageManifest, route);

  for (const key of [...SAFE_WORKER_CHILD_ENVIRONMENT_KEYS, ...credentialNames]) {
    const value = source[key];

    if (typeof value === 'string' && value.length > 0) {
      selected[key] = value;
    }
  }

  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    const entries = (selected[key] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!entries.includes('127.0.0.1')) {
      entries.push('127.0.0.1');
    }
    selected[key] = entries.join(',');
  }

  return selected;
}

/**
 * Resolves only the credential environment names authorized by the selected route.
 *
 * @param packageManifest Worker-visible AEP.
 * @param route The package's single resolved LLM route.
 * @returns Exact child credential environment names.
 */
function workerCredentialNames(
  packageManifest: WorkerShimPackageManifest,
  route: WorkerAdapterLlmRoute
): Set<string> {
  const names = new Set<string>();
  if (route.credentialVisibility === 'environment') {
    const runtimeNames = resolveRuntimeCredentialNames(packageManifest);
    if (runtimeNames.size !== 1) {
      throw new Error('Worker environment route requires exactly one runtime-env credential.');
    }
    for (const name of runtimeNames) names.add(name);
  } else if (route.credentialVisibility === 'placeholder') {
    names.add('OPENKIT_WORKER_INFERENCE_TOKEN');
  }
  if (resolveWorkerMcpServerIds(packageManifest).length > 0) {
    names.add('OPENKIT_WORKER_CAPABILITY_TOKEN');
  }
  return names;
}

/**
 * Reads exact credential values that must be removed from product diagnostics.
 *
 * @param packageManifest Worker-visible AEP.
 * @param childEnvironment Already allowlisted native-process environment.
 * @param route The package's single resolved LLM route.
 * @returns Non-empty exact secret values without logging them.
 */
function workerCredentialValues(
  packageManifest: WorkerShimPackageManifest,
  childEnvironment: Record<string, string>,
  route: WorkerAdapterLlmRoute
): string[] {
  return [...workerCredentialNames(packageManifest, route)]
    .map((name) => childEnvironment[name])
    .filter((value): value is string => Boolean(value));
}

/**
 * Resolves backend-materialized runtime environment credential names from the AEP.
 *
 * @param packageManifest Worker-visible AEP.
 * @returns Declared runtime environment variable names.
 */
function resolveRuntimeCredentialNames(packageManifest: WorkerShimPackageManifest): Set<string> {
  const names = new Set<string>();
  const declarations = packageManifest.credentials?.declarations;

  if (!Array.isArray(declarations)) {
    return names;
  }
  for (const declaration of declarations) {
    if (
      isRecord(declaration) &&
      declaration.visibility === 'runtime-env' &&
      typeof declaration.targetEnvVarName === 'string'
    ) {
      names.add(declaration.targetEnvVarName);
    }
  }

  return names;
}

/**
 * Builds redacted stdout and stderr summaries for failed native processes.
 *
 * @param result Native process result.
 * @param credentialValues Exact child credential values to remove.
 * @returns Product-safe diagnostics for transcript events.
 */
function workerFailureDiagnostics(
  result: WorkerProcessRunResult,
  credentialValues: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    [
      ['stderr', summarizeProcessOutput(result.stderr, credentialValues)],
      ['stdout', summarizeProcessOutput(result.stdout, credentialValues)],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

/**
 * Detects exact route credential material in one assistant candidate.
 *
 * @param output Assistant candidate, or null when the adapter produced none.
 * @param credentialValues Exact child credential values that must never be persisted.
 * @returns True when the candidate contains any exact non-empty credential value.
 */
function containsExactCredentialValue(
  output: string | null,
  credentialValues: readonly string[]
): boolean {
  return Boolean(
    output &&
      credentialValues
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
        .some((value) => value && output.includes(value))
  );
}

/**
 * Redacts and bounds every adapter-owned diagnostic before shared terminal merging.
 *
 * @param diagnostics Adapter-owned failure diagnostics.
 * @param credentialValues Exact child credential values to remove.
 * @returns Product-safe non-empty diagnostic summaries.
 */
function sanitizeAdapterDiagnostics(
  diagnostics: Readonly<Record<string, string>> | undefined,
  credentialValues: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(diagnostics ?? {})
      .map(([key, value]) => [key, summarizeProcessOutput(value, credentialValues)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );
}

/**
 * Redacts and bounds one process output stream for transcript diagnostics.
 *
 * @param output Raw process output.
 * @param credentialValues Exact child credential values to remove.
 * @returns Redacted output summary, or an empty string when no output exists.
 */
function summarizeProcessOutput(output: string, credentialValues: readonly string[]): string {
  return redactDiagnosticOutput(output, credentialValues).trim().slice(0, 1000);
}

/**
 * Removes common token-bearing fragments from process diagnostics.
 *
 * @param output Raw process output.
 * @param credentialValues Exact child credential values to remove.
 * @returns Output with exact values and common secret shapes removed.
 */
function redactDiagnosticOutput(output: string, credentialValues: readonly string[]): string {
  let redacted = output;
  const exactForms = new Set(
    credentialValues.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
  );

  for (const value of exactForms) {
    if (value) {
      redacted = redacted.split(value).join('[redacted]');
    }
  }

  return redacted
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
 * @param acceptsCommands Returns whether new commands may still affect terminal classification.
 * @param onInterrupt Optional worker interrupt callback.
 */
async function runWorkerControlLoop(
  client: WorkerControlClient,
  transcript: WorkerTranscriptWriter,
  signal: AbortSignal,
  seenCommandIds: Set<string>,
  acceptsCommands: () => boolean,
  onInterrupt?: () => void
): Promise<void> {
  while (!signal.aborted) {
    try {
      await delay(1000, undefined, { signal });
      if (signal.aborted) {
        return;
      }
      const commandPoll = await pollWorkerControl(client, transcript, 'running', signal);
      if (transcript.eventTranscriptSealed || !acceptsCommands()) {
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
 * Keeps the accepted worker lease live after terminal classification is sealed.
 *
 * @param client Session-level worker-control coordinator.
 * @param signal Terminal-report cancellation signal.
 * @returns Promise that resolves only when terminal reporting stops the loop.
 */
async function runWorkerTerminalHeartbeatLoop(
  client: WorkerControlClient,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      await delay(1000, undefined, { signal });
      if (!signal.aborted) {
        await client.recordHeartbeat(
          { message: 'Worker shim completing.', status: 'running' },
          signal
        );
      }
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
 * Builds worker lineage from AEP request authority and sandbox environment identities.
 *
 * @param environment Control environment.
 * @param packageRequestId Request lineage parsed from the Agent Environment Package.
 * @returns Worker lineage.
 */
function workerLineageFromEnvironment(
  environment: WorkerShimEnvironment,
  packageRequestId: unknown
): WorkerLineage {
  const environmentRequestId = environment.OPENKIT_REQUEST_ID;
  if (
    (packageRequestId !== undefined &&
      packageRequestId !== null &&
      (typeof packageRequestId !== 'string' || packageRequestId.length === 0)) ||
    environmentRequestId === ''
  ) {
    throw new Error('Worker request lineage is invalid.');
  }
  if (
    environmentRequestId !== undefined &&
    ((packageRequestId === null && environmentRequestId.length > 0) ||
      (typeof packageRequestId === 'string' && packageRequestId !== environmentRequestId))
  ) {
    throw new Error('Worker request lineage contradicts the Agent Environment Package.');
  }

  return {
    agentSessionId: requireEnvironmentValue(environment, 'OPENKIT_AGENT_SESSION_ID'),
    packageSnapshotId: requireEnvironmentValue(environment, 'OPENKIT_PACKAGE_SNAPSHOT_ID'),
    requestId:
      typeof packageRequestId === 'string'
        ? packageRequestId
        : packageRequestId === null
          ? null
          : (environmentRequestId ?? null),
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
  environment: WorkerShimEnvironment,
  key: keyof WorkerShimEnvironment
): string {
  const value = environment[key];

  if (!value) {
    throw new Error(`Missing required ${key} environment variable.`);
  }

  return value;
}
