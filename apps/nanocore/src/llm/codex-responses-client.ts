import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Agent, fetch as undiciFetch } from 'undici';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { GetAccountResponse } from '../runtime/codex/protocol.js';
import type {
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from './openai-compatible-client.js';
import type { LLMGatewayTransportContext } from './provider-dispatcher.js';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_RESPONSES_PATH = 'codex/responses';
const CODEX_RESPONSES_TIMEOUT_MS = 0;
const KEYCHAIN_SERVICE = 'Codex Auth';
const execFile = promisify(execFileCallback);
const codexResponsesDispatcher = new Agent({
  bodyTimeout: CODEX_RESPONSES_TIMEOUT_MS,
  headersTimeout: CODEX_RESPONSES_TIMEOUT_MS,
});

/**
 * Sends one Codex request through the process-local long-running dispatcher.
 *
 * @param input Request URL or request object.
 * @param init Optional request initialization.
 * @returns Upstream Codex response.
 */
const fetchCodexResponse: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });

  return (await undiciFetch(request.url, {
    dispatcher: codexResponsesDispatcher,
    headers,
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
    ...(body ? { body } : {}),
  })) as Response;
};

/**
 * Account-store surface needed for private Codex token resolution.
 */
export interface CodexTokenResolutionAccountStore {
  /**
   * Refreshes and reads the current Codex account without exposing token material.
   *
   * @returns Current Codex account state.
   */
  readAccountForTokenRefresh(): Promise<GetAccountResponse>;

  /**
   * Returns the Codex home path used by Codex-managed auth storage.
   *
   * @returns Codex home path, or null when unavailable.
   */
  getCodexHome(): Promise<string | null>;
}

/**
 * Resolved ChatGPT subscription token data used for one upstream request.
 */
export interface CodexResolvedAuthToken {
  /** Bearer token used only for upstream ChatGPT Codex calls. */
  readonly accessToken: string;
  /** ChatGPT account ID required by the Codex backend. */
  readonly chatgptAccountId: string;
}

/**
 * Token resolver used by the Codex Responses client.
 */
export interface CodexTokenResolver {
  /**
   * Resolves a fresh Codex ChatGPT bearer token.
   *
   * @returns Access token and ChatGPT account ID.
   */
  resolve(): Promise<CodexResolvedAuthToken>;
}

/**
 * Construction options for CodexAuthTokenResolver.
 */
export interface CodexAuthTokenResolverOptions {
  /** Account store that triggers Codex-managed refresh before disk or Keychain reads. */
  readonly accountStore: CodexTokenResolutionAccountStore;
  /** Optional platform override for tests. */
  readonly platform?: NodeJS.Platform;
  /** Optional direct Codex home override for tests or custom runtimes. */
  readonly codexHome?: string;
  /** Optional Keychain reader used by tests. */
  readonly readKeychainPassword?: (service: string, account: string) => Promise<string | null>;
}

/**
 * Resolves private Codex ChatGPT auth tokens from Codex-managed local storage.
 */
export class CodexAuthTokenResolver implements CodexTokenResolver {
  private readonly accountStore: CodexTokenResolutionAccountStore;
  private readonly platform: NodeJS.Platform;
  private readonly codexHome: string | null;
  private readonly readKeychainPassword: (
    service: string,
    account: string
  ) => Promise<string | null>;

  /**
   * Creates one token resolver.
   *
   * @param options Resolver dependencies and optional test overrides.
   */
  public constructor(options: CodexAuthTokenResolverOptions) {
    this.accountStore = options.accountStore;
    this.platform = options.platform ?? osPlatform();
    this.codexHome = options.codexHome ?? null;
    this.readKeychainPassword = options.readKeychainPassword ?? readMacosKeychainPassword;
  }

  /**
   * Resolves a refreshed ChatGPT subscription bearer token.
   *
   * @returns Resolved bearer token and account ID.
   */
  public async resolve(): Promise<CodexResolvedAuthToken> {
    await this.accountStore.readAccountForTokenRefresh();
    const codexHome = await this.resolveCodexHome();
    const keychainToken = await this.readKeychainToken(codexHome);

    if (keychainToken) {
      return keychainToken;
    }

    const fileToken = this.readAuthJsonToken(codexHome);

    if (fileToken) {
      return fileToken;
    }

    throw new Error('Codex ChatGPT auth token is unavailable. Sign in through Codex first.');
  }

  private async resolveCodexHome(): Promise<string> {
    return this.codexHome ?? (await this.accountStore.getCodexHome()) ?? join(homedir(), '.codex');
  }

  private async readKeychainToken(codexHome: string): Promise<CodexResolvedAuthToken | null> {
    if (this.platform !== 'darwin') {
      return null;
    }

    const account = computeCodexKeychainAccount(codexHome);
    const password = await this.readKeychainPassword(KEYCHAIN_SERVICE, account).catch(() => null);

    return password ? parseTokenData(password) : null;
  }

  private readAuthJsonToken(codexHome: string): CodexResolvedAuthToken | null {
    const authPath = join(codexHome, 'auth.json');

    if (!existsSync(authPath)) {
      return null;
    }

    const raw = readFileSync(authPath, 'utf8');
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const tokens = payload.tokens;

    return typeof tokens === 'object' && tokens
      ? parseTokenRecord(tokens as Record<string, unknown>)
      : null;
  }
}

/**
 * Construction options for CodexResponsesClient.
 */
export interface CodexResponsesClientOptions {
  /** Token resolver used for private ChatGPT subscription auth. */
  readonly tokenResolver?: CodexTokenResolver;
  /** Provider-aware token resolver factory used for account-scoped Codex slots. */
  readonly tokenResolverForProvider?: (provider: ResolvedLLMProviderConfig) => CodexTokenResolver;
  /** Fetch implementation used for HTTP calls. */
  readonly fetch?: typeof fetch;
}

/**
 * Responses-only HTTP client for the ChatGPT Codex backend API.
 */
export class CodexResponsesClient {
  private readonly tokenResolver: CodexTokenResolver | null;
  private readonly tokenResolverForProvider:
    | ((provider: ResolvedLLMProviderConfig) => CodexTokenResolver)
    | null;
  private readonly fetchImpl: typeof fetch;

  /**
   * Creates one Codex Responses client.
   *
   * @param options Client dependencies.
   */
  public constructor(options: CodexResponsesClientOptions) {
    this.tokenResolver = options.tokenResolver ?? null;
    this.tokenResolverForProvider = options.tokenResolverForProvider ?? null;
    this.fetchImpl = options.fetch ?? fetchCodexResponse;
  }

  /**
   * Creates a non-streaming Responses request through ChatGPT Codex.
   *
   * @param provider OpenAI Codex provider config.
   * @param request Responses request.
   * @param transport Optional cancellation and Codex continuity state.
   * @returns Responses response.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    transport: LLMGatewayTransportContext = {}
  ): Promise<OpenAICompatibleResponsesResponse> {
    const response = await this.send(provider, request, false, transport);
    return this.readJsonResponse<OpenAICompatibleResponsesResponse>(response);
  }

  /**
   * Creates a streaming Responses request through ChatGPT Codex.
   *
   * @param provider OpenAI Codex provider config.
   * @param request Responses request.
   * @param transport Optional cancellation and Codex continuity state.
   * @returns Upstream Responses SSE stream.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    transport: LLMGatewayTransportContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.send(provider, request, true, transport);

    if (!response.ok) {
      await this.readJsonResponse(response);
    }

    if (!response.body) {
      throw new Error('OpenAI Codex provider returned an empty stream.');
    }

    return response.body;
  }

  private async send(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    stream: boolean,
    transport: LLMGatewayTransportContext
  ): Promise<Response> {
    transport.signal?.throwIfAborted();
    const tokenResolver = this.resolveTokenResolver(provider);
    const first = await tokenResolver.resolve();
    transport.signal?.throwIfAborted();
    const firstResponse = await this.fetchImpl(
      this.createRequest(provider, request, first, stream, transport)
    );

    if (firstResponse.status !== 401) {
      this.acceptCodexTurnState(firstResponse, transport);
      return firstResponse;
    }

    await firstResponse.body?.cancel().catch(() => undefined);
    transport.signal?.throwIfAborted();
    const refreshed = await tokenResolver.resolve();
    transport.signal?.throwIfAborted();
    const finalResponse = await this.fetchImpl(
      this.createRequest(provider, request, refreshed, stream, transport)
    );
    this.acceptCodexTurnState(finalResponse, transport);
    return finalResponse;
  }

  private resolveTokenResolver(provider: ResolvedLLMProviderConfig): CodexTokenResolver {
    const resolver = this.tokenResolverForProvider?.(provider) ?? this.tokenResolver;

    if (!resolver) {
      throw new Error('OpenAI Codex provider is missing a token resolver.');
    }

    return resolver;
  }

  private createRequest(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    token: CodexResolvedAuthToken,
    stream: boolean,
    transport: LLMGatewayTransportContext
  ): Request {
    const body = {
      ...request,
      model: stripCodexModelPrefix(request.model),
      stream,
      ...(request.store === undefined ? { store: false } : {}),
    };
    const headers = new Headers({
      accept: stream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${token.accessToken}`,
      'chatgpt-account-id': token.chatgptAccountId,
      'content-type': 'application/json',
      'openai-beta': 'responses=experimental',
      originator: 'openkit',
    });
    if (transport.codexTurnState) {
      headers.set('x-codex-turn-state', transport.codexTurnState);
    }

    return new Request(joinUrl(provider.baseUrl ?? DEFAULT_CODEX_BASE_URL, CODEX_RESPONSES_PATH), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(transport.signal ? { signal: transport.signal } : {}),
    });
  }

  /**
   * Accepts Codex turn state only from the response returned to the caller.
   *
   * @param response Final upstream response.
   * @param transport Continuity observer supplied by the caller.
   */
  private acceptCodexTurnState(response: Response, transport: LLMGatewayTransportContext): void {
    const turnState = response.headers.get('x-codex-turn-state');

    if (turnState) {
      transport.onCodexTurnState?.(turnState);
    }
  }

  private async readJsonResponse<T>(response: Response): Promise<T> {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      const error = typeof payload.error === 'object' && payload.error ? payload.error : {};
      const detail = error as Record<string, unknown>;
      const message =
        typeof detail.message === 'string'
          ? detail.message
          : `OpenAI Codex provider request failed with status ${response.status}.`;

      throw new Error(message);
    }

    return payload as T;
  }
}

/**
 * Computes the Codex Keychain account name used by Codex Rust auth storage.
 *
 * @param codexHome Codex home directory.
 * @returns Keychain account name.
 */
export function computeCodexKeychainAccount(codexHome: string): string {
  const canonicalHome = canonicalizePath(codexHome);
  const digest = createHash('sha256').update(canonicalHome).digest('hex').slice(0, 16);

  return `cli|${digest}`;
}

function canonicalizePath(path: string): string {
  const resolvedPath = resolve(path);

  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
}

async function readMacosKeychainPassword(service: string, account: string): Promise<string | null> {
  const result = await execFile('/usr/bin/security', [
    'find-generic-password',
    '-s',
    service,
    '-a',
    account,
    '-w',
  ]);

  return result.stdout.trim() || null;
}

function parseTokenData(raw: string): CodexResolvedAuthToken | null {
  return parseTokenRecord(JSON.parse(raw) as Record<string, unknown>);
}

function parseTokenRecord(record: Record<string, unknown>): CodexResolvedAuthToken | null {
  const accessToken = record.access_token;
  const accountId = record.account_id ?? readAccountIdFromIdToken(record.id_token);

  if (typeof accessToken !== 'string' || typeof accountId !== 'string') {
    return null;
  }

  return {
    accessToken,
    chatgptAccountId: accountId,
  };
}

function readAccountIdFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'object' || !idToken) {
    return null;
  }

  const record = idToken as Record<string, unknown>;
  return typeof record.chatgpt_account_id === 'string' ? record.chatgpt_account_id : null;
}

function stripCodexModelPrefix(model: string): string {
  return model.replace(/^(openai-codex|openai_codex)\//, '');
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
