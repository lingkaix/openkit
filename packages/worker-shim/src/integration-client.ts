import { once } from 'node:events';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  type ClientHttp2Session,
  type ClientHttp2Stream,
  connect,
  constants as http2Constants,
  type IncomingHttpHeaders,
} from 'node:http2';
import { createServer, type Server as NetServer, type Socket } from 'node:net';

import type { WorkerControlFetch } from './control-client.js';

const INTEGRATION_READY_TIMEOUT_MS = 10_000;
const CONNECTION_RECEIVE_WINDOW_BYTES = 5 * 1024 * 1024;
const PER_STREAM_RECEIVE_WINDOW_BYTES = 256 * 1024;
const WORKER_CONTROL_MAX_BYTES = 1024 * 1024;
const INFERENCE_MAX_BYTES = 16 * 1024 * 1024;
const CAPABILITY_MAX_BYTES = 512 * 1024;
const MAX_HTTP2_WRITE_BYTES = 64 * 1024;
const LOOPBACK_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Fixed image-owned loopback target dialed by the stock OpenShell Supervisor. */
export const SANDBOX_INTEGRATION_TARGET = '127.0.0.1:17891' as const;

/** Fixed image-owned HTTP/1 ingress used only by native inference and capability clients. */
export const SANDBOX_NATIVE_INFERENCE_TARGET = '127.0.0.1:17892' as const;

/** Fixed native inference base URL a resident runtime calls with its inference loopback credential. */
export const SANDBOX_NATIVE_INFERENCE_BASE_URL = `http://${SANDBOX_NATIVE_INFERENCE_TARGET}/inference/v1`;

/** Fixed native capability base URL; an MCP server id follows `/mcp/`. */
export const SANDBOX_NATIVE_CAPABILITY_BASE_URL = `http://${SANDBOX_NATIVE_INFERENCE_TARGET}/capabilities`;

/**
 * Bound on the Turn-barrier drain of one AgentSession's in-flight loopback requests, owned by
 * Worker Agent Capability; requests still open when it expires are cut and their results refused.
 */
export const SANDBOX_TURN_DRAIN_MS = 10_000;

/** Complete route surface carried by the sandbox's single standard HTTP/2 session. */
export const SANDBOX_INTEGRATION_ROUTE_NAMESPACES = [
  '/worker-control/',
  '/inference/',
  '/capabilities/',
] as const;

type RouteFamily = 'capability' | 'worker-control' | 'inference';

const HARNESS_CONTROL_PATHS = new Set([
  '/worker-control/harness/poll',
  '/worker-control/harness/result',
]);

/** The three upstream route tokens of the Turn bound to one AgentSession. */
interface BoundTurnRoutes {
  readonly capabilityToken: string;
  readonly controlToken: string;
  /** Set at the Turn barrier; new loopback requests are refused from then on. */
  draining: boolean;
  readonly inferenceToken: string;
}

/** One AgentSession's session loopback credentials and its current Turn binding. */
interface LoopbackSession {
  readonly capabilityCredential: string;
  readonly inferenceCredential: string;
  /** In-flight native requests attributed to the bound Turn. */
  readonly inflight: Set<AbortController>;
  turn: BoundTurnRoutes | null;
}

/** One streaming response returned by the route-bound Integration client. */
type SandboxIntegrationResponse = {
  /** Streaming HTTP/2 response body. */
  body: ClientHttp2Stream;
  /** HTTP response headers. */
  headers: IncomingHttpHeaders;
  /** Whether the HTTP status is successful. */
  ok: boolean;
  /** HTTP response status. */
  status: number;
};

/** One accepted socket and its single standard HTTP/2 client session. */
export class SandboxIntegrationClient {
  private acceptedSocket: Socket | null = null;
  private readonly loopbackSessions = new Map<string, LoopbackSession>();
  private readonly nativeRequests = new Set<AbortController>();
  private readonly nativeServer: HttpServer;
  private readyState = false;
  private readyReject!: (reason?: unknown) => void;
  private readyResolve!: () => void;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private readonly server: NetServer;
  private session: ClientHttp2Session | null = null;
  private closed = false;

  /** Resolves only after the stock bridge completes the HTTP/2 handshake. */
  public readonly ready: Promise<void>;

  /** Worker-control fetch seam that preserves the existing retry and sequence owner. */
  public readonly workerControlFetch: WorkerControlFetch;

  /**
   * Creates one fixed listener and credential-separated route client.
   *
   * @param server Fixed Supervisor bridge listener.
   * @param nativeServer Fixed native inference listener.
   */
  public constructor(server: NetServer, nativeServer: HttpServer) {
    this.server = server;
    this.nativeServer = nativeServer;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readyTimer = setTimeout(() => {
      this.readyReject(new Error('Sandbox Integration readiness timed out.'));
      void this.close();
    }, INTEGRATION_READY_TIMEOUT_MS);
    this.workerControlFetch = async (path, init) => {
      if (HARNESS_CONTROL_PATHS.has(path)) {
        throw new TypeError('Worker-control fetch cannot call a private Harness route.');
      }
      const response = await this.request(path, init);
      return collectBoundedResponse(response, WORKER_CONTROL_MAX_BYTES, 'Worker-control');
    };
    nativeServer.on('request', (request, response) => {
      void this.handleNativeRoute(request, response).catch(() => response.destroy());
    });
  }

  /** Credential-free fetch seam for the two exact private Harness routes. */
  public async harnessControlFetch(
    path: string,
    init: Parameters<WorkerControlFetch>[1]
  ): Promise<Awaited<ReturnType<WorkerControlFetch>>> {
    if (!HARNESS_CONTROL_PATHS.has(path)) {
      throw new TypeError('Sandbox Integration rejected a non-private Harness route.');
    }
    const response = await this.request(path, init);
    return collectBoundedResponse(response, WORKER_CONTROL_MAX_BYTES, 'Harness-control');
  }

  /**
   * Registers one AgentSession's two session loopback credentials delivered by `session.open`.
   *
   * @param agentSessionId Exact AgentSession the credentials belong to.
   * @param credentials The inference and capability loopback credentials.
   */
  public registerSessionLoopback(
    agentSessionId: string,
    credentials: { readonly capabilityCredential: string; readonly inferenceCredential: string }
  ): void {
    const { capabilityCredential, inferenceCredential } = credentials;
    if (
      !LOOPBACK_CREDENTIAL_PATTERN.test(capabilityCredential) ||
      !LOOPBACK_CREDENTIAL_PATTERN.test(inferenceCredential) ||
      capabilityCredential === inferenceCredential
    ) {
      throw new Error('Sandbox Integration requires two distinct session loopback credentials.');
    }
    if (this.loopbackSessions.has(agentSessionId)) {
      throw new Error('Sandbox Integration AgentSession loopback is already registered.');
    }
    for (const session of this.loopbackSessions.values()) {
      if (
        [session.capabilityCredential, session.inferenceCredential].some(
          (value) => value === capabilityCredential || value === inferenceCredential
        )
      ) {
        throw new Error('Sandbox Integration session loopback credential is already in use.');
      }
    }
    this.loopbackSessions.set(agentSessionId, {
      capabilityCredential,
      inferenceCredential,
      inflight: new Set(),
      turn: null,
    });
  }

  /**
   * Destroys one AgentSession's loopback credentials at `session.close`, cutting any request.
   *
   * @param agentSessionId Exact closed AgentSession.
   */
  public destroySessionLoopback(agentSessionId: string): void {
    const session = this.loopbackSessions.get(agentSessionId);
    if (!session) {
      return;
    }
    this.loopbackSessions.delete(agentSessionId);
    for (const request of session.inflight) {
      request.abort();
    }
    session.inflight.clear();
    session.turn = null;
  }

  /**
   * Binds the three distinct upstream route tokens of one AgentSession's active Turn.
   *
   * @param agentSessionId AgentSession whose loopback requests the Turn now authorizes.
   * @param tokens The Turn's upstream worker-control, inference, and capability tokens.
   */
  public bindTurnRouteTokens(
    agentSessionId: string,
    tokens: {
      readonly capabilityToken: string;
      readonly controlToken: string;
      readonly inferenceToken: string;
    }
  ): void {
    const session = this.loopbackSessions.get(agentSessionId);
    if (!session) {
      throw new Error('Sandbox Integration AgentSession loopback is not registered.');
    }
    if (session.turn) {
      throw new Error('Sandbox Integration Turn route tokens are already bound.');
    }
    const { capabilityToken, controlToken, inferenceToken } = tokens;
    if (
      !capabilityToken ||
      !controlToken ||
      !inferenceToken ||
      new Set([capabilityToken, controlToken, inferenceToken]).size !== 3
    ) {
      throw new Error('Sandbox Integration requires distinct non-empty Turn route tokens.');
    }
    session.turn = { capabilityToken, controlToken, draining: false, inferenceToken };
  }

  /**
   * Starts the Turn barrier: refuses new loopback requests, waits at most `timeoutMs` for the
   * in-flight ones, then cuts the rest so their results never reach the runtime.
   *
   * @param agentSessionId AgentSession whose bound Turn reached its barrier.
   * @param timeoutMs Drain bound; the owner's value is {@link SANDBOX_TURN_DRAIN_MS}.
   * @returns The number of requests that were cut.
   */
  public async drainTurn(
    agentSessionId: string,
    timeoutMs = SANDBOX_TURN_DRAIN_MS
  ): Promise<number> {
    const session = this.loopbackSessions.get(agentSessionId);
    if (!session?.turn) {
      return 0;
    }
    session.turn.draining = true;
    const deadline = performance.now() + timeoutMs;
    while (session.inflight.size > 0 && performance.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, Math.min(25, deadline - performance.now())))
      );
    }
    const cut = session.inflight.size;
    for (const request of session.inflight) {
      request.abort();
    }
    session.inflight.clear();
    return cut;
  }

  /**
   * Clears one AgentSession's Turn route tokens after its barrier.
   *
   * @param agentSessionId AgentSession whose Turn ended.
   */
  public clearTurnRouteTokens(agentSessionId: string): void {
    const session = this.loopbackSessions.get(agentSessionId);
    if (!session) {
      return;
    }
    for (const request of session.inflight) {
      request.abort();
    }
    session.inflight.clear();
    session.turn = null;
  }

  /**
   * Accepts the sole stock bridge socket and starts the HTTP/2 client handshake.
   *
   * @param socket Supervisor-dialed loopback socket.
   */
  public accept(socket: Socket): void {
    if (this.closed || this.acceptedSocket) {
      socket.destroy();
      return;
    }

    this.acceptedSocket = socket;
    this.server.close();
    const session = connect('http://sandbox-integration', {
      createConnection: () => socket,
      settings: { enablePush: false, initialWindowSize: PER_STREAM_RECEIVE_WINDOW_BYTES },
    });
    this.session = session;
    session.once('connect', () => {
      session.setLocalWindowSize(CONNECTION_RECEIVE_WINDOW_BYTES);
      this.readyState = true;
      clearTimeout(this.readyTimer);
      this.readyResolve();
    });
    session.once('error', (error) => {
      this.readyReject(error);
      void this.close();
    });
    session.once('close', () => {
      if (!this.closed) {
        this.readyReject(new Error('Sandbox Integration session closed before readiness.'));
        void this.close();
      }
    });
  }

  /**
   * Sends one origin-form request over the accepted standard HTTP/2 session.
   *
   * @param path Exact route path under one accepted namespace.
   * @param init Method, route token, bounded body, and cancellation signal.
   * @returns Streaming HTTP/2 response.
   */
  public async request(
    path: string,
    init: {
      body?: string | Uint8Array | undefined;
      headers: Record<string, string>;
      method: string;
      signal?: AbortSignal | undefined;
    }
  ): Promise<SandboxIntegrationResponse> {
    await this.ready;
    init.signal?.throwIfAborted();
    const family = routeFamily(path);
    const bodyBytes =
      typeof init.body === 'string' ? Buffer.byteLength(init.body) : (init.body?.byteLength ?? 0);
    const maxBytes =
      family === 'worker-control'
        ? WORKER_CONTROL_MAX_BYTES
        : family === 'inference'
          ? INFERENCE_MAX_BYTES
          : CAPABILITY_MAX_BYTES;

    if (bodyBytes > maxBytes) {
      throw new TypeError(`Sandbox Integration ${family} request exceeds its byte bound.`);
    }
    if (HARNESS_CONTROL_PATHS.has(path)) {
      requireCredentialFreeHarnessHeaders(init.headers);
    } else {
      requireRouteToken(family, init.headers, this.boundTurns());
    }
    const session = this.session;
    if (!session || session.closed || session.destroyed) {
      throw new TypeError('Sandbox Integration session is not available.');
    }
    replenishConnectionWindow(session);

    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([name, value]) => {
        const normalized = name.toLowerCase();
        if (normalized.startsWith(':') || FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
          throw new TypeError('Sandbox Integration callers cannot override the HTTP/2 origin.');
        }
        return [normalized, value];
      })
    );
    const stream = session.request({
      ':method': init.method,
      ':path': path,
      ...headers,
    });

    return await responseForStream(stream, init.body, init.signal);
  }

  /** Relays one authenticated native HTTP/1 inference or capability request over the ready H2 session. */
  private async handleNativeRoute(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!this.readyState) {
      rejectNativeRequest(request, response, 503);
      return;
    }
    if (request.method !== 'POST') {
      rejectNativeRequest(request, response, 405);
      return;
    }
    const path = request.url ?? '';
    let family: RouteFamily;
    try {
      family = routeFamily(path);
      if (family === 'worker-control') {
        rejectNativeRequest(request, response, 404);
        return;
      }
    } catch {
      rejectNativeRequest(request, response, 404);
      return;
    }
    let headers: Record<string, string>;
    let session: LoopbackSession;
    try {
      headers = nativeRequestHeaders(request);
      session = this.requireLoopbackSession(family, headers.authorization);
    } catch {
      rejectNativeRequest(request, response, 401);
      return;
    }
    const turn = session.turn;
    if (!turn || turn.draining) {
      // Idle supplies no authority: with no Turn bound every loopback request is refused.
      rejectNativeRequest(request, response, 403);
      return;
    }
    headers.authorization = `Bearer ${
      family === 'inference' ? turn.inferenceToken : turn.capabilityToken
    }`;
    const maxBytes = family === 'inference' ? INFERENCE_MAX_BYTES : CAPABILITY_MAX_BYTES;
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      rejectNativeRequest(request, response, 413);
      return;
    }

    const abort = new AbortController();
    const cancel = () => abort.abort();
    const cancelIfIncomplete = () => {
      if (!response.writableEnded) {
        cancel();
      }
    };
    // A cut covers the whole HTTP/1 lifetime: a body still uploading and a response still
    // streaming end at once, and no late byte reaches the runtime or a later Turn.
    const cut = () => {
      request.destroy();
      response.destroy();
    };
    this.nativeRequests.add(abort);
    session.inflight.add(abort);
    abort.signal.addEventListener('abort', cut, { once: true });
    request.once('aborted', cancel);
    response.once('close', cancelIfIncomplete);
    try {
      const body = await collectNativeRequest(request, maxBytes);
      abort.signal.throwIfAborted();
      const upstream = await this.request(path, {
        body,
        headers,
        method: 'POST',
        signal: abort.signal,
      });
      response.writeHead(upstream.status, nativeResponseHeaders(upstream.headers));
      for await (const chunk of upstream.body) {
        if (!response.write(chunk)) {
          await once(response, 'drain', { signal: abort.signal });
        }
      }
      response.end();
    } catch (error) {
      if (!abort.signal.aborted) {
        if (!response.headersSent) {
          sendNativeError(response, error instanceof RangeError ? 413 : 502);
        } else {
          response.destroy();
        }
      } else {
        // A cut request's result is refused: the runtime never receives its response.
        response.destroy();
      }
    } finally {
      abort.signal.removeEventListener('abort', cut);
      request.off('aborted', cancel);
      response.off('close', cancelIfIncomplete);
      this.nativeRequests.delete(abort);
      session.inflight.delete(abort);
    }
  }

  /** Lists the route tokens of every currently bound Turn. */
  private boundTurns(): BoundTurnRoutes[] {
    return [...this.loopbackSessions.values()].flatMap((session) =>
      session.turn ? [session.turn] : []
    );
  }

  /**
   * Maps one native bearer to the AgentSession that owns it for exactly that route family.
   *
   * @param family Route family of the requested path.
   * @param authorization The single native authorization header value.
   * @returns The owning AgentSession.
   */
  private requireLoopbackSession(
    family: RouteFamily,
    authorization: string | undefined
  ): LoopbackSession {
    const credential = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    for (const session of this.loopbackSessions.values()) {
      const expected =
        family === 'inference' ? session.inferenceCredential : session.capabilityCredential;
      if (credential === expected) {
        return session;
      }
    }
    throw new TypeError(`Sandbox Integration rejected the ${family} loopback credential.`);
  }

  /** Closes both listeners, active native requests, accepted socket, and H2 session. */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.readyTimer);
    this.readyReject(new Error('Sandbox Integration closed.'));
    this.server.close();
    this.nativeServer.closeAllConnections();
    this.nativeServer.close();
    for (const request of this.nativeRequests) {
      request.abort();
    }
    this.nativeRequests.clear();
    this.session?.destroy();
    this.acceptedSocket?.destroy();
  }
}

/**
 * Opens the fixed sandbox-loopback Integration listener.
 *
 * @param options Optional supervisor cancellation.
 * @returns Route client with bounded readiness and definite close.
 */
export async function openSandboxIntegration(
  options: { signal?: AbortSignal | undefined } = {}
): Promise<SandboxIntegrationClient> {
  options.signal?.throwIfAborted();

  const server = createServer({ allowHalfOpen: true });
  const nativeServer = createHttpServer();
  const client = new SandboxIntegrationClient(server, nativeServer);
  const target = new URL(`http://${SANDBOX_INTEGRATION_TARGET}`);
  const nativeTarget = new URL(`http://${SANDBOX_NATIVE_INFERENCE_TARGET}`);
  server.on('connection', (socket) => client.accept(socket));
  try {
    await Promise.all([listen(server, target), listen(nativeServer, nativeTarget)]);
  } catch (error) {
    void client.ready.catch(() => undefined);
    await client.close();
    throw error;
  }
  server.on('error', () => void client.close());
  nativeServer.on('error', () => void client.close());

  if (options.signal?.aborted) {
    void client.ready.catch(() => undefined);
    await client.close();
    options.signal.throwIfAborted();
  }
  options.signal?.addEventListener('abort', () => void client.close(), { once: true });
  return client;
}

/** Binds one fixed listener and rejects startup when its port is unavailable. */
function listen(server: NetServer | HttpServer, target: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(Number(target.port), target.hostname, () => {
      server.off('error', fail);
      resolve();
    });
  });
}

/** Restores consumed connection credit before opening the next bounded stream. */
function replenishConnectionWindow(session: ClientHttp2Session): void {
  const receivedBytes = session.state.effectiveRecvDataLength ?? 0;
  if (receivedBytes > 0) {
    session.setLocalWindowSize(CONNECTION_RECEIVE_WINDOW_BYTES + receivedBytes);
  }
}

/** Returns the exact route family or rejects non-origin and undeclared paths. */
function routeFamily(path: string): RouteFamily {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) {
    throw new TypeError('Sandbox Integration accepts only origin-form route paths.');
  }
  const pathname = path.split('?', 1)[0] ?? '';
  if (pathname.startsWith('/worker-control/')) {
    return 'worker-control';
  }
  if (pathname.startsWith('/inference/')) {
    return 'inference';
  }
  if (pathname.startsWith('/capabilities/')) {
    return 'capability';
  }
  throw new TypeError('Sandbox Integration route namespace is not declared.');
}

/** Rejects a bearer that is not the same-family route token of a currently bound Turn. */
function requireRouteToken(
  family: RouteFamily,
  headers: Record<string, string>,
  turns: readonly BoundTurnRoutes[]
): void {
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization'
  )?.[1];
  const expected = turns.map((turn) =>
    family === 'worker-control'
      ? turn.controlToken
      : family === 'inference'
        ? turn.inferenceToken
        : turn.capabilityToken
  );
  if (expected.length === 0) {
    throw new TypeError(`Sandbox Integration ${family} route token is not bound.`);
  }
  if (!expected.some((token) => authorization === `Bearer ${token}`)) {
    throw new TypeError(`Sandbox Integration rejected the ${family} route token.`);
  }
}

/** Rejects credentials and client binding authority on the private Harness carriage. */
function requireCredentialFreeHarnessHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === 'authorization' || normalized === 'x-openkit-harness-binding') {
      throw new TypeError('Private Harness carriage must remain credential-free.');
    }
  }
}

/** Projects safe native HTTP/1 headers without hop-by-hop or duplicate authorization fields. */
function nativeRequestHeaders(request: IncomingMessage): Record<string, string> {
  const authorizationCount = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization'
  ).length;
  if (authorizationCount !== 1) {
    throw new TypeError('Native inference requires one authorization header.');
  }
  const connectionHeaders = new Set(
    (request.headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) => {
      const normalized = name.toLowerCase();
      if (
        value === undefined ||
        FORBIDDEN_REQUEST_HEADERS.has(normalized) ||
        connectionHeaders.has(normalized)
      ) {
        return [];
      }
      return [[normalized, Array.isArray(value) ? value.join(', ') : value]];
    })
  );
}

/** Collects one encoded native request under the semantic aggregate bound. */
async function collectNativeRequest(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new RangeError('Native Integration request exceeds its byte bound.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

/** Projects end-to-end response headers from H2 onto the local HTTP/1 response. */
function nativeResponseHeaders(headers: IncomingHttpHeaders): NodeJS.Dict<string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        value !== undefined && !name.startsWith(':') && !FORBIDDEN_REQUEST_HEADERS.has(name)
    )
  );
}

/** Returns one value-free local admission or relay failure. */
function sendNativeError(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-length': '0' });
  response.end();
}

/** Drains one locally rejected request without opening an outer stream. */
function rejectNativeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  status: number
): void {
  request.resume();
  sendNativeError(response, status);
}

/** Collects one bounded Integration response into the existing fetch-shaped surface. */
async function collectBoundedResponse(
  response: SandboxIntegrationResponse,
  maxBytes: number,
  label: string
): Promise<Awaited<ReturnType<WorkerControlFetch>>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        response.body.close(http2Constants.NGHTTP2_CANCEL);
        throw new TypeError(`${label} response exceeds the Integration byte bound.`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} response failed.`, { cause: error });
  }
  const text = Buffer.concat(chunks, bytes).toString('utf8');
  return { ok: response.ok, status: response.status, text: async () => text };
}

/** Resolves one response and normalizes stream failures to fetch transport errors. */
async function responseForStream(
  stream: ClientHttp2Stream,
  body: string | Uint8Array | undefined,
  signal: AbortSignal | undefined
): Promise<SandboxIntegrationResponse> {
  const response = new Promise<SandboxIntegrationResponse>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      stream.close(http2Constants.NGHTTP2_CANCEL);
      if (!settled) {
        settled = true;
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      }
    };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    stream.once('close', () => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new TypeError('Sandbox Integration request closed before response.'));
      }
    });
    stream.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(new TypeError('Sandbox Integration request failed.', { cause: error }));
      }
    });
    stream.once('response', (headers) => {
      if (settled) {
        return;
      }
      settled = true;
      const status = Number(headers[':status'] ?? 500);
      resolve({ body: stream, headers, ok: status >= 200 && status < 300, status });
    });
  });
  try {
    await writeRequestBody(stream, body, signal);
    return await response;
  } catch (error) {
    stream.close(http2Constants.NGHTTP2_CANCEL);
    throw error;
  }
}

/** Writes one bounded H2 request in fixed chunks while honoring peer backpressure. */
async function writeRequestBody(
  stream: ClientHttp2Stream,
  body: string | Uint8Array | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  if (bytes) {
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_HTTP2_WRITE_BYTES) {
      signal?.throwIfAborted();
      if (!stream.write(bytes.subarray(offset, offset + MAX_HTTP2_WRITE_BYTES))) {
        await waitForHttp2Drain(stream, signal);
      }
    }
  }
  stream.end();
}

/** Waits for H2 request capacity and fails if the stream closes first. */
function waitForHttp2Drain(
  stream: ClientHttp2Stream,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => {
      stream.off('close', closed);
      stream.off('drain', drained);
      stream.off('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    const closed = () => {
      cleanup();
      reject(new Error('Sandbox Integration request stream closed before drain.'));
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once('close', closed);
    stream.once('drain', drained);
    stream.once('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
