import { CodexAppServerClient } from '../runtime/codex/client.js';
import type {
  AccountLoginCompletedNotification,
  AccountUpdatedNotification,
  CancelLoginAccountResponse,
  GetAccountParams,
  GetAccountResponse,
  JsonRpcNotification,
  LoginAccountParams,
  LoginAccountResponse,
  LogoutAccountResponse,
} from '../runtime/codex/protocol.js';
import { StdioJsonRpcTransport } from '../runtime/codex/transport.js';

/**
 * Public OpenAI Codex OAuth login state.
 */
export type CodexOAuthStatus = 'logged_out' | 'pending' | 'logged_in' | 'unavailable' | 'error';

/**
 * UI-supported Codex ChatGPT login modes.
 */
export type CodexOAuthLoginMode = 'browser' | 'device_code';

/**
 * Sanitized OpenAI Codex OAuth status returned to the UI.
 */
export interface CodexOAuthStatusPayload {
  /** Reserved provider ID for OpenAI Codex. */
  readonly providerId: 'openai_codex';
  /** Server-owned account slot id. */
  readonly accountSlotId?: string;
  /** Human-readable account slot display name. */
  readonly displayName?: string;
  /** Whether this slot is the resolved default account slot. */
  readonly isDefault?: boolean;
  /** Runtime provider ids currently bound to this account slot. */
  readonly boundProviderIds?: string[];
  /** Current login state. */
  readonly status: CodexOAuthStatus;
  /** Active login mode when a login is pending. */
  readonly mode?: CodexOAuthLoginMode;
  /** Codex app-server login identifier for cancellation and completion tracking. */
  readonly loginId?: string;
  /** Browser login URL returned by Codex app-server. */
  readonly authUrl?: string;
  /** Device-code verification URL returned by Codex app-server. */
  readonly verificationUrl?: string;
  /** Device code returned by Codex app-server. */
  readonly userCode?: string;
  /** Safe ChatGPT account label returned by Codex app-server. */
  readonly accountLabel?: string;
  /** Safe ChatGPT plan label returned by Codex app-server. */
  readonly planType?: string;
  /** Public error or availability detail without token material. */
  readonly message?: string;
}

/**
 * Context used to create one account-scoped Codex app-server client.
 */
export interface CodexAccountClientFactoryContext {
  /** Server-owned account slot id. */
  readonly accountSlotId: string;
  /** Codex home directory for the account slot. */
  readonly codexHome: string;
}

/**
 * Minimal Codex app-server account client used by the OAuth bridge.
 */
export interface CodexAccountClient {
  /**
   * Sends one JSON-RPC account request.
   *
   * @param method Codex app-server JSON-RPC method.
   * @param params Request params for the method.
   * @returns Parsed JSON-RPC result.
   */
  request<TResult>(method: string, params: unknown): Promise<TResult>;

  /**
   * Subscribes to Codex app-server notifications.
   *
   * @param listener Notification listener to register.
   * @returns Unsubscribe callback.
   */
  onNotification(listener: (message: JsonRpcNotification) => void): () => void;

  /**
   * Returns the Codex home path captured during initialize, when available.
   *
   * @returns Codex home path or null.
   */
  getCodexHome?(): string | null;

  /**
   * Closes the underlying client transport.
   *
   * @returns Resolved close operation.
   */
  close(): Promise<void>;
}

/**
 * Factory for creating a Codex app-server account client.
 */
export type CodexAccountClientFactory = (
  context: CodexAccountClientFactoryContext
) => Promise<CodexAccountClient>;

/**
 * Observer invoked whenever a store status changes.
 */
export type CodexOAuthStatusObserver = (status: CodexOAuthStatusPayload) => void;

/**
 * Construction options for CodexOAuthStore.
 */
export interface CodexOAuthStoreOptions {
  /** Server-owned account slot id. */
  readonly accountSlotId?: string;
  /** Human-readable account slot display name. */
  readonly displayName?: string;
  /** Whether this slot is the default account slot. */
  readonly isDefault?: boolean;
  /** Runtime provider ids bound to this account slot. */
  readonly boundProviderIds?: string[];
  /** Codex home directory passed to Codex-managed auth storage. */
  readonly codexHome?: string | null;
  /** Optional factory used by tests or alternate Codex app-server launchers. */
  readonly clientFactory?: CodexAccountClientFactory;
  /** Optional status observer used by account-slot persistence. */
  readonly onStatusChange?: CodexOAuthStatusObserver;
}

const PROVIDER_ID = 'openai_codex' as const;

/**
 * Creates the default stdio Codex app-server account client.
 *
 * @returns Initialized Codex app-server client.
 */
async function createDefaultCodexAccountClient(
  context: CodexAccountClientFactoryContext
): Promise<CodexAccountClient> {
  const transport = new StdioJsonRpcTransport({
    cwd: process.cwd(),
    ...(context.codexHome ? { environment: { CODEX_HOME: context.codexHome } } : {}),
  });
  const client = new CodexAppServerClient({ transport });
  const initialized = await client.initialize();

  return {
    request: client.request.bind(client),
    onNotification: client.onNotification.bind(client),
    getCodexHome: () => initialized.codexHome,
    close: client.close.bind(client),
  };
}

/**
 * Converts unknown errors to public message strings.
 *
 * @param error Error value to format.
 * @returns Public error message.
 */
function publicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a logged-out public OAuth status.
 *
 * @returns Logged-out public status.
 */
function loggedOutStatus(): CodexOAuthStatusPayload {
  return {
    providerId: PROVIDER_ID,
    status: 'logged_out',
  };
}

/**
 * Maps a Codex account-read response to public OAuth state.
 *
 * @param response Codex app-server account response.
 * @returns Sanitized public account state.
 */
function statusFromAccount(response: GetAccountResponse): CodexOAuthStatusPayload {
  if (response.account?.type === 'chatgpt') {
    return {
      providerId: PROVIDER_ID,
      status: 'logged_in',
      accountLabel: response.account.email,
      planType: response.account.planType,
    };
  }

  return loggedOutStatus();
}

/**
 * App-local OpenAI Codex OAuth coordination store.
 */
export class CodexOAuthStore {
  private readonly accountSlotId: string | null;
  private readonly displayName: string | null;
  private readonly isDefault: boolean;
  private readonly boundProviderIds: string[];
  private readonly codexHome: string | null;
  private readonly clientFactory: CodexAccountClientFactory;
  private readonly onStatusChange: CodexOAuthStatusObserver | null;
  private clientPromise: Promise<CodexAccountClient> | null = null;
  private pendingStatus: CodexOAuthStatusPayload | null = null;
  private lastStatus: CodexOAuthStatusPayload;

  /**
   * Creates one OAuth coordination store.
   *
   * @param options Optional Codex account client factory.
   */
  public constructor(options: CodexOAuthStoreOptions = {}) {
    this.accountSlotId = options.accountSlotId ?? null;
    this.displayName = options.displayName ?? null;
    this.isDefault = options.isDefault ?? false;
    this.boundProviderIds = [...(options.boundProviderIds ?? [])];
    this.codexHome = options.codexHome ?? null;
    this.clientFactory = options.clientFactory ?? createDefaultCodexAccountClient;
    this.onStatusChange = options.onStatusChange ?? null;
    this.lastStatus = this.enrichStatus(loggedOutStatus());
  }

  /**
   * Return the sanitized OAuth status.
   *
   * @returns Current public OAuth state.
   */
  public async getStatus(): Promise<CodexOAuthStatusPayload> {
    try {
      const accountStatus = statusFromAccount(await this.readAccount());

      if (accountStatus.status === 'logged_in') {
        this.pendingStatus = null;
        this.updateLastStatus(accountStatus);
        return { ...this.lastStatus };
      }

      if (this.pendingStatus?.status === 'pending') {
        return { ...this.pendingStatus };
      }

      this.updateLastStatus(accountStatus);
      return { ...this.lastStatus };
    } catch (error) {
      if (this.pendingStatus?.status === 'pending') {
        return { ...this.pendingStatus };
      }

      this.updateLastStatus({
        providerId: PROVIDER_ID,
        status: 'unavailable',
        message: publicErrorMessage(error),
      });
      return { ...this.lastStatus };
    }
  }

  /**
   * Returns the last known OAuth status without probing Codex app-server.
   *
   * @returns Cached public OAuth state.
   */
  public getLastStatus(): CodexOAuthStatusPayload {
    return { ...this.lastStatus };
  }

  /**
   * Start a Codex app-server ChatGPT login flow.
   *
   * @param mode Login mode requested by the UI.
   * @returns Pending OAuth state with browser or device-code details.
   */
  public async start(mode: CodexOAuthLoginMode = 'browser'): Promise<CodexOAuthStatusPayload> {
    try {
      const client = await this.getClient();
      const params: LoginAccountParams =
        mode === 'device_code' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' };
      const response = await client.request<LoginAccountResponse>('account/login/start', params);

      this.pendingStatus = this.enrichStatus(this.statusFromLoginResponse(response));
      this.updateLastStatus(this.pendingStatus);
      return { ...this.pendingStatus };
    } catch (error) {
      this.pendingStatus = null;
      this.updateLastStatus({
        providerId: PROVIDER_ID,
        status: 'unavailable',
        message: publicErrorMessage(error),
      });
      return { ...this.lastStatus };
    }
  }

  /**
   * Cancel an in-progress Codex app-server login flow.
   *
   * @param loginId Optional login identifier; defaults to the current pending login.
   * @returns Current public OAuth state after cancellation.
   */
  public async cancel(loginId?: string): Promise<CodexOAuthStatusPayload> {
    const resolvedLoginId = loginId ?? this.pendingStatus?.loginId;

    try {
      if (resolvedLoginId) {
        const client = await this.getClient();
        await client.request<CancelLoginAccountResponse>('account/login/cancel', {
          loginId: resolvedLoginId,
        });
      }

      this.pendingStatus = null;
      this.updateLastStatus(loggedOutStatus());
      return await this.getStatus();
    } catch (error) {
      this.pendingStatus = null;
      this.updateLastStatus({
        providerId: PROVIDER_ID,
        status: 'error',
        message: publicErrorMessage(error),
      });
      return { ...this.lastStatus };
    }
  }

  /**
   * Clear the Codex app-server ChatGPT login.
   *
   * @returns Current public OAuth state after logout.
   */
  public async logout(): Promise<CodexOAuthStatusPayload> {
    try {
      const client = await this.getClient();
      await client.request<LogoutAccountResponse>('account/logout', {});
      this.pendingStatus = null;
      this.updateLastStatus(loggedOutStatus());
      return await this.getStatus();
    } catch (error) {
      this.pendingStatus = null;
      this.updateLastStatus({
        providerId: PROVIDER_ID,
        status: 'error',
        message: publicErrorMessage(error),
      });
      return { ...this.lastStatus };
    }
  }

  /**
   * Refreshes and returns the current Codex account state for internal token resolution.
   *
   * @returns Current Codex account response.
   */
  public async readAccountForTokenRefresh(): Promise<GetAccountResponse> {
    return this.readAccount(true);
  }

  /**
   * Returns the Codex home path used by Codex-managed auth storage.
   *
   * @returns Codex home path or null when the app-server did not report it.
   */
  public async getCodexHome(): Promise<string | null> {
    const client = await this.getClient();

    return this.codexHome ?? client.getCodexHome?.() ?? null;
  }

  /**
   * Returns the shared Codex account client, creating it on first use.
   *
   * @returns Initialized Codex account client.
   */
  private async getClient(): Promise<CodexAccountClient> {
    this.clientPromise ??= this.createClientWithListeners().catch((error: unknown) => {
      this.clientPromise = null;
      throw error;
    });
    return this.clientPromise;
  }

  /**
   * Creates a Codex account client and binds notification listeners.
   *
   * @returns Initialized Codex account client with listeners.
   */
  private async createClientWithListeners(): Promise<CodexAccountClient> {
    const client = await this.clientFactory({
      accountSlotId: this.accountSlotId ?? 'default',
      codexHome: this.codexHome ?? '',
    });
    client.onNotification((message) => {
      this.handleNotification(message);
    });
    return client;
  }

  /**
   * Reads the current Codex app-server account state.
   *
   * @returns Current Codex account response.
   */
  private async readAccount(refreshToken = false): Promise<GetAccountResponse> {
    const client = await this.getClient();
    const params: GetAccountParams = { refreshToken };
    return client.request<GetAccountResponse>('account/read', params);
  }

  /**
   * Converts a Codex login response to public pending state.
   *
   * @param response Login response returned by Codex app-server.
   * @returns Pending public OAuth state.
   */
  private statusFromLoginResponse(response: LoginAccountResponse): CodexOAuthStatusPayload {
    if (response.type === 'chatgptDeviceCode') {
      return {
        providerId: PROVIDER_ID,
        status: 'pending',
        mode: 'device_code',
        loginId: response.loginId,
        verificationUrl: response.verificationUrl,
        userCode: response.userCode,
      };
    }

    return {
      providerId: PROVIDER_ID,
      status: 'pending',
      mode: 'browser',
      loginId: response.loginId,
      authUrl: response.authUrl,
    };
  }

  /**
   * Handles Codex account notifications without exposing token material.
   *
   * @param message JSON-RPC notification emitted by Codex app-server.
   */
  private handleNotification(message: JsonRpcNotification): void {
    if (message.method === 'account/login/completed') {
      this.handleLoginCompleted(message.params as AccountLoginCompletedNotification);
      return;
    }

    if (message.method === 'account/updated') {
      this.handleAccountUpdated(message.params as AccountUpdatedNotification);
    }
  }

  /**
   * Handles a Codex login-completed notification.
   *
   * @param notification Login-completed notification payload.
   */
  private handleLoginCompleted(notification: AccountLoginCompletedNotification): void {
    const pendingStatus = this.pendingStatus;

    if (!pendingStatus || pendingStatus.loginId !== notification.loginId) {
      return;
    }

    if (notification.success) {
      this.pendingStatus = null;
      void this.getStatus().catch(() => undefined);
      return;
    }

    this.pendingStatus = null;
    this.updateLastStatus({
      providerId: PROVIDER_ID,
      status: 'error',
      ...(pendingStatus.mode ? { mode: pendingStatus.mode } : {}),
      loginId: notification.loginId,
      message: notification.error ?? 'ChatGPT login failed.',
    });
  }

  /**
   * Handles a Codex account-updated notification.
   *
   * @param notification Account-updated notification payload.
   */
  private handleAccountUpdated(notification: AccountUpdatedNotification): void {
    if (notification.authMode === 'chatgpt') {
      this.pendingStatus = null;
      this.updateLastStatus({
        providerId: PROVIDER_ID,
        status: 'logged_in',
        ...(this.lastStatus.accountLabel ? { accountLabel: this.lastStatus.accountLabel } : {}),
        ...(notification.planType ? { planType: notification.planType } : {}),
      });
      return;
    }

    this.pendingStatus = null;
    this.updateLastStatus(loggedOutStatus());
  }

  private enrichStatus(status: CodexOAuthStatusPayload): CodexOAuthStatusPayload {
    return {
      ...status,
      accountSlotId: this.accountSlotId ?? 'default',
      ...(this.displayName ? { displayName: this.displayName } : {}),
      isDefault: this.isDefault,
      boundProviderIds: [...this.boundProviderIds],
    };
  }

  private updateLastStatus(status: CodexOAuthStatusPayload): void {
    this.lastStatus = this.enrichStatus(status);
    this.onStatusChange?.(this.lastStatus);
  }
}
