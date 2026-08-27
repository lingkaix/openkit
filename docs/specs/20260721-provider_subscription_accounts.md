---
status: Accepted
implementation: Partial
---
# Provider Subscription Accounts

## Owns

This spec owns deployment-admin management of server-owned LLM subscription account slots, the binding from one provider profile to one slot, the slot-scoped bridge between OpenKit Vault storage and pi-ai authentication, login, refresh, logout, sanitized account status, and optional provider quota projection for the initially supported `openai-codex` and `xai` subscription providers.

## Does Not Own

This spec does not own LLM request, response, streaming, cache, usage, or error mapping, which belongs to `docs/specs/20260708-pi_ai_unified_llm_backend.md`; the public `/v1/*` Gateway contract, which belongs to `docs/specs/20260526-llm_gateway_responses_api.md`; pi-ai version pinning and external-boundary review, which belongs to `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`; the Vault backend implementation; provider subscription purchase, cancellation, billing, or remote credential revocation; user-owned subscription accounts; or a general OAuth framework.

It also does not own how a fixed real-provider test is executed: run counts, ordering, local credential-source paths, token-claim derivation, temporary environments, evidence packaging, and adjudication are L3 opt-in test concerns under `docs/specs/20260529-test_strategy.md`. A release's execution history belongs to its change record. This spec states product behavior and the distinct evidence a real-provider run must produce, not the procedure that produces it.

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/metering.md`

Related specs:


## Related Docs

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-app_api_openapi_projection.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260715-contract_stability_baseline.md`

## Summary

NanoCore keeps a thin provider-neutral account layer above stock pi-ai. OpenKit owns account slots, provider-profile binding, authorization, Vault persistence, sanitized status, audit, and quota projection; pi-ai owns provider login interactions, credential refresh, logout mechanics, and authenticated inference. Multi-account support is achieved with one pi-ai `Models` instance and one slot-scoped `CredentialStore` view per `(subscriptionProviderId, accountSlotId)`, never by switching a global credential store or changing ambient process state.

The accepted initial subscription providers are `openai-codex` and `xai`. `openai-codex` supports interactive login and Codex subscription inference; `xai` supports the reviewed pi-ai xAI login and Grok inference path. Provider quota is an optional side capability: Codex may use the official-client backend usage endpoint through a strict release-coupled adapter, while xAI reports `unsupported` until an official stable quota interface is available. Quota failure never blocks inference.

NanoCore does not depend on Codex app-server, `CODEX_HOME`, Codex-managed `auth.json`, or a dedicated Codex inference backend after cutover. Pi-ai performs provider refresh through the slot-scoped credential store, and OpenKit persists each refreshed credential through the Vault boundary.

## Goals / Non-goals

### Goals

- Support multiple independent Codex and xAI subscription accounts in one NanoCore deployment.
- Keep account selection explicit and safe under concurrent requests.
- Let pi-ai own provider-specific login and refresh behavior while OpenKit retains credential custody and product-facing account management.
- Preserve login, cancel, logout, status, provider-profile binding, and quota inspection as deployment-admin App API capabilities.
- Store credential material only through `VaultBackend` and expose only sanitized account metadata.
- Remove the Gateway's runtime dependency on Codex app-server and Codex local-home semantics.
- Fail one account slot independently without degrading unrelated slots or providers.

### Non-goals

- Do not build user-owned account slots, organization account sharing, automatic account rotation, load balancing, quota-aware failover, or cross-account fallback.
- Do not purchase, cancel, or modify a vendor subscription.
- Do not claim that local logout revokes a token remotely; it only removes OpenKit's local authority to use that credential.
- Do not scrape provider web pages or use an undocumented private xAI quota endpoint.
- Do not accept pasted access tokens or refresh tokens through the public App API.
- Do not expose pi-ai types, provider internals, credential values, account IDs, raw quota responses, Vault references, or authorization headers through public surfaces.
- Do not treat Claude consumer-subscription authentication as supported until a separate accepted revision proves both the commercial entitlement and the provider contract.

## Definitions And Supported Providers

`SubscriptionProviderId` is the closed release-coupled enum `openai-codex | xai`. It identifies the subscription authentication family, not a configured provider-profile instance. `SubscriptionLoginMode` is exactly `device_code`, and `SubscriptionAccountStatus` is `logged_out | pending | logged_in | unavailable | error`.

`AccountSlotId` is a deployment-local non-secret identifier matching `^[a-z0-9][a-z0-9_-]{0,63}$`. The durable account identity is the pair `(subscriptionProviderId, accountSlotId)`; the same slot id may exist under different subscription providers without collision.

A provider profile family is resolved deterministically by normalizing `vendor` and `id` independently: trim, lowercase, and replace hyphens with underscores. Only the exact normalized values `openai_codex` and `xai` are recognized. A recognized normalized `vendor` is authoritative; otherwise a recognized normalized `id` selects the family. If both values are recognized and select different families, the profile is invalid. `openai_codex` maps to subscription provider `openai-codex`, and `xai` maps to `xai`. An unrecognized value selects no subscription family, and `extensions.openkit.subscriptionAccount` never selects or overrides the family.

A supported-family `kind: oauth` profile is subscription-backed, must declare the strict extension `{ accountSlotId }`, and must omit `secretRef` and `baseUrl`. Its resolved family determines `subscriptionProviderId`; the extension does not duplicate that value. `subscriptionAccount` is forbidden for unsupported families and non-OAuth profiles. A supported-family OAuth profile without the extension is invalid. In particular, xAI `direct`, `gateway`, or `custom` profiles without the extension remain ordinary API-key or provider configurations and never appear in subscription inventory, account lifecycle, status, or quota operations.

Every subscription-backed profile binds explicitly to one existing `(subscriptionProviderId, accountSlotId)` pair, and NanoCore must not guess a default slot. Several provider profiles may bind the same slot, but one profile may bind only one slot. The `extensions.openkit` object is strict at cutover: `codexOAuth` and every other unknown OpenKit-owned field are rejected, while non-OpenKit vendor extension namespaces remain governed by their existing open-extension rule.

The public subscription-provider inventory reports each supported provider's id, display name, login modes, and quota capability. The accepted initial capability projection is:

| Subscription provider | Login modes | Inference | Quota |
| --- | --- | --- | --- |
| `openai-codex` | `device_code` | Codex Responses through pi-ai | `available` through the strict Codex usage adapter, otherwise `temporarily_unavailable` |
| `xai` | `device_code` through the reviewed pi-ai version | Grok through pi-ai | `unsupported` until an official stable xAI interface is accepted |

The public inventory is fixed and ordered as `openai-codex` followed by `xai`. Its exact descriptors are `{ subscriptionProviderId: "openai-codex", displayName: "OpenAI Codex", loginModes: ["device_code"], quotaCapability: "available" }` and `{ subscriptionProviderId: "xai", displayName: "xAI", loginModes: ["device_code"], quotaCapability: "unsupported" }`. Catalog order, authored profile order, account state, credential state, and dispatch readiness cannot alter or remove either descriptor. Inventory handling must return these descriptors without enumerating or reading account directories, `account.json`, Vault references, Vault availability, or credential state.

Inventory presence advertises a supported management contract, not current dispatchability. The exact pinned pi-ai version, valid OpenKit profile, provider entitlement, existing slot, available Vault, and usable login credential govern whether a configured profile can dispatch.

## Durable Authority And Storage

OpenKit owns non-secret slot metadata under:

```text
DATA_ROOT/server/files/provider-subscriptions/<subscription-provider-id>/accounts/<account-slot-id>/account.json
```

The only accepted durable format is this strict version-1 discriminated record:

```ts
type ProviderSubscriptionAccountRecordBase = {
  schemaVersion: 1;
  subscriptionProviderId: "openai-codex" | "xai";
  accountSlotId: string;
  createdAt: string;
  updatedAt: string;
  displayName?: string;
  vaultReferenceId?: string;
  accountLabel?: string;
  planLabel?: string;
};

type ProviderSubscriptionAccountRecord =
  | (ProviderSubscriptionAccountRecordBase & {
      status: "logged_out" | "pending" | "logged_in";
      message?: never;
    })
  | (ProviderSubscriptionAccountRecordBase & {
      status: "unavailable" | "error";
      message: string;
    });
```

The top-level object is strict: every unknown field is rejected, every optional field is omitted rather than `null`, and no process-local interaction or interaction id is stored, including while `status` is `pending`. `subscriptionProviderId` uses the closed provider enum, `accountSlotId` uses `^[a-z0-9][a-z0-9_-]{0,63}$`, and both values must equal the directory path. `vaultReferenceId` is 1 through 128 safe ASCII bytes matching `^[A-Za-z0-9_-]{1,128}$`. `displayName`, `accountLabel`, and `planLabel` are non-empty valid Unicode strings whose UTF-8 encoding is at most 256 bytes; `message` is a non-empty valid Unicode string whose UTF-8 encoding is at most 1,024 bytes. `message` is required only for `unavailable` and `error` and is forbidden for every other status. Before parsing, a reader rejects a file larger than 16,384 bytes or bytes that are not valid UTF-8. `createdAt` and `updatedAt` are canonical UTC `Date.toISOString()` values ending in `Z`; `createdAt` is immutable after creation, and every durable rewrite preserves an `updatedAt` value greater than or equal to the prior value.

`account.json` is the durable non-secret authority for account existence, provider and slot identity, the operator-supplied display name, `createdAt`, `updatedAt`, and the internal Vault-reference binding. Its sanitized last-known status and safe optional provider-derived account and plan labels are projections reconciled from current Vault and provider truth only after the authority state satisfies the ordinary-validity or same-live-mutation rules below. Public responses never expose the Vault reference. Credential material, token payloads, cookies, raw upstream account identifiers, and authorization headers must never enter this file, SQLite, logs, diagnostics, or workspace exports.

Core `vault_references` remains the generic durable non-secret authority for Vault-reference existence, backend kind, current material version, and revocation cascade. It gains no provider or slot columns and does not own account existence, pair identity, or the account-to-reference binding. The OpenKit Vault backend is the unique durable authority for credential material. `account.json` as a whole is not reconstructible from either source, and neither a Core reference row nor backend inventory may create, bind, rename, or delete an account.

For account binding `R`, the exact provider-subscription Core `VaultReference` row has `referenceId: R`, `ownerScope: server`, `workspaceId: null`, `userId: null`, `displayName: "Provider subscription credential"`, `secretKind: "provider-subscription-oauth"`, `backendKind: "encrypted-file"`, and `backendLocator: "encrypted-file://server/vault/<referenceId>"`, where `<referenceId>` is replaced by the exact value `R`. Initial creation inserts that exact row with `status: active` and `currentVersion: 1`. Any field mismatch is a persistence failure rather than a compatible provider-subscription reference.

The creating fenced mutation's direct ephemeral proof must include the successful insert result proving that the mutation newly created this exact Core row after committing the account binding. An idempotent insert result, conflict-tolerant lookup, or pre-existing matching row is not proof that the current mutation created the row and cannot authorize same-reference initial persistence.

Encrypted-file entry metadata MUST carry the strict projection `providerSubscriptionAccount: { subscriptionProviderId, accountSlotId }` defined by `docs/specs/20260704-vault_backend_implementation.md` for provider-subscription material. The projection is permitted only on server-owned material, is authenticated with each encrypted entry, is immutable across rotation, and exists only to inventory material by pair when account metadata or backend state is missing, corrupt, or contradictory. It is not an account record, binding, authorization input, dispatch selector, or public field; it must never be used to reconstruct `account.json` or to make a pair reusable.

Initial credential persistence holds the pair mutation fence and commits in this order: durably write the generated internal reference id into the existing strict `account.json` binding; insert the exact matching generic Core `VaultReference` above; store encrypted-file version 1 with the exact authenticated pair projection; then advance sanitized status and safe provider-label projections. Within that same still-live fenced mutation, a bound-plus-zero account may continue initial persistence with the same reference only when the mutation has direct ephemeral proof that it just committed the binding and newly inserted the exact Core row and a fresh inventory proves that no backend entry, state, material version, or revocation artifact exists for that reference. This proof is process-local, is not durable authority, cannot be inferred from a pre-existing Core row, and expires when the mutation settles or the process restarts.

The automatically continuable cross-authority prefixes are the unchanged unbound account before the binding write commits; the proof-gated same-process bound-plus-zero prefix above; a bound-plus-one account after backend store commits and before status projection, with exactly one strict matching live encrypted-file reference and its exact active generic Core row; and an exact backend-recognized revoked tombstone after backend revocation commits and before Core revocation and binding clear or account deletion complete. A crash after the binding or Core row commits but before backend material commits loses the ephemeral proof and leaves a historically ambiguous bound-plus-zero shape rather than a resumable initial-persistence prefix. No normal path can create live material without both an account binding and the exact generic Core reference.

Credential rotation commits encrypted-file version N+1 before advancing the matching generic Core current-version projection and sanitized account projections. Credential removal and account deletion commit encrypted-file revocation before the generic Core revocation cascade and binding clear or account deletion. These fixed orders do not claim a filesystem-and-SQLite transaction.

Each `account.json`, encrypted entry, and `state.json` write is independently atomic. The encrypted-file backend writes an entry before its matching state and enumerates both through its existing private filesystem namespace. A crash or failure may therefore leave an extra authenticated entry, missing state, stale state, or another strict disagreement. Such a condition is not a live credential or an accepted crash prefix: credential resolution, every account operation, startup or post-error reconciliation, account deletion, binding clear, and pair reuse fail closed with redacted persistence or Vault errors. No normal path compensates, forward-settles, hides, or automatically repairs the disagreement.

The existing credential-removal and reviewed-cleanup boundaries must discover every encrypted material version attributable by authenticated metadata to the exact reference and provider-slot pair, including a version absent from state, destroy it, and verify absence or unresolvability before the generic Core revocation cascade and binding clear or account deletion. Material whose attribution is missing, malformed, mismatched, or unverifiable leaves the account and binding intact. Reconciliation never performs this cleanup.

Ordinary account validity inventories every live and revoked Vault row whose non-secret owner metadata names the provider and slot pair and detects whether the current binding has the exact backend-recognized revoked tombstone defined by `docs/specs/20260704-vault_backend_implementation.md`. An `account.json` record is ordinarily valid only when it passes its strict schema, its stored provider and slot equal the pair encoded by its directory path, and its binding satisfies exactly one of these cases: an unbound account has zero owner-matched live references and zero or more completed historical tombstones defined below; or a bound account has exactly one owner-matched live reference whose reference id equals the account binding, no backend-recognized revoked tombstone for that current reference, and zero or more completed historical tombstones for different old reference ids. The proof-gated same-process bound-plus-zero prefix is permitted only inside its creating mutation and is not an ordinary validity result. A bound-plus-zero account after that proof expires, a bound account with the exact backend-recognized revoked tombstone before removal continuation completes, a present but invalid record, account-directory residue without a strict valid record, any owner-matched live reference whose id differs from the current binding, more than one owner-matched live reference, or any revoked row that is neither the current-binding removal prefix nor completed history fails closed and emits audit evidence. The current-binding tombstone remains recognizable only so the already-started removal path may finish the exact Core revocation cascade and binding clear or account deletion. NanoCore must not synthesize metadata from Vault inventory, omit a current or invalid pair from an account list, revoke or delete Vault history automatically, remove residue automatically, reuse any old reference id, or treat an ambiguous or invalid pair as absent.

A live matching encrypted-file reference at backend current version `N` must have the exact Core row for the same binding with `status: active`. Core `currentVersion: N` is accepted; a lower positive Core version may only be advanced monotonically to `N`; a higher Core version, non-positive or unsafe version, missing row, revoked status, or any identity, ownership, kind, locator, label, or scope mismatch fails closed. Initial persistence may store version 1 under the existing reference only inside the same still-live fenced mutation whose direct ephemeral proof includes the new exact-row insert result and whose fresh inventory proves that no backend artifact exists. After that mutation settles or the process restarts, a bound reference with no authenticated live material and no exact backend-recognized revoked tombstone is historically ambiguous and MUST fail closed as `provider_subscription_persistence_failed`; no ordinary path may rewrite status, continue same-reference persistence, create a Core row, clear the binding, or reuse the pair, and only reviewed cleanup may release it. The exact backend-recognized revoked tombstone at version `N` is instead the separately recognizable removal prefix while it still equals the current account binding, but only when the exact Core row has `currentVersion: N` and either `status: active`, meaning its cascade is pending, or `status: revoked`, meaning its cascade committed. The already-started logout or delete may then finish only the exact Core revocation cascade and binding clear or account deletion; it may not perform a Vault write, establish ordinary validity, continue same-reference persistence, reuse the reference, or invoke another recovery path.

After binding clear or account deletion commits, a backend-recognized tombstone for old reference `H` is completed historical tombstone only when its exact Core row has the same version, `status: revoked`, and every provider-subscription Core field above is exact for `H`. An unbound account or account-absent pair may have zero or more such histories with distinct old reference ids. Whole-backend inventory continues to validate them, but they are inert consumed history: they are not live or current account state, are never deleted or reused, create no account projection, and do not block the unbound account from logging in with a newly allocated reference or the cleanly absent pair from creating a new account and later allocating a new reference. Any tombstone with no current binding whose Core row is active, missing, at a different version, or non-exact in any field fails closed as `provider_subscription_persistence_failed`, as does every live owner-matched reference without the exact current account binding.

The previous `DATA_ROOT/server/files/oauth/openai-codex/.../codex-home` layout, `CODEX_HOME`, and Codex-managed `auth.json` are not read by the new path. No credential migration exists: existing slots require a new login after cutover, no compatibility alias or automatic token import is retained, and obsolete credential-bearing directories are removed only by an explicit reviewed cleanup step after the new path is verified.

## Pi Authentication Boundary

NanoCore creates one pi-ai `Models` instance for each active `(subscriptionProviderId, accountSlotId)` pair. Each instance receives a `CredentialStore` view scoped to exactly that pair. The view rejects access to any other provider id and maps its one logical credential to the slot's Vault reference.

NanoCore must not implement multi-account selection by mutating a global pi-ai store, using ambient credentials, changing process environment, synthesizing provider ids, or relying on asynchronous request-local globals. Provider dispatch resolves the account slot first and then selects the corresponding `Models` instance, so concurrent calls to different slots cannot observe each other's credentials.

Credential `set`, `modify`, and `remove`, together with the login and logout interaction transitions that can admit or invalidate those writes, are serialized by the same in-process lock keyed by `(subscriptionProviderId, accountSlotId)`. Pi-ai uses `modify` for refresh; the resulting credential is persisted as a new Vault material version before it becomes visible to later requests. A login completion may call `set` only while its matching interaction is still active, so a cancelled or stale completion cannot restore a credential. An in-flight refresh finishes under the lock before a later logout or delete revokes the latest credential, and work admitted after `remove` commits resolves no credential. One NanoCore process per data root is the accepted deployment baseline, so no distributed lock is required.

Pi-ai owns provider-specific device-code authorization and polling, credential parsing, expiry decisions, refresh exchange, and inference authentication. OpenKit owns the interaction id, cancellation signal, admin authorization, sanitized progress projection, credential persistence, and audit. NanoCore must not call Codex app-server to refresh an account and must not duplicate pi-ai's refresh state machine.

Login is the only credential-acquisition path the product exposes. NanoCore has no production import, discovery, or migration path, no public or private credential-setup API, and no alternate credential-store owner; the product neither reads nor infers credentials from any host location.

## Audit And Redaction

Provider-subscription lifecycle evidence is server-owned `AuditEvent` data in `core.sqlite`. The complete action set for this account and credential boundary is `provider_subscription.account.create`, `provider_subscription.account.update`, `provider_subscription.account.delete`, `provider_subscription.credential.store`, `provider_subscription.credential.rotate`, `provider_subscription.credential.revoke`, and `provider_subscription.reconcile`; this boundary adds no provider-specific or per-operation action aliases. A failed attempt uses the same action as its successful counterpart and records the stable redacted outcome and error code.

Each of these seven actions identifies the affected resource only by the non-secret local `(subscriptionProviderId, accountSlotId)` pair and uses a stable redacted summary. It must not carry a credential, token, cookie, authorization header, raw provider account id, upstream body, provider error body, Vault material, or account-to-reference binding. Credential resolution continues through the existing audited Vault wrapper and its existing `vault.resolve` action and `VaultUse` evidence rather than adding an eighth provider-subscription action; the Vault-owned reference and version fields allowed on that evidence remain governed by the Vault specifications.

## Account Lifecycle

### Create And Bind

Creating an account slot writes non-secret metadata with `status: logged_out`; it does not create or infer a credential. A cleanly absent pair may be created when it has zero live references and every retained revoked row is completed historical tombstone; creation does not bind, delete, or project those histories. A later login allocates a fresh reference id. A provider profile becomes dispatchable only when its explicit slot exists, the Vault is available, and the slot has a resolvable credential accepted by the selected provider path.

Updating a slot may change only its operator-supplied display name. Renaming the slot id is not supported; create a new slot and rebind profiles instead. Deleting a slot is rejected while a login is active or any provider profile references it. Once unbound, delete holds the slot mutation fence, revokes backend material, commits the exact Core reference revocation cascade, and only then removes `account.json`; failure before backend revocation commits leaves the account and binding intact, while failure after backend revocation leaves the exact backend-recognized revoked tombstone that permits a repeated delete to complete the cascade and account deletion only when the exact Core row and version predicate above also holds. A bound reference with neither live material nor that exact backend-recognized tombstone is not a deletion prefix and requires reviewed cleanup. Successful deletion leaves the old tombstone and exact same-version revoked Core row as immutable completed history; a later create for the same provider and slot allocates a fresh reference and never revives the old one.

### Login And Cancellation

Only one interactive login may be active for one slot. Starting login creates an OpenKit interaction id, sets the sanitized projection to `pending`, invokes the pi-ai device-code flow, and returns only the verification URL, user code, interaction id, and optional expiry.

Successful login persists the pi-ai credential through the slot-scoped `CredentialStore` before projecting `logged_in`, and its completion must still match the active interaction while holding the slot mutation fence. A failed provider interaction projects `error` or `unavailable` with a stable redacted message; it never exposes upstream response bodies or credential fragments. Cancellation targets the active interaction id, invalidates that interaction under the same fence, aborts pi-ai device-code polling, and reconciles status only after the authority state passes the validity rules above; a bound-plus-zero ambiguity returns `provider_subscription_persistence_failed` without a status rewrite. Any later completion from the invalidated interaction is stale and cannot persist a credential.

Interactive login state is process-local. After restart, an unfinished interaction no longer exists: startup reconciliation projects `logged_in` when the strict bound credential and exact live Core row resolve, `unavailable` when the Vault is locked or unavailable, and `logged_out` only for an ordinarily valid unbound account with zero owner-matched live references. A bound reference with no authenticated live material and no exact backend-recognized revoked tombstone fails as `provider_subscription_persistence_failed` without rewriting status, while that exact backend-recognized tombstone remains available only to continue the already-started removal path under the exact Core row and version predicate. A prior `interactionId` cannot be resumed.

### Refresh

Every inference request uses the slot-scoped pi-ai `Models` instance. When pi-ai determines that refresh is required, it performs refresh through `CredentialStore.modify`; the shared slot mutation fence prevents duplicate local writers, and the refreshed credential rotates the same Vault reference. Refresh failure marks the slot unavailable for new calls with a stable authentication-required error and does not fall back to another account.

### Logout

Logout invalidates and cancels any active login interaction, awaits that login task's settlement, then commits credential `remove` through the same slot mutation fence and projects `logged_out` only after backend revocation, the exact Core revocation cascade, and binding clear complete. A repeated logout may continue those remaining steps only from the exact backend-recognized revoked tombstone with the exact Core row and version predicate; a bound reference with neither live material nor that tombstone fails closed and cannot be cleared as an idempotent absence. After binding clear, the old tombstone and exact same-version revoked Core row become immutable completed history and a later login allocates a fresh reference. A cancelled or stale login completion cannot write after logout, and an in-flight refresh completes under the fence before logout revokes its latest credential version. Logout does not cancel the vendor subscription or promise remote token revocation. Work admitted after local removal commits sees no credential and fails authentication; an already-started provider request remains an external effect with its ordinary success, failure, or unknown outcome.

## Public App API

The provider-neutral deployment-admin surface is:

```text
GET    /api/app/provider-subscriptions
GET    /api/app/provider-subscriptions/{subscriptionProviderId}/accounts
POST   /api/app/provider-subscriptions/{subscriptionProviderId}/accounts
PATCH  /api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}
DELETE /api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}
GET    /api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/status
POST   /api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login
POST   /api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login/cancel
POST   /api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/logout
GET    /api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/quota
```

The canonical operation ids in route order are `listSubscriptionProviders`, `listProviderSubscriptionAccounts`, `createProviderSubscriptionAccount`, `updateProviderSubscriptionAccount`, `deleteProviderSubscriptionAccount`, `getProviderSubscriptionAccountStatus`, `startProviderSubscriptionAccountLogin`, `cancelProviderSubscriptionAccountLogin`, `logoutProviderSubscriptionAccount`, and `getProviderSubscriptionAccountQuota`.

All ten routes require deployment-admin authority and register through the canonical App API operation catalog. Inventory, account list, status, and quota are read operations; create, update, delete, login, cancel, and logout are mutations. DELETE succeeds with `204`, an empty body, and no response `Content-Type`; every other lifecycle read or mutation succeeds with `200`; quota normally returns its typed union with `200`. Create, update, login, and cancel require the strict bodies defined below. Logout accepts no request body. Provider ids and slot ids are validated before storage or credential access.

Provider inventory is the only account-state-free operation. The other nine ordinary operations—account list, create, update, delete, status, login start, login cancellation, logout, and quota—must apply the failed-closed metadata, whole-backend-inventory, and exact Core-row checks defined by this spec before account existence, conflict, lifecycle, or quota handling. A pair-addressed operation checks its requested pair; an account list checks every account-directory pair for that provider and every live or revoked backend inventory row whose non-secret owner metadata names that provider. If any checked current state or historical row violates the ordinary validity invariant above, the entire operation fails, and an account list must not return a partial array that omits the pair. Completed historical tombstones are validated but never projected as accounts. Delete and logout have only the narrow exception that the exact backend-recognized revoked tombstone for the current binding, together with its exact same-version Core row, may continue the already-started removal sequence; no other operation may treat that prefix as an ordinarily valid account.

The release-coupled schemas live in `@openkit/app-api-schemas`, use strict objects, and reject unknown fields. Optional fields are omitted rather than set to `null`. Every timestamp is accepted with the existing Zod datetime convention and emitted as a UTC `Date.toISOString()` value ending in `Z`. Account arrays are ordered lexicographically by `accountSlotId`; `boundProviderIds` are duplicate-free and lexicographically ordered.

```ts
type SubscriptionProviderId = "openai-codex" | "xai";
type SubscriptionLoginMode = "device_code";
type SubscriptionAccountStatus =
  | "logged_out"
  | "pending"
  | "logged_in"
  | "unavailable"
  | "error";

type ProviderSubscriptionDescriptor =
  | {
      subscriptionProviderId: "openai-codex";
      displayName: "OpenAI Codex";
      loginModes: ["device_code"];
      quotaCapability: "available";
    }
  | {
      subscriptionProviderId: "xai";
      displayName: "xAI";
      loginModes: ["device_code"];
      quotaCapability: "unsupported";
    };

type ProviderSubscriptionsResponse = {
  providers: [
    Extract<ProviderSubscriptionDescriptor, { subscriptionProviderId: "openai-codex" }>,
    Extract<ProviderSubscriptionDescriptor, { subscriptionProviderId: "xai" }>,
  ];
};

type CreateProviderSubscriptionAccountRequest = {
  accountSlotId: string;
  displayName?: string;
};

type UpdateProviderSubscriptionAccountRequest = {
  displayName: string;
};

type StartProviderSubscriptionAccountLoginRequest = {
  mode: SubscriptionLoginMode;
};

type CancelProviderSubscriptionAccountLoginRequest = {
  interactionId: string;
};
```

`accountSlotId` always uses the declared slot regex. Every other identifier, label, or user code in these public shapes is a non-empty string, and `displayName` additionally must be valid Unicode whose UTF-8 encoding is at most 256 bytes so every valid create or update request is persistable. `verificationUrl` must be an absolute `http:` or `https:` URL. Login mode is required and has no default; the strict request schema rejects `browser` and every value other than `device_code` as `invalid_request`. `interactionId` is the only public login-interaction identifier; `loginId` is not a field or alias.

```ts
type ProviderSubscriptionLoginInteraction = {
  mode: "device_code";
  interactionId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt?: string;
};

type ProviderSubscriptionAccountBase = {
  subscriptionProviderId: SubscriptionProviderId;
  accountSlotId: string;
  boundProviderIds: string[];
  createdAt: string;
  updatedAt: string;
  displayName?: string;
  accountLabel?: string;
  planLabel?: string;
};

type ProviderSubscriptionAccountState =
  | { status: "logged_out" }
  | { status: "pending"; interaction: ProviderSubscriptionLoginInteraction }
  | { status: "logged_in" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

type ProviderSubscriptionAccount =
  ProviderSubscriptionAccountBase & ProviderSubscriptionAccountState;

type ProviderSubscriptionAccountsResponse = {
  accounts: ProviderSubscriptionAccount[];
};
```

Inventory returns `ProviderSubscriptionsResponse`. List returns `ProviderSubscriptionAccountsResponse`. Create, update, status, login, cancel, and logout return `ProviderSubscriptionAccount`; an accepted login start returns its `pending` branch. Logout is locally idempotent only for an already unbound account or continuation from the exact backend-recognized revoked tombstone with its exact same-version Core row and returns the reconciled account branch after cancelling any active interaction and completing credential removal. Delete returns no payload. The account and status schema is implemented as one strict discriminated union with one branch per status: `interaction` exists only on `pending`, and `message` exists only on `unavailable` or `error`; fields from another branch are rejected rather than ignored. `logged_in` means a credential is locally resolvable and has not yet been rejected; it does not promise remaining quota or remote account validity.

`unavailable` means a retryable dependency condition such as a locked or unavailable Vault or an unavailable provider prevents reliable use or reconciliation. `error` means the current process observed a terminal interactive-login failure that requires a new login attempt or logout rather than a passive retry. Starting another login replaces either state with `pending`; logout replaces either state with `logged_out` only after its removal sequence completes. After restart, an ordinarily valid unbound account with zero owner-matched live references reconciles to `logged_out` rather than preserving a process-local login error; a bound-plus-zero ambiguity does not.

Public account payloads must not contain credential values, raw provider account ids, email addresses derived from credential or token internals, Vault references, raw provider errors, cookies, headers, pi-ai values, or provider-native fields. `accountLabel`, `planLabel`, and `message` are OpenKit-owned sanitized labels. App API, Core Client, bundled CLI, unified Skill, and Web move together in one release, so the previous Codex-specific `/api/app/oauth/openai-codex/*` routes are removed without aliases.

## Quota Capability

Quota is an on-demand read capability separate from login state and inference. Every quota response uses this envelope:

```ts
type ProviderSubscriptionQuota =
  | {
      subscriptionProviderId: "openai-codex";
      accountSlotId: string;
      availability: "available";
      observedAt: string;
      planType?: string;
      windows: Array<{
        id: string;
        usedPercent?: number;
        remainingPercent?: number;
        resetsAt?: string;
      }>;
    }
  | {
      subscriptionProviderId: "xai";
      accountSlotId: string;
      availability: "unsupported";
      observedAt: string;
    }
  | {
      subscriptionProviderId: "openai-codex";
      accountSlotId: string;
      availability: "temporarily_unavailable";
      observedAt: string;
      retryAfter?: string;
    };
```

Percentages are finite values in the inclusive range `0..100`; `remainingPercent` is derived only when the provider gives enough data and is clamped to that range. Window ids are stable OpenKit labels for the provider fields recognized by the current adapter, not raw upstream object keys. Missing provider values are omitted rather than guessed. No raw quota response or upstream error crosses the App API.

### Codex Release-Coupled Quota Reader

For `openai-codex`, the quota route first completes ordinary account reconciliation and obtains the existing pair-scoped handle. Reconciliation, pair-handle resolution, and their typed account or Vault failures retain the App API error precedence defined below and are not converted into a quota result. After a handle resolves, the reader obtains its `openai-codex` credential; the credential is usable only when it is an object with the exact discriminator `type: "oauth"`, a non-empty string `access`, and a non-empty string `accountId`. The reader reads or validates no other credential property. A missing or invalid credential, or a failure while reading it, returns the existing redacted `temporarily_unavailable` quota branch without a provider request.

For a usable credential, the reader issues exactly one bodyless `GET https://chatgpt.com/backend-api/wham/usage` request with exactly `Authorization: Bearer <access>`, `ChatGPT-Account-ID: <accountId>`, and `User-Agent: codex-cli`. One timeout of exactly 10,000 milliseconds covers the request and raw-body read. The reader accepts at most 65,536 raw response bytes inclusive; it rejects immediately when the cumulative byte count crosses that cap and does not read another chunk. It then decodes the accepted bytes as fatal UTF-8 before parsing the decoded text as JSON.

A successful raw response must satisfy all of the following:

- The top-level value is an object whose required `plan_type` is a non-empty string.
- `rate_limit` may be absent or `null`. When present, it is an object whose `allowed` and `limit_reached` fields are required booleans and whose `primary_window` and `secondary_window` fields may each be absent or `null`.
- Every present window is an object whose `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and `reset_at` fields are required signed 32-bit integers. This adapter additionally requires `used_percent` to be within the inclusive range `0..100`; it does not broaden or change the generic public quota number type. `reset_at` is Unix epoch seconds and must convert to a valid canonical ISO timestamp.
- Unknown non-consumed fields are ignored at every level.

The available projection always emits `planType` as the exact `plan_type` string and includes only non-null windows, ordered primary then secondary. Those windows use the fixed ids `primary` and `secondary`, preserve the exact integer as `usedPercent`, derive `remainingPercent` as `100 - usedPercent` clamped to `0..100`, and emit the converted timestamp as `resetsAt`.

Credential-read, network, timeout, non-2xx HTTP, body-limit, UTF-8, JSON, or consumed-schema failure returns only the existing redacted `temporarily_unavailable` quota branch. The reader does not project `allowed`, `limit_reached`, window durations, relative reset values, retry headers, additional buckets, reset credits, provider bodies, account ids, request headers, credentials, or raw errors. It adds no FedRAMP routing, cache, retry, scheduler, durable ledger, app-server call, or inference behavior.

For `xai`, quota returns `unsupported` until xAI publishes or supports a reviewed stable account-usage interface suitable for this entitlement. NanoCore must not scrape a web console or reverse-engineer a private endpoint to fill the gap.

Quota reads do not create a background scheduler, durable quota ledger, automatic account switch, or readiness gate. A short in-process cache may coalesce concurrent identical reads, but a cached observation must preserve its original `observedAt` and must never be presented as current after its bounded lifetime.

The quota route exists at the atomic public cutover. Until the bounded Codex reader lands, an ordinarily valid existing Codex slot returns `temporarily_unavailable`; an ordinarily valid existing xAI slot returns `unsupported` without a network request. Both are successful `200` results, not `ApiError` responses.

## App API Error Contract

The provider-subscription route handlers reuse the existing strict `ApiError` envelope and may emit only the following handler-owned codes, statuses, and fixed messages. Raw caught messages never replace these strings.

| Code | HTTP | Fixed message |
| --- | ---: | --- |
| `forbidden` | 403 | `Deployment-admin authority is required.` |
| `invalid_request` | 400 | `Invalid provider subscription request.` |
| `provider_subscription_provider_not_found` | 404 | `Subscription provider not found.` |
| `provider_subscription_account_slot_invalid` | 400 | `Account slot id is invalid.` |
| `provider_subscription_account_not_found` | 404 | `Provider subscription account not found.` |
| `provider_subscription_account_exists` | 409 | `Provider subscription account already exists.` |
| `provider_subscription_account_bound` | 409 | `Provider subscription account is bound to a provider profile.` |
| `provider_subscription_login_active` | 409 | `A login interaction is already active for this account.` |
| `provider_subscription_login_not_active` | 409 | `No login interaction is active for this account.` |
| `provider_subscription_login_interaction_mismatch` | 409 | `Login interaction does not match the active interaction.` |
| `provider_subscription_vault_locked` | 503 | `Provider subscription Vault is locked.` |
| `provider_subscription_vault_unavailable` | 503 | `Provider subscription Vault is unavailable.` |
| `provider_subscription_provider_unavailable` | 503 | `Subscription provider is unavailable.` |
| `provider_subscription_persistence_failed` | 500 | `Provider subscription persistence failed.` |
| `provider_subscription_projection_failed` | 500 | `Provider subscription projection failed.` |
| `internal_error` | 500 | `Provider subscription request failed.` |

The shared authentication middleware owns protected-route authentication under the NanoCore Config And Identity Contract. In server mode, a missing, invalid, or disabled actor inherits the global strict `ApiError` with HTTP `401`, code `core.auth.unauthenticated`, and fixed message `Authentication required.` before the provider-subscription handler runs; these handlers must not redefine that failure. After authentication succeeds, an authenticated actor without deployment-admin authority receives the handler-owned HTTP `403`, code `forbidden`, and fixed message `Deployment-admin authority is required.`. `invalid_request` covers malformed strict bodies that do not have a more specific row. Account status returns `200` with `logged_out` for an ordinarily valid unbound account with no live credential, including one with completed historical tombstones; `unavailable` when Vault or provider availability prevents reliable reconciliation; and `error` only for the process-local terminal login failure defined above. A bound reference with no authenticated live material and no exact backend-recognized revoked tombstone returns the persistence failure below rather than a status union. A failure before login interaction acceptance uses the relevant non-2xx provider or Vault error; a failure after acceptance is observed through the strict account-status union unless durable validation fails. Delete and logout use Vault availability errors when local revocation cannot commit; logout is locally idempotent for an already unbound account with only completed history and may finish the exact backend-recognized tombstone prefix only with its exact same-version Core row, but material absence without either condition is not idempotent success. Quota for a valid existing slot uses its `200` union, including credential, provider, timeout, or schema failures as Codex `temporarily_unavailable` and xAI as `unsupported`; malformed paths and cleanly absent slots still use ordinary request errors.

When any ordinary account operation encounters invalid metadata, a binding mismatch, an owner-matched live-reference cardinality violation, an exact Core-row or version violation, a tombstone without a current binding whose Core row is not exact same-version `revoked`, or a bound reference with no authenticated live material and no exact backend-recognized revoked tombstone after the creating mutation's proof has expired, it fails as one operation with HTTP `500`, code `provider_subscription_persistence_failed`, and fixed message `Provider subscription persistence failed.`. A non-removal operation encounters the same error while an exact current-binding tombstone prefix awaits removal continuation. This error takes precedence over account exists, account not found, lifecycle-conflict, and quota-result handling after authorization and provider and slot syntax validation. Create therefore cannot reuse an affected invalid pair and must not return `provider_subscription_account_exists` or `provider_subscription_account_not_found`; list returns no accounts, and quota returns no successful quota union. A cleanly absent pair has no account-directory residue, zero owner-matched live references, and zero or more completed historical tombstones; after validating that history, it retains ordinary not-found behavior and create may establish a new unbound account whose later login allocates a fresh reference.

## Failure And Recovery Semantics

- An unknown provider id or invalid slot id fails before filesystem or Vault access.
- A cleanly absent slot with zero live references and only completed historical tombstones, invalid request, locked or unavailable Vault during a required mutation, active-login conflict, interaction mismatch, and profile-bound delete use their stable typed errors; an ordinarily valid unbound account with zero owner-matched live references and only completed history reconciles to `logged_out`, and quota capability limits for a strict valid account use the successful quota union.
- Failure of one account slot does not change another slot's `Models` instance, credential, status, or provider readiness.
- Account metadata, exact Core reference state, and encrypted-file material are not a cross-domain transaction. Their fixed commit order, same-process ephemeral continuation proof, restart ambiguity rule, and exact backend-recognized revoked-tombstone removal prefix are the recovery boundary. Reconciliation may repair sanitized `logged_out` and safe label projections for an ordinarily valid unbound-plus-zero account; for an ordinarily valid bound account with live material, it may repair sanitized status and safe label projections and may advance only a lower current-version projection on the already exact active Core reference monotonically to the backend version. It performs no projection rewrite for ambiguous bound-plus-zero.
- A corrupt `account.json` remains failed closed even when no live Vault material exists. Missing metadata remains failed closed when account-directory residue exists or a live Vault reference has owner metadata for that pair; an absent account with only completed historical tombstones is not missing metadata because those histories create no account. All nine ordinary account operations use the exact persistence failure above for corrupt, live-orphan, incomplete-removal, or invalid-history states, while completed history alone does not block fresh pair use; provider inventory remains unaffected because it does not access account state.
- Recovery by metadata restoration is permitted only after an internal maintenance path validates a strict `account.json` whose provider and slot match the directory path and whose restored binding, backend inventory, and exact Core row already establish one of the ordinary-validity cases above. Metadata restoration does not admit or resolve an ambiguous bound-plus-zero account, regardless of whether a Core row is present. Once restored metadata establishes ordinary validity, ordinary reconciliation resumes; no account metadata may be inferred from the credential or Vault inventory.
- Recovery by cleanup is permitted only through explicitly reviewed internal maintenance outside the normal provider-subscription App API. Every ambiguous bound-plus-zero account enters this path and no other recovery path. For every orphan, extra, ambiguous bound-plus-zero, or other bound reference associated with the residue, the maintainer first invokes the existing `VaultBackend.revoke` when attributable material exists and retains proof that no version remains resolvable or, when material and an exact backend-recognized tombstone are both absent, reviewed proof of absence. When a Core `VaultReference` row exists, the maintainer then invokes the existing Core revocation cascade and proves that it committed before clearing the binding or removing residue; when the row is absent, cleanup records that absence and must not create one. Only after backend revocation or reviewed absence and any existing Core cascade complete may the binding be cleared or corrupt or missing-metadata residue be removed. Completed historical tombstones and their exact revoked Core rows are not residue and this path never deletes or changes them. This sequence is never run by reconciliation or an ordinary account operation; ordinary operations resume only when the pair satisfies the ordinary-validity invariant, and create may use a cleanly absent pair only with a fresh reference.
- No ordinary account operation performs either recovery path, deletes residue or completed history, or invokes orphan cleanup as a side effect, and this recovery boundary adds no public operation, lifecycle state, service, compatibility path, or automatic repair mechanism.
- A backend-revoked reference remains consumed even when no material resolves. Core revocation and binding clear must complete before a later credential store or login allocates a fresh reference; after they complete, the immutable historical tombstone and revoked Core row remain while a fresh distinct reference may be allocated. No path rotates, restores, or stores version 1 under a revoked id.
- If credential persistence fails after provider login succeeds, NanoCore reports login failure and retains no public credential data. The same still-live fenced mutation may retry the same-reference store only under the direct ephemeral-proof rule; after that mutation settles, a later login requires reviewed cleanup first. NanoCore must not keep an unpersisted process-only credential as durable authority.
- If a sanitized status, provider-label, or exact Core current-version projection fails after a backend store or rotation commits live material, the operation reports a projection failure and startup or post-error reconciliation repairs only those permitted projections; it must not replace account authority, invent a Core reference, lower or skip a version, roll back, revoke, or expose the credential. After backend revocation commits, only the exact current-binding backend-recognized tombstone with its exact same-version Core row may continue Core revocation and binding clear or account deletion; after clear or deletion, the same tombstone is inert completed history.
- Delete and local credential removal commit backend revocation, then the exact Core revocation cascade, then binding clear or account deletion. A backend revocation failure leaves `account.json` and its binding intact. A later failure is automatically continuable only when the exact current-binding backend-recognized tombstone and exact same-version Core row remain; any other material absence requires reviewed cleanup. Successful completion changes only the classification to immutable completed history and permits future use of a fresh reference.
- Quota failure never changes login status, provider binding, or inference readiness.

## Current Implementation Projection

`packages/config-schema` now owns the closed `openai-codex | xai` subscription-provider identity, bounded account-slot identity, strict `extensions.openkit.subscriptionAccount` profile field, and deterministic provider-family classification. `@openkit/app-api-schemas`, NanoCore's checked operation catalog, generated OpenAPI, and `client.providerSubscriptions` expose the provider-neutral contract and all ten accepted operations.

`apps/nanocore/src/app.ts` composes the provider-subscription manager and routes. The manager strictly reads and atomically replaces version-1 `account.json`, classifies each pair against the exact generic Core reference and encrypted-file Vault authorities, fences same-pair mutations while permitting cross-pair concurrency, and supplies one slot-scoped stock pi-ai `CredentialStore` and `Models` runtime per pair with ambient environment and file authentication disabled. Stock pi-ai owns both providers' device-code login, refresh through `CredentialStore.modify`, logout, and authenticated inference; OpenKit retains interaction cancellation, Vault custody, account projection, authorization, and audit.

The seven server `AuditEvent` actions are active through the composed manager, and the existing audited `vault.resolve` path remains the credential-read producer. The unified Gateway resolves the explicit pair before dispatch and uses stock pi-ai for native Codex Responses and reviewed xAI inference. The bundled Skill catalog maps the same ten operations through its existing generic `ops call` path without a provider-specific command branch.

The Web AI interface now projects the fixed Codex and xAI inventory, provider-scoped account status, and quota posture through `client.providerSubscriptions` without account mutations, and the operator manual projects the provider-neutral configuration and storage boundary.

Codex quota now uses the strict direct reader, while xAI quota returns network-free `unsupported`. The prior Codex account and Gateway artifacts have been physically removed. This spec remains `Partial` until real-use acceptance for the Codex subscription path completes; the fixed run shape is an L3 opt-in test concern and its execution history belongs to the release change record.

## Accepted Design

The clean target is one cohesive NanoCore provider-subscription account manager with provider-specific capability adapters only where the provider contract genuinely differs. The manager owns slots, authorization, metadata, Vault references, per-slot locking, and public projection. Stock pi-ai owns login and refresh through one `Models` plus one constrained `CredentialStore` view per slot. A small Codex quota reader is the only accepted provider-specific side adapter in the initial slice; xAI quota is an explicit unsupported capability.

No general extension framework, plugin registry, global credential switcher, duplicate OAuth implementation, or second account state machine is introduced. New subscription providers require an accepted spec revision that defines entitlement, pi-ai support, login modes, quota posture, and failure behavior.

## Alternatives Considered

**Keep the dedicated Codex backend and add a parallel xAI backend.** Rejected because each new subscription provider would duplicate login, refresh, streaming, usage, and error behavior that pi-ai already owns.

**Use one global pi-ai credential store and switch the active account around each request.** Rejected because overlapping requests can observe the wrong credential and refresh the wrong account.

**Encode account identity into synthetic pi-ai provider ids.** Rejected because it leaks OpenKit account management into upstream provider vocabulary and breaks catalog and adapter assumptions.

**Keep Codex app-server only for refresh or quota.** Rejected because pi-ai already owns refresh and a bounded direct quota adapter is smaller than retaining a second runtime service and credential home.

**Implement xAI quota through browser scraping or a private endpoint.** Rejected because the result would be fragile, unsafe, and outside an accepted provider contract.

## Rollout / Migration Plan

Remaining rollout is owned by this specification. The exact stock pi-ai upgrade is verified first. The next implementation package lands only the internally consumed provider-id, slot-id, metadata, Vault credential-store, isolation, locking, and reconciliation foundation, including the exact Core row, new-insert-result ephemeral proof, failed-closed post-restart bound-plus-zero classification, backend-recognized tombstone predicate, exact same-version Core removal continuation, completed-history classification after binding clear or deletion, fresh-reference reuse of unbound and cleanly absent pairs, metadata restoration only for already ordinary-valid restored states, and reviewed cleanup as the sole bound-plus-zero recovery; it does not activate the authored `subscriptionAccount` extension or any provider-subscription route. It adds no additional durable file, record field, MAC, marker, journal, state, migration, cleanup or deletion API, operation, compatibility path, or automatic repair; the existing `account.json`, backend tombstone inventory, and Core row remain the only authorities. One later atomic kernel cutover then replaces configuration, App API schemas and live handlers, the NanoCore and Agent Skill Interface operation catalogs, generated OpenAPI, Core Client, diagnostics, pi-ai authentication, and all Codex and xAI subscription inference together while removing the active dedicated Codex account and Gateway dependency. The exact ten mechanical Skill mappings land through the existing generic catalog in that cutover, and no separate CLI or Skill implementation package follows. No compatibility alias, stub route, dual client, dual credential path, or intermediate account-to-inference bridge is permitted. The strict Codex quota reader, Web, and residual deletion follow in their separate bounded packages.

Cutover is same-release and clean-target. Existing Codex slots require re-login, old route and config names have no compatibility aliases, and legacy credential homes are not imported into Vault.

The cutover does not remove or rename `/api/app/vault/bootstrap/codex-auth-json` and does not alter worker-runtime Codex app-server ownership; only the active provider-subscription account and Gateway dependency is removed.

## Testing Strategy / Acceptance Criteria

- L0 verifies the exact pi-ai pin, catalog reconciliation, generated App API projection, no retired route or config vocabulary, and no pi-ai public-vocabulary leak.
- L1 proves slot-id validation, explicit provider-profile binding, exact device-code interactions for both Codex and xAI, strict `browser` rejection as `invalid_request` before provider work, one `Models` and credential-store view per pair, cross-slot isolation, one shared fence across credential set, refresh, removal, and affected interaction transitions, binding-before-Core-before-material creation, every exact Core-row field and initial active version 1, rejection of a pre-existing or idempotently returned Core row as direct ephemeral proof, same-reference initial store only with the new exact-row insert result inside the creating fenced mutation and inventory proof of no backend artifact, post-restart bound-plus-zero persistence failure without status rewrite, Core creation, binding clear, or reuse, whole-inventory recognition of the unique exact backend-recognized revoked tombstone with no material, temporary, or unknown residue, live Core version equality or lower-only monotonic advance with higher and every field mismatch failed closed, current-binding tombstone continuation only with the exact same-version Core row in active or revoked status and without a Vault write, completed historical classification only after unbind or account deletion with the exact same-version revoked Core row, zero or multiple distinct completed histories without account projection or blockage of a fresh reference, failed closure for every unbound or absent tombstone with active, missing, wrong-version, or non-exact Core state and for every live orphan, successful delete followed by same-pair create and fresh-reference login while old history remains immutable, encrypted-file-before-Core-before-account removal, rotation version projection, Vault store/rotate/revoke mapping, authoritative metadata and bounded projection reconciliation, fixed provider inventory without account or Vault access, valid unbound-plus-zero and bound-plus-one ordinary cases, whole-list and pair-addressed failed-closed behavior across all nine ordinary operations for ambiguous, extra, or binding-mismatched states except the narrow delete and logout current-tombstone continuation, pair-reuse blocking for every old reference but fresh-reference admission for completed pairs, metadata restoration only for a restored ordinary-valid state, reviewed cleanup as the sole ambiguous bound-plus-zero recovery, authenticated provider-slot projection round trips, atomic account, entry, and state writes, entry/state orphan and mismatch detection without omission or automatic repair, every-version reviewed cleanup, the exact seven server `AuditEvent` actions plus existing `vault.resolve` reuse, safe status projection, Codex quota validation, xAI quota `unsupported`, and redaction.
- L2 proves provider-neutral App API schemas and errors, admin authorization, Core Client parity, strict device-code-only request and pending-interaction schemas with `browser` rejected as `invalid_request`, the exact `500` persistence error and absence of partial account-list or quota success under corrupt, live-orphan, ambiguous bound-plus-zero, invalid tombstone, or exact Core-row mismatch conditions, completed-history non-projection, clean-absence create and not-found behavior with completed history, and strict absence of credential, Vault, account-id, raw quota, and upstream-error fields.
- L3 proves two same-provider account slots can log in through independent test credentials and serve overlapping requests without credential crossover; logout waits for active login settlement, cannot be undone by stale completion, removes the latest in-flight refresh result, and remains isolated through restart reconciliation.
- L3 opt-in real-provider evidence is explicit, skip-aware, and quota-gated, and proves prepared account status, one inference request, refresh when safely exercisable, local logout, sanitized status, and a provider quota observation or typed temporary unavailability. Evidence contains no credential value, credential-source path, or provider-private value.
- L5 proves NanoCore boots and serves configured subscription-backed providers without Codex app-server, `CODEX_HOME`, or ambient credentials.

Acceptance requires all of the following: two account slots can be selected explicitly and used concurrently; pi-ai performs login and refresh; credentials persist only through Vault; provider inventory is account-state-free; same-reference initial persistence is possible only inside the creating fenced mutation with clean inventory and direct ephemeral proof that includes the new exact-Core-row insert result; a pre-existing row never supplies that proof; after restart, a bound reference with neither authenticated live material nor the exact backend-recognized revoked tombstone fails every ordinary account operation as a whole with the fixed persistence error, performs no status rewrite, same-reference continuation, Core creation, binding clear, or pair reuse, and remains blocked until reviewed cleanup completes; metadata restoration never resolves that ambiguity; a live reference accepts only the exact active Core row with equal version or a lower version advanced monotonically; the current-binding backend-recognized tombstone can continue only the already-started removal sequence with the exact same-version active-or-revoked Core row and authorizes no Vault write, ordinary validity, same-reference reuse, or other recovery; after binding clear or deletion, only an exact same-version revoked Core row makes it inert completed history; zero or multiple distinct completed histories remain immutable and unprojected without blocking an unbound account or cleanly absent pair from allocating a fresh reference; any other tombstone without a current binding and every live orphan fail closed; successful delete followed by same-provider-and-slot create allocates a fresh reference while the old tombstone and revoked Core row remain; corrupt metadata retains the same failed-closed boundary; public status and quota are sanitized; quota failure does not block inference; the public Gateway uses no dedicated Codex backend; NanoCore has no Gateway/account dependency on Codex app-server or `CODEX_HOME`; and retired Codex-specific App API and provider-extension names are absent.

## Risks & Mitigations

- Pi-ai authentication API drift could corrupt account handling; the exact pin, focused adapter tests, and upgrade review constrain it.
- Concurrent login, refresh, logout, or delete could restore or remove the wrong credential; one shared mutation fence per provider and slot plus Vault version rotation serializes local writers and rejects stale interaction completion.
- A crash after binding and exact Core-row creation but before material store makes later material absence historically ambiguous; only the new-row insert result inside the still-live creating mutation permits continuation, while restart fails closed into reviewed cleanup and the exact backend-recognized revoked tombstone with its same-version Core row remains the sole automatic removal prefix.
- The Codex usage endpoint can change without public notice; strict validation converts drift into typed quota unavailability without affecting inference.
- A credential could leak through account or quota errors; fixed public schemas, redaction tests, and Vault-only material storage fail that boundary closed.
- Pi-ai xAI login may authenticate an account whose entitlement does not permit the requested Grok model; provider rejection remains a typed authentication or entitlement failure and does not imply subscription support beyond verified behavior.
- Removing legacy Codex homes requires re-login; the clean cut avoids unsafe token import and preserves the repository's no-backward-compatibility rule.

## Resolved Decisions

- Multi-account support belongs to a thin OpenKit slot layer above pi-ai, not a fork of pi-ai.
- Pi-ai owns login and credential refresh for both Codex and xAI.
- OpenKit owns Vault persistence, authorization, account switching by explicit profile binding, status, and quota projection.
- The public originator value and other pi-ai-controlled internal request details may use stock pi-ai behavior; OpenKit does not fork or patch pi-ai merely to preserve an old private value.
- Initial Codex and xAI login is device-code-only; `browser` is not a supported request mode.
- Codex quota uses a bounded direct provider adapter, not Codex app-server; xAI quota is explicitly unsupported until a stable interface exists.
- The dedicated Codex provider backend, Codex app-server account dependency, `CODEX_HOME`, and Codex-specific public account routes are removed at cutover.

## Deferred / Future Work

- User-owned subscription slots and explicit user-to-slot authorization.
- Quota-aware account selection or failover, if a later accepted design establishes a real need.
- xAI quota after a stable official interface exists.
- Credential-backed xAI real-use lifecycle verification, which activates only after an xAI subscription account exists and an engineer explicitly authorizes those effects. Until then xAI retains its product capability and deterministic lower-layer acceptance, and no run claims xAI real-use acceptance.
- Codex browser login after stock pi-ai exposes a server-compatible callback seam or a separately accepted completion operation; the initial contract adds neither an eleventh operation nor a deployment-mode restriction.
- Claude or another consumer subscription after entitlement and provider-interface review.

## Links

- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-app_api_openapi_projection.md`

- pi-ai upstream: `https://github.com/earendil-works/pi/tree/main/packages/ai`
