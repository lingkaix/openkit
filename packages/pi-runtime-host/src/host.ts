import { rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  CHANNEL_NATIVE_EVENT_MAX_BYTES,
  type HostErrorCode,
  type HostEvent,
  type HostNativeHandle,
  type HostOpenRequest,
  type HostRequest,
  HostRequestSchema,
  type HostResponse,
  type PiModelDescriptor,
} from './channel.ts';
import {
  type HostManagedMcpAdapter,
  loadHostManagedMcp,
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpToolApprovalRequest,
} from './host-managed-mcp.ts';
import {
  allocatePiSessionPath,
  digestPiSessionHandle,
  encodePiSessionHandle,
  type PiSessionHandle,
  PiSessionIdentityError,
  parsePiSessionHandle,
  provePiSessionHeader,
  requireAbsentPiSession,
} from './identity.ts';
import { type PiTurnOutcome, PiTurnOutcomeTracker } from './outcome.ts';

/** The one adapter-owned provider alias every generated model descriptor uses. */
export const PI_PROVIDER_ALIAS = 'openkit-worker-inference';

/** Interactive Extension UI methods; every call is reported and resolves as a cancelled prompt. */
const UI_PROMPT_METHODS = ['select', 'confirm', 'input', 'editor', 'custom'] as const;
/**
 * Extension UI methods whose effect is only visible on a terminal. Each is reported once and then
 * behaves as the SDK's headless default. Read-only accessors such as `theme` and `getEditorText`
 * stay available because they change nothing a user could see.
 */
const UI_TERMINAL_METHODS = [
  'addAutocompleteProvider',
  'notify',
  'onTerminalInput',
  'pasteToEditor',
  'setEditorComponent',
  'setEditorText',
  'setFooter',
  'setHeader',
  'setHiddenThinkingLabel',
  'setStatus',
  'setTheme',
  'setTitle',
  'setToolsExpanded',
  'setWidget',
  'setWorkingIndicator',
  'setWorkingMessage',
  'setWorkingVisible',
] as const;

/** Frame sink and exit hook the host process wires to its private channel. */
export interface PiRuntimeHostIo {
  /** Called once after the `close` response has been sent. */
  onClosed(): void;
  /** Writes one outbound frame to the supervising Harness. */
  send(frame: HostEvent | HostResponse): void;
}

type HostState = 'unopened' | 'opening' | 'open' | 'active' | 'closing' | 'closed' | 'failed';

/** The admitted conversation of this host after a successful `open`. */
interface Binding {
  /** Descriptor admitted for the next Turn, replaced by `configure`. */
  model: PiModelDescriptor;
  /** Whether `model` still has to be registered and selected before the next prompt. */
  modelPending: boolean;
  /**
   * Proved restricted handle. It is set at `open` for a resumed conversation, and for a new one
   * only when its first Turn completed; until then a session file that exists grants nothing.
   */
  handle: PiSessionHandle | null;
  readonly request: HostOpenRequest;
  readonly runtime: ModelRuntime;
  readonly sessionPath: string;
}

/** The one Turn in progress. */
interface ActiveTurn {
  readonly done: Promise<PiTurnOutcome>;
  /** Reason the host itself fenced this Turn, such as a failed identity proof. */
  failure: string | null;
  interrupted: boolean;
  readonly resolve: (outcome: PiTurnOutcome) => void;
  /** True while the SDK session, resources, and MCP connection are being prepared. */
  settingUp: boolean;
  readonly turnId: string;
}

/** Raised at a preparation or preflight boundary once the Turn was interrupted or fenced. */
class TurnCancelledError extends Error {
  public constructor() {
    super('Pi Turn was cancelled.');
    this.name = 'TurnCancelledError';
  }
}

/**
 * One dedicated Pi SDK host: exactly one native conversation, prompted once per Turn.
 *
 * The SDK session, the resource loader, and the host-managed MCP connection are created lazily
 * at the first Turn, because the capability plane refuses every request until the Harness has
 * bound a Turn and the adapter freezes its tool catalog when it connects. The catalog is not
 * listed again at later Turns; a supply change is a setup change that the Harness serves with a
 * successor host resuming the same session file.
 */
export class PiRuntimeHost {
  #binding: Binding | null = null;
  readonly #io: PiRuntimeHostIo;
  #mcp: HostManagedMcpAdapter | null = null;
  #opening: Promise<void> | null = null;
  #reportedUi = new Set<string>();
  #session: AgentSession | null = null;
  #state: HostState = 'unopened';
  #turn: ActiveTurn | null = null;

  public constructor(io: PiRuntimeHostIo) {
    this.#io = io;
  }

  /**
   * Returns the raw values no outbound frame may contain.
   *
   * @returns The two loopback credentials once a binding is open, otherwise nothing.
   */
  public secrets(): readonly string[] {
    const request = this.#binding?.request;
    return request ? [request.inferenceCredential, request.capabilityCredential] : [];
  }

  /**
   * Handles one inbound request line; every outcome is sent through the frame sink.
   *
   * @param line One complete request line.
   */
  public async receive(line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.#fail(null, 'invalid_request', 'Request is not JSON.');
      return;
    }
    const parsed = HostRequestSchema.safeParse(value);
    if (!parsed.success) {
      const id = (value as { id?: unknown } | null)?.id;
      this.#fail(
        Number.isSafeInteger(id) ? (id as number) : null,
        'invalid_request',
        'Request is invalid.'
      );
      return;
    }
    await this.#dispatch(parsed.data);
  }

  /**
   * Stops the host after its channel was lost: cancels setup and work and releases resources.
   */
  public async abandon(): Promise<void> {
    if (this.#state === 'closed' || this.#state === 'closing') return;
    this.#state = 'closing';
    await this.#opening?.catch(() => undefined);
    await this.#stop();
    this.#state = 'closed';
  }

  async #dispatch(request: HostRequest): Promise<void> {
    if (this.#state === 'closing' || this.#state === 'closed') {
      this.#fail(request.id, 'invalid_state', 'Host is closing.');
      return;
    }
    switch (request.op) {
      case 'open':
        return this.#open(request);
      case 'inspect':
        return this.#inspect(request.id);
      case 'configure':
        return this.#configure(request.id, request.model);
      case 'turn':
        return this.#runTurn(request.id, request.turnId, request.prompt);
      case 'interrupt':
        return this.#interrupt(request.id, request.turnId);
      case 'close':
        return this.#close(request.id);
    }
  }

  async #open(request: HostOpenRequest): Promise<void> {
    if (this.#state !== 'unopened') {
      this.#fail(request.id, 'invalid_state', 'Host is already open.');
      return;
    }
    this.#state = 'opening';
    const opening = this.#openBinding(request);
    this.#opening = opening;
    try {
      await opening;
    } finally {
      this.#opening = null;
    }
  }

  /** Opens the binding; a close that wins the race leaves no binding and a refused `open`. */
  async #openBinding(request: HostOpenRequest): Promise<void> {
    const superseded = () => this.#state !== 'opening';
    let allocated: string | null = null;
    try {
      let handle: PiSessionHandle | null = null;
      let sessionPath: string;
      if (request.resume) {
        handle = parsePiSessionHandle(request.resume.handle, request.stateRoot);
        if (handle.cwd !== request.workingDirectory) {
          throw new PiSessionIdentityError('Pi session handle records another working directory.');
        }
        handle = await provePiSessionHeader(
          request.stateRoot,
          handle.path,
          request.workingDirectory,
          handle.sessionId
        );
        sessionPath = handle.path;
      } else {
        sessionPath = await allocatePiSessionPath(request.stateRoot);
        allocated = sessionPath;
      }
      // Ambient SDK defaults that do not take an explicit directory resolve to the admitted one.
      process.env.PI_CODING_AGENT_DIR = request.agentDir;
      const runtime = await ModelRuntime.create({
        allowModelNetwork: false,
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      registerModel(runtime, request.inferenceBaseUrl, request.model);
      await runtime.setRuntimeApiKey(PI_PROVIDER_ALIAS, request.inferenceCredential);
      // A close or channel loss during any await above leaves the binding unadopted.
      if (superseded()) throw new TurnCancelledError();
      this.#binding = {
        handle,
        model: request.model,
        modelPending: false,
        request,
        runtime,
        sessionPath,
      };
      this.#state = 'open';
      this.#respond(request.id, { nativeHandle: readyOrPending(handle) });
    } catch (error) {
      // The fresh directory was never adopted; removing it only succeeds while it is empty.
      if (allocated) await rmdir(dirname(allocated)).catch(() => undefined);
      if (superseded()) {
        this.#fail(request.id, 'invalid_state', 'Host is closing.');
        return;
      }
      this.#state = 'failed';
      this.#fail(
        request.id,
        error instanceof PiSessionIdentityError ? 'identity_failed' : 'setup_failed',
        error instanceof PiSessionIdentityError ? error.message : 'Pi host setup failed.'
      );
    }
  }

  async #inspect(id: number): Promise<void> {
    const binding = this.#binding;
    if (!binding || !['open', 'active', 'failed'].includes(this.#state)) {
      this.#fail(id, 'invalid_state', 'Host is not open.');
      return;
    }
    if (this.#state === 'failed') {
      this.#respond(id, {
        nativeHandle: await this.#reportHandle(binding),
        state: 'failed',
        turnId: null,
      });
      return;
    }
    try {
      const nativeHandle = await this.#proveHandle(binding);
      this.#respond(id, {
        nativeHandle,
        state: this.#state === 'active' ? 'active' : 'idle',
        turnId: this.#turn?.turnId ?? null,
      });
    } catch (error) {
      await this.#latchIdentityFailure();
      this.#fail(id, 'identity_failed', identityMessage(error));
    }
  }

  async #configure(id: number, model: PiModelDescriptor): Promise<void> {
    const binding = this.#binding;
    if (this.#state === 'active') {
      this.#fail(id, 'busy', 'A Turn is active.');
      return;
    }
    if (!binding || this.#state !== 'open') {
      this.#fail(id, 'invalid_state', 'Host is not open.');
      return;
    }
    binding.model = model;
    binding.modelPending = true;
    this.#respond(id, {});
  }

  /**
   * Accepts one Turn, answers `started`, then prepares and prompts. A preparation failure, an
   * interrupt, or a failed identity proof settles the Turn through `turn_settled`.
   */
  async #runTurn(id: number, turnId: string, prompt: string): Promise<void> {
    const binding = this.#binding;
    if (this.#state === 'active') {
      this.#fail(id, 'busy', 'A Turn is active.');
      return;
    }
    if (!binding || this.#state !== 'open') {
      this.#fail(id, 'invalid_state', 'Host is not open.');
      return;
    }
    let resolve!: (outcome: PiTurnOutcome) => void;
    const done = new Promise<PiTurnOutcome>((settle) => {
      resolve = settle;
    });
    const turn: ActiveTurn = {
      done,
      failure: null,
      interrupted: false,
      resolve,
      settingUp: true,
      turnId,
    };
    this.#turn = turn;
    this.#state = 'active';
    this.#respond(id, { state: 'started' });

    const established = binding.handle !== null;
    const route = { model: binding.model.modelId, provider: PI_PROVIDER_ALIAS };
    const tracker = new PiTurnOutcomeTracker();
    let session: AgentSession | null = null;
    let setupFailure: string | null = null;
    try {
      session = await this.#prepareTurn(binding, turn);
    } catch (error) {
      if (!(error instanceof TurnCancelledError)) {
        setupFailure =
          error instanceof PiSessionIdentityError ? 'pi-identity-failed' : 'pi-setup-failed';
      }
    } finally {
      turn.settingUp = false;
    }
    let earlierEntries = new Set<string>();
    let promptFailed = false;
    if (session && !cancelled(turn)) {
      // Compaction appends its entry without an `entry_appended` event, so the identities this
      // prompt produced are the compaction entries that were not in the graph before it.
      earlierEntries = new Set(session.sessionManager.getEntries().map((entry) => entry.id));
      const unsubscribe = session.subscribe((event) => {
        tracker.observe(event as AgentSessionEvent & Record<string, unknown>);
        this.#forwardNative(turnId, event);
      });
      try {
        await session.prompt(prompt, {
          // The SDK calls this synchronously just before it starts the agent run. An interrupt
          // that arrived during the input hooks or pre-run compaction stops the run here.
          preflightResult: () => {
            if (cancelled(turn)) throw new TurnCancelledError();
          },
        });
      } catch (error) {
        if (!(error instanceof TurnCancelledError)) promptFailed = true;
      } finally {
        unsubscribe();
      }
    }
    let outcome: PiTurnOutcome =
      turn.failure !== null
        ? { reason: turn.failure, status: 'failed' }
        : setupFailure !== null && !turn.interrupted
          ? { reason: setupFailure, status: 'failed' }
          : tracker.finish({ interrupted: turn.interrupted, promptFailed, route });
    const compactionEntryIds = session
      ? session.sessionManager
          .getEntries()
          .filter((entry) => entry.type === 'compaction' && !earlierEntries.has(entry.id))
          .map((entry) => entry.id)
      : [];
    let nativeHandle: HostNativeHandle;
    try {
      nativeHandle =
        outcome.status === 'completed' && !established
          ? await this.#promoteHandle(binding)
          : await this.#proveHandle(binding);
    } catch {
      nativeHandle = { state: 'unknown' };
      outcome = { reason: 'pi-identity-failed', status: 'failed' };
      turn.failure = 'pi-identity-failed';
    }
    this.#turn = null;
    // A new conversation is reusable only after one completed Turn proved its handle. Any other
    // first result, and any identity or setup failure, fences the binding for exact close.
    const fenced =
      turn.failure !== null || setupFailure !== null || (!established && binding.handle === null);
    if (this.#state === 'active') this.#state = fenced ? 'failed' : 'open';
    this.#io.send({ compactionEntryIds, event: 'turn_settled', nativeHandle, outcome, turnId });
    turn.resolve(outcome);
  }

  async #interrupt(id: number, turnId: string): Promise<void> {
    const turn = this.#turn;
    if (!turn || turn.turnId !== turnId) {
      this.#respond(id, { outcome: 'not_active' });
      return;
    }
    turn.interrupted = true;
    await this.#cancelTurn(turn);
    const outcome = await turn.done;
    this.#respond(id, { outcome: outcome.status });
  }

  async #close(id: number): Promise<void> {
    this.#state = 'closing';
    await this.#opening?.catch(() => undefined);
    await this.#stop();
    const nativeHandle = this.#binding
      ? await this.#reportHandle(this.#binding)
      : { state: 'pending' as const };
    this.#state = 'closed';
    this.#respond(id, { nativeHandle, state: 'closed' });
    this.#io.onClosed();
  }

  /** Cancels a Turn at every stage: pending MCP setup, pre-run hooks, compaction, or the run. */
  async #cancelTurn(turn: ActiveTurn): Promise<void> {
    if (turn.settingUp && !this.#session) {
      // Closing the adapter aborts a connection that `ready()` is still establishing. A resident
      // session keeps its connection: a later Turn's setup only proves identity and the model.
      const mcp = this.#mcp;
      this.#mcp = null;
      await mcp?.close().catch(() => undefined);
    }
    await this.#session?.abort().catch(() => undefined);
  }

  /** Interrupts any Turn, closes the MCP connection, and disposes the SDK session. */
  async #stop(): Promise<void> {
    const turn = this.#turn;
    if (turn) {
      turn.interrupted = true;
      await this.#cancelTurn(turn);
      await turn.done;
    }
    await this.#mcp?.close().catch(() => undefined);
    this.#mcp = null;
    this.#session?.dispose();
    this.#session = null;
  }

  /** Fences the binding after a failed identity proof, stopping an active Turn. */
  async #latchIdentityFailure(): Promise<void> {
    const turn = this.#turn;
    if (this.#state === 'closing' || this.#state === 'closed') return;
    this.#state = 'failed';
    if (turn) {
      turn.failure = 'pi-identity-failed';
      await this.#cancelTurn(turn);
    }
  }

  /**
   * Re-proves the conversation, then creates the resident session at the first Turn or applies a
   * changed model at later ones. Each asynchronous boundary checks for cancellation and disposes
   * any resource created after it.
   */
  async #prepareTurn(binding: Binding, turn: ActiveTurn): Promise<AgentSession> {
    const { request } = binding;
    const checkpoint = () => {
      if (cancelled(turn) || this.#state === 'closing') throw new TurnCancelledError();
    };
    if (binding.handle) {
      await provePiSessionHeader(
        request.stateRoot,
        binding.handle.path,
        request.workingDirectory,
        binding.handle.sessionId
      );
    } else {
      await requireAbsentPiSession(request.stateRoot, binding.sessionPath);
    }
    checkpoint();
    if (binding.modelPending) {
      registerModel(binding.runtime, request.inferenceBaseUrl, binding.model);
    }
    const model = binding.runtime.getModel(PI_PROVIDER_ALIAS, binding.model.modelId);
    if (!model) throw new Error('Pi model descriptor was not registered.');
    if (this.#session) {
      if (binding.modelPending) await this.#session.setModel(model);
      binding.modelPending = false;
      checkpoint();
      return this.#session;
    }
    const openkitServers = new Set(request.mcpServers);
    // The resident session keeps this Extension for every later Turn, so the check reads the
    // current Turn on each hook invocation and never retains this first Turn's state.
    const extensionFactories: ExtensionFactory[] = [
      hostControl(openkitServers, () => {
        const current = this.#turn;
        return current === null || cancelled(current) || this.#state !== 'active';
      }),
    ];
    if (openkitServers.size > 0) {
      const createAdapter = await loadHostManagedMcp();
      checkpoint();
      const base = request.capabilityBaseUrl.replace(/\/+$/, '');
      const authorization = `Bearer ${request.capabilityCredential}`;
      const adapter = createAdapter({
        onToolCall: (call) => call.dispatch(),
        servers: Object.fromEntries(
          request.mcpServers.map((server) => [
            server,
            {
              createTransport: () =>
                new StreamableHTTPClientTransport(
                  new URL(`${base}/mcp/${encodeURIComponent(server)}`),
                  { requestInit: { headers: { authorization } } }
                ),
            },
          ])
        ),
      });
      this.#mcp = adapter;
      try {
        await adapter.ready();
      } catch (error) {
        checkpoint();
        throw error;
      }
      checkpoint();
      extensionFactories.unshift(adapter.extensionFactory);
    }
    // Every Pi mode initializes the process theme; Extensions that format tool output read it
    // once the host offers a UI context. Only the built-in theme loads, with no file watcher,
    // so user themes stay off.
    initTheme('dark', false);
    const settingsManager = SettingsManager.create(request.workingDirectory, request.agentDir, {
      projectTrusted: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      agentDir: request.agentDir,
      // Retained `SYSTEM.md` and `APPEND_SYSTEM.md` in the agent or project directory would
      // otherwise replace or extend the system prompt; `noContextFiles` covers only AGENTS files.
      appendSystemPromptOverride: () => [],
      cwd: request.workingDirectory,
      extensionFactories,
      noContextFiles: true,
      noThemes: true,
      settingsManager,
      systemPromptOverride: () => undefined,
    });
    await resourceLoader.reload();
    checkpoint();
    const { extensionsResult, session } = await createAgentSession({
      agentDir: request.agentDir,
      cwd: request.workingDirectory,
      model,
      modelRuntime: binding.runtime,
      resourceLoader,
      sessionManager: SessionManager.open(
        binding.sessionPath,
        dirname(binding.sessionPath),
        request.workingDirectory
      ),
      settingsManager,
    });
    this.#session = session;
    binding.modelPending = false;
    if (binding.handle && session.sessionId !== binding.handle.sessionId) {
      throw new PiSessionIdentityError('Pi session opened another conversation.');
    }
    checkpoint();
    for (const error of extensionsResult.errors) {
      this.#io.send({ event: 'extension_error', message: `${error.path}: ${error.error}` });
    }
    await session.bindExtensions({
      onError: (error) =>
        this.#io.send({
          event: 'extension_error',
          message: `${error.extensionPath} ${error.event}: ${error.error}`,
        }),
      uiContext: this.#headlessUi(session.extensionRunner.getUIContext()),
    });
    if (session.extensionRunner.getShortcuts({}).size > 0) this.#reportUi('registerShortcut');
    checkpoint();
    return session;
  }

  /** Proves the established handle, or that a new conversation still grants nothing. */
  async #proveHandle(binding: Binding): Promise<HostNativeHandle> {
    const { stateRoot, workingDirectory } = binding.request;
    if (binding.handle) {
      await provePiSessionHeader(
        stateRoot,
        binding.handle.path,
        workingDirectory,
        binding.handle.sessionId
      );
      return readyOrPending(binding.handle);
    }
    try {
      await requireAbsentPiSession(stateRoot, binding.sessionPath);
      return { state: 'pending' };
    } catch {
      // A file without a completed first Turn is preserved but is not reusable authority.
      return { state: 'unknown' };
    }
  }

  /** Proves and records the handle of a new conversation whose first Turn completed. */
  async #promoteHandle(binding: Binding): Promise<HostNativeHandle> {
    const sessionId = this.#session?.sessionId;
    if (!sessionId) throw new PiSessionIdentityError('Pi session file appeared without a session.');
    binding.handle = await provePiSessionHeader(
      binding.request.stateRoot,
      binding.sessionPath,
      binding.request.workingDirectory,
      sessionId
    );
    return readyOrPending(binding.handle);
  }

  /** Reports the handle without promoting it and without failing. */
  async #reportHandle(binding: Binding): Promise<HostNativeHandle> {
    try {
      return await this.#proveHandle(binding);
    } catch {
      return { state: 'unknown' };
    }
  }

  /**
   * Returns the Extension UI the headless host offers: every prompt resolves as cancelled and is
   * reported, and every terminal-only method is reported once and then has no visible effect.
   */
  #headlessUi(base: ExtensionUIContext): ExtensionUIContext {
    const ui: ExtensionUIContext = { ...base };
    for (const method of UI_PROMPT_METHODS) {
      Object.assign(ui, {
        [method]: async () => {
          this.#io.send({ event: 'ui_unsupported', method, turnId: this.#turn?.turnId ?? null });
          return method === 'confirm' ? false : undefined;
        },
      });
    }
    for (const method of UI_TERMINAL_METHODS) {
      const original = base[method] as (...args: unknown[]) => unknown;
      Object.assign(ui, {
        [method]: (...args: unknown[]) => {
          this.#reportUi(method);
          return original(...args);
        },
      });
    }
    return ui;
  }

  /** Reports one terminal-only feature once per host. */
  #reportUi(method: string): void {
    if (this.#reportedUi.has(method)) return;
    this.#reportedUi.add(method);
    this.#io.send({ event: 'ui_unsupported', method, turnId: this.#turn?.turnId ?? null });
  }

  /** Forwards one completed native session event; streaming deltas are not forwarded. */
  #forwardNative(turnId: string, event: AgentSessionEvent): void {
    if (event.type === 'message_update') return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    } catch {
      bytes = -1;
    }
    if (bytes < 0 || bytes > CHANNEL_NATIVE_EVENT_MAX_BYTES) {
      this.#io.send({ bytes, event: 'native_omitted', turnId, type: event.type });
      return;
    }
    this.#io.send({ data: event, event: 'native', turnId });
  }

  #respond(id: number, result: Record<string, unknown>): void {
    this.#io.send({ id, ok: true, result });
  }

  #fail(id: number | null, code: HostErrorCode, message: string): void {
    this.#io.send({ error: { code, message }, id, ok: false });
  }
}

/** Whether the host must not start or continue native work for this Turn. */
function cancelled(turn: ActiveTurn): boolean {
  return turn.interrupted || turn.failure !== null;
}

/** Registers the adapter-owned provider alias with exactly the admitted logical model. */
function registerModel(runtime: ModelRuntime, baseUrl: string, model: PiModelDescriptor): void {
  runtime.registerProvider(PI_PROVIDER_ALIAS, {
    api: 'openai-completions',
    baseUrl,
    models: [
      {
        contextWindow: model.contextWindow,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: model.modelId,
        input: [...model.inputModalities],
        maxTokens: model.maxOutputTokens,
        name: model.modelId,
        reasoning: model.reasoning,
      },
    ],
  });
}

/**
 * The host's own Extension. It answers the adapter's approval broker for OpenKit host-managed
 * servers only: authorization of those calls belongs to the Gateway behind the capability plane,
 * and this broker is the embedding host's gate. Requests for other servers come from a user's own
 * in-Sandbox MCP configuration and are left unclaimed, so that configuration keeps its own
 * behavior. When no Turn may run it also cancels compaction, which the SDK can start before a run
 * exists and therefore before `abort()` can reach it.
 *
 * The pinned agent loop checks an existing run's abort signal after its tool-call handlers and
 * before tool execution. An Extension can also trigger a new native run with a fresh signal, so the
 * resident host-control Extension checks the current Turn at every `agent_start` and aborts a run
 * when that Turn is absent, cancelled, fenced, or no longer active. These checks stop new work; they
 * do not prove rollback of an already-dispatched external effect.
 *
 * @param servers OpenKit host-managed server ids.
 * @param isFenced Reads, at each invocation, whether native work must not proceed.
 */
function hostControl(servers: ReadonlySet<string>, isFenced: () => boolean): ExtensionFactory {
  return (pi) => {
    pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (data) => {
      const request = data as McpToolApprovalRequest;
      if (servers.has(request.serverName)) request.claim(() => 'allow_once');
    });
    pi.on('session_before_compact', () => (isFenced() ? { cancel: true } : undefined));
    pi.on('agent_start', (_event, ctx) => {
      if (isFenced()) ctx.abort();
    });
  };
}

/** Projects a proved handle to its Harness state. */
function readyOrPending(handle: PiSessionHandle | null): HostNativeHandle {
  if (!handle) return { state: 'pending' };
  const encoded = encodePiSessionHandle(handle);
  return { digest: digestPiSessionHandle(encoded), handle: encoded, state: 'ready' };
}

/** Returns a proof failure message that never carries file content. */
function identityMessage(error: unknown): string {
  return error instanceof PiSessionIdentityError ? error.message : 'Pi session proof failed.';
}
