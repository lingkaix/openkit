import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import {
  isProtectedNativeEnvironmentName,
  WorkerErrorEnvelopeSchema,
} from '@openkit/worker-protocol';
import type {
  WorkerAdapterLlmRoute,
  WorkerAdapterResult,
  WorkerNativeHandle,
  WorkerResidentAdapter,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurn,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import { CodexRuntimeCapture } from '../codex-runtime-capture.js';
import { validateTurnReasoningEffort } from '../reasoning-effort.js';
import {
  CODEX_APPROVAL_POLICY,
  CODEX_RPC_TIMEOUT_MS,
  CODEX_SANDBOX,
  CodexAppServer,
  codexThreadItemTypes,
  codexTurnStatuses,
  redactDiagnostic,
} from './codex-app-server.js';

/** Wait after SIGTERM, and again after SIGKILL, before an exit is treated as unproved. */
const CODEX_STOP_GRACE_MS = 2_000;
/** Complete setup control budget; the following bounded stop keeps the total below ten seconds. */
const CODEX_SETUP_TIMEOUT_MS = 5_000;
/** Filesystem inspection and correlated interrupt-terminal deadlines. */
const CODEX_INSPECT_TIMEOUT_MS = 1_000;

/** Races a control operation and always releases its deadline timer. Model work is not timed. */
async function controlDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error('Codex control deadline expired.'));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Deployment pin selected from the npm `latest` dist-tag and proved as App Server v2. */
export const CODEX_ADAPTER_VERSION = '0.159.2';
/** Fixed provider id. An AEP provider id is never copied into Codex. */
export const CODEX_PROVIDER_ID = 'openkit-worker-inference';
/** Native assistant text bound. Larger UTF-8 results fail the Turn. */
export const CODEX_RESULT_MAX_BYTES = 16 * 1024 * 1024;

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MCP_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Image-owned immutable binary, installed by the worker-runtimes Codex slice. */
export const CODEX_PRODUCTION_BINARY = '/usr/local/lib/codex/bin/codex';

/**
 * Environment of the supervised process. `CODEX_HOME` is the complete admitted retained native home.
 * Loopback credentials are not copied into this environment.
 */
export function codexChildEnvironment(
  environment: Readonly<Record<string, string>>,
  stateRoot: string
): NodeJS.ProcessEnv {
  return { ...environment, CODEX_HOME: stateRoot };
}

/** Launch controls protect external routing and credential custody without limiting local tools. */
export function codexLaunchArguments(): readonly string[] {
  return [
    'app-server',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'features.web_search_request=false',
    '-c',
    'cli_auth_credentials_store="ephemeral"',
    '-c',
    'model_provider="openai"',
  ];
}

/**
 * Normalizes one terminal Codex turn. Cancellation wins over partial assistant text.
 * More than one assistant message, an unknown status, or a result over 16 MiB fails closed.
 */
export function normalizeCodexAssistant(
  status: string,
  texts: readonly string[]
): WorkerAdapterResult {
  if (status === 'process-exited' || status === 'identity-mismatch') {
    return { assistantText: null, status: 'failed', stopReason: status };
  }
  if (status === 'interrupted' || status === 'failed') {
    return { assistantText: null, status, stopReason: status };
  }
  if (status !== 'completed') {
    return { assistantText: null, status: 'failed', stopReason: 'malformed-result' };
  }
  if (texts.length > 1) {
    return { assistantText: null, status: 'failed', stopReason: 'malformed-result' };
  }
  const text = texts[0] ?? '';
  if (Buffer.byteLength(text, 'utf8') > CODEX_RESULT_MAX_BYTES) {
    return { assistantText: null, status: 'failed', stopReason: 'result-too-large' };
  }
  const trimmed = text.trim();
  return {
    assistantText: trimmed.length > 0 ? trimmed : null,
    status: 'completed',
    stopReason: 'completed',
  };
}

/** Rejects routes the pinned App Server cannot represent before a native Turn is admitted. */
function assertRelayRoute(route: WorkerAdapterLlmRoute): void {
  if (
    route.credentialVisibility !== 'placeholder' ||
    route.endpoint.kind !== 'openai-compatible' ||
    route.endpoint.workerBaseUrl !== undefined ||
    route.endpoint.upstream?.kind !== 'nanocore-gateway'
  ) {
    throw new Error('Codex rejected a route it cannot represent as the worker inference relay.');
  }
}

/** Canonicalizes admitted core route values, ignoring only additive content. */
function routeKey(route: WorkerAdapterLlmRoute): string {
  assertRelayRoute(route);
  if (
    [route.id, route.model, route.providerInstanceId].some(
      (value) => typeof value !== 'string' || value.length === 0
    )
  )
    throw new Error('Codex rejected an invalid route identity.');
  const params = route.modelParameters;
  if (
    params &&
    (!Number.isSafeInteger(params.contextWindow) ||
      params.contextWindow <= 0 ||
      !Number.isSafeInteger(params.maxOutputTokens) ||
      params.maxOutputTokens <= 0 ||
      typeof params.reasoning !== 'boolean' ||
      !Array.isArray(params.inputModalities) ||
      params.inputModalities.some(
        (value) => !['text', 'image', 'audio', 'video', 'pdf'].includes(value)
      ))
  )
    throw new Error('Codex rejected invalid route model parameters.');
  return JSON.stringify([
    route.id,
    route.model,
    route.providerInstanceId,
    route.reasoningEffortLevels !== undefined,
    route.credentialVisibility,
    route.endpoint.kind,
    route.endpoint.upstream?.kind,
    route.endpoint.upstream?.baseUrlRef ?? null,
    params
      ? [
          params.contextWindow,
          params.maxOutputTokens,
          [...params.inputModalities].sort(),
          params.reasoning,
        ]
      : null,
  ]);
}

/** Rejects an environment that would replace adapter-owned launch, home, or credentials. */
function assertLaunchEnvironment(
  environment: Readonly<Record<string, string>>,
  secrets: readonly string[]
): void {
  for (const [name, value] of Object.entries(environment)) {
    // The Harness has already supplied trusted shared bootstrap bindings such as HOME and TMPDIR.
    // Refuse the Codex-specific projection without rejecting that managed bootstrap supply.
    if (
      isProtectedNativeEnvironmentName(name, 'codex') &&
      !isProtectedNativeEnvironmentName(name, '')
    ) {
      throw new Error(`Codex rejected environment ${name}.`);
    }
    if (secrets.some((secret) => secret && value.includes(secret))) {
      throw new Error('Codex rejected an environment value carrying a loopback credential.');
    }
  }
}

/** Projects supplied credentials in memory; idle identities are disabled regardless of transport. */
function sessionConfig(
  input: WorkerResidentOpenInput,
  mcpServerIds: readonly string[],
  idleMcpServerIds: readonly string[] = []
): Record<string, unknown> {
  const servers: Record<string, unknown> = Object.fromEntries(
    idleMcpServerIds.map((id) => [id, { enabled: false }])
  );
  const capabilityBase = input.loopback.capabilityBaseUrl.replace(/\/$/, '');
  for (const id of mcpServerIds) {
    if (!MCP_SERVER_ID.test(id)) throw new Error('Codex rejected an MCP server id.');
    servers[id] = {
      enabled: true,
      url: `${capabilityBase}/mcp/${id}`,
      http_headers: { Authorization: `Bearer ${input.loopback.capabilityCredential}` },
    };
  }
  return {
    model_provider: CODEX_PROVIDER_ID,
    web_search: 'disabled',
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: 'OpenKit worker inference',
        base_url: input.loopback.inferenceBaseUrl.replace(/\/$/, ''),
        wire_api: 'responses',
        requires_openai_auth: false,
        experimental_bearer_token: input.loopback.inferenceCredential,
      },
    },
    mcp_servers: servers,
  };
}

/** Decodes a resume reference. Corrupt bytes fail before a process is started. */
function decodeThreadId(reference: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(reference);
  } catch {
    throw new Error('Codex resume reference is not UTF-8.');
  }
  if (!THREAD_ID.test(text)) throw new Error('Codex resume reference is not a thread id.');
  return text;
}

/** Reads assistant texts from a terminal turn or an `item/completed` agent message. */
function assistantTexts(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Codex assistant item is malformed.');
  const items = (value as { items?: unknown }).items;
  const single = 'type' in value ? [value] : null;
  if (items !== undefined && !Array.isArray(items))
    throw new Error('Codex assistant items are malformed.');
  const records = single ?? items ?? [];
  const texts: string[] = [];
  for (const item of records) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Codex assistant item is malformed.');
    const record = item as { type?: unknown; text?: unknown };
    if (typeof record.type !== 'string' || !KNOWN_ITEM_TYPES.has(record.type))
      throw new Error('Codex assistant item type is unknown.');
    if (record.type !== 'agentMessage') continue;
    if (typeof record.text !== 'string') throw new Error('Codex assistant item is malformed.');
    if (record.text.trim()) texts.push(record.text);
  }
  return texts;
}

const KNOWN_ITEM_TYPES = new Set(codexThreadItemTypes());
const KNOWN_TURN_STATUSES = new Set(codexTurnStatuses());
if (!KNOWN_ITEM_TYPES.has('agentMessage') || !KNOWN_TURN_STATUSES.has('completed')) {
  throw new Error('Pinned Codex schema is missing consumed Turn discriminants.');
}

interface ThreadBody {
  readonly thread?: { readonly id?: string; readonly path?: string; readonly cwd?: string };
}

interface TurnBody {
  readonly turn?: { readonly id?: string; readonly status?: string; readonly items?: unknown };
}

/** One supervised App Server binding. The handle reference is the UTF-8 thread id. */
class CodexResidentSession implements WorkerResidentSession {
  readonly exited: Promise<void>;
  private readonly rpc: CodexAppServer;
  private readonly secrets: readonly string[];
  private readonly resolveExited: () => void;
  private threadId: string | null = null;
  private rolloutPath: string | null = null;
  private child: ChildProcessWithoutNullStreams | null;
  private phase: 'running' | 'stopping' | 'absent' | 'unknown' = 'running';
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private invalidation: Promise<WorkerAdapterResult> | null = null;
  private terminalSeen = false;
  /** True while an intentional stop is in progress, so that exit is not a host failure. */
  private suppressExit = false;
  /** A stop did not observe process exit. Close must fail so the Harness fences. */
  private exitUnproved = false;
  private stopInFlight: Promise<boolean> | null = null;
  private unusable = false;
  private active = false;
  /** Working directory and MCP ids bound when the thread was loaded. Null until that load. */
  private boundSupply: string | null = null;
  /** Canonical admitted descriptors fixed by the first Turn, independent of preferred order. */
  private boundRoutes: string | null = null;
  private readonly itemText = new Map<string, string[]>();
  private readonly turnWaiters = new Map<
    string,
    {
      resolve: (value: { status: string; texts: readonly string[] }) => void;
      reject: (error: Error) => void;
    }
  >();
  /** A terminal can arrive in the same stdout chunk as turn/start acceptance. */
  private earlyTerminal: { turnId: string; status: string; texts: readonly string[] } | null = null;
  private acceptingTurn = false;
  /** Per-Turn delivery evidence; no native effort selection is cached. */
  private reasoningEffortDelivery: string | undefined;
  /** Setup collisions reported through existing result diagnostics for this fixed supply. */
  private nativeConfigurationWarning: string | null = null;
  private currentTurnId: string | null = null;

  constructor(
    private readonly open: WorkerResidentOpenInput,
    child: ChildProcessWithoutNullStreams,
    private readonly stopGraceMs = CODEX_STOP_GRACE_MS,
    private readonly launch: CodexResidentLaunch = {}
  ) {
    this.child = child;
    this.secrets = [open.loopback.inferenceCredential, open.loopback.capabilityCredential];
    let resolveExited: (value: void | PromiseLike<void>) => void = () => undefined;
    this.exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    this.resolveExited = () => resolveExited();
    this.rpc = new CodexAppServer(
      child,
      this.secrets,
      (method, params) => this.onNotification(method, params),
      () => {
        void this.invalidateTurn('malformed-result').catch(() => undefined);
      },
      launch.controlTimeoutMs ?? CODEX_RPC_TIMEOUT_MS
    );
    child.on('exit', () => {
      this.phase = 'absent';
      this.child = null;
      if (!this.invalidation) this.failWaiters('process-exited');
      if (!this.closing && !this.suppressExit) this.resolveExited();
    });
  }

  childState(): 'absent' | 'running' | 'stopping' | 'unknown' {
    return this.phase;
  }

  /**
   * `ready` only when the rollout file at `thread.path` is non-empty, which is the resumable id.
   * A thread id whose file is still absent stays `pending`.
   */
  async nativeHandle(): Promise<WorkerNativeHandle> {
    const child = this.child;
    if (this.exitUnproved || this.phase !== 'running' || this.unusable || this.closing)
      return { state: 'unknown' };
    let exists: boolean;
    try {
      exists = await controlDeadline(
        this.rolloutExists(),
        this.launch.inspectTimeoutMs ?? CODEX_INSPECT_TIMEOUT_MS
      );
    } catch {
      return { state: 'unknown' };
    }
    if (
      child !== this.child ||
      !this.processIsLive() ||
      this.phase !== 'running' ||
      this.unusable ||
      this.closing
    )
      return { state: 'unknown' };
    if (!this.threadId || !exists) return { state: 'pending' };
    return { state: 'ready', reference: new TextEncoder().encode(this.threadId) };
  }

  /**
   * Shares the complete close result, including failure. This pin has no qualified native
   * drain/flush operation; stopping a host with a loaded conversation cannot certify flush.
   */
  close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  /** Attempts cleanup while preserving the unqualified native flush obligation. */
  private async closeOnce(): Promise<void> {
    const requiresFlush = this.threadId !== null || this.active;
    const stopped = await this.stopProcess();
    this.itemText.clear();
    this.earlyTerminal = null;
    if (!stopped || this.exitUnproved) {
      this.noteExitUnproved();
      throw new Error('Codex close did not confirm the process exited.');
    }
    if (requiresFlush)
      throw new Error(
        'Codex close has no proved native drain/persistence flush boundary for this pin.'
      );
  }

  /**
   * Handshake only for a new conversation. Resume proves the exact id before the handle is ready.
   * A failed resume leaves no new thread.
   */
  async establish(resumeThreadId: string | null): Promise<void> {
    await this.rpc.request('initialize', {
      clientInfo: { name: 'openkit-worker', title: 'OpenKit', version: CODEX_ADAPTER_VERSION },
    });
    await this.rpc.notify('initialized');
    let cwd = this.open.stateRoot;
    if (resumeThreadId) {
      // Metadata-only read proves the exact directory without loading a conversation or MCP clients.
      const metadata = (await this.rpc.request('thread/read', {
        threadId: resumeThreadId,
        includeTurns: false,
      })) as ThreadBody;
      if (
        metadata?.thread?.id !== resumeThreadId ||
        typeof metadata.thread.cwd !== 'string' ||
        !metadata.thread.cwd
      ) {
        throw new Error('Codex resumed conversation working directory is unproved.');
      }
      cwd = metadata.thread.cwd;
    }
    const idleMcpServerIds = Object.keys(await this.readEffectiveMcpServers(cwd));
    if (!resumeThreadId) return;
    const resumed = (await this.rpc.request('thread/resume', {
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX,
      modelProvider: CODEX_PROVIDER_ID,
      config: sessionConfig(this.open, [], idleMcpServerIds),
      threadId: resumeThreadId,
      cwd,
    })) as ThreadBody;
    this.rememberThread(resumed, resumeThreadId);
  }

  /** Reads and validates effective MCP entries without activating clients. */
  private async readEffectiveMcpServers(
    cwd: string
  ): Promise<Record<string, Record<string, unknown>>> {
    const effective = (await this.rpc.request('config/read', { includeLayers: false, cwd })) as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    if (
      !effective ||
      typeof effective !== 'object' ||
      !effective.config ||
      typeof effective.config !== 'object'
    )
      throw new Error('Codex effective native configuration is unproved.');
    const servers = effective.config.mcp_servers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
      throw new Error('Codex effective native MCP configuration is malformed.');
    const ids = Object.keys(servers);
    for (const id of ids) {
      const server = servers[id];
      if (!server || typeof server !== 'object' || Array.isArray(server))
        throw new Error('Codex native MCP configuration is malformed.');
    }
    return servers as Record<string, Record<string, unknown>>;
  }

  /**
   * Accepts one Turn once `turn/start` has a turn id. A rejection means that request was never
   * written, or the process was confirmed
   * exited. Otherwise the returned Turn is one the Harness cannot settle and therefore fences.
   */
  async startTurn(input: WorkerResidentTurnInput): Promise<WorkerResidentTurn> {
    const effort = validateTurnReasoningEffort(input);
    if (this.closing) throw new Error('Codex binding is closing.');
    if (this.exitUnproved && this.processIsLive()) {
      return this.surfaceLive(new Error('Codex runtime is unavailable.'));
    }
    const preferred = routeKey(input.llmRoute);
    if (!Array.isArray(input.allowedLlmRoutes) || input.allowedLlmRoutes.length === 0)
      throw new Error('Codex requires the admitted route set.');
    const routes = input.allowedLlmRoutes.map(routeKey).sort();
    if (
      !routes.includes(preferred) ||
      new Set(input.allowedLlmRoutes.map((route) => route.model)).size !== routes.length ||
      new Set(input.allowedLlmRoutes.map((route) => route.id)).size !== routes.length
    )
      throw new Error('Codex rejected an unadmitted or ambiguous preferred route.');
    const routeSet = JSON.stringify(routes);
    if (this.boundRoutes !== null && this.boundRoutes !== routeSet)
      throw new Error('Codex rejected a changed admitted route set.');
    if (input.runtimeProvenance)
      throw new Error('Codex App Server provenance is not implemented for this pin.');
    if (this.unusable || this.phase !== 'running' || this.active) {
      throw new Error('Codex binding cannot accept a Turn.');
    }
    this.reasoningEffortDelivery =
      input.llmRoute.reasoningEffortLevels === undefined
        ? 'not-delivered: model has no reasoning'
        : undefined;
    this.boundRoutes = routeSet;
    this.active = true;
    this.terminalSeen = false;
    this.rpc.permissionRecords.length = 0;
    let capture: CodexRuntimeCapture | null = null;
    let submitted = false;
    const native = { outstanding: false };
    try {
      const setup = async (): Promise<TurnBody> => {
        await this.bindSupply(input, native);
        const threadId = this.threadId;
        if (!threadId) throw new Error('Codex binding has no thread.');
        if (input.runtimeProvenance || input.runtimeCapture.captureCoverage.value === 'on') {
          capture = await CodexRuntimeCapture.create(
            input.runtimeCapture,
            this.open.stateRoot,
            CODEX_ADAPTER_VERSION
          );
          await capture.writeStdout(
            Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`)
          );
        }
        submitted = true;
        this.acceptingTurn = true;
        return (await this.nativeRequest(
          'turn/start',
          {
            threadId,
            input: [{ type: 'text', text: input.turnInput }],
            model: input.llmRoute.model,
            ...(effort !== undefined && input.llmRoute.reasoningEffortLevels !== undefined
              ? { effort }
              : {}),
          },
          native
        )) as TurnBody;
      };
      const started = await controlDeadline(
        setup(),
        this.launch.setupTimeoutMs ?? CODEX_SETUP_TIMEOUT_MS,
        () => {
          this.unusable = true;
        }
      );
      const threadId = this.threadId!;
      const turnId = started.turn?.id;
      const status = started.turn?.status;
      this.acceptingTurn = false;
      if (this.closing || this.unusable)
        throw new Error('Codex binding lost its native stream during acceptance.');
      if (
        typeof turnId !== 'string' ||
        turnId.length === 0 ||
        typeof status !== 'string' ||
        !KNOWN_TURN_STATUSES.has(status) ||
        !started.turn ||
        typeof started.turn !== 'object' ||
        Array.isArray(started.turn) ||
        !Array.isArray(started.turn.items)
      )
        throw new Error('Codex did not accept the Turn.');
      if (this.earlyTerminal && this.earlyTerminal.turnId !== turnId)
        throw new Error('Codex terminal identity did not match the accepted Turn.');
      if ([...this.itemText.keys()].some((id) => id !== turnId))
        throw new Error('Codex item identity did not match the accepted Turn.');
      assistantTexts(started.turn);
      this.currentTurnId = turnId;
      const settled = this.finishTurn(turnId, status, started.turn, capture);
      return {
        settled,
        interrupt: async () => {
          if (this.unusable || this.phase !== 'running') {
            if (!(await this.stopProcess()))
              throw new Error('Codex interrupt stop remains unproved.');
            return;
          }
          try {
            await controlDeadline(
              (async () => {
                const result = await this.rpc.request('turn/interrupt', { threadId, turnId });
                if (!result || typeof result !== 'object' || Array.isArray(result))
                  throw new Error('Codex interrupt result is malformed.');
                await settled;
              })(),
              this.launch.controlTimeoutMs ?? CODEX_RPC_TIMEOUT_MS
            );
          } catch {
            await this.invalidateTurn('interrupt-unproved');
          }
        },
      };
    } catch (error) {
      this.acceptingTurn = false;
      this.earlyTerminal = null;
      this.currentTurnId = null;
      this.itemText.clear();
      this.active = false;
      // No Turn was admitted: this reader owns no open handles or publishable final capture.
      // Native cleanup must not wait behind observational collection.
      if (!this.unusable && !this.closing && !native.outstanding && !submitted) throw error;
      return this.abandonUnaccepted(error);
    }
  }

  /**
   * Binds MCP servers and the working directory once, when the thread is loaded.
   * Codex does not list tools again at `turn/start`, so a later supply change is rejected
   * before any native request. The model stays on `turn/start`. Skill roots stay per Turn.
   * A resumed open has already proved the id with every effective MCP entry disabled, so its first Turn applies
   * the Turn supply once through `thread/unsubscribe` and `thread/resume`.
   */
  private async bindSupply(
    input: WorkerResidentTurnInput,
    native: { outstanding: boolean }
  ): Promise<void> {
    const key = `${input.workingDirectory}\n${[...input.mcpServerIds].sort().join('\n')}`;
    if (this.boundSupply !== null && this.boundSupply !== key) {
      throw new Error('Codex rejected a supply change; this binding does not re-list tools.');
    }
    if (this.boundSupply === null) {
      const authoredServers = await this.readEffectiveMcpServers(input.workingDirectory);
      const collisions = input.mcpServerIds.filter((id) => Object.hasOwn(authoredServers, id));
      const collision = collisions.find((id) => {
        const server = authoredServers[id]!;
        return typeof server.url !== 'string' || Object.hasOwn(server, 'command');
      });
      // HTTP entries accept the managed URL/header overlay. Other transports would produce a
      // broken merged entry; remove this refusal when native whole-entry replacement is available.
      if (collision) {
        const id = redactDiagnostic(collision, this.secrets);
        const envelope = WorkerErrorEnvelopeSchema.parse({
          code: 'codex_mcp_id_collision',
          message: `Codex ${CODEX_ADAPTER_VERSION} cannot replace authored MCP entry "${id}". Rename your authored entry to a different id before retrying this Turn.`,
          retryable: false,
          diagnostics: [
            {
              code: 'native_config_collision',
              message: `Warning: authored MCP entry "${id}" conflicts with a protected OpenKit id; Turn preparation was refused.`,
            },
          ],
        });
        throw Object.assign(new Error(envelope.message), envelope);
      }
      this.nativeConfigurationWarning = collisions.length
        ? redactDiagnostic(
            collisions
              .map((id) => `Warning: managed MCP entry "${id}" overrides authored HTTP entry.`)
              .join(' '),
            this.secrets
          )
        : null;
      // Omit idle overrides so native directory layers restore authored enabled/disabled state.
      // Only current supplied identities receive the authenticated Gateway projection.
      const config = sessionConfig(this.open, input.mcpServerIds);
      if (this.threadId) await this.applyResumedSupply(input, config, native);
      else await this.startNativeThread(input, config, native);
      this.boundSupply = key;
    }
    await this.setSkillRoots(input.skillTargetPaths, native);
  }

  /** Creates the conversation with the first Turn's directory, model, and MCP configuration. */
  private async startNativeThread(
    input: WorkerResidentTurnInput,
    config: Record<string, unknown>,
    native: { outstanding: boolean }
  ): Promise<void> {
    const started = (await this.nativeRequest(
      'thread/start',
      {
        approvalPolicy: CODEX_APPROVAL_POLICY,
        sandbox: CODEX_SANDBOX,
        model: input.llmRoute.model,
        modelProvider: CODEX_PROVIDER_ID,
        cwd: input.workingDirectory,
        ephemeral: false,
        config,
      },
      native
    )) as ThreadBody;
    this.rememberThread(started, null);
  }

  /** One-shot supply apply for a binding whose open already proved `thread/resume`. */
  private async applyResumedSupply(
    input: WorkerResidentTurnInput,
    config: Record<string, unknown>,
    native: { outstanding: boolean }
  ): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) throw new Error('Codex binding has no thread.');
    try {
      await this.nativeRequest('thread/unsubscribe', { threadId }, native);
      const resumed = (await this.nativeRequest(
        'thread/resume',
        {
          threadId,
          cwd: input.workingDirectory,
          approvalPolicy: CODEX_APPROVAL_POLICY,
          sandbox: CODEX_SANDBOX,
          model: input.llmRoute.model,
          modelProvider: CODEX_PROVIDER_ID,
          config,
        },
        native
      )) as ThreadBody;
      this.rememberThread(resumed, threadId);
    } catch (error) {
      this.unusable = true;
      throw error;
    }
  }

  /** Projects the complete current native Skill roots, including removal of all old roots. */
  private async setSkillRoots(
    skills: readonly { readonly id: string; readonly targetPath: string }[],
    native: { outstanding: boolean }
  ): Promise<void> {
    await this.nativeRequest(
      'skills/extraRoots/set',
      { extraRoots: skills.map((skill) => skill.targetPath) },
      native
    );
  }

  /**
   * One control request. Native errors have no qualified non-acceptance semantics, so the
   * outstanding flag stays set on failure until dedicated-process stop is confirmed.
   */
  private async nativeRequest(
    method: string,
    params: unknown,
    native: { outstanding: boolean }
  ): Promise<unknown> {
    if (this.closing || this.unusable) throw new Error('Codex binding is closing or unusable.');
    native.outstanding = true;
    const result = await this.rpc.request(method, params);
    native.outstanding = false;
    return result;
  }

  /** Checks retained rollout existence; inspection separately bounds this filesystem proof. */
  private async rolloutExists(): Promise<boolean> {
    if (!this.rolloutPath) return false;
    try {
      const info = await (this.launch.inspectRollout ?? stat)(this.rolloutPath);
      return info.size > 0;
    } catch {
      return false;
    }
  }

  private rememberThread(body: ThreadBody, expected: string | null): void {
    const id = body.thread?.id;
    if (typeof id !== 'string' || !THREAD_ID.test(id) || (expected !== null && id !== expected)) {
      this.unusable = true;
      throw new Error('Codex thread identity did not match the retained thread.');
    }
    this.threadId = id;
    if (body.thread?.path) this.rolloutPath = body.thread.path;
  }

  private finishTurn(
    turnId: string,
    status: string,
    turn: unknown,
    capture: CodexRuntimeCapture | null
  ): Promise<WorkerAdapterResult> {
    if (status !== 'inProgress' && this.terminalSeen)
      void this.invalidateTurn('duplicate-terminal').catch(() => undefined);
    if (status !== 'inProgress') this.terminalSeen = true;
    const completion =
      status === 'inProgress' && !this.earlyTerminal
        ? new Promise<{ status: string; texts: readonly string[] }>((resolve, reject) => {
            this.turnWaiters.set(turnId, { resolve, reject });
          })
        : Promise.resolve(this.earlyTerminal ?? { status, texts: assistantTexts(turn) });
    this.earlyTerminal = null;
    const settled = completion.then(async (outcome) => {
      let result = normalizeCodexAssistant(outcome.status, outcome.texts);
      await capture?.finalize().catch(() => undefined);
      if (this.invalidation) result = await this.invalidation;
      this.turnWaiters.delete(turnId);
      this.itemText.delete(turnId);
      this.currentTurnId = null;
      this.active = false;
      return this.withDiagnostics(result);
    });
    settled.catch(() => undefined);
    return settled;
  }

  /** Adds bounded native diagnostics, including setup warnings on completed results. */
  private withDiagnostics(result: WorkerAdapterResult): WorkerAdapterResult {
    const diagnostics: Record<string, string> = { reasoningEffort: 'unknown' };
    if (this.reasoningEffortDelivery)
      diagnostics.reasoningEffortDelivery = this.reasoningEffortDelivery;
    if (this.nativeConfigurationWarning)
      diagnostics.nativeConfiguration = this.nativeConfigurationWarning;
    const stderr = this.rpc.stderrDiagnostic();
    if (stderr) diagnostics.stderr = stderr;
    if (this.rpc.permissionRecords.length > 0) {
      diagnostics.nativePermissions = this.rpc.permissionRecords
        .map((record) => `${record.outcome}:${record.method}`)
        .join(',')
        .slice(0, 1024);
    }
    return { ...result, diagnostics };
  }

  private onNotification(method: string, params: unknown): void {
    if (this.unusable || this.closing) return;
    if (method !== 'item/completed' && method !== 'turn/completed') return;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      void this.invalidateTurn('malformed-result').catch(() => undefined);
      return;
    }
    const record = params as {
      threadId?: unknown;
      turnId?: unknown;
      turn?: unknown;
      item?: unknown;
    };
    if (typeof record.threadId !== 'string' || record.threadId !== this.threadId) {
      void this.invalidateTurn('identity-mismatch').catch(() => undefined);
      return;
    }
    if (method === 'item/completed') {
      this.rememberItem(record.turnId, record.item);
      return;
    }
    if (method !== 'turn/completed') return;
    const turn = record.turn as { id?: unknown; status?: unknown } | undefined;
    if (
      typeof turn?.id !== 'string' ||
      (record.turnId !== undefined && record.turnId !== turn.id)
    ) {
      void this.invalidateTurn('identity-mismatch').catch(() => undefined);
      return;
    }
    const waiter = this.turnWaiters.get(turn.id);
    const status =
      typeof turn.status === 'string' &&
      KNOWN_TURN_STATUSES.has(turn.status) &&
      turn.status !== 'inProgress'
        ? turn.status
        : 'malformed-result';
    let texts: string[] = [];
    try {
      texts = assistantTexts(turn);
      if (texts.length === 0) texts = this.itemText.get(turn.id) ?? [];
    } catch {
      void this.invalidateTurn('malformed-result').catch(() => undefined);
      return;
    }
    if (status === 'malformed-result') {
      void this.invalidateTurn(status).catch(() => undefined);
      return;
    }
    if (this.terminalSeen || (!this.active && !this.acceptingTurn)) {
      void this.invalidateTurn('duplicate-terminal').catch(() => undefined);
      return;
    }
    this.terminalSeen = true;
    if (waiter) waiter.resolve({ status, texts });
    else if (this.acceptingTurn && !this.earlyTerminal)
      this.earlyTerminal = { turnId: turn.id, status, texts };
    else void this.invalidateTurn('identity-mismatch').catch(() => undefined);
  }

  private rememberItem(turnId: unknown, item: unknown): void {
    if (!this.active && !this.acceptingTurn) return;
    if (
      typeof turnId !== 'string' ||
      (this.currentTurnId && turnId !== this.currentTurnId) ||
      (this.itemText.size > 0 && !this.itemText.has(turnId))
    ) {
      void this.invalidateTurn('identity-mismatch').catch(() => undefined);
      return;
    }
    let texts: string[];
    try {
      texts = assistantTexts(item);
    } catch {
      void this.invalidateTurn('malformed-result').catch(() => undefined);
      return;
    }
    if (texts.length === 0) return;
    const existing = this.itemText.get(turnId) ?? [];
    if (Buffer.byteLength([...existing, ...texts].join(''), 'utf8') > CODEX_RESULT_MAX_BYTES) {
      void this.invalidateTurn('malformed-result').catch(() => undefined);
      return;
    }
    this.itemText.set(turnId, [...existing, ...texts]);
  }

  private failWaiters(status: string): void {
    for (const [id, waiter] of this.turnWaiters) {
      this.turnWaiters.delete(id);
      waiter.resolve({ status, texts: [] });
    }
  }

  /** A malformed consumed native event stops this binding before settling its active Turn. */
  private invalidateTurn(status: string): Promise<WorkerAdapterResult> {
    this.unusable = true;
    if (!this.invalidation) {
      this.invalidation = this.stopProcess().then((stopped) => {
        if (!stopped) {
          this.noteExitUnproved();
          const error = new Error('Codex native settlement stop remains unproved.');
          for (const waiter of this.turnWaiters.values()) waiter.reject(error);
          throw error;
        }
        this.failWaiters(status);
        return { assistantText: null, status: 'failed' as const, stopReason: status };
      });
      this.invalidation.catch(() => undefined);
    }
    return this.invalidation;
  }

  /**
   * Stops the process after a failed open. Returns when the exit was not observed so the caller
   * can hand the session back; a confirmed exit rejects the open.
   */
  async failOpen(
    error: unknown,
    resumeThreadId: string | null,
    secrets: readonly string[]
  ): Promise<void> {
    this.unusable = true;
    if (!(await this.stopProcess())) {
      this.noteExitUnproved();
      return;
    }
    const message = error instanceof Error ? error.message : 'Codex session.open failed.';
    const withoutThread = resumeThreadId ? message.split(resumeThreadId).join('[thread]') : message;
    throw new Error(redactDiagnostic(withoutThread, secrets).slice(0, 300));
  }

  /** Stops the process before a Turn rejection that may already have been accepted. */
  private async abandonUnaccepted(error: unknown): Promise<WorkerResidentTurn> {
    if (await this.stopProcess()) throw error;
    return this.surfaceLive(error);
  }

  /** Returns the unproved-stop Turn and remembers that close must not report success. */
  private surfaceLive(error: unknown): WorkerResidentTurn {
    this.noteExitUnproved();
    return surfaceUnprovedCodexTurn(error, () => this.stopProcess());
  }

  private noteExitUnproved(): void {
    this.exitUnproved = true;
    if (this.phase !== 'absent') this.phase = 'unknown';
  }

  /** Whether the dedicated process has not exited. */
  private processIsLive(): boolean {
    const child = this.child;
    if (!child || typeof child.pid !== 'number') return false;
    return !childHasExited(child);
  }

  /**
   * SIGTERM, then SIGKILL. True only when no process remains. A missed exit is false.
   * One in-flight stop is shared so a fence interrupt and close observe the same result.
   */
  private stopProcess(): Promise<boolean> {
    this.stopInFlight ??= this.stopProcessOnce().finally(() => {
      this.stopInFlight = null;
    });
    return this.stopInFlight;
  }

  private async stopProcessOnce(): Promise<boolean> {
    const child = this.child;
    if (!child || typeof child.pid !== 'number' || childHasExited(child)) {
      this.child = null;
      this.phase = 'absent';
      return true;
    }
    this.suppressExit = true;
    this.phase = 'stopping';
    try {
      child.stdin.end();
    } catch {
      // stdin may already be closed.
    }
    const stopped = await confirmCodexChildStopped(child, this.stopGraceMs);
    this.suppressExit = false;
    if (stopped || childHasExited(child)) {
      this.child = null;
      this.phase = 'absent';
      return true;
    }
    this.phase = 'unknown';
    return false;
  }
}

function childHasExited(child: CodexStoppableChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
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

function signalChild(child: CodexStoppableChild, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal) || childHasExited(child);
  } catch (error) {
    return isProcessGone(error) || childHasExited(child);
  }
}

/**
 * Child that can be signaled and observed. The real `codex` process satisfies this, and tests
 * pass a peer that never emits `exit` to prove the unconfirmed stop.
 */
export interface CodexStoppableChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

/**
 * SIGTERM, then SIGKILL. Returns true only after the exit event. `graceMs` is the wait after
 * SIGTERM and again after SIGKILL. A child that never emits `exit` returns false.
 *
 * @param child Process to stop.
 * @param graceMs Bound for each signal. Production uses two seconds.
 * @returns Whether the process is gone.
 */
export async function confirmCodexChildStopped(
  child: CodexStoppableChild,
  graceMs = CODEX_STOP_GRACE_MS
): Promise<boolean> {
  if (childHasExited(child)) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let onExit: () => void = () => undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      onExit = () => resolve(childHasExited(child));
      child.once('exit', onExit);
      if (!signalChild(child, 'SIGTERM')) {
        resolve(childHasExited(child));
        return;
      }
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), graceMs);
      timer = setTimeout(() => resolve(childHasExited(child)), graceMs * 2);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    child.off('exit', onExit);
  }
}

/**
 * Turn surfaced when a stop did not prove that the native process exited. `settled` rejects
 * with the original failure. `interrupt` resolves only after a later stop is confirmed, and
 * otherwise rejects with bounded uncertainty so the Harness fences the unproved stop.
 *
 * @param error Failure that must not be reported as a clean refusal while the process may be live.
 * @param confirmStopped Later stop attempt used by the Harness interrupt.
 * @returns A resident Turn the Harness treats as accepted only so it can fence the stop.
 */
export function surfaceUnprovedCodexTurn(
  error: unknown,
  confirmStopped: () => Promise<boolean>
): WorkerResidentTurn {
  const settled = Promise.reject(error);
  settled.catch(() => undefined);
  return {
    interrupt: async () => {
      if (await confirmStopped()) return;
      throw new Error('Codex interrupt stop remains unproved.');
    },
    settled,
  };
}

/** Optional launch override used to drive a scripted peer. Production does not set it. */
export interface CodexResidentLaunch {
  /** Injects the pinned npm vendor binary for tests; production uses the immutable image path. */
  readonly binaryPath?: string;
  /** Replaces the vendor binary. The returned process must use piped stdio. */
  readonly spawnProcess?: (
    binaryPath: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => ChildProcessWithoutNullStreams;
  /** Short test-only request, setup, and inspection budgets. */
  readonly controlTimeoutMs?: number;
  /** Test-only aggregate setup deadline, excluding the subsequent bounded stop. */
  readonly setupTimeoutMs?: number;
  /** Test-only deadline for the asynchronous rollout proof. */
  readonly inspectTimeoutMs?: number;
  /** Delays the filesystem proof to reproduce an inspection/exit race. */
  readonly inspectRollout?: (path: string) => Promise<{ size: number }>;
  /** Replaces the two-second stop bound. A test uses a short bound for a child that never exits. */
  readonly stopGraceMs?: number;
}

/**
 * Opens one binding. A rejection means no Codex process remains. When the process was spawned
 * and its exit cannot be proved, the returned session has an unknown handle and `close` rejects
 * so the Harness fences instead of treating the open as a clean refusal.
 *
 * @param input AgentSession roots, loopback, environment, and resume reference.
 * @param launch Test launch override. Omitted for the vendor binary.
 * @returns The live binding, or a binding whose close fails closed.
 */
export async function openCodexResidentSession(
  input: WorkerResidentOpenInput,
  launch?: CodexResidentLaunch
): Promise<WorkerResidentSession> {
  const secrets = [input.loopback.inferenceCredential, input.loopback.capabilityCredential];
  if (secrets.some((secret) => secret.length === 0)) {
    throw new Error('Codex requires both loopback credentials before native work.');
  }
  assertLaunchEnvironment(input.environment, secrets);
  const resumeThreadId = input.resumeReference ? decodeThreadId(input.resumeReference) : null;
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
  const child = (
    launch?.spawnProcess ??
    ((binary, args, options) =>
      spawn(binary, [...args], {
        ...options,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams)
  )(launch?.binaryPath ?? CODEX_PRODUCTION_BINARY, codexLaunchArguments(), {
    cwd: input.stateRoot,
    env: codexChildEnvironment(input.environment, input.stateRoot),
  });
  const session = new CodexResidentSession(
    input,
    child,
    launch?.stopGraceMs ?? CODEX_STOP_GRACE_MS,
    launch
  );
  try {
    await controlDeadline(
      session.establish(resumeThreadId),
      launch?.setupTimeoutMs ?? CODEX_SETUP_TIMEOUT_MS
    );
  } catch (error) {
    await session.failOpen(error, resumeThreadId, secrets);
  }
  return session;
}

/** Resident Codex App Server v2 adapter. One process per binding; close does not delete `CODEX_HOME`. */
export const codexResidentAdapter: WorkerResidentAdapter = {
  openSession(input) {
    return openCodexResidentSession(input);
  },
};

/** Test factory for the exact npm vendor binary; the registry uses the production adapter. */
export function createCodexResidentAdapter(options: {
  readonly binaryPath: string;
}): WorkerResidentAdapter {
  return { openSession: (input) => openCodexResidentSession(input, options) };
}
