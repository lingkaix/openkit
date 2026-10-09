import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { access, cp, lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { OpenCodeClient } from '@opencode/client';
import { REASONING_EFFORT_LEVELS, ReasoningEffortSchema } from '@openkit/protocol';
import type {
  WorkerAdapterLlmRoute,
  WorkerAdapterResult,
  WorkerNativeEvidence,
  WorkerNativeHandle,
  WorkerResidentAdapter,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurn,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import { LIFECYCLE_DEFAULTS, LifecycleDeadline } from '../lifecycle-deadline.js';
import { validateTurnReasoningEffort } from '../reasoning-effort.js';
import {
  type RuntimeFact,
  RuntimeSemanticCapture,
  runtimeOriginRef,
  runtimeRef,
  runtimeToolName,
} from '../runtime-capture.js';
import { containTurnLifecycleRecorder } from '../turn-timeline.js';
import { OPENCODE_PLUGIN_SOURCE } from './opencode-plugin.js';

/** Slash-free native provider id for the trusted relay. It is not an AEP provider instance id. */
export const OPENCODE_PROVIDER_ID = 'openkit-worker-inference';

/**
 * This adapter does not re-list tools at Turn start. A changed MCP server set or working
 * directory is a successor AgentSession. The resident contract has no declaration field, so
 * callers read this constant. `@opencode/cli@2.0.22` calls MCP `tools/list` when a server connects.
 */
export const OPENCODE_LISTS_TOOLS_AT_TURN_START = false;

/** Native permission reply used when an ask still arrives. The shortest-lived grant is `once`. */
export const OPENCODE_PERMISSION_REPLY = 'once';

const CLIENT_PACKAGE = '@opencode/client@2.0.22';
const CLI_PACKAGE = '@opencode/cli@2.0.22';
const CLI_NAME = '@opencode/cli';
const RESULT_BYTE_LIMIT = 16 * 1024 * 1024;
const DIAGNOSTIC_BYTE_LIMIT = 16 * 1024;
const HANDLE_PREFIX = 'v1:';
const SETTLED_ASSISTANT_FINISH = new Set(['stop', 'length']);
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Disables autonomous update and model-catalog traffic while preserving native discovery. */
const ISOLATION_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
};

interface OpenCodeClientModule {
  OpenCode: {
    make(options: { baseUrl: string; headers?: { authorization: string } }): OpenCodeClient;
  };
}

/** Replaceable loaders so a missing client or binary fails open without starting a server. */
export interface OpenCodeAdapterDependencies {
  /** Loads `@opencode/client`. The default import fails closed when the package is absent. */
  readonly loadClient?: () => Promise<OpenCodeClientModule>;
  /** Resolves the supervised `@opencode/cli` binary. */
  readonly resolveBinary?: () => string;
  /**
   * Starts the supervised server. Tests use this to represent a process whose exit cannot be
   * observed. Production spawns the resolved binary.
   */
  readonly spawnServer?: (
    binary: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => ChildProcess;
  /** How long one stop signal may wait for exit before escalation or unproved stop. Production uses half the shared native-stop cleanup tail. */
  readonly stopTimeoutMs?: number;
  /** Test-only shorter interruption proof deadline, excluding signal escalation. */
  readonly interruptTimeoutMs?: number;
  /** Test-only shorter native RPC deadline. */
  readonly rpcTimeoutMs?: number;
  /** Optional caller-held open budget; production starts one shared deadline at openSession. */
  readonly openDeadline?: LifecycleDeadline;
}

/**
 * Bounds and redacts one diagnostic value to a complete UTF-8 prefix of at most 16 KiB.
 * URLs are omitted because vendor errors may embed credentials outside the known secret set.
 *
 * @param value Raw diagnostic text.
 * @param secrets Exact values that must not appear.
 * @returns Redacted prefix.
 */
export function boundOpenCodeDiagnostic(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  redacted = redacted.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[redacted URL]');
  return new StringDecoder('utf8').write(Buffer.from(redacted).subarray(0, DIAGNOSTIC_BYTE_LIMIT));
}

/**
 * Opens one resident OpenCode V2 server per call.
 *
 * @param dependencies Optional client and binary loaders. Production uses the package pins.
 * @returns The resident adapter registered as `opencode`.
 */
export function createOpenCodeAdapter(
  dependencies: OpenCodeAdapterDependencies = {}
): WorkerResidentAdapter {
  const loadClient = dependencies.loadClient ?? loadOpenCodeClient;
  const resolveBinary = dependencies.resolveBinary ?? resolveOpenCodeBinary;
  const spawnServer = dependencies.spawnServer ?? defaultSpawnServer;
  const stopTimeoutMs =
    dependencies.stopTimeoutMs ?? LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs / 2;
  const rpcTimeoutMs = dependencies.rpcTimeoutMs ?? LIFECYCLE_DEFAULTS.nativeRequestMs;
  return {
    async openSession(input) {
      const deadline =
        dependencies.openDeadline ??
        new LifecycleDeadline(
          LIFECYCLE_DEFAULTS.nativeOpenMs,
          LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
        );
      const secrets = [input.loopback.inferenceCredential, input.loopback.capabilityCredential];
      let binary: string;
      try {
        binary = resolveBinary();
      } catch (error) {
        throw new Error(boundOpenCodeDiagnostic(errorText(error), secrets));
      }
      let clientModule: OpenCodeClientModule;
      try {
        if (deadline.workRemainingMs() <= 0)
          throw new NativeDeadlineError('OpenCode open preparation timed out.');
        clientModule = await nativeDeadline(
          'client loading',
          loadClient(),
          deadline.workRemainingMs()
        );
      } catch (error) {
        throw new Error(
          boundOpenCodeDiagnostic(
            error instanceof NativeDeadlineError ? errorText(error) : missingClientMessage(error),
            secrets
          )
        );
      }
      return supervise(
        input,
        binary,
        clientModule,
        spawnServer,
        stopTimeoutMs,
        rpcTimeoutMs,
        dependencies.interruptTimeoutMs ?? Number.POSITIVE_INFINITY,
        deadline
      );
    },
  };
}

/** Production OpenCode adapter. The client package is loaded when a session opens. */
export const opencodeAdapter = createOpenCodeAdapter();

/**
 * Resolves the published CLI binary next to `@opencode/cli`, never an ambient `opencode` on `PATH`.
 *
 * @returns Absolute executable path.
 */
export function resolveOpenCodeBinary(): string {
  const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
  let pkgPath: string;
  try {
    pkgPath = require.resolve(`${CLI_NAME}/package.json`);
  } catch (error) {
    throw new Error(missingBinaryMessage(error));
  }
  const pkg = require(pkgPath) as { bin?: { opencode?: string } };
  const relative = pkg.bin?.opencode;
  if (!relative) throw new Error(missingBinaryMessage(new Error('package bin is missing')));
  return join(dirname(pkgPath), relative);
}

async function loadOpenCodeClient(): Promise<OpenCodeClientModule> {
  return (await import('@opencode/client')) as OpenCodeClientModule;
}

function missingClientMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${CLIENT_PACKAGE} is not installed on the worker shim Node resolution path. The worker-runtimes image must install that exact package where the shim resolves it. ${detail}`;
}

function missingBinaryMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${CLI_PACKAGE} server executable is not installed for this platform. The worker-runtimes image must install the glibc Linux build of that exact pin. ${detail}`;
}

async function supervise(
  input: WorkerResidentOpenInput,
  binary: string,
  clientModule: OpenCodeClientModule,
  spawnServer: NonNullable<OpenCodeAdapterDependencies['spawnServer']>,
  stopTimeoutMs: number,
  rpcTimeoutMs: number,
  interruptTimeoutMs: number,
  openDeadline: LifecycleDeadline
): Promise<WorkerResidentSession> {
  let preparationDeadline: LifecycleDeadline | undefined = openDeadline;
  const rpc = <T>(name: string, work: Promise<T>) =>
    nativeDeadline(name, work, preparationDeadline?.workRemainingMs(rpcTimeoutMs) ?? rpcTimeoutMs);
  const secrets = [input.loopback.inferenceCredential, input.loopback.capabilityCredential];
  if (secrets.some((value) => value.length === 0) || secrets[0] === secrets[1]) {
    throw new Error('OpenCode requires two distinct loopback credentials.');
  }
  const password = randomBytes(24).toString('base64url');
  const secretValues = [...secrets, password];
  const directories = await prepareDirectories(input);
  // Filesystem preparation must finish before refusal; its pending writes cannot be cancelled safely.
  if (openDeadline.workRemainingMs() <= 0)
    throw new NativeDeadlineError('OpenCode open preparation timed out.');
  writeFileSync(join(directories.pluginDir, 'package.json'), '{"type":"module"}\n', {
    mode: 0o600,
  });
  writeFileSync(join(directories.pluginDir, 'index.js'), OPENCODE_PLUGIN_SOURCE, { mode: 0o600 });
  writeSecret(
    join(directories.loopbackDir, 'inference-bearer'),
    input.loopback.inferenceCredential
  );
  writeSecret(
    join(directories.loopbackDir, 'capability-bearer'),
    input.loopback.capabilityCredential
  );
  writeSecret(join(directories.loopbackDir, 'inference-base'), input.loopback.inferenceBaseUrl);

  const configPath = join(directories.configDir, 'openkit.json');
  writeSecret(
    configPath,
    JSON.stringify(serverConfig(directories.pluginDir, directories.skillsDir))
  );

  let stdout = '';
  let stderr = '';
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let spawnError: Error | null = null;
  let childState: 'absent' | 'running' | 'stopping' | 'unknown' = 'absent';
  let closeObserved = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let nativeTerminal: boolean | undefined;
  let processExited: boolean | undefined;
  let drainAttempted = false;
  let streamFailed = false;
  let persistencePreservingClose: boolean | undefined;
  const nativeEvidence = (): WorkerNativeEvidence => ({
    ...(nativeTerminal === undefined ? {} : { nativeTerminal }),
    ...(processExited === undefined ? {} : { processExited }),
    ...(drainAttempted ? { pipesDrained: stdoutEnded && stderrEnded && !streamFailed } : {}),
    ...(persistencePreservingClose === undefined ? {} : { persistencePreservingClose }),
  });
  let gracefulExit = false;
  let forcedStop = false;
  let stopRequested = false;
  let gracefulRequested = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing = false;
  let turnActive = false;
  // Only the shared callback is retained; no adapter timeline or labels are owned here.
  let recordLifecycleFact: WorkerResidentTurnInput['recordLifecycleFact'];
  let exitObserved = false;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const child = spawnServer(
    binary,
    ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'],
    {
      cwd: directories.workDir,
      env: serverEnvironment(input, directories, password, secretValues),
    }
  );
  child.stdin?.on('error', (error) => {
    spawnError = error;
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, stdoutDecoder.write(chunk));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, stderrDecoder.write(chunk));
  });
  child.stdout?.once('end', () => {
    drainAttempted = true;
    stdoutEnded = true;
    stdout = appendBounded(stdout, stdoutDecoder.end());
  });
  child.stderr?.once('end', () => {
    drainAttempted = true;
    stderrEnded = true;
    stderr = appendBounded(stderr, stderrDecoder.end());
  });
  // Stream errors lose evidence but must never escape as an unhandled EventEmitter error.
  child.stdout?.on('error', (error) => {
    drainAttempted = true;
    streamFailed = true;
    spawnError = error;
  });
  child.stderr?.on('error', (error) => {
    drainAttempted = true;
    streamFailed = true;
    spawnError = error;
  });
  const markExited = () => {
    if (exitObserved) return;
    exitObserved = true;
    childState = 'absent';
    resolveExited();
  };
  // A spawn `error` is not process exit. Resolving `exited` there let a live server look dead.
  child.on('error', (error) => {
    spawnError = error;
    if (child.pid === undefined) {
      markExited();
      return;
    }
    if (!exitObserved) childState = 'unknown';
  });
  child.on('close', () => {
    drainAttempted = true;
    closeObserved = true;
    resolveClosed();
  });
  child.on('exit', (code, signal) => {
    processExited = true;
    recordLifecycleFact?.({ label: 'host_exit', code, signal });
    gracefulExit =
      gracefulRequested && !stopRequested && !forcedStop && code === 0 && signal === null;
    markExited();
  });
  if (!exitObserved) childState = child.pid === undefined ? 'unknown' : 'running';

  let stopPromise: Promise<boolean> | null = null;
  let closePromise: Promise<void> | null = null;
  const confirmStopped = (
    deadline = new LifecycleDeadline(LIFECYCLE_DEFAULTS.nativeStopMs)
  ): Promise<boolean> => {
    closing = true;
    if (exitObserved) return Promise.resolve(true);
    processExited ??= false;
    if (stopPromise)
      return nativeDeadline('joined native stop', stopPromise, deadline.remainingMs()).catch(
        () => false
      );
    const pending = stopChild(
      child,
      () => {
        if (!exitObserved) childState = 'stopping';
      },
      exited,
      () => exitObserved,
      markExited,
      stopTimeoutMs,
      deadline,
      (signal) => {
        stopRequested = true;
        if (signal === 'SIGKILL') forcedStop = true;
      }
    );
    stopPromise = pending;
    void pending.then((stopped) => {
      if (!stopped && !exitObserved) childState = 'unknown';
    });
    void pending.finally(() => {
      if (stopPromise === pending) stopPromise = null;
    });
    return pending;
  };
  const closeHost = (
    deadline = new LifecycleDeadline(
      LIFECYCLE_DEFAULTS.nativeStopMs,
      LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
    )
  ): Promise<void> => {
    if (!closePromise) {
      closing = true;
      const activeAtClose = turnActive;
      persistencePreservingClose = false;
      closePromise = (async () => {
        // On 2.0.22 --stdio EOF returns normally from serve and runs scoped finalizers,
        // including SQLite.close. Signals interrupt that scope and do not prove this path.
        if (!activeAtClose && !exitObserved && child.stdin) {
          gracefulRequested = true;
          child.stdin.end();
          // An exhausted preparation still needs native finalizers; leave half its cleanup for signals.
          const workMs = deadline.workRemainingMs();
          const gracefulMs =
            workMs > 0
              ? workMs
              : deadline.remainingMs(Math.min(stopTimeoutMs, deadline.remainingMs() / 2));
          await nativeDeadline('graceful EOF drain', exited, gracefulMs).catch(() => undefined);
        }
        const stopped = await confirmStopped(deadline);
        if (stopped || exitObserved) {
          childState = 'absent';
          drainAttempted = true;
          if (!closeObserved)
            await nativeDeadline(
              'post-close stream drain',
              closed,
              deadline.remainingMs(stopTimeoutMs)
            );
          if (activeAtClose || !gracefulExit || !stdoutEnded || !stderrEnded || streamFailed) {
            throw new Error('OpenCode native drain or persistence flush was not proved.');
          }
          persistencePreservingClose = true;
          return;
        }
        childState = 'unknown';
        throw new Error('OpenCode server exit was not confirmed.');
      })();
    }
    return closePromise;
  };

  try {
    const baseUrl = await waitForListening(
      child,
      () => stdout,
      () => spawnError,
      () => exitObserved,
      openDeadline
    );
    const client = clientModule.OpenCode.make({
      baseUrl,
      headers: { authorization: `Basic ${basicAuth(password)}` },
    });
    const proved = await proveConversation(client, input.resumeReference, rpc);
    const session = bindSession(proved, client);
    preparationDeadline = undefined;
    return session;
  } catch (error) {
    // A thrown open is a clean refusal. The Harness does not close or fence it, so the process
    // must already be gone. An exit that cannot be proved stays on the returned binding.
    const stopped = await confirmStopped(openDeadline);
    if (stopped || exitObserved) {
      childState = 'absent';
      if (!closeObserved)
        await nativeDeadline(
          'open failure stream drain',
          closed,
          openDeadline.remainingMs(stopTimeoutMs)
        ).catch(() => undefined);
      throw new Error(
        boundOpenCodeDiagnostic(`${errorText(error)}\n${stderr}\n${stdout}`, secretValues)
      );
    }
    const failure = new Error(
      boundOpenCodeDiagnostic(`${errorText(error)}\n${stderr}\n${stdout}`, secretValues)
    );
    childState = 'unknown';
    return refusedSession(failure);
  }

  function refusedSession(failure: Error): WorkerResidentSession {
    return {
      exited,
      childState: () => childState,
      nativeEvidence,
      close: closeHost,
      async nativeHandle(): Promise<WorkerNativeHandle> {
        return { state: 'unknown' };
      },
      async startTurn() {
        const stopped = await confirmStopped();
        if (stopped || exitObserved) throw failure;
        childState = 'unknown';
        return surfaceUnprovedOpenCodeTurn(failure, confirmAgain);
      },
    };
  }

  function bindSession(
    proved: { reference: Uint8Array | null; sessionId: string | null },
    client: OpenCodeClient
  ): WorkerResidentSession {
    let boundSupply: string | null = null;
    let boundRoutes: string | null = null;
    let publishedBoundary: NativeMessage[] | null = null;
    const sessionId = proved.sessionId;
    // A resumed get already read the row from disk. A new id stays pending until that select matches.
    let durable = input.resumeReference !== null && proved.sessionId !== null;

    const session: WorkerResidentSession = {
      exited,
      childState: () => childState,
      nativeEvidence,
      close: closeHost,
      async nativeHandle(): Promise<WorkerNativeHandle> {
        if (
          exitObserved ||
          child.exitCode !== null ||
          child.signalCode !== null ||
          !proved.reference ||
          !sessionId
        ) {
          return { state: 'unknown' };
        }
        if (!durable) durable = sessionRowVisible(input.stateRoot, sessionId);
        if (!durable) return { state: 'pending' };
        try {
          const info = await rpc('session.get', client.session.get({ sessionID: sessionId }));
          assertSessionInfo(info, sessionId);
        } catch {
          return { state: 'unknown' };
        }
        // The process may exit while the bounded inspection request is in flight.
        if (exitObserved || child.exitCode !== null || child.signalCode !== null) {
          return { state: 'unknown' };
        }
        return { state: 'ready', reference: proved.reference };
      },
      async startTurn(turn) {
        recordLifecycleFact = containTurnLifecycleRecorder(turn.recordLifecycleFact);
        const effort = validateTurnReasoningEffort(turn);
        const reasoning = turn.llmRoute.reasoningEffortLevels !== undefined;
        let reasoningEffortDiagnostic = 'unknown';
        if (exitObserved || child.exitCode !== null || child.signalCode !== null) {
          throw new Error('OpenCode binding is not running.');
        }
        if (closing) {
          const stopped = await confirmStopped();
          if (stopped || exitObserved) throw new Error('OpenCode binding is not running.');
          childState = 'unknown';
          return surfaceUnprovedOpenCodeTurn(
            new Error('OpenCode binding is not running.'),
            confirmAgain
          );
        }
        if (!proved.reference || !sessionId) {
          throw new Error('OpenCode resume did not prove the native conversation.');
        }
        if (turnActive) throw new Error('OpenCode binding already has an active Turn.');
        const routes = [...turn.allowedLlmRoutes].sort((a, b) => a.id.localeCompare(b.id));
        for (const route of routes) assertRoute(route, input.loopback.inferenceBaseUrl);
        // Advertisement can change without changing the native all-level declaration.
        const routeKey = JSON.stringify(
          routes.map(({ reasoningEffortLevels, ...route }) => ({
            ...route,
            reasoningControls: reasoningEffortLevels !== undefined,
          }))
        );
        if (!routes.some((route) => JSON.stringify(route) === JSON.stringify(turn.llmRoute))) {
          throw new Error('OpenCode preferred route is outside the admitted set.');
        }
        if (boundRoutes !== null && boundRoutes !== routeKey) {
          throw new Error(
            'OpenCode admitted route set changed; exact resume through a successor is required.'
          );
        }
        if (new Set(routes.map((route) => route.model)).size !== routes.length) {
          throw new Error('OpenCode admitted routes contain duplicate native model ids.');
        }
        assertNoSecret(turn, secretValues);
        const serverIds = normalizeServerIds(turn.mcpServerIds);
        const supplyKey = JSON.stringify([
          turn.workingDirectory,
          [...serverIds].sort(),
          turn.skillTargetPaths.map((skill) => [skill.id, skill.targetPath]).sort(),
        ]);
        if (boundSupply !== null && boundSupply !== supplyKey) {
          throw new Error(
            'OpenCode does not re-list tools at Turn start, so this supply change needs a successor AgentSession that resumes the native conversation.'
          );
        }
        turnActive = true;
        // MCP supply arrives only here; idle time after session.open is not preparation time.
        const setupDeadline = new LifecycleDeadline(
          LIFECYCLE_DEFAULTS.nativeOpenMs,
          LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
        );
        const rpc: NativeRpc = (name, work) =>
          nativeDeadline(name, work, setupDeadline.workRemainingMs(rpcTimeoutMs));

        let nativeWarnings = '';
        let nativeModels: string[] = [];
        let before = new Set<string>();
        let promptStartedAt = 0;
        let promptId = '';
        let promptAttempted = false;
        let captureAbandoned = false;
        // Native HTTP authentication is adapter-private, so the shared input cannot enumerate it.
        const capture = new RuntimeSemanticCapture({
          ...turn.runtimeCapture,
          // A timed-out sink may finish later; permit only the incomplete-collection report after stop.
          emit: async (record, body) => {
            if (
              !captureAbandoned ||
              (record.fact.kind === 'coverage' &&
                record.fact.coverage === 'unavailable' &&
                record.fact.reason === 'collector-failed')
            )
              await turn.runtimeCapture.emit(record, body);
          },
          credentialValues: [
            ...turn.runtimeCapture.credentialValues,
            ...secretValues,
            basicAuth(password),
          ],
        });
        const sourceRef = runtimeRef(
          'rts',
          turn.runtimeCapture.packageSnapshotId,
          `${sessionId}:${turn.turnId}`
        );
        const originRef = runtimeOriginRef(turn.runtimeCapture.packageSnapshotId, sessionId);
        try {
          if (boundSupply === null) {
            const native = await inspectNativeBindings(
              client,
              turn.workingDirectory,
              configPath,
              serverIds,
              rpc
            );
            nativeWarnings = native.warnings;
            nativeModels = native.models;
            // The final inline native Skill source is separate from all authored roots.
            // Populate it once before reload, including an explicitly empty selection.
            for (const skill of turn.skillTargetPaths) {
              if (basename(skill.id) !== skill.id || skill.id === '.' || skill.id === '..') {
                throw new Error('OpenCode managed Skill id escapes its projection root.');
              }
              symlinkSync(skill.targetPath, join(directories.skillsDir, skill.id), 'dir');
            }
          }
          if (boundRoutes === null) {
            // Explicit configuration and location.reload are supported by the pin. Reload
            // rebuilds services in this same host; it neither creates nor replaces a session.
            const config = serverConfig(
              directories.pluginDir,
              directories.skillsDir,
              routes,
              nativeModels
            );
            writeSecret(configPath, JSON.stringify(config));
            await rpc('location.reload catalog', client.location.reload());
            boundRoutes = routeKey;
          }
          if (boundSupply === null) {
            // Move initializes the destination services. Configure that location
            // before prompting, keeping native and managed MCP in its own registry.
            await rpc(
              'session.move',
              client.session.move({ directory: turn.workingDirectory, sessionID: sessionId })
            );
            // Move is itself a native inbox operation. Drain it before recording the
            // prompt boundary, so its idle event cannot settle the admitted Turn.
            await rpc('session.wait after move', client.session.wait({ sessionID: sessionId }));
            await syncMcpServers(
              client,
              serverIds,
              input.loopback.capabilityBaseUrl,
              turn.workingDirectory,
              directories.loopbackDir,
              rpc,
              setupDeadline
            );
            boundSupply = supplyKey;
          }
          const catalog = await rpc(
            'model.list catalog',
            client.model.list({ location: { directory: turn.workingDirectory } })
          );
          const actual = catalog.data
            .filter((model) => model.providerID === OPENCODE_PROVIDER_ID && model.enabled)
            .map((model) => model.id)
            .sort();
          if (
            JSON.stringify(actual) !== JSON.stringify(routes.map((route) => route.model).sort())
          ) {
            throw new Error('OpenCode native catalog does not match the admitted model set.');
          }
          const previousSelection = await rpc(
            'session.get before model selection',
            client.session.get({ sessionID: sessionId })
          );
          assertSessionInfo(previousSelection, sessionId);
          const selectingEffort = reasoning && effort !== undefined;
          if (
            selectingEffort ||
            previousSelection.model?.providerID !== OPENCODE_PROVIDER_ID ||
            previousSelection.model?.id !== turn.llmRoute.model
          ) {
            await rpc(
              'session.switchModel',
              client.session.switchModel({
                sessionID: sessionId,
                model: {
                  providerID: OPENCODE_PROVIDER_ID,
                  id: turn.llmRoute.model,
                  ...(selectingEffort ? { variant: effort } : {}),
                },
              })
            );
            await rpc(
              'session.wait after model selection',
              client.session.wait({ sessionID: sessionId })
            );
          }
          const selected = await rpc(
            'session.get selected model',
            client.session.get({ sessionID: sessionId })
          );
          if (selectingEffort && selected.model?.variant !== effort)
            throw new Error('OpenCode effort selection was not proved.');
          const effective = ReasoningEffortSchema.safeParse(selected.model?.variant);
          reasoningEffortDiagnostic = effective.success ? effective.data : 'unknown';
          assertSessionInfo(selected, sessionId);
          // Full permission is the default; preserve authored denies from the native agent.
          const agent = await rpc(
            'agent.get permissions',
            client.agent.get({
              agentID: selected.agent ?? 'build',
              location: { directory: turn.workingDirectory },
            })
          );
          await rpc(
            'session.update permissions',
            client.session.update({
              sessionID: sessionId,
              permissions: [
                { action: '*', resource: '*', effect: 'allow' },
                ...agent.data.permissions.filter((rule) => rule.effect === 'deny'),
              ],
            })
          );

          if (
            selected.model?.providerID !== OPENCODE_PROVIDER_ID ||
            selected.model.id !== turn.llmRoute.model
          ) {
            throw new Error('OpenCode native preferred model selection was not proved.');
          }
          const previous = await listMessages(client, sessionId, rpc);
          if (publishedBoundary) assertPublishedBoundary(publishedBoundary, previous);
          before = new Set(previous.map((message) => message.id));
          await nativeDeadline(
            'structural preparation',
            (async () => {
              await capture.emit(sourceRef, {
                kind: 'coverage',
                runtimeOriginRef: originRef,
                family: 'primary-content',
                coverage: turn.runtimeCapture.captureCoverage.value === 'on' ? 'collecting' : 'off',
              });
              if (captureAbandoned) return;
              await capture.emit(sourceRef, {
                kind: 'origin',
                runtimeOriginRef: originRef,
                phase: 'started',
              });
            })(),
            setupDeadline.workRemainingMs()
          );
          promptStartedAt = Date.now();
          promptAttempted = true;
          nativeTerminal = undefined;
          const admitted = await rpc(
            'session.prompt',
            client.session.prompt({ sessionID: sessionId, text: turn.turnInput })
          );
          if (typeof admitted.id !== 'string' || admitted.id.length === 0) {
            throw new Error('OpenCode prompt admission did not return an identity.');
          }
          promptId = admitted.id;
          // The admitted prompt now starts an actual correlated-terminal proof attempt.
          nativeTerminal = false;
        } catch (error) {
          turnActive = false;
          const failure = new Error(boundOpenCodeDiagnostic(errorText(error), secretValues));
          if (!promptAttempted) {
            captureAbandoned = true;
            // No prompt was submitted. Reuse the qualified EOF drain and its retained close
            // promise, so a clean setup refusal remains closable without mistaking exit for flush.
            try {
              await closeHost(setupDeadline);
            } catch (cleanupError) {
              return surfaceUnprovedOpenCodeTurn(
                new Error(
                  boundOpenCodeDiagnostic(
                    `${failure.message}; ${errorText(cleanupError)}`,
                    secretValues
                  )
                ),
                confirmAgain
              );
            }
            throw failure;
          }
          // A submitted prompt may already be accepted. Confirmed stop can normalize its
          // failed settlement, but cannot erase that attempt through a clean refusal.
          const stopped = await confirmStopped(setupDeadline);
          try {
            await capture.emit(sourceRef, {
              kind: 'origin',
              runtimeOriginRef: originRef,
              phase: 'unknown',
            });
            await capture.emit(sourceRef, {
              kind: 'coverage',
              runtimeOriginRef: originRef,
              family: 'primary-content',
              coverage: 'unavailable',
              reason: 'collector-failed',
            });
            await capture.emit(sourceRef, {
              kind: 'coverage',
              runtimeOriginRef: originRef,
              family: 'primary-content',
              coverage: 'ended',
            });
          } catch (captureError) {
            return surfaceUnprovedOpenCodeTurn(captureError, confirmAgain);
          }
          if (stopped || exitObserved) {
            return {
              settled: Promise.resolve({
                ...failedResult(failure.message, secretValues),
                nativeEvidence: nativeEvidence(),
              }),
              interrupt: async () => undefined,
            };
          }
          childState = 'unknown';
          return surfaceUnprovedOpenCodeTurn(failure, confirmAgain);
        }
        let interruptDeadline: LifecycleDeadline | undefined;
        let nativePhase: RuntimeFact['phase'] = 'unknown';
        const capturedSnapshots = new Map<string, string>();
        const observeMessages = async (messages: NativeMessage[]): Promise<void> => {
          if (captureAbandoned) return;
          for (const message of messages) {
            if (before.has(message.id)) continue;
            const snapshot = JSON.stringify(message);
            if (capturedSnapshots.get(message.id) === snapshot) continue;
            await captureOpenCodeMessage(
              capture,
              sourceRef,
              originRef,
              turn.runtimeCapture.packageSnapshotId,
              message
            );
            capturedSnapshots.set(message.id, snapshot);
          }
        };
        let collected = false;
        let interruptPromise: Promise<void> | null = null;
        let interruptFailure: Error | null = null;
        // A failed interruption must reject settlement even if native collection cannot finish.
        let rejectUnprovedStop!: (error: Error) => void;
        const unprovedStop = new Promise<never>((_, reject) => {
          rejectUnprovedStop = reject;
        });
        let resolveStoppedCollection!: (result: WorkerAdapterResult) => void;
        const stoppedCollection = new Promise<WorkerAdapterResult>((resolve) => {
          resolveStoppedCollection = resolve;
        });
        const collection = settleTurn({
          before,
          promptId,
          child,
          client,
          logPath: join(directories.xdgDir, 'opencode', 'log', 'opencode.log'),
          output: () => ({ stderr, stdout }),
          secrets: secretValues,
          sessionId,
          startedAt: promptStartedAt,
          stop: () => confirmStopped(interruptDeadline),
          interruptRequested: () => interruptDeadline !== undefined,
          rpc: (name, work) =>
            Promise.race([
              nativeDeadline(
                name,
                work,
                interruptDeadline?.workRemainingMs(rpcTimeoutMs) ?? rpcTimeoutMs
              ),
              exited.then(() => {
                throw new Error('OpenCode server exited during the Turn.');
              }),
            ]),
          observed: observeMessages,
          published: async (messages) => {
            if (captureAbandoned) return;
            nativeTerminal = true;
            const outcome = messages.at(-1)?.outcome;
            nativePhase =
              outcome === 'succeeded'
                ? 'completed'
                : outcome === 'interrupted'
                  ? 'interrupted'
                  : 'failed';
            publishedBoundary = messages;
            for (const message of messages) {
              if (!before.has(message.id)) {
                recordLifecycleFact?.({ label: 'native_event' });
              }
            }
            await observeMessages(messages);
          },
        }).then(async (result) => {
          await capture.emit(sourceRef, {
            kind: 'origin',
            runtimeOriginRef: originRef,
            phase: nativePhase,
          });
          await capture.flushCompleted();
          if (!nativeTerminal || nativePhase === 'interrupted') await capture.interrupt();
          if (!nativeTerminal)
            await capture.emit(sourceRef, {
              kind: 'coverage',
              runtimeOriginRef: originRef,
              family: 'primary-content',
              coverage: 'unavailable',
              reason: 'collector-failed',
            });
          await capture.emit(sourceRef, {
            kind: 'coverage',
            runtimeOriginRef: originRef,
            family: 'primary-content',
            coverage: 'ended',
          });
          collected = true;
          result = {
            ...result,
            diagnostics: {
              ...result.diagnostics,
              reasoningEffort: reasoningEffortDiagnostic,
              ...(!reasoning
                ? { reasoningEffortDelivery: 'not-delivered: model has no reasoning' }
                : {}),
            },
          };
          return nativeWarnings
            ? {
                ...result,
                diagnostics: {
                  ...result.diagnostics,
                  native: boundOpenCodeDiagnostic(
                    [nativeWarnings, result.diagnostics?.native].filter(Boolean).join(' '),
                    secretValues
                  ),
                },
              }
            : result;
        });
        const settled = Promise.race([collection, unprovedStop, stoppedCollection])
          .then(async (result) => {
            // A session-scoped cancellation must be drained before a new native prompt can run.
            if (interruptPromise) await interruptPromise;
            if (interruptFailure)
              return {
                ...failedResult(interruptFailure.message, secretValues),
                nativeEvidence: nativeEvidence(),
              };
            return { ...result, nativeEvidence: nativeEvidence() };
          })
          .finally(() => {
            turnActive = false;
          });
        settled.catch(() => undefined);
        return {
          settled,
          interrupt(
            deadline = new LifecycleDeadline(
              LIFECYCLE_DEFAULTS.nativeStopMs,
              LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
            )
          ): Promise<void> {
            if (interruptPromise)
              return nativeDeadline(
                'joined interruption',
                interruptPromise,
                deadline.remainingMs()
              ).catch((error: unknown) => {
                if (error instanceof NativeDeadlineError)
                  throw new NativeDeadlineError(
                    'OpenCode joined interruption timed out; native cleanup was not proved.'
                  );
                throw error;
              });
            if (collected || !turnActive) return Promise.resolve();
            interruptDeadline = deadline;
            interruptPromise = nativeDeadline(
              'interruption proof',
              (async () => {
                if (deadline.workRemainingMs() <= 0)
                  throw new NativeDeadlineError('OpenCode interruption proof timed out.');
                const response = await nativeDeadline(
                  'session.interrupt',
                  client.session.interrupt({ sessionID: sessionId }),
                  deadline.workRemainingMs(rpcTimeoutMs)
                );
                if (!response || typeof response.interrupted !== 'boolean') {
                  throw new Error('OpenCode interrupt response has an unknown boolean core.');
                }
                // The ACK is not a terminal. The correlated native outcome decides the status.
                await collection;
              })(),
              deadline.workRemainingMs(interruptTimeoutMs)
            ).catch(async (error) => {
              interruptFailure = new Error(boundOpenCodeDiagnostic(errorText(error), secretValues));
              if (!(await confirmStopped(deadline))) {
                captureAbandoned = true;
                rejectUnprovedStop(interruptFailure);
                throw interruptFailure;
              }
              // Proved absence must release settlement even if the structural sink never returns.
              captureAbandoned = true;
              interruptFailure = new Error(
                `${interruptFailure.message}; OpenCode structural collection incomplete after stop.`
              );
              await nativeDeadline(
                'incomplete collection report',
                capture.emit(sourceRef, {
                  kind: 'coverage',
                  runtimeOriginRef: originRef,
                  family: 'primary-content',
                  coverage: 'unavailable',
                  reason: 'collector-failed',
                }),
                deadline.remainingMs()
              ).catch(() => undefined);
              resolveStoppedCollection(failedResult(interruptFailure.message, secretValues));
            });
            interruptPromise.catch(() => undefined);
            return interruptPromise;
          },
        } satisfies WorkerResidentTurn;
      },
    };
    return session;
  }

  async function confirmAgain(deadline?: LifecycleDeadline): Promise<boolean> {
    const stopped = await confirmStopped(deadline);
    if (!stopped && !exitObserved) childState = 'unknown';
    return stopped || exitObserved;
  }
}

/** Tests lexical and canonical containment without accepting path-prefix siblings. */
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

/** Observes dangling links too; only genuine absence permits initialization. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Validates the complete source before copying, dereferencing only contained links. */
async function validateNativeSource(source: string, path = source): Promise<void> {
  const target = await realpath(path);
  if (!within(source, target)) throw new Error('OpenCode image source escapes its root.');
  const entry = await lstat(target);
  await access(target, entry.isDirectory() ? 5 : 4);
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await validateNativeSource(source, join(path, name));
  } else if (!entry.isFile()) {
    throw new Error('OpenCode image source contains an unreadable native entry.');
  }
}

/** Seeds only an absent native configuration home under the existing Thread writer lease. */
async function initializeNativeHome(stateRoot: string): Promise<void> {
  const home = join(stateRoot, 'config');
  const root = await realpath(stateRoot);
  if (await pathExists(home)) {
    if (!(await lstat(home)).isDirectory() || !within(root, await realpath(home))) {
      throw new Error('OpenCode native home escapes its retained root.');
    }
    return;
  }
  const staging = `${home}.initializing`;
  if (await pathExists(staging))
    throw new Error('OpenCode native home initialization is incomplete.');
  // The shim image user's home, never the redirected launch HOME, owns defaults.
  const source = process.env.HOME ? resolve(process.env.HOME, '.config', 'opencode') : null;
  if (!source || within(resolve(stateRoot), source) || !(await pathExists(source))) {
    await mkdir(home, { mode: 0o700 });
    return;
  }
  const canonicalSource = await realpath(source);
  if (within(root, canonicalSource)) {
    await mkdir(home, { mode: 0o700 });
    return;
  }
  if (!(await lstat(canonicalSource)).isDirectory()) {
    throw new Error('OpenCode image source root must be a directory.');
  }
  await validateNativeSource(canonicalSource);
  await cp(canonicalSource, staging, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  if (await pathExists(home))
    throw new Error('OpenCode native home was created during initialization.');
  await rename(staging, home);
}

async function prepareDirectories(input: WorkerResidentOpenInput): Promise<{
  configDir: string;
  homeDir: string;
  loopbackDir: string;
  pluginDir: string;
  skillsDir: string;
  tmpDir: string;
  workDir: string;
  xdgDir: string;
}> {
  await initializeNativeHome(input.stateRoot);
  const homeDir = join(input.stateRoot, 'home');
  const xdgDir = join(input.stateRoot, 'xdg');
  const configDir = join(input.controlRoot, 'config');
  const skillsDir = join(input.controlRoot, 'skills');
  const tmpDir = join(input.stateRoot, 'tmp');
  const workDir = join(input.stateRoot, 'work');
  const pluginDir = join(input.controlRoot, 'plugin');
  const loopbackDir = join(input.controlRoot, 'loopback');
  for (const directory of [
    homeDir,
    xdgDir,
    configDir,
    skillsDir,
    tmpDir,
    workDir,
    pluginDir,
    loopbackDir,
  ]) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  return { configDir, homeDir, loopbackDir, pluginDir, skillsDir, tmpDir, workDir, xdgDir };
}

function serverEnvironment(
  input: WorkerResidentOpenInput,
  directories: Awaited<ReturnType<typeof prepareDirectories>>,
  password: string,
  secrets: readonly string[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.environment)) {
    if (secrets.some((secret) => value.includes(secret))) continue;
    env[key] = value;
  }
  env.HOME = directories.homeDir;
  env.OPENCODE_TEST_HOME = directories.homeDir;
  env.XDG_CACHE_HOME = directories.xdgDir;
  env.XDG_CONFIG_HOME = input.stateRoot;
  env.XDG_DATA_HOME = directories.xdgDir;
  env.XDG_STATE_HOME = directories.xdgDir;
  env.TMPDIR = directories.tmpDir;
  env.TEMP = directories.tmpDir;
  env.TMP = directories.tmpDir;
  env.PATH = env.PATH ?? '/usr/bin:/bin';
  env.OPENCODE_CONFIG_DIR = join(input.stateRoot, 'config');
  env.OPENCODE_CONFIG = join(directories.configDir, 'openkit.json');
  // Inline safety/discovery settings retain highest precedence while the explicit file
  // supplies the first-Turn catalog, which can be reloaded without replacing this host.
  const baseConfig = serverConfig(directories.pluginDir, directories.skillsDir);
  // The pin reads explicit files before Workspace documents. Its native environment
  // substitution lets the existing host plugin refresh this final inline projection on reload.
  env.OPENKIT_OPENCODE_CONFIG = JSON.stringify(baseConfig);
  env.OPENCODE_CONFIG_CONTENT = '{env:OPENKIT_OPENCODE_CONFIG}';
  env.OPENCODE_PASSWORD = password;
  for (const [key, value] of Object.entries(ISOLATION_ENV)) env[key] = value;
  return env;
}

/** Generates the exact native catalog with no invented model or upstream credential. */
function serverConfig(
  pluginDir: string,
  skillsDir: string,
  routes: readonly WorkerAdapterLlmRoute[] = [],
  nativeModels: readonly string[] = []
): Record<string, unknown> {
  return {
    // This pin exposes no setting that disables downloads while preserving local LSP.
    lsp: false,
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    plugins: [pluginDir],
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        canonical: OPENCODE_PROVIDER_ID,
        // Native documents merge model maps. Tombstones keep foreign models unavailable.
        models: {
          ...Object.fromEntries(nativeModels.map((id) => [id, { disabled: true }])),
          ...Object.fromEntries(
            routes.map((route) => [
              route.model,
              {
                name: route.model,
                modelID: route.model,
                package: '@ai-sdk/openai-compatible',
                disabled: false,
                ...(route.reasoningEffortLevels !== undefined
                  ? {
                      variants: REASONING_EFFORT_LEVELS.map((id) => ({
                        id,
                        settings: { reasoningEffort: id },
                      })),
                    }
                  : {}),
                ...(route.modelParameters
                  ? {
                      limit: {
                        context: route.modelParameters.contextWindow,
                        output: route.modelParameters.maxOutputTokens,
                      },
                      capabilities: {
                        tools: true,
                        input: route.modelParameters.inputModalities,
                        output: ['text', ...(route.modelParameters.reasoning ? ['reasoning'] : [])],
                      },
                    }
                  : {}),
              },
            ])
          ),
        },
        package: '@ai-sdk/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:9/wrong' },
      },
    },
    share: 'disabled',
    skills: [skillsDir],
    update: 'disable',
    websearch: false,
  };
}

async function waitForListening(
  child: ChildProcess,
  stdout: () => string,
  spawnFailure: () => Error | null,
  hasExited: () => boolean,
  deadline: LifecycleDeadline
): Promise<string> {
  for (;;) {
    if (deadline.workRemainingMs() <= 0) throw new Error('OpenCode server did not listen.');
    const match = stdout().match(/https?:\/\/127\.0\.0\.1:\d+/);
    if (match) return match[0];
    const failure = spawnFailure();
    if (failure) throw failure;
    if (hasExited() || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('OpenCode server exited before it listened.');
    }
    await delay(deadline.workRemainingMs(20));
  }
}

/** Validates the native core fields used to prove identity and settlement, ignoring additions. */
function assertSessionInfo(
  value: unknown,
  sessionId: string
): asserts value is { id: string; time: { idle?: number }; outcome?: string } {
  if (typeof value !== 'object' || value === null)
    throw new Error('OpenCode session inspection has an unknown shape.');
  const row = value as Record<string, unknown>;
  if (row.id !== sessionId || typeof row.time !== 'object' || row.time === null) {
    throw new Error('OpenCode session inspection returned an unknown identity or time.');
  }
  const idle = (row.time as Record<string, unknown>).idle;
  if (idle !== undefined && (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0)) {
    throw new Error('OpenCode session inspection returned an unknown idle value.');
  }
  if (
    row.outcome !== undefined &&
    row.outcome !== 'succeeded' &&
    row.outcome !== 'failed' &&
    row.outcome !== 'interrupted'
  ) {
    throw new Error('OpenCode session inspection returned an unknown outcome.');
  }
}

async function proveConversation(
  client: OpenCodeClient,
  resumeReference: Uint8Array | null,
  rpc: NativeRpc
): Promise<{ reference: Uint8Array | null; sessionId: string | null }> {
  if (resumeReference) {
    const sessionId = decodeHandle(resumeReference);
    if (!sessionId) return { reference: null, sessionId: null };
    try {
      const info = await rpc('session.get', client.session.get({ sessionID: sessionId }));
      assertSessionInfo(info, sessionId);
    } catch (error) {
      if (error instanceof NativeDeadlineError) throw error;
      return { reference: null, sessionId: null };
    }
    return { reference: Buffer.from(resumeReference), sessionId };
  }
  const created = await rpc(
    'session.create',
    client.session.create({
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    })
  );
  if (typeof created.id !== 'string' || created.id.length === 0) {
    throw new Error('OpenCode session id is missing.');
  }
  return { reference: encodeHandle(created.id), sessionId: created.id };
}

/**
 * Reports whether a new process can read this conversation.
 *
 * `@opencode/cli@2.0.22` commits the id into `session_v2` of `$XDG_DATA_HOME/opencode/opencode.db`
 * before `session.create` returns. A read-only select saw that row while the server was alive,
 * and after SIGKILL a second `opencode serve` on the same directory resumed it. The handle stays
 * pending until this select matches, and a later inspect keeps the first successful proof.
 */
function sessionRowVisible(stateRoot: string, sessionId: string): boolean {
  const dbPath = join(stateRoot, 'xdg', 'opencode', 'opencode.db');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1_000 });
    const row = db.prepare('SELECT id FROM session_v2 WHERE id = ?').get(sessionId);
    return row?.id === sessionId;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // The select result already decided the handle. Closing the read is not that proof.
    }
  }
}

function encodeHandle(sessionId: string): Uint8Array {
  return Buffer.from(`${HANDLE_PREFIX}${sessionId}`, 'utf8');
}

function decodeHandle(reference: Uint8Array): string | null {
  const text = Buffer.from(reference).toString('utf8');
  if (!text.startsWith(HANDLE_PREFIX)) return null;
  const sessionId = text.slice(HANDLE_PREFIX.length);
  if (
    sessionId.length === 0 ||
    sessionId.length > 256 ||
    sessionId.includes(String.fromCharCode(0)) ||
    /[\s/]/.test(sessionId)
  ) {
    return null;
  }
  return sessionId;
}

function assertRoute(route: WorkerAdapterLlmRoute, inferenceBaseUrl: string): void {
  const upstream = route.endpoint.upstream?.kind;
  const base = route.endpoint.workerBaseUrl;
  if (
    route.credentialVisibility === 'environment' ||
    route.endpoint.kind !== 'openai-compatible' ||
    (upstream !== undefined && upstream !== 'nanocore-gateway') ||
    (base !== undefined && base !== inferenceBaseUrl)
  ) {
    throw new Error('OpenCode rejected the selected route before admitting the Turn.');
  }
}

function assertNoSecret(turn: WorkerResidentTurnInput, secrets: readonly string[]): void {
  const fields = [
    turn.turnInput,
    ...turn.allowedLlmRoutes.map((route) => route.model),
    turn.llmRoute.model,
    turn.workingDirectory,
    ...turn.mcpServerIds,
    ...turn.skillTargetPaths.flatMap((skill) => [skill.id, skill.targetPath]),
  ];
  if (fields.some((field) => secrets.some((secret) => secret && field.includes(secret)))) {
    throw new Error('OpenCode refused a Turn field that contains a loopback credential.');
  }
}

function normalizeServerIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.some((id) => !SERVER_ID_PATTERN.test(id))) {
    throw new Error('OpenCode refused an MCP server id.');
  }
  return unique;
}

/** Validates native MCP shape and status core without imposing managed id policy. */
function assertMcpList(
  value: unknown
): asserts value is { data: Array<{ name: string; status: { status: string } }> } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { data?: unknown }).data)
  ) {
    throw new Error('OpenCode MCP status list has an unknown shape.');
  }
  for (const server of (value as { data: unknown[] }).data) {
    if (typeof server !== 'object' || server === null)
      throw new Error('OpenCode MCP status entry is malformed.');
    const row = server as Record<string, unknown>;
    const status = row.status as { status?: unknown; error?: unknown } | null;
    if (
      typeof row.name !== 'string' ||
      typeof status !== 'object' ||
      status === null ||
      typeof status.status !== 'string' ||
      !['connected', 'pending', 'disabled', 'failed', 'needs_auth'].includes(status.status)
    ) {
      throw new Error('OpenCode MCP server status is unknown.');
    }
    if (
      (status.status === 'failed' || status.status === 'needs_auth') &&
      typeof status.error !== 'string'
    ) {
      throw new Error('OpenCode MCP server error status is malformed.');
    }
  }
}

/** Inspects native documents for value-free warnings and shadowed managed model ids. */
async function inspectNativeBindings(
  client: OpenCodeClient,
  workingDirectory: string,
  configPath: string,
  ids: readonly string[],
  rpc: NativeRpc
): Promise<{ warnings: string; models: string[] }> {
  const models = new Set<string>();
  const warnings = new Set<string>();
  const entries = await rpc(
    'config.get native bindings',
    client.config.get({ location: { directory: workingDirectory } })
  );
  for (const entry of entries) {
    if (entry.type !== 'document' || !entry.path || entry.path === configPath) continue;
    if (Object.hasOwn(entry.info.providers ?? {}, OPENCODE_PROVIDER_ID)) {
      warnings.add('OpenCode protected provider overrides a native configuration entry.');
      for (const id of Object.keys(entry.info.providers?.[OPENCODE_PROVIDER_ID]?.models ?? {}))
        models.add(id);
    }
    if (ids.some((id) => Object.hasOwn(entry.info.mcp?.servers ?? {}, id))) {
      warnings.add('OpenCode protected MCP binding overrides a native configuration entry.');
    }
  }
  return { warnings: [...warnings].join(' '), models: [...models] };
}

async function syncMcpServers(
  client: OpenCodeClient,
  ids: readonly string[],
  capabilityBaseUrl: string,
  workingDirectory: string,
  loopbackDir: string,
  rpc: NativeRpc,
  deadline: LifecycleDeadline
): Promise<void> {
  const location = { directory: workingDirectory };
  writeSecret(
    join(loopbackDir, 'mcp-grants'),
    JSON.stringify(
      Object.fromEntries(ids.map((id) => [id, `${capabilityBaseUrl.replace(/\/$/, '')}/mcp/${id}`]))
    )
  );
  const marker = join(
    loopbackDir,
    `tools-${createHash('sha256').update(workingDirectory).digest('hex')}`
  );
  const existing = await rpc('mcp.list', client.mcp.list({ location }));
  assertMcpList(existing);
  const nativeServers = existing.data.filter(
    (server) =>
      !ids.includes(server.name) && ['connected', 'pending'].includes(server.status.status)
  );
  if (ids.length > 0 || nativeServers.length > 0) await waitForToolGeneration(marker, 0, deadline);
  for (const server of nativeServers) {
    const before = toolGeneration(marker);
    // Native connect drains its startup and publishes ToolsChanged even when already connected.
    // Reuse the existing location-specific reload proof for native as well as managed supply.
    await rpc('mcp.connect native', client.mcp.connect({ location, server: server.name }));
    await waitForToolGeneration(marker, before, deadline);
  }
  for (const id of ids) {
    const before = toolGeneration(marker);
    await rpc(
      'mcp.add',
      client.mcp.add({
        location,
        config: {
          codemode: false,
          oauth: false,
          type: 'remote',
          url: `${capabilityBaseUrl.replace(/\/$/, '')}/mcp/${id}`,
        },
        server: id,
      })
    );
    // MCP.add lists once; the native MCP.ToolsChanged event reloads Tool asynchronously.
    // Await the plugin's Tool transform generation rather than guessing a debounce delay.
    await waitForToolGeneration(marker, before, deadline);
  }
  if (ids.length === 0) return;
  for (;;) {
    if (deadline.workRemainingMs() <= 0) throw new Error('OpenCode MCP server did not connect.');
    const listed = await rpc('mcp.list', client.mcp.list({ location }));
    assertMcpList(listed);
    const pending: string[] = [];
    for (const id of ids) {
      const status = listed.data.find((server) => server.name === id)?.status.status;
      if (status === 'connected') continue;
      if (status !== 'pending') throw new Error('OpenCode selected MCP server is unavailable.');
      pending.push(id);
    }
    if (pending.length === 0) return;
    await delay(deadline.workRemainingMs(100));
  }
}

/** Reads the value-free generation published by the native Tool registry transform. */
function toolGeneration(path: string): number {
  try {
    const value = Number(readFileSync(path, 'utf8'));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Proves one location's registry generation within the enclosing preparation work budget. */
async function waitForToolGeneration(
  path: string,
  previous: number,
  deadline: LifecycleDeadline
): Promise<void> {
  for (;;) {
    if (deadline.workRemainingMs() <= 0)
      throw new Error('OpenCode native tool registry did not reload.');
    if (toolGeneration(path) > previous) return;
    await delay(deadline.workRemainingMs(20));
  }
}

async function settleTurn(options: {
  before: Set<string>;
  promptId: string;
  child: ChildProcess;
  client: OpenCodeClient;
  logPath: string;
  output: () => { stderr: string; stdout: string };
  secrets: readonly string[];
  sessionId: string;
  startedAt: number;
  stop: () => Promise<boolean>;
  interruptRequested: () => boolean;
  rpc: NativeRpc;
  observed: (messages: NativeMessage[]) => Promise<void>;
  published: (messages: NativeMessage[]) => Promise<void>;
}): Promise<WorkerAdapterResult> {
  const finish = (result: WorkerAdapterResult) =>
    attachStreams(result, options.output(), options.secrets);
  const lostEvidence = async (detail: string): Promise<WorkerAdapterResult> => {
    const safeDetail = boundOpenCodeDiagnostic(detail, options.secrets);
    if (!(await options.stop())) throw new Error(safeDetail);
    return finish(failedResult(safeDetail, options.secrets));
  };
  try {
    const stderrAtStart = options.output().stderr.length;
    const logAtStart = fileSize(options.logPath);
    let outcome: string | undefined;
    for (;;) {
      if (options.child.exitCode !== null || options.child.signalCode !== null) {
        return finish(failedResult('OpenCode server exited during the Turn.', options.secrets));
      }
      const drained = `${options.output().stderr.slice(stderrAtStart)}\n${readSince(
        options.logPath,
        logAtStart
      )}`;
      if (drained.includes('Failed to drain Session')) {
        return lostEvidence('OpenCode session drain failed.');
      }
      const info = await options.rpc(
        'session.get',
        options.client.session.get({ sessionID: options.sessionId })
      );
      assertSessionInfo(info, options.sessionId);
      if (await replyNativePrompts(options.client, options.sessionId, options.rpc)) {
        return lostEvidence(
          'OpenCode unexpected native permission was refused; native drain was not proved.'
        );
      }
      if ((info.time.idle ?? 0) >= options.startedAt) {
        outcome = info.outcome;
        break;
      }
      // Reuse the native poll owner so structural facts survive a later terminal or host loss.
      await options.observed(await listMessages(options.client, options.sessionId, options.rpc));
      await delay(200);
    }
    const all = await listMessages(options.client, options.sessionId, options.rpc);
    const messages = all.filter((message) => !options.before.has(message.id));
    // Correlate and freeze provenance before structural publication or capture finalization.
    const result = {
      ...interpretMessages(messages, options.promptId, options.secrets, outcome),
      interruptRequested: options.interruptRequested(),
    };
    await options.published(all);
    return finish(result);
  } catch (error) {
    return lostEvidence(errorText(error));
  }
}

function attachStreams(
  result: WorkerAdapterResult,
  output: { stderr: string; stdout: string },
  secrets: readonly string[]
): WorkerAdapterResult {
  if (result.status !== 'failed') return result;
  const diagnostics = { ...(result.diagnostics ?? {}) };
  if (output.stderr) diagnostics.stderr = boundOpenCodeDiagnostic(output.stderr, secrets);
  if (output.stdout) diagnostics.stdout = boundOpenCodeDiagnostic(output.stdout, secrets);
  return { ...result, diagnostics };
}

async function replyNativePrompts(
  client: OpenCodeClient,
  sessionId: string,
  rpc: NativeRpc,
  // Retain refusal for future user-configurable policy; the current default grants once.
  decision: 'once' | 'reject' = OPENCODE_PERMISSION_REPLY
): Promise<boolean> {
  const requests = await rpc('permission.list', client.permission.list({ sessionID: sessionId }));
  for (const request of requests) {
    await rpc(
      'permission.reply',
      client.permission.reply({
        decision,
        requestID: request.id,
        sessionID: sessionId,
      })
    );
  }
  const forms = await rpc('session.form.list', client.session.form.list({ sessionID: sessionId }));
  for (const form of forms) {
    await rpc(
      'session.form.cancel',
      client.session.form.cancel({ formID: form.id, sessionID: sessionId })
    );
  }
  return (decision === 'reject' && requests.length > 0) || forms.length > 0;
}

interface NativeMessage {
  finish?: string;
  id: string;
  outcome?: string;
  text: string;
  error?: boolean;
  type: string;
  /** Native tool snapshots consumed only by the existing structural/content collector. */
  tools?: Record<string, unknown>[];
}

/** Collects bounded native pages, validating cursor cores and identities before any Turn projection. */
async function listMessages(
  client: OpenCodeClient,
  sessionId: string,
  rpc: NativeRpc
): Promise<NativeMessage[]> {
  const rows: NativeMessage[] = [];
  const identities = new Set<string>();
  let cursor: string | undefined;
  let contentBytes = 0;
  let envelopeBytes = 0;
  for (let page = 0; page < 20; page += 1) {
    const response = await rpc(
      'message.list',
      client.message.list({
        sessionID: sessionId,
        ...(cursor ? { cursor } : { order: 'asc' as const }),
      })
    );
    if (!Array.isArray(response.data)) {
      throw new Error('OpenCode message list has an unknown shape.');
    }
    for (const row of response.data) {
      const { content, ...envelope } = row as Record<string, unknown>;
      contentBytes += nativeBytes(content);
      envelopeBytes += nativeBytes(envelope);
      if (contentBytes > RESULT_BYTE_LIMIT || envelopeBytes > RESULT_BYTE_LIMIT)
        throw new Error('OpenCode native result exceeded 16 MiB.');
      const message = readMessage(row);
      if (identities.has(message.id)) {
        throw new Error('OpenCode repeated one native message identity.');
      }
      identities.add(message.id);
      rows.push(message);
    }
    const envelope: unknown = response.cursor;
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      throw new Error('OpenCode pagination cursor envelope is unknown.');
    }
    const next = (envelope as { next?: unknown }).next;
    if (next !== undefined && next !== null && (typeof next !== 'string' || next.length === 0))
      throw new Error('OpenCode pagination cursor is unknown.');
    if (next === undefined || next === null) return rows;
    cursor = next;
  }
  throw new Error('OpenCode message list did not end.');
}

/** Counts content as UTF-8 bytes before accumulating parts or pages; stops at the bound. */
function nativeBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (!value || typeof value !== 'object') return 0;
  let bytes = 0;
  for (const [key, member] of Object.entries(value)) {
    if (key === 'type') continue;
    bytes += nativeBytes(member);
    if (bytes > RESULT_BYTE_LIMIT) break;
  }
  return bytes;
}

/** Detects new or changed already-published terminals before the next native prompt. */
function assertPublishedBoundary(
  previous: readonly NativeMessage[],
  current: readonly NativeMessage[]
): void {
  const old = new Map(previous.map((row) => [row.id, row]));
  for (const row of current) {
    const prior = old.get(row.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row))
      throw new Error('OpenCode published terminal boundary changed.');
    if (
      !prior &&
      (row.type === 'idle' || (row.type === 'assistant' && row.finish !== 'tool-calls'))
    )
      throw new Error('OpenCode received late terminal evidence after publication.');
  }
  if (previous.some((row) => !current.some((candidate) => candidate.id === row.id)))
    throw new Error('OpenCode published terminal boundary disappeared.');
}

function readMessage(value: unknown): NativeMessage {
  if (typeof value !== 'object' || value === null) {
    throw new Error('OpenCode message has an unknown shape.');
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.type !== 'string') {
    throw new Error('OpenCode message identity is missing.');
  }
  if (row.type === 'assistant') return readAssistant(row);
  if (row.type === 'idle') {
    if (row.outcome !== 'succeeded' && row.outcome !== 'failed' && row.outcome !== 'interrupted') {
      throw new Error('OpenCode idle outcome is unknown.');
    }
    return { id: row.id, outcome: row.outcome, text: '', type: 'idle' };
  }
  if (
    ![
      'user',
      'synthetic',
      'system',
      'skill',
      'shell',
      'compaction',
      'agent-switched',
      'model-switched',
      'location-switched',
    ].includes(row.type)
  ) {
    throw new Error('OpenCode message type is unknown.');
  }
  return { id: row.id, text: '', type: row.type };
}

function readAssistant(row: Record<string, unknown>): NativeMessage {
  if (
    row.finish !== undefined &&
    row.finish !== 'stop' &&
    row.finish !== 'length' &&
    row.finish !== 'tool-calls' &&
    row.finish !== 'content-filter' &&
    row.finish !== 'error' &&
    row.finish !== 'unknown'
  ) {
    throw new Error('OpenCode assistant finish is unknown.');
  }
  if (!Array.isArray(row.content)) throw new Error('OpenCode assistant content is missing.');
  let text = '';
  for (const part of row.content) {
    if (typeof part !== 'object' || part === null) {
      throw new Error('OpenCode assistant content part is unknown.');
    }
    const record = part as Record<string, unknown>;
    if (record.type === 'text') {
      if (typeof record.text !== 'string') throw new Error('OpenCode assistant text is unknown.');
      if (
        Buffer.byteLength(text, 'utf8') + Buffer.byteLength(record.text, 'utf8') >
        RESULT_BYTE_LIMIT
      )
        throw new Error('OpenCode assistant output exceeded 16 MiB.');
      text += record.text;
      continue;
    }
    if (record.type !== 'reasoning' && record.type !== 'tool') {
      throw new Error('OpenCode assistant content type is unknown.');
    }
  }
  return {
    ...(typeof row.finish === 'string' ? { finish: row.finish } : {}),
    id: String(row.id),
    error: row.error !== undefined,
    text,
    type: 'assistant',
    tools: row.content.filter(
      (part) => (part as Record<string, unknown>).type === 'tool'
    ) as Record<string, unknown>[],
  };
}

/** Maps observed native message snapshots into the existing semantic collector; reasoning is excluded. */
async function captureOpenCodeMessage(
  capture: RuntimeSemanticCapture,
  sourceRef: string,
  originRef: string,
  namespace: string,
  message: NativeMessage
): Promise<void> {
  if (message.type !== 'assistant') return;
  await capture.emit(
    sourceRef,
    {
      kind: 'assistant',
      runtimeOriginRef: originRef,
      messageRef: runtimeRef('rtm', namespace, `${originRef}:${message.id}`),
      phase:
        message.error || message.finish === 'error'
          ? 'failed'
          : message.finish === undefined
            ? 'running'
            : 'completed',
      representation: 'snapshot',
    },
    {
      bytes: Buffer.from(message.text),
      mediaType: 'text/plain',
      boundary: 'runtime.assistant.text',
    }
  );
  for (const tool of message.tools ?? []) {
    const state = tool.state;
    if (
      typeof tool.id !== 'string' ||
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state)
    ) {
      await capture.emit(sourceRef, {
        kind: 'coverage',
        runtimeOriginRef: originRef,
        family: 'primary-content',
        coverage: 'unavailable',
        reason: 'malformed-frame',
      });
      continue;
    }
    const record = state as Record<string, unknown>;
    const phase =
      record.status === 'completed'
        ? 'completed'
        : record.status === 'error'
          ? 'failed'
          : record.status === 'running'
            ? 'running'
            : record.status === 'streaming'
              ? 'started'
              : undefined;
    if (!phase) {
      await capture.emit(sourceRef, {
        kind: 'coverage',
        runtimeOriginRef: originRef,
        family: 'primary-content',
        coverage: 'unavailable',
        reason: 'malformed-frame',
      });
      continue;
    }
    const fact: RuntimeFact = {
      kind: 'tool' as const,
      runtimeOriginRef: originRef,
      callRef: runtimeRef('rtc', namespace, `${originRef}:${tool.id}`),
      phase,
      ...(runtimeToolName(tool.name) ? { toolName: runtimeToolName(tool.name) } : {}),
    };
    await capture.emit(
      sourceRef,
      fact,
      record.input === undefined
        ? undefined
        : {
            bytes: Buffer.from(
              typeof record.input === 'string' ? record.input : JSON.stringify(record.input)
            ),
            mediaType: typeof record.input === 'string' ? 'text/plain' : 'application/json',
            boundary: 'runtime.tool.arguments',
          }
    );
    if (Array.isArray(record.content))
      await capture.emit(sourceRef, fact, {
        bytes: Buffer.from(JSON.stringify(record.content)),
        mediaType: 'application/json',
        boundary: 'runtime.tool.result',
      });
  }
  await capture.flushCompleted();
}

function interpretMessages(
  messages: readonly NativeMessage[],
  promptId: string,
  secrets: readonly string[],
  outcome: string | undefined
): WorkerAdapterResult {
  // This pin has no assistant parent id. The admitted user message and the next idle
  // delimit the Turn in its ordered conversation; prior ids were removed above.
  const promptIndex = messages.findIndex(
    (message) => message.id === promptId && message.type === 'user'
  );
  if (
    promptIndex < 0 ||
    messages.slice(promptIndex + 1).some((message) => message.type === 'user')
  ) {
    throw new Error('OpenCode terminal evidence is not correlated to the admitted prompt.');
  }
  messages = messages.slice(promptIndex + 1);
  const finals = messages.filter(
    (message) =>
      message.type === 'assistant' &&
      message.finish !== undefined &&
      message.finish !== 'tool-calls'
  );
  if (finals.some((message) => message.error && SETTLED_ASSISTANT_FINISH.has(message.finish ?? '')))
    throw new Error('OpenCode assistant carries native error evidence.');
  if (finals.length > 1) throw new Error('OpenCode assistant terminal evidence is contradictory.');
  const idles = messages.filter((message) => message.type === 'idle');
  const idle = idles.at(-1);
  if (idles.length !== 1 || messages.at(-1) !== idle || outcome !== idle?.outcome) {
    throw new Error(
      'OpenCode terminal boundary is missing, duplicate, unordered, or contradictory.'
    );
  }
  const assistant = [...messages].reverse().find((message) => message.type === 'assistant');
  if (
    idle?.outcome === 'succeeded' &&
    assistant &&
    !SETTLED_ASSISTANT_FINISH.has(assistant.finish ?? '')
  ) {
    throw new Error('OpenCode terminal evidence is contradictory.');
  }
  if (
    idle?.outcome !== 'succeeded' &&
    idle &&
    assistant &&
    SETTLED_ASSISTANT_FINISH.has(assistant.finish ?? '')
  ) {
    throw new Error('OpenCode terminal evidence is contradictory.');
  }
  if (idle?.outcome === 'interrupted')
    return { assistantText: null, status: 'interrupted', stopReason: 'interrupted' };
  if (idle?.outcome === 'failed') {
    return failedResult(`OpenCode turn outcome is ${idle.outcome}.`, secrets);
  }
  if (!assistant) {
    if (idle?.outcome === 'succeeded') {
      return { assistantText: null, status: 'completed', stopReason: 'completed' };
    }
    return failedResult('OpenCode turn ended without an assistant message.', secrets);
  }
  if (assistant.finish === undefined || !SETTLED_ASSISTANT_FINISH.has(assistant.finish)) {
    return failedResult(`OpenCode assistant finish is ${assistant.finish ?? 'missing'}.`, secrets);
  }
  if (Buffer.byteLength(assistant.text, 'utf8') > RESULT_BYTE_LIMIT) {
    return failedResult('OpenCode assistant output exceeded 16 MiB.', secrets);
  }
  if (secrets.some((secret) => secret && assistant.text.includes(secret))) {
    return failedResult('OpenCode assistant output contained a loopback credential.', secrets);
  }
  if (assistant.finish === 'length')
    return { assistantText: null, status: 'length', stopReason: 'length' };
  return {
    assistantText: assistant.text.length > 0 ? assistant.text : null,
    status: 'completed',
    stopReason: 'completed',
  };
}

function failedResult(detail: string, secrets: readonly string[]): WorkerAdapterResult {
  return {
    assistantText: null,
    diagnostics: { native: boundOpenCodeDiagnostic(detail, secrets) },
    status: 'failed',
    stopReason: 'error',
  };
}

function defaultSpawnServer(
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): ChildProcess {
  return spawn(binary, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Turn returned when a rejected open or Turn cannot prove that the native process exited.
 * `settled` rejects with the original failure. `interrupt` resolves only after a later stop is
 * confirmed, and otherwise rejects so the Harness fences the unproved stop.
 *
 * @param error Failure that must not be reported as a clean refusal while the process may be live.
 * @param confirmStopped Later stop attempt used by the Harness interrupt.
 * @returns A resident Turn the Harness accepts only so it can fence the stop.
 */
export function surfaceUnprovedOpenCodeTurn(
  error: unknown,
  confirmStopped: (deadline?: LifecycleDeadline) => Promise<boolean>
): WorkerResidentTurn {
  const settled = Promise.reject(error);
  settled.catch(() => undefined);
  return {
    async interrupt(deadline) {
      if (await confirmStopped(deadline)) return;
      throw new Error('OpenCode native stop was not proved.');
    },
    settled,
  };
}

/**
 * Stops one child and reports whether its exit was observed. A signal that cannot be delivered,
 * or an exit event that does not arrive, is not treated as a dead process.
 *
 * @returns True only when no process remains.
 */
async function stopChild(
  child: ChildProcess,
  markStopping: () => void,
  exited: Promise<void>,
  hasExited: () => boolean,
  markExited: () => void,
  timeoutMs: number,
  deadline: LifecycleDeadline,
  requested: (signal: NodeJS.Signals) => void
): Promise<boolean> {
  if (hasExited()) return true;
  if (child.pid === undefined) {
    await nativeDeadline('process exit', exited, deadline.remainingMs(timeoutMs)).catch(
      () => undefined
    );
    if (!hasExited()) markExited();
    return true;
  }
  markStopping();
  const termWindowMs = deadline.remainingMs(Math.min(timeoutMs, deadline.remainingMs() / 2));
  requested('SIGTERM');
  deliverSignal(child, 'SIGTERM', hasExited, markExited);
  if (hasExited()) return true;
  await nativeDeadline('process exit', exited, termWindowMs).catch(() => undefined);
  if (hasExited()) return true;
  requested('SIGKILL');
  const killed = deliverSignal(child, 'SIGKILL', hasExited, markExited);
  if (hasExited()) return true;
  if (!killed) return false;
  await nativeDeadline('process exit', exited, deadline.remainingMs(timeoutMs)).catch(
    () => undefined
  );
  return hasExited();
}

/** Sends one signal. An `ESRCH` failure means the process is already gone. */
function deliverSignal(
  child: ChildProcess,
  signal: NodeJS.Signals,
  hasExited: () => boolean,
  markExited: () => void
): boolean {
  try {
    return child.kill(signal) !== false || hasExited();
  } catch (error) {
    if (hasExited() || isProcessGone(error)) {
      markExited();
      return true;
    }
    return false;
  }
}

/** Whether `child.kill` failed because the process had already exited. */
function isProcessGone(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ESRCH'
  );
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= DIAGNOSTIC_BYTE_LIMIT) return current;
  return (current + chunk).slice(0, DIAGNOSTIC_BYTE_LIMIT);
}

function fileSize(path: string): number {
  try {
    return readFileSync(path).byteLength;
  } catch {
    return 0;
  }
}

function readSince(path: string, offset: number): string {
  try {
    return readFileSync(path).subarray(offset).toString('utf8');
  } catch {
    return '';
  }
}

function writeSecret(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
}

function basicAuth(password: string): string {
  return Buffer.from(`opencode:${password}`).toString('base64');
}

/** Preserves vendor cause codes/messages without serializing request or socket metadata. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  // The SDK wraps fetch, which wraps the socket error; cap malformed or cyclic vendor chains.
  for (let depth = 0; depth < 8 && !seen.has(error); depth += 1) {
    seen.add(error);
    if (typeof error !== 'object' || error === null) {
      parts.push(String(error));
      break;
    }
    const detail = error as { message?: unknown; code?: unknown; cause?: unknown };
    const message = typeof detail.message === 'string' ? detail.message : String(error);
    const code = typeof detail.code === 'string' || typeof detail.code === 'number';
    parts.push(code ? `${detail.code}: ${message}` : message);
    if (detail.cause === undefined) break;
    error = detail.cause;
  }
  return parts.join('; cause: ');
}

type NativeRpc = <T>(name: string, work: Promise<T>) => Promise<T>;

class NativeDeadlineError extends Error {}

/** Clears each exchange timer; enclosing lifecycle deadlines supply remaining time. */
function nativeDeadline<T>(name: string, work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new NativeDeadlineError(`OpenCode ${name} timed out.`)),
      timeoutMs
    );
  });
  return Promise.race([work, expired]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
