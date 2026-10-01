import { rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  initTheme,
  loadSkills,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { loadPiMcpInternals, OpenKitMcpGate } from './capability-mcp.ts';
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

/** Interactive Extension UI methods; confirmation allows and free-input prompts return undefined. */
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
 * The SDK session, the resource loader, and Pi's native MCP connection are created lazily at the
 * first Turn, because the capability plane refuses every request until the Harness has bound a
 * Turn. OpenKit tools stay on that connection for later Turns; a supply change is a setup change
 * that the Harness serves with a successor host resuming the same session file.
 */
export class PiRuntimeHost {
  #awaitingOpenKitMcp = false;
  #binding: Binding | null = null;
  readonly #io: PiRuntimeHostIo;
  /** Native MCP gate for the resident session. It retains only this host's OpenKit transports. */
  #mcpGate: OpenKitMcpGate | null = null;
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
  async #cancelTurn(_turn: ActiveTurn): Promise<void> {
    if (this.#awaitingOpenKitMcp && this.#session) {
      // The first Turn's connection is still opening. Dropping it must abort the held HTTP
      // initialize. A later Turn's setup only proves identity and the model, so it leaves the
      // resident connection up and only aborts the run.
      const session = this.#session;
      this.#session = null;
      await this.#releaseSession(session);
      return;
    }
    await this.#session?.abort().catch(() => undefined);
  }

  /** Interrupts any Turn, closes MCP, and disposes the SDK session. */
  async #stop(): Promise<void> {
    const turn = this.#turn;
    if (turn) {
      turn.interrupted = true;
      await this.#cancelTurn(turn);
      await turn.done;
    }
    if (this.#session) {
      const session = this.#session;
      this.#session = null;
      await this.#releaseSession(session);
    }
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
    // Pi MCP server names are letters, digits, `_`, and `-`. A producer value outside that rule
    // fails setup here. Admitted catalog names already satisfy it.
    const rejectedNames = [...openkitServers].filter((id) => !/^[A-Za-z0-9_-]+$/.test(id));
    if (rejectedNames.length > 0) {
      throw new Error(
        `OpenKit MCP server id is not a Pi MCP server name: ${rejectedNames.join(', ')}.`
      );
    }
    const piMcp = await loadPiMcpInternals();
    checkpoint();
    const base = request.capabilityBaseUrl.replace(/\/+$/, '');
    const authorization = `Bearer ${request.capabilityCredential}`;
    const managedServers = request.mcpServers.map((id) => ({
      authorization,
      id,
      url: `${base}/mcp/${encodeURIComponent(id)}`,
    }));
    const gate = new OpenKitMcpGate({
      managed: managedServers.map((server) => ({
        name: server.id,
        config: {
          exposure: 'direct' as const,
          headers: { Authorization: server.authorization },
          url: server.url,
        },
        scope: 'extension' as const,
        source: 'OpenKit',
      })),
      agentDir: request.agentDir,
      createDefaultTransport: piMcp.createDefaultTransport,
      cwd: request.workingDirectory,
      loadMcpConfig: piMcp.loadMcpConfig,
      secrets: [request.inferenceCredential, request.capabilityCredential],
    });
    this.#mcpGate = gate;
    // The resident session keeps these Extensions for every later Turn. The gate reads the
    // current Turn on each hook invocation and never retains this first Turn's state. The MCP
    // factories are applied after native resources; authored exclusions cannot remove them.
    const extensionFactories = [
      hostControl(managedServers, () => {
        const current = this.#turn;
        return current === null || cancelled(current) || this.#state !== 'active';
      }),
      {
        hidden: true,
        factory: createToolSearchExtension(),
        name: 'tool-search',
        replaceable: false,
      },
      {
        hidden: true,
        factory: createMcpExtension({
          createTransport: (entry, cwd, authProvider) =>
            gate.createTransport(entry, cwd, authProvider),
          loadConfig: () => gate.loadConfig(),
          onConnectionState: (connection) => gate.connectionState(connection),
        }),
        name: 'mcp',
        replaceable: false,
      },
    ];
    try {
      return await this.#openResidentSession(
        binding,
        turn,
        request,
        model,
        extensionFactories,
        gate,
        openkitServers
      );
    } catch (error) {
      await gate.closeRetained();
      throw error;
    }
  }

  /**
   * Loads resources, requires the host-supplied inline MCP/search Extensions, activates search
   * additively, and waits for admitted servers before provider work.
   */
  async #openResidentSession(
    binding: Binding,
    turn: ActiveTurn,
    request: Binding['request'],
    model: NonNullable<ReturnType<ModelRuntime['getModel']>>,
    extensionFactories: NonNullable<
      ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionFactories']
    >,
    gate: OpenKitMcpGate,
    openkitServers: ReadonlySet<string>
  ): Promise<AgentSession> {
    const checkpoint = () => {
      if (cancelled(turn) || this.#state === 'closing') throw new TurnCancelledError();
    };
    // Every Pi mode initializes the process theme; Extensions that format tool output read it
    // once the host offers a UI context. Only the built-in theme loads, with no file watcher,
    // so user themes stay off.
    initTheme('dark', false);
    const settingsManager = SettingsManager.create(request.workingDirectory, request.agentDir, {
      projectTrusted: true,
    });
    const resourceLoader = new DefaultResourceLoader({
      agentDir: request.agentDir,
      cwd: request.workingDirectory,
      extensionFactories,
      noThemes: true,
      // Pi applies first-registration tool precedence. Remove collided native bindings before
      // binding the final host layer, while preserving unrelated registrations and user files.
      // Host factories keep the named inline identity and provenance assigned by Pi.
      extensionsOverride: (loaded) => {
        const protectedExtensions = loaded.extensions.filter(
          (extension) =>
            extension.path === '<inline:mcp>' || extension.path === '<inline:tool-search>'
        );
        for (const extension of protectedExtensions) {
          const name = extension.path === '<inline:mcp>' ? 'mcp' : 'tool-search';
          if (settingsManager.getSettings().extensions?.includes(`-builtin:${name}`)) {
            console.warn(`OpenKit overlay: retained ${extension.path} despite -builtin:${name}.`);
          }
          for (const native of loaded.extensions) {
            if (protectedExtensions.includes(native)) continue;
            // A native MCP owner carries connection handlers as well as /mcp. Replace that
            // owner as a whole so two native extensions cannot connect the managed servers.
            if (name === 'mcp' && native.commands.has('mcp')) {
              console.warn('OpenKit overlay: replaced native MCP Extension.');
              loaded.extensions = loaded.extensions.filter((candidate) => candidate !== native);
              continue;
            }
            for (const tool of extension.tools.keys()) {
              if (native.tools.delete(tool))
                console.warn(`OpenKit overlay: replaced native ${tool}.`);
            }
          }
        }
        return loaded;
      },
      settingsManager,
      // Selected supply is a separate native load, so local precedence cannot shadow it.
      skillsOverride: (native) => {
        const managed = loadSkills({
          agentDir: request.agentDir,
          cwd: request.workingDirectory,
          includeDefaults: false,
          skillPaths: request.skillTargetPaths,
        });
        const managedNames = new Set(managed.skills.map((skill) => skill.name));
        if (native.skills.some((skill) => managedNames.has(skill.name))) {
          console.warn('OpenKit overlay: selected Skills replace colliding native Skills.');
        }
        return {
          skills: [
            ...native.skills.filter((skill) => !managedNames.has(skill.name)),
            ...managed.skills,
          ],
          diagnostics: [...native.diagnostics, ...managed.diagnostics],
        };
      },
    });
    await resourceLoader.reload();
    checkpoint();
    const protectedProvider = binding.runtime.getRegisteredProviderConfig(PI_PROVIDER_ALIAS);
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
    const mcp = extensionsResult.extensions.find((extension) => extension.path === '<inline:mcp>');
    const search = extensionsResult.extensions.find(
      (extension) => extension.path === '<inline:tool-search>'
    );
    const searchDefinition = search?.tools.get('tool_search')?.definition;
    if (
      !mcp ||
      !searchDefinition ||
      session.getToolDefinition('tool_search') !== searchDefinition
    ) {
      throw new Error('Host-supplied native MCP or search factory is unavailable.');
    }
    const recordExtensionError = (message: string): void => {
      this.#io.send({ event: 'extension_error', message });
    };
    for (const error of extensionsResult.errors) {
      recordExtensionError(`${error.path}: ${error.error}`);
    }
    await session.bindExtensions({
      onError: (error) =>
        recordExtensionError(`${error.extensionPath} ${error.event}: ${error.error}`),
      uiContext: this.#headlessUi(session.extensionRunner.getUIContext()),
    });
    // session_start may change a protected binding; the managed layer is seated last.
    // Later Extension execution remains outside supported setup supply.
    for (const extension of extensionsResult.extensions) {
      if (extension !== search && extension.tools.delete('tool_search')) {
        console.warn('OpenKit overlay: replaced session_start tool_search.');
      }
    }
    extensionsResult.runtime.refreshTools();
    if (session.getToolDefinition('tool_search') !== searchDefinition) {
      throw new Error('Host-supplied Pi tool_search registration is unavailable.');
    }
    session.setActiveToolsByName([...session.getActiveToolNames(), 'tool_search']);
    if (!session.getActiveToolNames().includes('tool_search')) {
      throw new Error('Host-supplied Pi tool_search could not be activated.');
    }
    if (
      binding.runtime.getRegisteredProviderConfig(PI_PROVIDER_ALIAS) !== protectedProvider ||
      session.model !== model
    ) {
      console.warn('OpenKit overlay: restored managed provider and model.');
    }
    registerModel(binding.runtime, request.inferenceBaseUrl, binding.model);
    binding.runtime.setRuntimeApiKey(PI_PROVIDER_ALIAS, request.inferenceCredential);
    await session.setModel(binding.runtime.getModel(PI_PROVIDER_ALIAS, binding.model.modelId)!);
    if (session.extensionRunner.getShortcuts({}).size > 0) this.#reportUi('registerShortcut');
    checkpoint();
    if (openkitServers.size > 0) {
      this.#awaitingOpenKitMcp = true;
      try {
        await this.#waitForOpenKitMcp(gate, openkitServers, turn);
      } finally {
        this.#awaitingOpenKitMcp = false;
      }
    }
    checkpoint();
    return session;
  }

  /** Closes retained OpenKit transports, then disposes the SDK session. `dispose` emits no shutdown. */
  async #releaseSession(session: AgentSession): Promise<void> {
    await this.#mcpGate?.closeRetained();
    await session.extensionRunner
      .emit({ reason: 'quit', type: 'session_shutdown' })
      .catch(() => undefined);
    session.dispose();
  }

  /**
   * Waits until every admitted server finishes native setup on the host-owned transport.
   * An empty catalog is ready. Close or error before that exchange fails the wait. Pi's first
   * prompt only waits `startupWaitMs` and then continues, so this wait is the setup gate.
   */
  async #waitForOpenKitMcp(
    gate: OpenKitMcpGate,
    servers: ReadonlySet<string>,
    turn: ActiveTurn
  ): Promise<void> {
    const deadline = Date.now() + OPENKIT_MCP_CONNECT_TIMEOUT_MS;
    while (true) {
      if (cancelled(turn) || this.#state === 'closing') throw new TurnCancelledError();
      const failed = gate.failedServers(servers);
      if (failed.length > 0) {
        throw new Error(`OpenKit MCP server failed to connect: ${failed.join(', ')}.`);
      }
      if (gate.allReady(servers)) return;
      if (Date.now() >= deadline) {
        const missing = [...servers].filter((id) => !gate.allReady(new Set([id])));
        throw new Error(`OpenKit MCP server did not connect: ${missing.join(', ')}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
   * Returns the Extension UI the headless host offers: confirmation allows, free input cancels and is
   * reported, and every terminal-only method is reported once and then has no visible effect.
   */
  #headlessUi(base: ExtensionUIContext): ExtensionUIContext {
    const ui: ExtensionUIContext = { ...base };
    for (const method of UI_PROMPT_METHODS) {
      Object.assign(ui, {
        [method]: async () => {
          this.#io.send({ event: 'ui_unsupported', method, turnId: this.#turn?.turnId ?? null });
          // Keep the boolean response point deny-capable for future user-configurable policy.
          return method === 'confirm' ? true : undefined;
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
 * How long the first Turn waits for each OpenKit server before failing setup.
 *
 * Pi retries a transient HTTP failure after 250ms and 1000ms, and a non-transient refusal such as
 * 403 fails on the first attempt. This bound covers that retry and the lazy MCP runtime load, and
 * it is shorter than Pi's 60s request timeout so a refused server does not hold the prompt.
 */
const OPENKIT_MCP_CONNECT_TIMEOUT_MS = 15_000;

/**
 * The host's own Extension. It registers each admitted OpenKit server with Pi's native MCP for
 * this session only: `url` is the capability route, the bearer stays in the `Authorization`
 * header, and `exposure: "direct"` declares the tools to the model. The registration is not
 * written to `mcp.json`. Authorization of the calls belongs to the Gateway behind the capability
 * plane. The host no longer brokers an adapter approval event.
 *
 * When no Turn may run it also cancels compaction, which the SDK can start before a run exists
 * and therefore before `abort()` can reach it. The pinned agent loop checks an existing run's
 * abort signal after its tool-call handlers and before tool execution. An Extension can also
 * trigger a new native run with a fresh signal, so this Extension checks the current Turn at
 * every `agent_start` and aborts a run when that Turn is absent, cancelled, fenced, or no longer
 * active. These checks stop new work; they do not prove rollback of an already-dispatched
 * external effect.
 *
 * @param servers OpenKit servers to register before `session_start`.
 * @param isFenced Reads, at each invocation, whether native work must not proceed.
 */
function hostControl(
  servers: readonly { authorization: string; id: string; url: string }[],
  isFenced: () => boolean
): ExtensionFactory {
  return (pi) => {
    for (const server of servers) {
      pi.registerMcpServer(server.id, {
        exposure: 'direct',
        headers: { Authorization: server.authorization },
        url: server.url,
      });
    }
    pi.on('session_before_compact', () => (isFenced() ? { cancel: true } : undefined));
    pi.on('agent_start', (_event, ctx) => {
      if (isFenced()) ctx.abort();
    });
  };
}

function readyOrPending(handle: PiSessionHandle | null): HostNativeHandle {
  if (!handle) return { state: 'pending' };
  const encoded = encodePiSessionHandle(handle);
  return { digest: digestPiSessionHandle(encoded), handle: encoded, state: 'ready' };
}

/** Returns a proof failure message that never carries file content. */
function identityMessage(error: unknown): string {
  return error instanceof PiSessionIdentityError ? error.message : 'Pi session proof failed.';
}
