import {
  type CancelProviderSubscriptionAccountLoginRequest,
  CancelProviderSubscriptionAccountLoginRequestSchema,
  type CreateProviderSubscriptionAccountRequest,
  CreateProviderSubscriptionAccountRequestSchema,
  type ProviderSubscriptionAccount,
  ProviderSubscriptionAccountSchema,
  type ProviderSubscriptionAccountsResponse,
  ProviderSubscriptionAccountsResponseSchema,
  type ProviderSubscriptionQuota,
  ProviderSubscriptionQuotaSchema,
  type ProviderSubscriptionsResponse,
  ProviderSubscriptionsResponseSchema,
  type StartProviderSubscriptionAccountLoginRequest,
  StartProviderSubscriptionAccountLoginRequestSchema,
  type UpdateProviderSubscriptionAccountRequest,
  UpdateProviderSubscriptionAccountRequestSchema,
} from '@openkit/app-api-schemas';
import { parseJsonResponse } from './http.js';
import type { ClientTransport } from './transport.js';

/**
 * Encodes one path segment after native USVString normalization.
 *
 * @param value Raw provider or account-slot identifier.
 * @returns Percent-encoded path segment.
 */
function encodePathSegment(value: string): string {
  const usvString = new TextDecoder(undefined, { ignoreBOM: true }).decode(
    new TextEncoder().encode(value)
  );
  return encodeURIComponent(usvString);
}

/** Provider-subscription inventory, account, login, and quota client. */
export interface ProviderSubscriptionsClient {
  /** Returns the fixed supported provider-subscription inventory. */
  listProviders(): Promise<ProviderSubscriptionsResponse>;
  /** Returns accounts for one supported provider subscription. */
  listAccounts(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId']
  ): Promise<ProviderSubscriptionAccountsResponse>;
  /** Creates one provider-scoped account slot. */
  createAccount(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    input: CreateProviderSubscriptionAccountRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Updates one provider-scoped account slot. */
  updateAccount(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string,
    input: UpdateProviderSubscriptionAccountRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Deletes one provider-scoped account slot. */
  deleteAccount(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string
  ): Promise<void>;
  /** Returns the sanitized status of one provider-scoped account slot. */
  getAccountStatus(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string
  ): Promise<ProviderSubscriptionAccount>;
  /** Starts device-code login for one provider-scoped account slot. */
  startAccountLogin(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string,
    input: StartProviderSubscriptionAccountLoginRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Cancels one active provider-scoped login interaction. */
  cancelAccountLogin(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string,
    input: CancelProviderSubscriptionAccountLoginRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Logs out one provider-scoped account slot. */
  logoutAccount(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string
  ): Promise<ProviderSubscriptionAccount>;
  /** Returns the bounded quota projection for one provider-scoped account slot. */
  getAccountQuota(
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string
  ): Promise<ProviderSubscriptionQuota>;
}

/**
 * Creates the provider-subscription inventory, account, login, and quota client.
 *
 * @param transport Shared Core Client HTTP transport.
 * @returns Provider-subscription client bound to the transport.
 */
export function createProviderSubscriptionsClient(
  transport: ClientTransport
): ProviderSubscriptionsClient {
  /**
   * Builds the route prefix for one provider-scoped account slot.
   *
   * @param subscriptionProviderId Supported provider-subscription identifier.
   * @param accountSlotId Provider-scoped account-slot identifier.
   * @returns Encoded account route.
   */
  const accountPath = (
    subscriptionProviderId: ProviderSubscriptionAccount['subscriptionProviderId'],
    accountSlotId: string
  ): string =>
    `/api/app/provider-subscriptions/${encodePathSegment(subscriptionProviderId)}/accounts/${encodePathSegment(accountSlotId)}`;

  return {
    listProviders: () =>
      transport.getJson('/api/app/provider-subscriptions', ProviderSubscriptionsResponseSchema),
    listAccounts: (subscriptionProviderId) =>
      transport.getJson(
        `/api/app/provider-subscriptions/${encodePathSegment(subscriptionProviderId)}/accounts`,
        ProviderSubscriptionAccountsResponseSchema
      ),
    createAccount: (subscriptionProviderId, input) =>
      transport.postJson(
        `/api/app/provider-subscriptions/${encodePathSegment(subscriptionProviderId)}/accounts`,
        CreateProviderSubscriptionAccountRequestSchema.parse(input),
        ProviderSubscriptionAccountSchema
      ),
    updateAccount: (subscriptionProviderId, accountSlotId, input) =>
      transport.patchJson(
        accountPath(subscriptionProviderId, accountSlotId),
        UpdateProviderSubscriptionAccountRequestSchema.parse(input),
        ProviderSubscriptionAccountSchema
      ),
    deleteAccount: (subscriptionProviderId, accountSlotId) =>
      transport.deleteEmpty(accountPath(subscriptionProviderId, accountSlotId)),
    getAccountStatus: (subscriptionProviderId, accountSlotId) =>
      transport.getJson(
        `${accountPath(subscriptionProviderId, accountSlotId)}/status`,
        ProviderSubscriptionAccountSchema
      ),
    startAccountLogin: (subscriptionProviderId, accountSlotId, input) =>
      transport.postJson(
        `${accountPath(subscriptionProviderId, accountSlotId)}/login`,
        StartProviderSubscriptionAccountLoginRequestSchema.parse(input),
        ProviderSubscriptionAccountSchema
      ),
    cancelAccountLogin: (subscriptionProviderId, accountSlotId, input) =>
      transport.postJson(
        `${accountPath(subscriptionProviderId, accountSlotId)}/login/cancel`,
        CancelProviderSubscriptionAccountLoginRequestSchema.parse(input),
        ProviderSubscriptionAccountSchema
      ),
    logoutAccount: async (subscriptionProviderId, accountSlotId) => {
      const response = await transport.fetch(
        transport.url(`${accountPath(subscriptionProviderId, accountSlotId)}/logout`),
        {
          credentials: 'include',
          headers: new Headers(transport.headers),
          method: 'POST',
        }
      );
      return parseJsonResponse(response, ProviderSubscriptionAccountSchema);
    },
    getAccountQuota: (subscriptionProviderId, accountSlotId) =>
      transport.getJson(
        `${accountPath(subscriptionProviderId, accountSlotId)}/quota`,
        ProviderSubscriptionQuotaSchema
      ),
  };
}
