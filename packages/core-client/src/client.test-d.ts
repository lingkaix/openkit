import type {
  CancelProviderSubscriptionAccountLoginRequest,
  CreateProviderSubscriptionAccountRequest,
  ProviderSubscriptionAccount,
  ProviderSubscriptionAccountsResponse,
  ProviderSubscriptionQuota,
  ProviderSubscriptionsResponse,
  StartProviderSubscriptionAccountLoginRequest,
  UpdateProviderSubscriptionAccountRequest,
} from '@openkit/app-api-schemas';
import type { CoreClient } from './client.js';

/** Exact public provider-subscription namespace required on the composed Core Client. */
interface ExpectedProviderSubscriptionsClient {
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

/** Resolves to true only when both types have identical assignability. */
type IsIdentical<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

/** Rejects any compile-time contract that does not resolve to true. */
type AssertTrue<Value extends true> = Value;

/** Compile-time proof that Core Client exposes exactly the accepted provider-subscription surface. */
export type CoreClientProviderSubscriptionsContract = AssertTrue<
  IsIdentical<CoreClient['providerSubscriptions'], ExpectedProviderSubscriptionsClient>
>;
