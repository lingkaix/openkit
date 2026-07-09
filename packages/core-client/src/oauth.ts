import {
  type CancelOpenAICodexOAuthRequest,
  CancelOpenAICodexOAuthRequestSchema,
  type CodexOAuthAccountSummary,
  CodexOAuthAccountSummarySchema,
  type CodexOAuthAccountsPayload,
  CodexOAuthAccountsPayloadSchema,
  type CodexOAuthStatusPayload,
  CodexOAuthStatusPayloadSchema,
  type CreateOpenAICodexOAuthAccountRequest,
  CreateOpenAICodexOAuthAccountRequestSchema,
  type StartOpenAICodexOAuthRequest,
  StartOpenAICodexOAuthRequestSchema,
  type UpdateOpenAICodexOAuthAccountRequest,
  UpdateOpenAICodexOAuthAccountRequestSchema,
} from '@openkit/app-api-schemas';
import type { ClientTransport } from './transport.js';

export type { CodexOAuthLoginMode, CodexOAuthStatusPayload } from '@openkit/app-api-schemas';

/** OpenAI Codex OAuth account client. */
export interface OpenAICodexOAuthClient {
  /** Lists server-owned OpenAI Codex ChatGPT account slots. */
  listAccounts(): Promise<CodexOAuthAccountsPayload>;
  /** Creates one server-owned OpenAI Codex ChatGPT account slot. */
  createAccount(input: CreateOpenAICodexOAuthAccountRequest): Promise<CodexOAuthAccountSummary>;
  /** Renames one server-owned OpenAI Codex ChatGPT account slot. */
  updateAccount(
    accountSlotId: string,
    input: UpdateOpenAICodexOAuthAccountRequest
  ): Promise<CodexOAuthAccountSummary>;
  /** Deletes one server-owned OpenAI Codex ChatGPT account slot. */
  deleteAccount(accountSlotId: string): Promise<void>;
  /** Reads one account-scoped OpenAI Codex ChatGPT login status. */
  getAccountStatus(accountSlotId: string): Promise<CodexOAuthStatusPayload>;
  /** Starts one account-scoped browser or device-code OpenAI Codex ChatGPT login. */
  startAccount(
    accountSlotId: string,
    input?: StartOpenAICodexOAuthRequest
  ): Promise<CodexOAuthStatusPayload>;
  /** Cancels one account-scoped pending OpenAI Codex ChatGPT login. */
  cancelAccount(
    accountSlotId: string,
    input?: CancelOpenAICodexOAuthRequest
  ): Promise<CodexOAuthStatusPayload>;
  /** Logs out one account-scoped OpenAI Codex ChatGPT account. */
  logoutAccount(accountSlotId: string): Promise<CodexOAuthStatusPayload>;
}

/** Creates the OpenAI Codex OAuth account client. */
export function createOpenAICodexOAuthClient(transport: ClientTransport): OpenAICodexOAuthClient {
  return {
    listAccounts: () =>
      transport.getJson('/api/app/oauth/openai-codex/accounts', CodexOAuthAccountsPayloadSchema),
    createAccount: (input) =>
      transport.postJson(
        '/api/app/oauth/openai-codex/accounts',
        CreateOpenAICodexOAuthAccountRequestSchema.parse(input),
        CodexOAuthAccountSummarySchema
      ),
    updateAccount: (accountSlotId, input) =>
      transport.patchJson(
        `/api/app/oauth/openai-codex/accounts/${encodeURIComponent(accountSlotId)}`,
        UpdateOpenAICodexOAuthAccountRequestSchema.parse(input),
        CodexOAuthAccountSummarySchema
      ),
    deleteAccount: (accountSlotId) =>
      transport.deleteEmpty(
        `/api/app/oauth/openai-codex/accounts/${encodeURIComponent(accountSlotId)}`
      ),
    getAccountStatus: (accountSlotId) =>
      transport.getJson(
        `/api/app/oauth/openai-codex/accounts/${encodeURIComponent(accountSlotId)}/status`,
        CodexOAuthStatusPayloadSchema
      ),
    startAccount: (accountSlotId, input = {}) =>
      transport.postJson(
        `/api/app/oauth/openai-codex/accounts/${encodeURIComponent(accountSlotId)}/start`,
        StartOpenAICodexOAuthRequestSchema.parse(input),
        CodexOAuthStatusPayloadSchema
      ),
    cancelAccount: (accountSlotId, input = {}) =>
      transport.postJson(
        `/api/app/oauth/openai-codex/accounts/${encodeURIComponent(accountSlotId)}/cancel`,
        CancelOpenAICodexOAuthRequestSchema.parse(input),
        CodexOAuthStatusPayloadSchema
      ),
    logoutAccount: (accountSlotId) =>
      transport.postJson(
        `/api/app/oauth/openai-codex/accounts/${encodeURIComponent(accountSlotId)}/logout`,
        {},
        CodexOAuthStatusPayloadSchema
      ),
  };
}
