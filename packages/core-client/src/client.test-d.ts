import type {
  CancelProviderSubscriptionAccountLoginRequest,
  CreateProviderSubscriptionAccountRequest,
  ProviderSubscriptionAccount,
  ProviderSubscriptionAccountsResponse,
  ProviderSubscriptionAutoTopup,
  ProviderSubscriptionQuota,
  ProviderSubscriptionsResponse,
  StartProviderSubscriptionAccountLoginRequest,
  UpdateProviderSubscriptionAccountRequest,
} from '@openkit/app-api-schemas';
import type { CoreClient } from './client.js';

/** Exact canonical provider-subscription operations required on the composed Core Client. */
interface ExpectedProviderSubscriptionOperations {
  /** Returns the fixed supported provider-subscription inventory. */
  'provider-subscription.provider-list'(
    input: Record<string, never>
  ): Promise<ProviderSubscriptionsResponse>;
  /** Returns accounts for one supported provider subscription. */
  'provider-subscription.account-list'(input: {
    subscriptionProviderId: string;
  }): Promise<ProviderSubscriptionAccountsResponse>;
  /** Creates one provider-scoped account slot. */
  'provider-subscription.account-create'(
    input: { subscriptionProviderId: string } & CreateProviderSubscriptionAccountRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Updates one provider-scoped account slot. */
  'provider-subscription.account-update'(
    input: {
      subscriptionProviderId: string;
      accountSlotId: string;
    } & UpdateProviderSubscriptionAccountRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Deletes one provider-scoped account slot. */
  'provider-subscription.account-delete'(input: {
    subscriptionProviderId: string;
    accountSlotId: string;
  }): Promise<null>;
  /** Returns the sanitized status of one provider-scoped account slot. */
  'provider-subscription.account-status'(input: {
    subscriptionProviderId: string;
    accountSlotId: string;
  }): Promise<ProviderSubscriptionAccount>;
  /** Starts device-code login for one provider-scoped account slot. */
  'provider-subscription.account-login-start'(
    input: {
      subscriptionProviderId: string;
      accountSlotId: string;
    } & StartProviderSubscriptionAccountLoginRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Cancels one active provider-scoped login interaction. */
  'provider-subscription.account-login-cancel'(
    input: {
      subscriptionProviderId: string;
      accountSlotId: string;
    } & CancelProviderSubscriptionAccountLoginRequest
  ): Promise<ProviderSubscriptionAccount>;
  /** Logs out one provider-scoped account slot. */
  'provider-subscription.account-logout'(input: {
    subscriptionProviderId: string;
    accountSlotId: string;
  }): Promise<ProviderSubscriptionAccount>;
  /** Returns the bounded quota projection for one provider-scoped account slot. */
  'provider-subscription.account-quota'(input: {
    subscriptionProviderId: string;
    accountSlotId: string;
  }): Promise<ProviderSubscriptionQuota>;
  /** Returns the bounded xAI auto-top-up observation for one provider-scoped account slot. */
  'provider-subscription.account-auto-topup'(input: {
    subscriptionProviderId: string;
    accountSlotId: string;
  }): Promise<ProviderSubscriptionAutoTopup>;
}

/** Flattens selector intersections and makes operation-map mutability explicit for exact comparison. */
type CanonicalMethods<Surface extends { [Key in keyof Surface]: (input: never) => unknown }> = {
  readonly [Key in keyof Surface]: (
    input: { [Field in keyof Parameters<Surface[Key]>[0]]: Parameters<Surface[Key]>[0][Field] }
  ) => ReturnType<Surface[Key]>;
};

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
  IsIdentical<
    CanonicalMethods<Pick<CoreClient['operations'], keyof ExpectedProviderSubscriptionOperations>>,
    CanonicalMethods<ExpectedProviderSubscriptionOperations>
  >
>;
