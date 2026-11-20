import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpExtensionOptions, McpTransportFactory } from '@earendil-works/pi-coding-agent';
import { KNOWLEDGE_MANAGER_RUN_DEADLINE_MS } from '@openkit/config-schema';
import { Agent } from 'undici';

const OPENKIT_WORK_SERVER = 'openkit-work';
// Admission and terminal result delivery can extend the response wait past the default role bound.
const KNOWLEDGE_RESPONSE_WAIT_MS = KNOWLEDGE_MANAGER_RUN_DEADLINE_MS + 15_000;

/**
 * Loaded MCP configuration returned by Pi 1.5.2's loader.
 *
 * `loadMcpConfig` and `createDefaultTransport` ship in the installed package but are not root-package exports. The host resolves the package entry and imports those sibling files by absolute file URL. That access is pinned to the installed 1.5.2 dist layout.
 */
type LoadedMcpConfig = ReturnType<NonNullable<McpExtensionOptions['loadConfig']>>;

/** Transport object returned by Pi's factory. Methods stay on this object so `instanceof` holds. */
type NativeTransport = ReturnType<McpTransportFactory>;
type NativeHttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type NativeTransportFactory = (
  ...args: [...Parameters<McpTransportFactory>, httpFetch?: NativeHttpFetch]
) => NativeTransport;

/** Selects only the two canonical Work tools that wait for a Knowledge Manager Turn. */
function isKnowledgeTool(name: unknown): boolean {
  return name === 'knowledge_ask' || name === 'knowledge_tell';
}

interface PiMcpInternals {
  createDefaultTransport: NativeTransportFactory;
  loadMcpConfig: (options: {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
  }) => LoadedMcpConfig;
}

let loading: Promise<PiMcpInternals> | undefined;

/**
 * Loads Pi 1.5.2's MCP loader and default transport from the installed dist modules.
 *
 * @returns The two helpers. They are not public root exports.
 */
export function loadPiMcpInternals(): Promise<PiMcpInternals> {
  loading ??= importPiMcpInternals();
  return loading;
}

async function importPiMcpInternals(): Promise<PiMcpInternals> {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const directory = dirname(entry);
  const config = (await import(
    pathToFileURL(join(directory, 'extensions/mcp/config.js')).href
  )) as {
    loadMcpConfig: PiMcpInternals['loadMcpConfig'];
  };
  const runtime = (await import(
    pathToFileURL(join(directory, 'extensions/mcp/runtime.js')).href
  )) as { createDefaultTransport: NativeTransportFactory };
  return {
    createDefaultTransport: runtime.createDefaultTransport,
    loadMcpConfig: config.loadMcpConfig,
  };
}

type ServerPhase = 'pending' | 'ready' | 'failed';

/** Refuses an ambiguous native/managed catalog under the Pi Worker Adapter setup contract. */
export class PiMcpNamespaceCollisionError extends Error {
  public constructor() {
    super('Pi MCP server namespaces collide; use distinct normalized server names.');
    this.name = 'PiMcpNamespaceCollisionError';
  }
}

/**
 * Owns the native MCP hooks for one resident session.
 *
 * The loader hook reads the configuration Pi actually connects, including a file an Extension writes while loading. The transport hook redacts both loopback credentials before Pi's log and result handlers see a message. Pi's patched connection-state callback records completed setup or terminal failure after native retries, on the current connection attempt. Pi 1.4.0 closes in-progress transports through native session shutdown; the gate leaves lifetime ownership with Pi.
 */
export class OpenKitMcpGate {
  readonly #admitted: ReadonlySet<string>;
  readonly #agentDir: string;
  readonly #createDefaultTransport: NativeTransportFactory;
  readonly #cwd: string;
  readonly #loadMcpConfig: PiMcpInternals['loadMcpConfig'];
  readonly #phase = new Map<string, ServerPhase>();
  readonly #secrets: readonly string[];
  readonly #managed: LoadedMcpConfig['servers'];
  // The pinned transport retains its own session signal. Carry the selected call's signal to fetch too.
  readonly #knowledgeCall = new AsyncLocalStorage<{ signal?: AbortSignal } | undefined>();
  #knowledgeDispatcher: Agent | undefined;
  #refusal: PiMcpNamespaceCollisionError | null = null;

  constructor(options: {
    managed: LoadedMcpConfig['servers'];
    agentDir: string;
    createDefaultTransport: NativeTransportFactory;
    cwd: string;
    loadMcpConfig: PiMcpInternals['loadMcpConfig'];
    secrets: readonly string[];
  }) {
    this.#managed = options.managed;
    this.#admitted = new Set(options.managed.map((server) => server.name));
    this.#agentDir = options.agentDir;
    this.#createDefaultTransport = options.createDefaultTransport;
    this.#cwd = options.cwd;
    this.#loadMcpConfig = options.loadMcpConfig;
    this.#secrets = options.secrets;
  }

  /** Loads native configuration, overlays whole managed entries and refuses ambiguous catalog namespaces. */
  loadConfig(registered: readonly { name: string }[] = []): LoadedMcpConfig {
    if (this.#refusal) throw this.#refusal;
    const loaded = this.#loadMcpConfig({
      agentDir: this.#agentDir,
      cwd: this.#cwd,
      projectTrusted: true,
    });
    const overridden = loaded.servers
      .filter((server) => this.#admitted.has(server.name))
      .map((server) => server.name);
    if (overridden.length > 0) {
      console.warn(`OpenKit overlay: replaced native MCP servers: ${overridden.join(', ')}.`);
    }
    const servers = [
      ...loaded.servers.filter((server) => !this.#admitted.has(server.name)),
      ...this.#managed,
    ];
    // Pi 1.4.0 drops colliding file entries with a diagnostic and lets configured namespaces shadow registrations. Refuse the whole catalog before that can silently remove a target.
    const namespaces = new Map<string, string>();
    const collision = [...servers, ...registered].some(({ name }) => {
      const namespace = name.replace(/-/g, '_');
      const prior = namespaces.get(namespace);
      namespaces.set(namespace, name);
      return prior !== undefined && prior !== name;
    });
    if (collision || loaded.errors.some((error) => this.#isNamespaceCollision(error))) {
      this.#refusal = new PiMcpNamespaceCollisionError();
      throw this.#refusal;
    }
    return { ...loaded, servers };
  }

  /** Latches native registration refusals that Pi reports as Extension diagnostics instead of throwing from setup. */
  observeSetupError(message: string): void {
    if (this.#isNamespaceCollision(message)) this.#refusal = new PiMcpNamespaceCollisionError();
  }

  #isNamespaceCollision(message: string): boolean {
    // These are the two exact diagnostic forms emitted by the pinned file loader and Extension registration API.
    return /(?:^|: )(?:MCP )?server "[A-Za-z0-9_-]+" conflicts with (?:registered server )?"[A-Za-z0-9_-]+"$/.test(
      message
    );
  }

  /** Uses the same response budget for Pi's native call timer and HTTP wait. */
  knowledgeToolTimeoutMs(server: string, tool: string): number | undefined {
    if (server === OPENKIT_WORK_SERVER && this.#admitted.has(server) && isKnowledgeTool(tool))
      return KNOWLEDGE_RESPONSE_WAIT_MS;
  }

  /** Extends only the POST response for the selected call and keeps both cancellation signals. */
  #fetchWork(fetchRequest: NativeHttpFetch, input: string | URL, init?: RequestInit) {
    const call = this.#knowledgeCall.getStore();
    if (!call || init?.method !== 'POST') return fetchRequest(input, init);
    this.#knowledgeDispatcher ??= new Agent({
      headersTimeout: KNOWLEDGE_RESPONSE_WAIT_MS,
      bodyTimeout: KNOWLEDGE_RESPONSE_WAIT_MS,
    });
    const signal =
      call.signal && init.signal ? AbortSignal.any([call.signal, init.signal]) : call.signal;
    const options: RequestInit = {
      ...init,
      ...(signal ? { signal } : {}),
      // Fetch uses dispatch(), which Pi's pinned Undici and Node's bundled version both provide.
      dispatcher: this.#knowledgeDispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
    };
    return fetchRequest(input, options);
  }

  /**
   * Refuses a latched catalog collision; otherwise builds Pi's default transport, redacts incoming messages, and tracks admitted server setup.
   *
   * @param entry Server Pi is connecting.
   * @param cwd Session working directory.
   * @param authProvider OAuth provider Pi supplies, unused by header-authenticated OpenKit servers.
   * @returns The native transport.
   */
  createTransport(
    entry: Parameters<McpTransportFactory>[0],
    cwd: string,
    authProvider: Parameters<McpTransportFactory>[2]
  ): NativeTransport {
    if (this.#refusal) throw this.#refusal;
    const admitted = this.#admitted.has(entry.name);
    const managedWork = admitted && entry.name === OPENKIT_WORK_SERVER;
    const fetchRequest = globalThis.fetch;
    const transport = this.#createDefaultTransport(
      entry,
      cwd,
      authProvider,
      managedWork ? (input, init) => this.#fetchWork(fetchRequest, input, init) : undefined
    );
    if (admitted && this.#phase.get(entry.name) !== 'ready') {
      this.#phase.set(entry.name, 'pending');
    }
    this.#wrap(transport, managedWork);
    return transport;
  }

  /** Observes only Pi's completed registration or terminal failure for the latest connection. */
  connectionState(connection: { entry: { name: string }; state: string }): void {
    const name = connection.entry.name;
    if (!this.#admitted.has(name)) return;
    if (connection.state === 'connecting') {
      this.#phase.set(name, 'pending');
    } else if (connection.state === 'connected') {
      this.#phase.set(name, 'ready');
    } else if (
      connection.state === 'failed' ||
      connection.state === 'needs-auth' ||
      connection.state === 'closed' ||
      connection.state === 'disconnected'
    ) {
      this.#phase.set(name, 'failed');
    }
  }

  /** Admitted servers whose latest transport failed before setup completed. */
  failedServers(servers: ReadonlySet<string>): string[] {
    return [...servers].filter((id) => this.#phase.get(id) === 'failed');
  }

  /** Whether every admitted server finished native setup on its own transport. */
  allReady(servers: ReadonlySet<string>): boolean {
    return [...servers].every((id) => this.#phase.get(id) === 'ready');
  }

  #wrap(transport: NativeTransport, managedWork: boolean): void {
    const originalOnMessage = transport.onMessage.bind(transport);
    transport.onMessage = (listener) =>
      originalOnMessage((message) => {
        const redacted = redactSecrets(message, this.#secrets) as typeof message;
        listener(redacted);
      });
    const originalSend = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try {
        if (!managedWork) await originalSend(message);
        else if (
          'id' in message &&
          'method' in message &&
          message.method === 'tools/call' &&
          typeof message.params === 'object' &&
          message.params !== null &&
          'name' in message.params &&
          isKnowledgeTool(message.params.name)
        ) {
          await this.#knowledgeCall.run(options ?? {}, originalSend, message, options);
        } else {
          await this.#knowledgeCall.run(undefined, originalSend, message);
        }
      } catch (error) {
        sanitizeError(error, this.#secrets);
        throw error;
      }
    };
    const originalOnError = transport.onError.bind(transport);
    transport.onError = (listener) =>
      originalOnError((error) => {
        sanitizeError(error, this.#secrets);
        listener(error);
      });
  }
}

function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  // Serialize first so member names receive the same protection as values and `__proto__` is data.
  const redacted = JSON.parse(redactText(serialized, secrets)) as unknown;
  redactBlobs(redacted, secrets);
  return redacted;
}

function redactText(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

/** Redacts decoded MCP resource blobs before Pi converts or writes them. */
function redactBlobs(value: unknown, secrets: readonly string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) redactBlobs(item, secrets);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.blob === 'string') {
    let bytes = Buffer.from(record.blob, 'base64');
    let changed = false;
    for (const secret of secrets) {
      if (!secret) continue;
      const needle = Buffer.from(secret);
      const chunks: Buffer[] = [];
      let start = 0;
      let found = bytes.indexOf(needle, start);
      if (found < 0) continue;
      while (found >= 0) {
        chunks.push(bytes.subarray(start, found), Buffer.from('[redacted]'));
        start = found + needle.length;
        found = bytes.indexOf(needle, start);
      }
      chunks.push(bytes.subarray(start));
      bytes = Buffer.concat(chunks);
      changed = true;
    }
    if (changed) record.blob = bytes.toString('base64');
  }
  for (const item of Object.values(record)) redactBlobs(item, secrets);
}

/** Preserve native error identity and status so Pi's retry and tool-error classification stay intact. */
function sanitizeError(error: unknown, secrets: readonly string[]): void {
  if (error instanceof Error) error.message = redactText(error.message, secrets);
}
