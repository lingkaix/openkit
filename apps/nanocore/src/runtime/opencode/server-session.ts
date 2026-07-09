import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

import { createOpencodeClient, type OpencodeClient, type TextPart } from '@opencode-ai/sdk/client';

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionFactory,
  AgentSessionState,
  CreateAgentSessionInput,
} from '../types.js';

const LOOPBACK_HOSTNAME = '127.0.0.1';
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_INTERVAL_MS = 100;

/**
 * Credentials used to protect one supervised OpenCode server.
 */
export interface OpenCodeServerCredentials {
  /** Basic-auth password generated for this child server. */
  password: string;
  /** Basic-auth username generated for this child server. */
  username: string;
}

/**
 * Inputs required to create a typed OpenCode SDK client for one child server.
 */
export interface OpenCodeServerClientInput {
  /** Loopback base URL for the supervised OpenCode server. */
  baseUrl: string;
  /** Credentials that NanoCore generated for the server. */
  credentials: OpenCodeServerCredentials;
  /** Project directory passed through to OpenCode session requests. */
  directory: string;
}

/**
 * Inputs used to spawn a supervised OpenCode server process.
 */
export interface OpenCodeServerSpawnInput {
  /** Configured OpenCode serve command. */
  command: string;
  /** Working directory for the child process. */
  cwd: string;
  /** Environment variables passed to the child process. */
  environment: Record<string, string>;
  /** Loopback hostname bound by the child server. */
  hostname: string;
  /** Allocated loopback port bound by the child server. */
  port: number;
}

/**
 * Process interface used by the OpenCode server session.
 */
export interface OpenCodeServerProcess {
  /** Optional standard-error stream exposed by real child processes. */
  stderr?: NodeJS.ReadableStream;
  /** Optional standard-output stream exposed by real child processes. */
  stdout?: NodeJS.ReadableStream;
  /** Stops the child process. */
  kill(signal?: NodeJS.Signals): boolean;
  /** Registers a one-time process error or exit handler. */
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

/**
 * Result returned after prompting one OpenCode session.
 */
export interface OpenCodeServerPromptResult {
  /** Provider message or item id, when OpenCode returned one. */
  itemId?: string;
  /** Assistant text to project into OpenKit item records. */
  text: string;
}

/**
 * Narrow OpenCode SDK client surface consumed by the agent session.
 */
export interface OpenCodeServerClient {
  /** Aborts an active OpenCode session, when supported by the server. */
  abort?(sessionId: string): Promise<void>;
  /** Creates a reusable OpenCode session for the bound OpenKit thread. */
  createSession(input: { directory: string; title: string }): Promise<{ id: string }>;
  /** Sends one user prompt to the OpenCode session. */
  prompt(input: {
    directory: string;
    input: string;
    sessionId: string;
  }): Promise<OpenCodeServerPromptResult>;
}

/**
 * Injectable dependencies for tests and future runtime variants.
 */
export interface OpenCodeServerAgentSessionDependencies {
  /** Allocates an unused loopback port. */
  allocatePort?: () => number | Promise<number>;
  /** Creates the SDK-backed client after readiness succeeds. */
  createClient?: (input: OpenCodeServerClientInput) => OpenCodeServerClient;
  /** Fetch implementation used for raw readiness probes. */
  fetch?: typeof fetch;
  /** Generates credentials for the private OpenCode server. */
  generateCredentials?: () => OpenCodeServerCredentials;
  /** Returns the current ISO timestamp. */
  now?: () => string;
  /** Delay between readiness probe attempts. */
  readinessIntervalMs?: number;
  /** Maximum time to wait for readiness. */
  readinessTimeoutMs?: number;
  /** Sleep primitive used by readiness polling. */
  sleep?: (ms: number) => Promise<void>;
  /** Spawns the child OpenCode server process. */
  spawnServer?: (input: OpenCodeServerSpawnInput) => OpenCodeServerProcess;
}

/**
 * Agent session that supervises `opencode serve` and talks to it through the SDK.
 */
export class OpenCodeServerAgentSession implements AgentSession {
  public readonly id: string;
  public readonly environmentPackage: CreateAgentSessionInput['environmentPackage'];
  public readonly threadId: string;

  private readonly command: string;
  private readonly cwd: string;
  private readonly dependencies: Required<OpenCodeServerAgentSessionDependencies>;
  private readonly environment: Record<string, string>;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly workspaceId: string;
  private activeTurnId: string | null = null;
  private client: OpenCodeServerClient | null = null;
  private interruptedTurns = new Set<string>();
  private openCodeSessionId: string | null = null;
  private serverProcess: OpenCodeServerProcess | null = null;
  private state: AgentSessionState = 'bound';

  /**
   * Creates an OpenCode server-backed agent session.
   */
  public constructor(
    input: CreateAgentSessionInput,
    dependencies: OpenCodeServerAgentSessionDependencies = {}
  ) {
    this.id = input.id;
    this.environmentPackage = input.environmentPackage;
    this.threadId = input.threadId;
    this.workspaceId = input.workspaceId;
    this.command = input.agent.config.command ?? 'opencode serve';
    this.cwd = input.workspaceCwd ?? input.agent.config.workspaceRoot;
    this.environment = {
      ...input.agent.config.environment,
      ...(input.workspaceRoots.length > 0
        ? { OPENKIT_WORKSPACE_ROOTS: JSON.stringify(input.workspaceRoots) }
        : {}),
    };
    this.dependencies = {
      allocatePort: dependencies.allocatePort ?? allocateLoopbackPort,
      createClient: dependencies.createClient ?? createSdkOpenCodeServerClient,
      fetch: dependencies.fetch ?? fetch,
      generateCredentials: dependencies.generateCredentials ?? generateServerCredentials,
      now: dependencies.now ?? (() => new Date().toISOString()),
      readinessIntervalMs: dependencies.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS,
      readinessTimeoutMs: dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      sleep: dependencies.sleep ?? sleep,
      spawnServer: dependencies.spawnServer ?? spawnOpenCodeServer,
    };
  }

  /**
   * Registers a session event listener.
   */
  public onEvent(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts one OpenCode prompt turn through the supervised server.
   */
  public async startTurn(turnId: string, input: string): Promise<void> {
    this.activeTurnId = turnId;

    try {
      const client = await this.ensureClient();
      const sessionId = await this.ensureOpenCodeSession(client);

      if (this.interruptedTurns.has(turnId)) {
        return;
      }

      this.state = 'running';
      this.emit({
        type: 'turn-started',
        turnId,
        startedAt: this.dependencies.now(),
      });

      const result = await client.prompt({
        directory: this.cwd,
        input,
        sessionId,
      });

      if (this.interruptedTurns.has(turnId)) {
        return;
      }

      if (result.text.length > 0) {
        this.emit({
          type: 'agent-message-delta',
          turnId,
          ...(result.itemId ? { itemId: result.itemId } : {}),
          delta: result.text,
        });
      }

      this.state = 'bound';
      this.emit({
        type: 'turn-completed',
        turnId,
        status: 'completed',
        stopReason: 'completed',
        completedAt: this.dependencies.now(),
      });
    } catch (error) {
      if (this.interruptedTurns.has(turnId)) {
        return;
      }

      this.state = 'stopping';
      await this.stopServer('SIGTERM');
      this.state = 'failed';
      this.emit({
        type: 'turn-completed',
        turnId,
        status: 'failed',
        stopReason: 'error',
        completedAt: this.dependencies.now(),
        error: {
          code: isReadinessError(error) ? 'opencode_server_not_ready' : 'opencode_server_failed',
          message: error instanceof Error ? error.message : 'OpenCode server turn failed.',
        },
      });
    } finally {
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
      }
      this.interruptedTurns.delete(turnId);
    }
  }

  /**
   * Interrupts the active OpenCode prompt turn.
   */
  public async interruptTurn(turnId: string): Promise<void> {
    if (this.activeTurnId !== turnId) {
      return;
    }

    this.interruptedTurns.add(turnId);
    this.state = 'stopping';

    if (this.client?.abort && this.openCodeSessionId) {
      await this.client.abort(this.openCodeSessionId);
    }

    this.activeTurnId = null;
    this.state = 'bound';
    this.emit({
      type: 'turn-completed',
      turnId,
      status: 'interrupted',
      stopReason: 'aborted',
      completedAt: this.dependencies.now(),
    });
  }

  /**
   * Closes the supervised server process and releases the session.
   */
  public async close(): Promise<void> {
    this.state = 'stopping';
    await this.stopServer('SIGTERM');
    this.state = 'exited';
  }

  /**
   * Returns the current agent-session lifecycle state.
   */
  public getState(): AgentSessionState {
    return this.state;
  }

  /**
   * Creates the OpenCode client after starting and probing the server.
   */
  private async ensureClient(): Promise<OpenCodeServerClient> {
    if (this.client) {
      return this.client;
    }

    this.state = 'starting';
    const port = await this.dependencies.allocatePort();
    const credentials = this.dependencies.generateCredentials();
    const baseUrl = `http://${LOOPBACK_HOSTNAME}:${port}`;
    const environment = {
      ...this.environment,
      OPENCODE_SERVER_PASSWORD: credentials.password,
      OPENCODE_SERVER_USERNAME: credentials.username,
      OPENKIT_THREAD_ID: this.threadId,
      OPENKIT_WORKSPACE_ID: this.workspaceId,
    };
    const process = this.dependencies.spawnServer({
      command: this.command,
      cwd: this.cwd,
      environment,
      hostname: LOOPBACK_HOSTNAME,
      port,
    });

    this.serverProcess = process;
    process.once('error', (error) => {
      this.handleServerExit(error.message);
    });
    process.once('exit', (code, signal) => {
      if (this.state !== 'stopping' && this.state !== 'exited') {
        this.handleServerExit(
          signal
            ? `OpenCode server exited with signal ${signal}.`
            : `OpenCode server exited with code ${code ?? 'unknown'}.`
        );
      }
    });

    try {
      await this.waitForReadiness(baseUrl, credentials);
    } catch (error) {
      this.state = 'stopping';
      await this.stopServer('SIGTERM');
      throw new OpenCodeReadinessError(
        error instanceof Error ? error.message : 'OpenCode server did not become ready.'
      );
    }

    this.client = this.dependencies.createClient({
      baseUrl,
      credentials,
      directory: this.cwd,
    });
    return this.client;
  }

  /**
   * Creates or reuses the OpenCode-side session for the bound thread.
   */
  private async ensureOpenCodeSession(client: OpenCodeServerClient): Promise<string> {
    if (this.openCodeSessionId) {
      return this.openCodeSessionId;
    }

    const session = await client.createSession({
      directory: this.cwd,
      title: `OpenKit ${this.threadId}`,
    });

    this.openCodeSessionId = session.id;
    return session.id;
  }

  /**
   * Polls raw OpenCode endpoints until the child server is ready.
   */
  private async waitForReadiness(
    baseUrl: string,
    credentials: OpenCodeServerCredentials
  ): Promise<void> {
    const deadline = Date.now() + this.dependencies.readinessTimeoutMs;
    const headers = { authorization: buildBasicAuthorization(credentials) };
    let lastError: Error | null = null;

    for (;;) {
      for (const path of ['/global/health', '/doc']) {
        try {
          const response = await this.dependencies.fetch(`${baseUrl}${path}`, { headers });

          if (response.ok) {
            return;
          }

          lastError = new Error(`${path} returned HTTP ${response.status}.`);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('Readiness probe failed.');
        }
      }

      if (Date.now() >= deadline) {
        break;
      }

      await this.dependencies.sleep(this.dependencies.readinessIntervalMs);
    }

    throw lastError ?? new Error('OpenCode server readiness timed out.');
  }

  /**
   * Stops and forgets the supervised server process.
   */
  private async stopServer(signal: NodeJS.Signals): Promise<void> {
    const process = this.serverProcess;

    this.client = null;
    this.openCodeSessionId = null;
    this.serverProcess = null;

    if (process) {
      process.kill(signal);
    }
  }

  /**
   * Marks the session failed after an unexpected child-process exit.
   */
  private handleServerExit(reason: string): void {
    this.serverProcess = null;
    this.client = null;
    this.openCodeSessionId = null;
    this.state = 'failed';

    if (this.activeTurnId) {
      this.emit({
        type: 'turn-completed',
        turnId: this.activeTurnId,
        status: 'failed',
        stopReason: 'error',
        completedAt: this.dependencies.now(),
        error: {
          code: 'opencode_server_exited',
          message: reason,
        },
      });
      return;
    }

    this.emit({
      type: 'session-state-changed',
      state: 'failed',
      reason,
    });
  }

  /**
   * Emits one normalized session event.
   */
  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/**
 * Creates OpenCode server-backed sessions.
 */
export class OpenCodeServerAgentSessionFactory implements AgentSessionFactory {
  private readonly dependencies: OpenCodeServerAgentSessionDependencies;

  /**
   * Creates a factory with optional test dependencies.
   */
  public constructor(dependencies: OpenCodeServerAgentSessionDependencies = {}) {
    this.dependencies = dependencies;
  }

  /**
   * Creates one server-backed OpenCode session.
   */
  public async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return new OpenCodeServerAgentSession(input, this.dependencies);
  }
}

/**
 * SDK-backed implementation of the narrow OpenCode client interface.
 */
class SdkOpenCodeServerClient implements OpenCodeServerClient {
  private readonly client: OpencodeClient;
  private readonly directory: string;

  /**
   * Creates a typed SDK client for a supervised OpenCode server.
   */
  public constructor(input: OpenCodeServerClientInput) {
    this.directory = input.directory;
    this.client = createOpencodeClient({
      baseUrl: input.baseUrl,
      headers: {
        authorization: buildBasicAuthorization(input.credentials),
      },
    });
  }

  /**
   * Creates one OpenCode session through the SDK.
   */
  public async createSession(input: { directory: string; title: string }): Promise<{ id: string }> {
    const response = await this.client.session.create({
      body: { title: input.title },
      query: { directory: input.directory },
      throwOnError: true,
    });

    return { id: response.data.id };
  }

  /**
   * Sends one prompt through the SDK and collapses returned text parts.
   */
  public async prompt(input: {
    directory: string;
    input: string;
    sessionId: string;
  }): Promise<OpenCodeServerPromptResult> {
    const response = await this.client.session.prompt({
      body: {
        parts: [{ type: 'text', text: input.input }],
      },
      path: { id: input.sessionId },
      query: { directory: input.directory },
      throwOnError: true,
    });
    const text = response.data.parts
      .filter((part): part is TextPart => {
        return part.type === 'text';
      })
      .map((part) => part.text)
      .join('');

    return {
      itemId: response.data.info.id,
      text,
    };
  }

  /**
   * Aborts the active OpenCode session through the SDK.
   */
  public async abort(sessionId: string): Promise<void> {
    await this.client.session.abort({
      path: { id: sessionId },
      query: { directory: this.directory },
      throwOnError: true,
    });
  }
}

/**
 * Error marker used to preserve readiness failure codes.
 */
class OpenCodeReadinessError extends Error {}

/**
 * Creates the default SDK client wrapper.
 */
function createSdkOpenCodeServerClient(input: OpenCodeServerClientInput): OpenCodeServerClient {
  return new SdkOpenCodeServerClient(input);
}

/**
 * Allocates a loopback TCP port for a child server.
 */
async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, LOOPBACK_HOSTNAME, () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to allocate an OpenCode server port.'));
        });
        return;
      }

      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Generates one username/password pair for a child OpenCode server.
 */
function generateServerCredentials(): OpenCodeServerCredentials {
  return {
    password: randomBytes(24).toString('base64url'),
    username: 'openkit',
  };
}

/**
 * Spawns the configured OpenCode server command on loopback.
 */
function spawnOpenCodeServer(input: OpenCodeServerSpawnInput): ChildProcessWithoutNullStreams {
  return spawn(
    `${input.command} --hostname ${quoteShellArg(input.hostname)} --port ${input.port}`,
    {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.environment,
      },
      shell: true,
      stdio: 'pipe',
    }
  );
}

/**
 * Quotes one shell argument for the local command surface.
 */
function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the HTTP Basic authorization header for the child server.
 */
function buildBasicAuthorization(credentials: OpenCodeServerCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

/**
 * Waits for a small interval.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Returns true when an error came from OpenCode readiness probing.
 */
function isReadinessError(error: unknown): boolean {
  return error instanceof OpenCodeReadinessError;
}
