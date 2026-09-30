import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpExtensionOptions, McpTransportFactory } from '@earendil-works/pi-coding-agent';

/**
 * Loaded MCP configuration returned by Pi 0.99.1's loader.
 *
 * `loadMcpConfig` and `createDefaultTransport` ship in the installed package but are not
 * root-package exports. The host resolves the package entry and imports those sibling files by
 * absolute file URL. That access is pinned to the installed 0.99.1 dist layout.
 */
type LoadedMcpConfig = ReturnType<NonNullable<McpExtensionOptions['loadConfig']>>;

/** Transport object returned by Pi's factory. Methods stay on this object so `instanceof` holds. */
type NativeTransport = ReturnType<McpTransportFactory>;

interface PiMcpInternals {
  createDefaultTransport: McpTransportFactory;
  loadMcpConfig: (options: {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
  }) => LoadedMcpConfig;
}

let loading: Promise<PiMcpInternals> | undefined;

/**
 * Loads Pi 0.99.1's MCP loader and default transport from the installed dist modules.
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
  )) as { createDefaultTransport: McpTransportFactory };
  return {
    createDefaultTransport: runtime.createDefaultTransport,
    loadMcpConfig: config.loadMcpConfig,
  };
}

type ServerPhase = 'pending' | 'ready' | 'failed';

/**
 * Owns the native MCP hooks for one resident session.
 *
 * The loader hook reads the configuration Pi actually connects, including a file an Extension
 * writes while loading. The transport hook redacts both loopback credentials before Pi's log and
 * result handlers see a message. Pi's patched connection-state callback records completed setup
 * or terminal failure after native retries, on the current connection attempt. Pi 0.99.1 does not close a transport while
 * initialize is pending. This gate retains and closes only the host's OpenKit transports until
 * upstream closes in-progress transports through session shutdown. Remove the extra ownership when
 * that behavior is pinned and the held-initialize regression passes without it.
 */
export class OpenKitMcpGate {
  readonly #admitted: ReadonlySet<string>;
  readonly #agentDir: string;
  readonly #createDefaultTransport: McpTransportFactory;
  readonly #cwd: string;
  readonly #loadMcpConfig: PiMcpInternals['loadMcpConfig'];
  readonly #phase = new Map<string, ServerPhase>();
  readonly #retained: NativeTransport[] = [];
  readonly #secrets: readonly string[];
  #override: Error | null = null;

  constructor(options: {
    admitted: ReadonlySet<string>;
    agentDir: string;
    createDefaultTransport: McpTransportFactory;
    cwd: string;
    loadMcpConfig: PiMcpInternals['loadMcpConfig'];
    secrets: readonly string[];
  }) {
    this.#admitted = options.admitted;
    this.#agentDir = options.agentDir;
    this.#createDefaultTransport = options.createDefaultTransport;
    this.#cwd = options.cwd;
    this.#loadMcpConfig = options.loadMcpConfig;
    this.#secrets = options.secrets;
  }

  /** Error latched when the loader returned an admitted name, including a disabled entry. */
  overrideError(): Error | null {
    return this.#override;
  }

  /**
   * Invokes Pi's loader for the admitted directory and refuses an admitted name before returning.
   *
   * @returns The same object Pi's loader returned when no admitted name is present.
   */
  loadConfig(): LoadedMcpConfig {
    const loaded = this.#loadMcpConfig({
      agentDir: this.#agentDir,
      cwd: this.#cwd,
      projectTrusted: false,
    });
    const overridden = loaded.servers
      .filter((server) => this.#admitted.has(server.name))
      .map((server) => server.name);
    if (overridden.length > 0) {
      this.#override = new Error(
        `OpenKit MCP server is overridden by the agent directory mcp.json: ${overridden.join(', ')}.`
      );
      throw this.#override;
    }
    return loaded;
  }

  /**
   * Builds Pi's default transport, redacts incoming messages, and retains admitted servers.
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
    const transport = this.#createDefaultTransport(entry, cwd, authProvider);
    const admitted = this.#admitted.has(entry.name);
    if (admitted && this.#phase.get(entry.name) !== 'ready') {
      this.#phase.set(entry.name, 'pending');
      this.#retained.push(transport);
    }
    this.#wrap(transport);
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

  /**
   * Closes retained OpenKit transports. A second call is a no-op.
   *
   * `McpServerConnection.close` cannot reach a client still inside `connectOnce`.
   * `StreamableHttpTransport.close` aborts that HTTP request.
   */
  async closeRetained(): Promise<void> {
    const closing = this.#retained.splice(0);
    await Promise.all(closing.map((transport) => transport.close().catch(() => undefined)));
  }

  #wrap(transport: NativeTransport): void {
    const originalOnMessage = transport.onMessage.bind(transport);
    transport.onMessage = (listener) =>
      originalOnMessage((message) => {
        const redacted = redactSecrets(message, this.#secrets) as typeof message;
        listener(redacted);
      });
    const originalSend = transport.send.bind(transport);
    transport.send = async (message) => {
      try {
        await originalSend(message);
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

/** Whether the loaded Extensions still include the host-supplied built-in MCP Extension. */
export function hostSuppliedBuiltinMcp(
  extensions: readonly { path: string; sourceInfo: { source: string } }[]
): boolean {
  return extensions.some(
    (extension) => extension.path === 'builtin:mcp' && extension.sourceInfo.source === 'builtin'
  );
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
