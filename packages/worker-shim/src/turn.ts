import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CaptureCoverageBindingSchema,
  GitFailureExplanationSchema,
  WorkerCanonicalTerminalEventDataSchema,
  type WorkerLineage,
  type WorkerStartupFailure,
} from '@openkit/worker-protocol';
import type {
  WorkerAdapterLlmRoute,
  WorkerResidentSession,
  WorkerResidentTurn,
} from './adapter-registry.js';
import { WorkerControlClient, type WorkerControlFetch } from './control-client.js';
import type { SandboxIntegrationClient } from './integration-client.js';
import { type WorkerTerminalOutcomeInput, WorkerTranscriptWriter } from './transcript.js';
import {
  materializeWorkspaceGitInputs,
  publishWorkspaceGitSnapshots,
  type WorkspaceGitInput,
} from './workspace-git.js';

const WORKER_CONTROL_READINESS_TIMEOUT_MS = 10_000;
/**
 * Bound on one native stop: a resident Turn whose `interrupt()` neither resolves nor rejects in
 * this time is treated as a stop that could not be proved.
 */
const NATIVE_STOP_TIMEOUT_MS = 10_000;
const WORKER_MCP_CAPABILITY_ROUTES = [
  'mcp.list_servers',
  'mcp.list_tools',
  'mcp.call_tool',
] as const;

/** Safe image environment of the Harness process. */
export type WorkerShimEnvironment = Readonly<Record<string, string | undefined>>;

/** The three upstream route tokens delivered by one `turn.start`. */
export interface ResidentTurnRouteTokens {
  /** Upstream capability route token. */
  readonly capabilityToken: string;
  /** Worker-control token used only by the Harness's own control client. */
  readonly controlToken: string;
  /** Upstream inference route token. */
  readonly inferenceToken: string;
}

/** Inputs for one Turn on a resident AgentSession binding. */
export interface ResidentTurnOptions {
  /** Adapter fixed by the owning Harness. */
  readonly adapterId: string;
  /** Exact session credential values excluded from diagnostics, output, and publication. */
  readonly credentialValues: readonly string[];
  /** Harness environment, checked only for retired overrides. */
  readonly environment: WorkerShimEnvironment;
  /** Test seam replacing the Integration worker-control fetch. */
  readonly fetch?: WorkerControlFetch | undefined;
  /** Harness-lifetime Sandbox Integration client. */
  readonly integration: SandboxIntegrationClient;
  /** Lineage of the admitted `turn.start`; the request id comes from the AEP. */
  readonly lineage: Omit<WorkerLineage, 'requestId'>;
  /** Called after the resident runtime accepted the Turn and its routes are bound. */
  readonly onStarted: () => void;
  /** Receives closed pre-start failure metadata without changing the original rejection. */
  readonly onStartupFailure?: ((failure: WorkerStartupFailure) => void) | undefined;
  /** Called after the native Turn settled, the loopback drained, and output was published. */
  readonly onTurnBarrier?: (() => void) | undefined;
  /** Owner-materialized AEP path of this Turn. */
  readonly packagePath: string;
  /** Resident binding that runs the Turn on its retained conversation. */
  readonly resident: WorkerResidentSession;
  /** Names of the session-static runtime environment delivered with `session.open`. */
  readonly runtimeEnvironmentNames: ReadonlySet<string>;
  /** Fixed Turn output root exported through the file-effect slots. */
  readonly sessionDir: string;
  /** Private `turn.interrupt` cancellation for this Turn. */
  readonly signal: AbortSignal;
  /** Route tokens of this Turn. */
  readonly tokens: ResidentTurnRouteTokens;
  /** Turn-private native output directory, removed after collection. */
  readonly turnDirectory: string;
}

/**
 * Rejection of a Turn whose native work could not be proved stopped: the runtime's interrupt
 * rejected or did not settle in time. The binding must keep its capacity until wider cleanup.
 */
class NativeSettlementUnknownError extends Error {
  /** Creates the rejection, keeping the failure that required the stop as its cause. */
  public constructor(cause: unknown) {
    super('Resident native Turn settlement could not be proved.', { cause });
    this.name = 'NativeSettlementUnknownError';
  }
}

/**
 * Whether a rejected resident Turn left native work that could still be running.
 *
 * @param error Rejection of {@link runResidentTurn}.
 * @returns True when the native stop could not be proved.
 */
export function isNativeSettlementUnknown(error: unknown): boolean {
  return error instanceof NativeSettlementUnknownError;
}

/**
 * Rejection of `startTurn` when native acceptance could not be proved. The Harness must fence
 * the binding and keep the Turn occupied; a known-absent acceptance stays an ordinary failure.
 */
class NativeAcceptanceUnknownError extends Error {
  /** Creates the rejection, keeping the adapter failure as its cause. */
  public constructor(cause: unknown) {
    super('Resident native Turn acceptance could not be proved.', { cause });
    this.name = 'NativeAcceptanceUnknownError';
  }
}

/**
 * Whether a rejected resident Turn left native acceptance unproved.
 *
 * @param error Rejection of {@link runResidentTurn}.
 * @returns True when `startTurn` itself rejected.
 */
export function isNativeAcceptanceUnknown(error: unknown): boolean {
  return error instanceof NativeAcceptanceUnknownError;
}

/**
 * Requests native interruption and reports whether it was proved within the bound.
 *
 * @param turn Started resident Turn.
 * @returns True once `interrupt()` resolved, which by contract means the Turn settled.
 */
async function stopNativeTurn(turn: WorkerResidentTurn): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      turn.interrupt().then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), NATIVE_STOP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Worker-local outcome of one resident Turn. */
export interface ResidentTurnResult {
  /** Normalized worker terminal status. */
  readonly status: 'completed' | 'failed' | 'interrupted';
}

/**
 * Runs one admitted Turn on a resident binding: validates its AEP, materializes supply and
 * workspace inputs, binds the Turn's routes, proves worker-control readiness, starts the Turn on
 * the retained conversation, and after settlement drains the loopback, publishes output, and
 * reports one final status. The binding itself stays open.
 *
 * @param options Turn inputs.
 * @returns The worker-local terminal status.
 */
export async function runResidentTurn(options: ResidentTurnOptions): Promise<ResidentTurnResult> {
  const progress: { stage: WorkerStartupFailure['stage'] | null } = { stage: 'package_validation' };
  try {
    return await runResidentTurnImplementation(options, progress);
  } catch (error) {
    if (progress.stage) {
      options.onStartupFailure?.(describeWorkerStartupFailure(progress.stage, error));
    }
    throw error;
  }
}

/** Runs one Turn while identifying the last pre-start dependency entered. */
async function runResidentTurnImplementation(
  options: ResidentTurnOptions,
  progress: { stage: WorkerStartupFailure['stage'] | null }
): Promise<ResidentTurnResult> {
  const packageManifest = await readWorkerShimPackage(options.packagePath);

  if (packageManifest.control?.mode !== 'sandbox-integration') {
    throw new Error('Worker shim requires control.mode to be sandbox-integration.');
  }
  validateSandboxIntegrationBindings(packageManifest.control.bindings);
  rejectRetiredWorkerOverrides(packageManifest, options.environment);
  validateWorkerShimCommand(packageManifest);
  if (resolveWorkerAdapterId(packageManifest) !== options.adapterId) {
    throw new Error('Worker package adapter does not match its owning Harness.');
  }
  const { llmRoute, allowedLlmRoutes } = resolveWorkerLlmRoutes(packageManifest);
  const mcpServerIds = resolveWorkerMcpServerIds(packageManifest);
  const skillSupply = resolveSkillSupply(packageManifest.supply?.skills);
  const turnInput = resolveWorkerTurnInput(packageManifest);
  const cwd = resolveWorkerWorkingDirectory(packageManifest);
  const workspaceInputs = resolveWorkspaceInputs(packageManifest);
  const captureCoverageResult = CaptureCoverageBindingSchema.safeParse(
    packageManifest.observability?.captureCoverage
  );
  if (!captureCoverageResult.success) {
    throw new Error('Worker observation capture requires the exact admitted coverage binding.');
  }
  const captureCoverage = captureCoverageResult.data;
  requireSessionRuntimeEnvironment(packageManifest, options.runtimeEnvironmentNames);
  const provenanceDeclaration = parseRuntimeProvenanceDeclaration(
    packageManifest.control?.transcript?.runtimeProvenance
  );
  const lineage: WorkerLineage = {
    ...options.lineage,
    requestId: resolveRequestId(packageManifest.scope?.requestId),
  };
  const credentialValues = options.credentialValues;

  await mkdir(options.sessionDir, { recursive: true });
  await writeFile(join(options.sessionDir, 'events.jsonl'), '', 'utf8');
  await writeFile(join(options.sessionDir, 'items.jsonl'), '', 'utf8');
  await writeFile(join(options.sessionDir, 'artifacts.jsonl'), '', 'utf8');
  progress.stage = 'runtime_supply';
  await materializeRuntimeSupply(packageManifest);
  const workspaceRoot = packageManifest.workspace?.root;
  if (
    workspaceInputs.length > 0 &&
    (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0)
  ) {
    throw new Error('Git workspace materialization requires workspace.root.');
  }
  progress.stage = 'workspace_materialization';
  const workspaceBases = await materializeWorkspaceGitInputs(
    workspaceInputs,
    typeof workspaceRoot === 'string' ? workspaceRoot : cwd,
    options.sessionDir
  );

  let controlSession: WorkerControlClient | null = null;
  const controlAbortController = new AbortController();
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
    sessionDir: options.sessionDir,
  });
  let terminalOutcomeAttempted = false;
  let workerControlReady = false;
  let residentTurn: WorkerResidentTurn | null = null;
  let interrupted = options.signal.aborted;
  const interruptReason = new Error('Harness turn.interrupt');
  /** The one native stop of the started Turn; its result is shared by every stop request. */
  let nativeStop: Promise<boolean> | null = null;
  const stopStartedTurn = (turn: WorkerResidentTurn): Promise<boolean> => {
    nativeStop ??= stopNativeTurn(turn);
    return nativeStop;
  };
  let failUnprovedStop!: (error: Error) => void;
  /** Rejects once a delivered interrupt could not be proved, so the Turn does not wait forever. */
  const unprovedStop = new Promise<never>((_resolve, reject) => {
    failUnprovedStop = reject;
  });
  unprovedStop.catch(() => undefined);
  /** Delivers private `turn.interrupt` to the started Turn, or stops readiness before start. */
  const onInterrupt = () => {
    interrupted = true;
    if (residentTurn) {
      void stopStartedTurn(residentTurn).then((stopped) => {
        if (!stopped) failUnprovedStop(new Error('Resident native interrupt was not proved.'));
      });
    } else {
      controlAbortController.abort(interruptReason);
    }
  };
  options.signal.addEventListener('abort', onInterrupt, { once: true });

  try {
    progress.stage = 'integration_ready';
    await options.integration.ready;
    options.integration.bindTurnRouteTokens(options.lineage.agentSessionId, options.tokens);
    const session = new WorkerControlClient({
      baseUrl: '/worker-control',
      fetch: options.fetch ?? options.integration.workerControlFetch,
      lineage,
      token: options.tokens.controlToken,
    });
    controlSession = session;

    progress.stage = 'worker_control_ready';
    if (!interrupted) {
      try {
        await waitForWorkerControlReadiness(
          () => recordWorkerHeartbeat(session, writer, 'starting', controlAbortController.signal),
          controlAbortController
        );
        workerControlReady = true;
      } catch (error) {
        if (!interrupted) {
          throw error;
        }
      }
    }
    if (interrupted) {
      progress.stage = null;
      terminalOutcomeAttempted = true;
      await writeAndReportTerminalOutcome(writer, workerControlReady ? session : null, {
        status: 'interrupted',
        stopReason: 'aborted',
      });
      return { status: 'interrupted' };
    }

    progress.stage = 'native_spawn';
    // Only this call can leave a native Turn accepted without proof. Earlier failures are absent.
    let startedTurn: WorkerResidentTurn;
    try {
      startedTurn = await options.resident.startTurn({
        llmRoute,
        allowedLlmRoutes,
        mcpServerIds,
        runtimeCapture: {
          captureCoverage,
          credentialValues,
          emit: (record, body) => writer.writeObservation(record, body),
          packageSnapshotId: lineage.packageSnapshotId,
        },
        ...(provenanceDeclaration
          ? { runtimeProvenance: { ...provenanceDeclaration, lineage } }
          : {}),
        skillTargetPaths: skillSupply.map((skill) => ({
          id: skill.id,
          targetPath: skill.materialization.targetPath,
        })),
        turnDirectory: options.turnDirectory,
        turnId: lineage.turnId,
        turnInput,
        workingDirectory: cwd,
      });
    } catch (error) {
      throw new NativeAcceptanceUnknownError(error);
    }
    // Observe both outcomes before transcript I/O; the derived promise never rejects, so a
    // pending writer cannot expose exceptional settlement at the process rejection boundary.
    const settlement = startedTurn.settled.then(
      (result) => ({ kind: 'settled' as const, result }),
      (error: unknown) => ({ error })
    );
    residentTurn = startedTurn;
    progress.stage = null;
    if (interrupted) {
      onInterrupt();
    }
    options.onStarted();
    session.enablePostLaunchRecovery();
    const heartbeat = runWorkerHeartbeatLoop(session, writer, controlAbortController.signal);
    let adapterResult: Awaited<WorkerResidentTurn['settled']>;
    // A resident host that ends on its own fails the Turn; it is not an interrupt, and the ended
    // host is the proof that its native work stopped.
    const hostEndedError = new Error('Resident host ended during the Turn.');
    try {
      await writer.writeAndAppendEvent({
        data: { adapter: options.adapterId, status: 'turn.started' },
        type: 'worker.ready',
      });
      const hostEnded = () => ({ error: hostEndedError });
      const outcome = await Promise.race([
        settlement,
        heartbeat.then(
          () => ({ error: new Error('Worker control stopped before the Turn settled.') }),
          (error: unknown) => ({ error })
        ),
        options.resident.exited.then(hostEnded, hostEnded),
        unprovedStop,
      ]);
      if (!('result' in outcome)) {
        throw outcome.error;
      }
      adapterResult = outcome.result;
    } catch (error) {
      // An unproved stop leaves native work that may still run; the Harness must fence it.
      if (error !== hostEndedError && !(await stopStartedTurn(startedTurn))) {
        throw new NativeSettlementUnknownError(error);
      }
      throw error;
    }

    await writer.writeAndAppendEvent({
      data: { adapter: options.adapterId, status: 'turn.settled' },
      type: 'worker.heartbeat',
    });
    // Turn barrier: loopback requests still in flight are drained, then cut, before collection.
    await options.integration.drainTurn(options.lineage.agentSessionId);
    await publishWorkspaceGitSnapshots({
      bases: workspaceBases,
      credentialValues,
      inputs: workspaceInputs,
      lineage,
      sessionDir: options.sessionDir,
    });
    controlAbortController.abort();
    await heartbeat.catch(() => undefined);
    options.signal.removeEventListener('abort', onInterrupt);
    options.onTurnBarrier?.();
    const assistantOutputRejected = containsExactCredentialValue(
      adapterResult.assistantText,
      credentialValues
    );
    const status = assistantOutputRejected ? 'failed' : adapterResult.status;

    if (adapterResult.assistantText && status !== 'interrupted' && !assistantOutputRejected) {
      await writer.writeAssistantMessage({ status, text: adapterResult.assistantText });
    }
    const adapterDiagnostics = sanitizeAdapterDiagnostics(
      adapterResult.diagnostics,
      credentialValues
    );
    const terminalInput: WorkerTerminalOutcomeInput = {
      ...(status === 'failed' && Object.keys(adapterDiagnostics).length > 0
        ? { diagnostics: adapterDiagnostics }
        : {}),
      status,
      stopReason:
        status === 'completed' ? 'completed' : status === 'interrupted' ? 'aborted' : 'error',
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
      { ...terminalData, sequence: terminalRecord.sequence },
      terminalControlController.signal
    );
    try {
      await Promise.race([finalStatusPromise, terminalHeartbeatPromise]);
    } finally {
      terminalControlController.abort();
      await Promise.allSettled([finalStatusPromise, terminalHeartbeatPromise]);
    }
    return { status };
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
    options.signal.removeEventListener('abort', onInterrupt);
    controlSession?.disablePostLaunchRecovery();
    controlAbortController.abort();
    options.integration.clearTurnRouteTokens(options.lineage.agentSessionId);
    await rm(options.turnDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

/**
 * Requires the Turn's AEP runtime-env declarations to name exactly the session-static
 * environment delivered with `session.open`; a binding cannot apply a changed declaration.
 */
function requireSessionRuntimeEnvironment(
  packageManifest: WorkerShimPackageManifest,
  sessionNames: ReadonlySet<string>
): void {
  const declared = resolveRuntimeCredentialNames(packageManifest);
  if (
    declared.size !== sessionNames.size ||
    [...declared].some((name) => !sessionNames.has(name))
  ) {
    throw new Error('Runtime environment credential materialization is invalid.');
  }
}

/** Reads the optional AEP request lineage. */
function resolveRequestId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Worker request lineage is invalid.');
  }
  return value;
}

/** Minimal immutable AEP projection consumed by the worker shim. */
interface WorkerShimPackageManifest {
  /** Exact immutable observation admission binding projected by Core. */
  observability?: { captureCoverage?: unknown };
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
    /** Closed routing mode governing the allowed route set. */
    mode?: unknown;
    /** Logical model selected from the allowed route set. */
    preferredLogicalModelId?: unknown;
    /** Non-empty allowed route set. */
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

/** Classifies startup failure without publishing paths, credentials, or child output. */
function describeWorkerStartupFailure(
  stage: WorkerStartupFailure['stage'],
  cause: unknown
): WorkerStartupFailure {
  const explanation = GitFailureExplanationSchema.safeParse(
    cause instanceof Error && 'explanation' in cause ? cause.explanation : undefined
  );
  if (explanation.success && stage === explanation.data.stage) {
    return { stage, reason: explanation.data.code, explanation: explanation.data };
  }
  const reasons: Readonly<Record<string, WorkerStartupFailure['reason']>> = {
    'Retained Git workspace baseline is unavailable.': 'retained_baseline_unavailable',
    'Retained Git workspace baseline conflicts with the requested commit.':
      'retained_baseline_conflict',
    'Retained Git workspace source is unavailable.': 'retained_source_unavailable',
    'Retained Git workspace source conflicts with the requested origin.':
      'retained_source_conflict',
    'Remote Git workspace initialization failed.': 'git_init_failed',
    'Remote Git commit fetch failed.': 'git_fetch_failed',
    'Remote Git commit is not available from the configured remote.':
      'git_fetch_commit_unavailable',
    'Remote Git commit fetch TLS failed.': 'git_fetch_tls_failed',
    'Remote Git commit fetch transport failed.': 'git_fetch_transport_failed',
    'Remote Git commit checkout failed.': 'git_checkout_failed',
    'Worker control readiness timed out.': 'control_timeout',
  };
  const code = cause instanceof Error && 'code' in cause ? cause.code : null;
  const reason =
    code === 'ENOENT'
      ? 'missing_file'
      : code === 'EACCES' || code === 'EPERM'
        ? 'permission_denied'
        : cause instanceof SyntaxError
          ? 'invalid_json'
          : cause instanceof Error
            ? Object.hasOwn(reasons, cause.message)
              ? reasons[cause.message]!
              : 'failed'
            : 'failed';
  return { stage, reason };
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
  const skillMarkdown = join(skill.materialization.targetPath, 'SKILL.md');
  try {
    await access(skillMarkdown);
  } catch {
    throw new Error(`Skill tree is missing SKILL.md at ${skill.materialization.targetPath}`);
  }
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
 * Validates the exact allowed route set and selects its unique preferred route.
 *
 * @param packageManifest Worker-visible AEP.
 * @returns The exact allowed routes and this Turn's preferred route.
 * @throws Error when the mode, selection, route count, or selected shape is invalid.
 */
function resolveWorkerLlmRoutes(packageManifest: WorkerShimPackageManifest): {
  llmRoute: WorkerAdapterLlmRoute;
  allowedLlmRoutes: readonly WorkerAdapterLlmRoute[];
} {
  const mode = packageManifest.llm?.mode;
  const preferredLogicalModelId = packageManifest.llm?.preferredLogicalModelId;
  const routes = packageManifest.llm?.routes;

  if (mode !== 'gateway' && mode !== 'backend-local' && mode !== 'direct-external') {
    throw new Error('Worker shim requires a supported LLM routing mode.');
  }
  if (typeof preferredLogicalModelId !== 'string' || preferredLogicalModelId.length === 0) {
    throw new Error('Worker shim requires one preferred logical model.');
  }
  if (
    !Array.isArray(routes) ||
    routes.length === 0 ||
    (mode !== 'gateway' && routes.length !== 1)
  ) {
    throw new Error('Worker shim requires exactly one resolved LLM route.');
  }
  const preferredRoutes = routes.filter(
    (route): route is Record<string, unknown> =>
      isRecord(route) && route.model === preferredLogicalModelId
  );
  const [route] = preferredRoutes;
  if (preferredRoutes.length !== 1 || !route) {
    throw new Error('Worker shim requires exactly one resolved LLM route for the preferred model.');
  }
  const allowedLlmRoutes = routes.map((candidate) => projectWorkerLlmRoute(candidate));
  if (
    new Set(allowedLlmRoutes.map((candidate) => candidate.model)).size !== routes.length ||
    new Set(allowedLlmRoutes.map((candidate) => candidate.id)).size !== routes.length
  ) {
    throw new Error('Worker shim requires unambiguous logical-model and route identities.');
  }
  const expected =
    mode === 'gateway'
      ? (['placeholder', 'openai-compatible', 'nanocore-gateway'] as const)
      : mode === 'direct-external'
        ? (['environment', 'provider-compatible', 'direct-provider'] as const)
        : (['none', 'backend-local', 'backend-local'] as const);
  if (
    allowedLlmRoutes.some(
      (candidate) =>
        candidate.credentialVisibility !== expected[0] ||
        candidate.endpoint.kind !== expected[1] ||
        candidate.endpoint.upstream?.kind !== expected[2] ||
        candidate.endpoint.workerBaseUrl !== undefined
    )
  ) {
    throw new Error('Worker shim requires matching LLM routing-mode authority.');
  }
  return {
    llmRoute: allowedLlmRoutes.find((candidate) => candidate.model === preferredLogicalModelId)!,
    allowedLlmRoutes,
  };
}

/** Validates and projects one admitted logical-model route without repairing its core shape. */
function projectWorkerLlmRoute(route: unknown): WorkerAdapterLlmRoute {
  if (!isRecord(route)) throw new Error('Worker shim received an invalid resolved LLM route.');
  const endpoint = route.endpoint;
  if (
    !isNonEmptyString(route.id) ||
    !isNonEmptyString(route.model) ||
    !isNonEmptyString(route.providerInstanceId) ||
    !isRecord(endpoint) ||
    (endpoint.upstream !== undefined && !isRecord(endpoint.upstream)) ||
    (endpoint.workerBaseUrl !== undefined && !isNonEmptyString(endpoint.workerBaseUrl))
  ) {
    throw new Error('Worker shim received an invalid resolved LLM route.');
  }
  const upstream = isRecord(endpoint.upstream) ? endpoint.upstream : undefined;
  if (upstream && upstream.baseUrlRef !== undefined && !isNonEmptyString(upstream.baseUrlRef)) {
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
    ...(route.modelParameters !== undefined
      ? { modelParameters: projectWorkerModelParameters(route.modelParameters) }
      : {}),
    providerInstanceId: route.providerInstanceId,
  };
}

/** Checks an identity or present optional reference without coercion. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validates the complete present model descriptor, including positive safe-integer limits, and drops safe additive content. */
function projectWorkerModelParameters(
  value: unknown
): NonNullable<WorkerAdapterLlmRoute['modelParameters']> {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.contextWindow) ||
    typeof value.contextWindow !== 'number' ||
    value.contextWindow <= 0 ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    typeof value.maxOutputTokens !== 'number' ||
    value.maxOutputTokens <= 0 ||
    !Array.isArray(value.inputModalities) ||
    !value.inputModalities.every(
      (modality) =>
        typeof modality === 'string' &&
        ['text', 'image', 'audio', 'video', 'pdf'].includes(modality)
    ) ||
    typeof value.reasoning !== 'boolean'
  ) {
    throw new Error('Worker shim received invalid resolved LLM model parameters.');
  }
  return {
    contextWindow: value.contextWindow,
    maxOutputTokens: value.maxOutputTokens,
    inputModalities: [...value.inputModalities] as NonNullable<
      WorkerAdapterLlmRoute['modelParameters']
    >['inputModalities'],
    reasoning: value.reasoning,
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
      if (names.has(declaration.targetEnvVarName))
        throw new Error('Runtime environment credential materialization is invalid.');
      names.add(declaration.targetEnvVarName);
    }
  }

  return names;
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

/** Keeps the live worker lease heartbeat on its independent periodic schedule. */
async function runWorkerHeartbeatLoop(
  client: WorkerControlClient,
  transcript: WorkerTranscriptWriter,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      await delay(1000, undefined, { signal });
      if (!signal.aborted) {
        await recordWorkerHeartbeat(client, transcript, 'running', signal);
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
