/**
 * JSON-RPC request sent to Codex app-server.
 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: TParams;
}

/**
 * JSON-RPC success response returned by Codex app-server.
 */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: number;
  result: TResult;
}

/**
 * JSON-RPC error response returned by Codex app-server.
 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: {
    code: number;
    message: string;
  };
}

/**
 * JSON-RPC notification emitted by Codex app-server.
 */
export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc?: '2.0';
  method: string;
  params: TParams;
}

/**
 * JSON-RPC response union.
 */
export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

/**
 * Minimal initialize request supported by nanocore.
 */
export interface InitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities: null;
}

/**
 * Minimal initialize response used by nanocore.
 */
export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/**
 * Minimal Codex account shape returned by `account/read`.
 */
export type CodexAccount =
  | {
      type: 'apiKey';
    }
  | {
      type: 'chatgpt';
      email: string;
      planType: string;
    }
  | {
      type: 'amazonBedrock';
    };

/**
 * Minimal account-read request used by the OpenAI Codex OAuth bridge.
 */
export interface GetAccountParams {
  refreshToken: boolean;
}

/**
 * Minimal account-read response returned by Codex app-server.
 */
export interface GetAccountResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

/**
 * ChatGPT login request variants supported by Codex app-server.
 */
export type LoginAccountParams =
  | {
      type: 'chatgpt';
      codexStreamlinedLogin?: boolean;
    }
  | {
      type: 'chatgptDeviceCode';
    };

/**
 * ChatGPT login response variants returned by Codex app-server.
 */
export type LoginAccountResponse =
  | {
      type: 'chatgpt';
      loginId: string;
      authUrl: string;
    }
  | {
      type: 'chatgptDeviceCode';
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };

/**
 * Status returned after cancelling a Codex account login.
 */
export type CancelLoginAccountStatus = 'canceled' | 'notFound';

/**
 * Response returned after cancelling a Codex account login.
 */
export interface CancelLoginAccountResponse {
  status: CancelLoginAccountStatus;
}

/**
 * Empty response returned after Codex account logout.
 */
export type LogoutAccountResponse = Record<string, never>;

/**
 * Codex account auth mode surfaced by account notifications.
 */
export type CodexAccountAuthMode = 'apiKey' | 'chatgpt' | 'amazonBedrock';

/**
 * `account/updated` notification payload.
 */
export interface AccountUpdatedNotification {
  authMode: CodexAccountAuthMode | null;
  planType: string | null;
}

/**
 * `account/login/completed` notification payload.
 */
export interface AccountLoginCompletedNotification {
  loginId: string;
  success: boolean;
  error: string | null;
}

/**
 * Minimal Codex thread object returned by `thread/start`.
 */
export interface CodexThread {
  id: string;
  name: string | null;
  preview: string;
}

/**
 * Minimal text user input item accepted by `turn/start`.
 */
export interface TurnTextInput {
  type: 'text';
  text: string;
  text_elements: [];
}

/**
 * Minimal Codex turn payload.
 */
export interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: {
    code: string | null;
    message: string;
  } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

/**
 * Minimal selectable option for Codex request_user_input questions.
 */
export interface ToolRequestUserInputOption {
  label: string;
  description: string;
}

/**
 * Minimal question payload for Codex request_user_input requests.
 */
export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options?: ToolRequestUserInputOption[] | null;
  isOther?: boolean;
  isSecret?: boolean;
}

/**
 * `turn/started` notification payload.
 */
export interface TurnStartedNotification {
  threadId: string;
  turn: CodexTurn;
}

/**
 * `turn/completed` notification payload.
 */
export interface TurnCompletedNotification {
  threadId: string;
  turn: CodexTurn;
}

/**
 * `item/agentMessage/delta` notification payload.
 */
export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/**
 * `item/commandExecution/outputDelta` notification payload.
 */
export interface CommandExecutionOutputDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

/**
 * Minimal Codex thread item shape used for Codex runtime normalization.
 */
export type CodexThreadItem =
  | {
      type: 'agentMessage';
      id: string;
      text?: string;
    }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number | null;
    };

/**
 * `item/started` notification payload.
 */
export interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}

/**
 * `item/completed` notification payload.
 */
export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
}
