# Remote Auth Credential Bootstrap

Status: Accepted
Implementation: Implemented

## Owns

- The OpenKit access-token format, lifecycle, and the closed v1 scope set.
- The server-mode first-boot bootstrap ceremony that establishes the owner `User` and the first credential.
- The channel authentication contract for the MCP channel and any remote coordinator calling NanoCore with a token.
- Client-side credential storage rules for desktop AI applications and the MCP server process.
- Transport requirements for accepting bearer tokens on non-loopback interfaces.
- Token rotation, revocation, and the independence of `Token` and `AuthSession` revocation.
- The actor-context resolution and audit-label binding for token-authenticated requests.

## Does Not Own

- Canonical identity concepts. `docs/core/identity.md` owns `User`, `AuthSession`, `Token`, `WorkspaceMember`, `AutomationIdentity`, and actor-context terminology; this spec realizes them for remote auth.
- Authorization policy evaluation, roles, or permission decisions. Those belong to `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`.
- Multi-user membership, invitations, and role administration, which remain deferred tenancy work.
- User-owned external-service secrets and provider credentials. Those belong to the vault specs (`docs/specs/20260703-vault_secret_injection.md`).
- Better Auth implementation details, table layout, or session-cookie mechanics beyond their appearance in the Current Implementation Projection.
- Worker sandbox session tokens and lease-bound worker authentication, owned by the scheduler and worker control protocol specs.

## Core References

- `docs/core/identity.md`
- `docs/deployment.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

This spec fills the remote-auth gap deferred by `docs/specs/20260628-nanocore_config_identity_contract.md`: how a server-mode NanoCore deployment mints its first credential, how the MCP channel and remote coordinators authenticate afterward, and how desktop clients store credential material safely.

The clean target is a single credential family: server-issued opaque access tokens realizing the `Token` identity concept. Tokens carry a `okt_` prefix for leak scanning, are stored hashed, are shown exactly once at issuance, and belong to a small closed scope set. Server mode mints a one-time owner bootstrap token on first boot; local mode keeps its implicit local-user posture unchanged. The MCP channel authenticates with `OPENKIT_NANOCORE_TOKEN` as a bearer token, replacing the raw `OPENKIT_NANOCORE_COOKIE` / `OPENKIT_NANOCORE_AUTHORIZATION` passthrough in the same change. Clients store tokens in the OS keychain first, an encrypted fallback file second, and never in plaintext config. Bearer tokens are refused over non-loopback plaintext HTTP.

## Goals

- Define one token format and lifecycle precise enough to implement, test, and audit.
- Make a fresh server-mode deployment reach an authenticated owner without any out-of-band credential provisioning.
- Give the MCP channel a first-class, scoped, revocable credential instead of forwarded raw headers.
- Bind every token-authenticated request to an explicit actor context that flows into audit labels.
- Keep client machines free of plaintext token material at rest.
- Keep the check structure ready for multi-user tenancy so later work only adds membership facts, per the NGAC direction in the policy specs.

## Non-goals

- Do not design OAuth flows, device pairing, browser login UX, or federated identity for v1.
- Do not change local-mode loopback trust or the implicit local user posture.
- Do not define permission policy semantics; scopes here are authentication-layer coarse gates, not the policy model.
- Do not preserve the raw cookie/authorization env-var passthrough as a compatibility alias.
- Do not design worker-side sandbox token minting, which stays lease-bound in the scheduler design.

## Background

`docs/specs/20260628-nanocore_config_identity_contract.md` accepts Better Auth as the current server-mode browser auth implementation and explicitly defers remote NanoCore auth bootstrap, desktop credential storage, and audit labels for MCP-originated operations. The MCP channel previously shipped with deployment-supplied raw cookie and authorization-header forwarding; this spec replaces that stopgap with scoped NanoCore tokens. `docs/core/identity.md` already names the conceptual records this spec needs: `Token` with status values `active`, `expired`, `revoked`, `rotated`, and the invariant that raw token secret material must not be exposed after issuance.

There is currently no way to stand up a remote NanoCore and authenticate to it without hand-crafting a Better Auth session and pasting header values into environment variables. That path has no scoping, no revocation story, no rotation story, and no audit identity for MCP-originated operations.

## Decision

NanoCore owns opaque access-token issuance and verification as the remote channel credential:

- Tokens are server-issued opaque secrets realizing the `Token` concept, verified by hash lookup on every request. There is no client-verifiable or stateless token format in v1.
- Server mode self-bootstraps: an empty deployment mints exactly one owner bootstrap token through the operator channel, consumed exactly once.
- The MCP channel and remote coordinators authenticate with `Authorization: Bearer` carrying a scoped token supplied via `OPENKIT_NANOCORE_TOKEN`. The raw cookie/authorization passthrough is removed in the same change, per the internal development compatibility rule.
- Clients store tokens in the OS keychain when available, an encrypted file fallback otherwise, and never in plaintext config files.
- Bearer authentication and bootstrap-token consumption over non-loopback plaintext HTTP are refused; server mode MUST present TLS on non-loopback interfaces before either secret is accepted there.
- Rotation is overlap-based, revocation is immediate, and `AuthSession` and `Token` revocation are independent.

## Contract / Expected Behavior

### Token format and record

- A token secret MUST be the fixed prefix `okt_` followed by a random secret with at least 256 bits of entropy from a cryptographically secure source, encoded so the full secret is a single URL-safe string. The prefix exists so secret scanners and redaction filters can match OpenKit tokens; redaction tooling SHOULD treat any `okt_`-prefixed string as credential material.
- NanoCore MUST store only a strong one-way hash of the secret. The plaintext secret MUST NOT be persisted, logged, or retrievable after issuance, and MUST be returned exactly once in the issuance response or bootstrap emission.
- The `Token` record MUST carry: token id (UUIDv7), owner identity (user id or `AutomationIdentity` id), scope, issued time, expiration time, revocation time, rotation lineage (predecessor token id and rotation grace expiry when rotated), status (`active`, `expired`, `revoked`, `rotated` per `docs/core/identity.md`), and a last-used summary (last-used time, channel, and coarse source summary; no full request logs).
- Token read models MUST expose the token id and a short non-secret display fragment at most; they MUST NOT expose the hash or any recoverable secret material.

### Scopes

Scopes are a small closed set in v1:

- `server-admin`: full administrative authority over the deployment, including token issuance and revocation, user creation, and server config.
- `workspace`: read and write product operations bound to an explicit list of workspace ids recorded on the token.
- `workspace-readonly`: read-only product operations bound to an explicit list of workspace ids.

Rules:

- A token MUST carry exactly one scope. `workspace` and `workspace-readonly` tokens MUST carry at least one workspace id; `server-admin` tokens MUST NOT carry workspace bindings.
- Scope checks are authentication-layer gates. Passing a scope check MUST NOT be treated as a permission decision; policy evaluation still applies downstream, per `docs/core/permissions.md`.
- Requests outside a token's scope MUST fail with a typed authorization error that does not reveal whether the target resource exists.
- Better Auth session actors and workspace-scoped token actors MUST be checked against active workspace membership on every workspace-addressed request. A missing membership verifier MUST fail closed, workspace tokens MUST also be bound to the addressed workspace, and `server-admin` tokens remain exempt from workspace bindings.
- Membership revocation MUST retain the membership edge with `status = "removed"`; hard deletion is not a supported revocation mechanism because it discards the tombstone. Workspace creation and workspace import MUST record the owner membership transactionally. Request-time filesystem discovery MUST NOT synthesize missing membership, revive an existing `removed` edge, or replace the first workspace registry owner.
- Global App Search requests made by `workspace` or `workspace-readonly` tokens MUST search only token-bound workspaces with active membership. The same visible workspace set MUST constrain workspace, thread, knowledge, artifact, and item results; removing active membership MUST remove that workspace from subsequent search results and the removal MUST survive NanoCore restart.
- Deployment-wide data-root administration routes MUST accept only the implicit local actor in local mode or a `server-admin` token in server mode. A Better Auth session, `workspace` token, or `workspace-readonly` token MUST NOT confer data-root administration authority.

### Server-mode bootstrap ceremony

- When NanoCore starts in server mode with zero `User` records, it MUST mint a one-time owner bootstrap token and emit it exactly once through the operator channel: printed to stdout at startup and/or written to a file with `0600` permissions inside the data root. The emission MUST state clearly that the value is shown once and never again.
- The bootstrap token MUST be consumable exactly once, MUST expire unconsumed after a bounded window (default 24 hours), and MUST self-invalidate immediately on consumption. A restart with zero users and an expired unconsumed bootstrap token MUST mint a fresh one and invalidate the old emission file.
- Consuming the bootstrap token MUST atomically create the owner `User` and either the owner's first `AuthSession` or the first `server-admin` token, then invalidate the bootstrap token in the same transaction. Partial consumption MUST NOT leave a consumed-but-ownerless state.
- Once at least one `User` exists, NanoCore MUST NOT mint bootstrap tokens again. Recovery of a locked-out deployment is an operator data-root procedure, not a re-bootstrap.
- Local mode keeps the implicit local user posture from `docs/specs/20260628-nanocore_config_identity_contract.md`: no bootstrap token, no ceremony, loopback trust unchanged.

### Channel authentication

- The MCP channel and any remote coordinator MUST authenticate to server-mode NanoCore with a scoped token presented as `Authorization: Bearer <token>`.
- The MCP server MUST read the token from `OPENKIT_NANOCORE_TOKEN` (or from the client credential store, see below) at process start. The `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` raw passthrough variables are removed in the same change with no compatibility alias, per the internal development compatibility rule.
- Every authenticated request MUST resolve to an actor context containing: the acting identity (`User` or `AutomationIdentity`), the token id (or `AuthSession` id for session-authenticated requests), and the channel. The actor context MUST flow into audit labels for MCP-originated operations so audit records can answer which identity, credential, and channel caused an action, per `docs/core/audit.md`.
- Token verification failures MUST be indistinguishable between unknown, expired, revoked, and malformed tokens in the response body, and MUST NOT echo the presented value.
- Tokens MUST NOT be accepted from query strings, request bodies, or cookies. The bearer header is the only token transport.
- Better Auth session cookies remain a valid authentication path for browser product surfaces; this spec adds token authentication beside it, and both resolve to the same actor-context shape.

### Client credential storage

- Desktop clients (setup Skills, the MCP server configuration flow, future installers) MUST store tokens in the OS keychain when available: macOS Keychain, Windows Credential Manager, or Secret Service / libsecret on Linux.
- When no keychain backend is available, the fallback MUST be an encrypted file under the user's OpenKit config directory, and any process using the fallback MUST emit a boot-time warning naming the degraded storage.
- Plaintext tokens in config files, MCP configuration JSON committed to disk, repository files, examples, artifacts, or change records are prohibited. Environment-variable delivery (`OPENKIT_NANOCORE_TOKEN`) is permitted as a process-launch mechanism because it is not at-rest storage, but documentation MUST steer users toward keychain-backed delivery.
- The MCP server process MUST read the token from the keychain or environment at start and MUST NOT persist it itself, echo it in tool responses, resources, logs, or diagnostics, or include it in error payloads.

### Transport requirements

- NanoCore MUST refuse bearer-token authentication over plaintext HTTP on non-loopback interfaces. Server mode MUST present TLS — either natively or via a fronting proxy that the deployment declares — before tokens are accepted on non-loopback addresses.
- Loopback interfaces continue to accept tokens over plaintext HTTP so local development and the desktop-embedded posture in `docs/deployment.md` keep working.
- The refusal MUST be a typed startup or request error naming the transport requirement, not a silent downgrade or a warning-only acceptance.

### Rotation and revocation

- Rotation MUST be overlap-based: rotating a token issues a new token (returned once), marks the old token `rotated` with a grace expiry (default 24 hours, configurable down to zero), and records rotation lineage on both records. During grace, the old token still authenticates; after grace it behaves as expired.
- Revocation MUST take effect immediately at the auth layer: the next verification of a revoked token fails. There is no revocation grace.
- `AuthSession` records and `Token` records MUST be revocable independently. Revoking a user's sessions MUST NOT revoke their tokens, and vice versa; an owner-initiated "revoke all credentials" action is a composite of both.
- A rotated or revoked token MUST NOT be reactivatable; recovery is issuing a new token.
- `server-admin` tokens MUST be able to list, issue, rotate, and revoke tokens through public App API routes; those routes are the only token administration surface, and MCP token-administration tools MUST be facades over them.

## Accepted Design

Token verification is a NanoCore auth-middleware concern beside the existing Better Auth session resolution: the middleware extracts the bearer value, rejects non-`okt_` shapes early, hashes and looks up the token, checks status, expiry, rotation grace, transport class, and scope-to-route class, then attaches the actor context used by downstream policy enforcement and audit producers. The same socket-derived transport gate runs before the public bootstrap-consumption handler reads its request body. The last-used summary is updated after successful verification and remains a redacted read model.

Bootstrap is a startup hook: on server-mode boot with zero users, mint the bootstrap secret, store its hash with a `bootstrap` marker distinct from the public scope set, and emit the plaintext once. A single public consumption endpoint accepts the bootstrap token and the owner profile payload and performs the atomic owner-creation transaction.

The client side ships a small credential-store helper used by the setup Skills and MCP server: resolve order is explicit environment variable, then OS keychain entry keyed by NanoCore endpoint URL, then encrypted fallback file, with the boot-time warning on fallback use.

## Current Implementation Projection

- `mcp/` reads `OPENKIT_NANOCORE_URL`, resolves `OPENKIT_NANOCORE_TOKEN` first, an OS keychain token second, and an encrypted fallback file third, maps the token to `Authorization: Bearer <token>`, and exposes `openkit.consume_bootstrap_token` over the public App API bootstrap-consume route. The old raw `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` passthrough variables are removed without aliases.
- Server mode uses Better Auth for session authentication; `apps/nanocore/src/auth/middleware.ts` attaches actor context and enforces server-mode auth for protected APIs. Token verification lands beside it in the same middleware layer.
- Local mode resolves the implicit local user via `LOCAL_USER_ID`; this spec does not change that path.
- NanoCore now has the first server-side access-token auth and administration slice: `okt_` opaque secret generation with at least 256 bits of entropy, versioned SHA-256 token hashing, constant-time verification, closed v1 scope-shape validation, active / expired / revoked / rotated usability checks, durable server-scope `openkit_access_tokens` records, and server-mode bearer verification in `apps/nanocore/src/auth/middleware.ts`. When `createApp` has a Core DB, protected App API and internal routes can authenticate `Authorization: Bearer <okt_token>` and resolve an actor with `kind: "token"` and the durable token id without exposing token material in auth failures. NanoCore refuses bearer tokens over non-loopback plaintext HTTP before verification. NanoCore also exposes the first token administration App API surface: `GET /api/app/auth/tokens`, `POST /api/app/auth/tokens`, `POST /api/app/auth/tokens/:tokenId/revoke`, and `POST /api/app/auth/tokens/:tokenId/rotate`; only `server-admin` token actors can administer tokens, while Better Auth session actors and workspace-scoped token actors receive `access_token_admin_forbidden`; list/revoke/rotate responses expose only redacted token records, and create/rotate return the plaintext token only once. `@openkit/core-client` exposes those same token administration routes under `client.app`, and `@openkit/mcp` exposes them as `openkit.list_openkit_access_tokens`, `openkit.create_openkit_access_token`, `openkit.revoke_openkit_access_token`, and `openkit.rotate_openkit_access_token` without adding a second administration surface. Successful bearer verification updates the redacted last-used summary fields exposed by the token administration API, and MCP requests now send stable `mcp` / `desktop-agent` channel metadata that NanoCore records in that summary. Better Auth session actors and workspace-scoped token actors now require active membership for workspace-addressed requests, a missing membership verifier fails closed, workspace-scoped tokens additionally enforce route-level workspace bindings, and workspace-readonly tokens reject mutating methods with non-echoing `core.auth.scope_forbidden` failures. The MCP server authenticates through `OPENKIT_NANOCORE_TOKEN` first, otherwise reads an OS keychain token keyed by the configured NanoCore URL across macOS Keychain, Linux Secret Service, and Windows Credential Manager, and finally reads a machine-scoped encrypted fallback file with a degraded-storage warning. It also exposes `openkit.consume_bootstrap_token`, which consumes the one-time bootstrap token through `@openkit/core-client` without echoing the bootstrap token in the MCP response and can store the returned NanoCore token when called with `storeCredential: true`: Linux writes to Secret Service through stdin, Windows writes to Credential Manager through stdin, and other platforms fall back to the encrypted file instead of using secret-bearing command argv. Server-mode first boot now issues a distinct one-time bootstrap token when the OpenKit `users` table is empty, writes the plaintext only to an owner-readable data-root emission file, and exposes `POST /api/app/auth/bootstrap/consume` as the public one-shot consume route that atomically creates the owner `User` and returns the first `server-admin` access token once. The server-mode MCP smoke now exercises the clean-data-root bootstrap story end to end: owned NanoCore startup, owner-only bootstrap emission file, bootstrap consumption, server-admin workspace setup, scoped workspace token issuance, and MCP connection through `OPENKIT_NANOCORE_TOKEN`.
- Successful bootstrap consumption, access-token issuance, token revocation, and token rotation now emit server-owned general `AuditEvent` rows through the existing audit recorder. The rows use stable token lifecycle action names and redacted token ids, scopes, owners, and authenticated actor ids when present; they do not store bootstrap token values, plaintext `okt_` secrets, token hashes, keychain material, fallback encrypted-file contents, or authorization headers.
- Token records target the server-scope database in the layout owned by `docs/specs/20260703-storage_layout_record_ownership.md`.

## Alternatives Considered

- JWT or other stateless self-verifying tokens. Rejected: immediate revocation requires a server-side denylist anyway, which erases the statelessness benefit; opaque server-checked tokens are simpler, keep no claims to version, and match the single-NanoCore deployment shape. Revocation and simplicity win.
- OAuth 2.0 device authorization flow for desktop pairing. Deferred: it is the right long-term UX for pairing an AI application with a remote NanoCore, but it needs a browser surface, client registration, and consent UI that do not exist yet. The token contract here is the substrate a device flow would mint into.
- Keeping the raw cookie/authorization env-var passthrough beside tokens. Rejected under the internal development compatibility rule: two parallel channel-auth contracts guarantee drift, and the passthrough has no scoping, rotation, or audit identity.
- Better Auth API-key plugin as the token implementation. Not rejected as an implementation choice — it MAY satisfy this contract — but the contract is owned here in OpenKit terms so the provider remains swappable, consistent with the Better Auth posture in the config identity contract.
- mTLS client certificates for channel auth. Rejected for v1: certificate provisioning and renewal on end-user desktops is heavier than the problem requires; TLS remains a transport requirement, not an identity mechanism.

## Consequences

- A fresh remote deployment becomes self-service: boot, read the bootstrap token once, consume it, issue scoped tokens.
- The MCP channel gains a revocable, scoped, auditable credential, and MCP-originated operations gain a real actor identity in audit labels.
- Removing the raw header passthrough is a breaking change for existing server-mode dogfooding environments; operators must issue a token and switch to `OPENKIT_NANOCORE_TOKEN` in the same upgrade.
- NanoCore takes on hash-verification on every token-authenticated request and a small token administration API surface.
- Client tooling takes on a keychain dependency per platform, with the encrypted-file fallback as the portability escape hatch.

## Rollout / Migration Plan

This is new machinery plus one same-change removal, not a compatibility migration:

1. Token record, hashing, verification middleware, scope checks, and transport refusal land together in NanoCore, with token administration routes behind `server-admin`.
2. Server-mode bootstrap ceremony lands next, gated on the zero-user condition.
3. The MCP server switches to `OPENKIT_NANOCORE_TOKEN` and deletes the cookie/authorization passthrough in the same change; `mcp/README.md`, the setup Skills, and `docs/specs/20260617-openkit_ai_interface.md` are updated in that change.
4. The client credential-store helper reads OS keychain entries first and encrypted fallback files second. Linux and Windows setup writes use stdin-backed keychain commands; macOS setup uses encrypted fallback until a safe non-argv keychain writer is available.

Fresh dogfooding deployments authenticate by consuming the one-time bootstrap token. Existing data roots require an existing `server-admin` token; locked-out deployments require a separately defined operator data-root recovery procedure, and this change does not allow an ordinary Better Auth session to elevate through token-administration routes.

## Testing Strategy / Acceptance Criteria

Mapped to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: repository checks that no plaintext `okt_` secret appears in committed files, examples, or fixtures other than clearly fake documented placeholders; schema-drift checks for the `Token` record shape.
- L1: unit tests for secret generation entropy and prefix shape, hash-and-lookup verification, status transitions (`active` to `expired`/`revoked`/`rotated`), rotation-grace math, scope-to-route gating, bootstrap single-consumption logic, and credential-store resolve order including fallback warning emission, encrypted fallback non-plaintext storage, and stdin-backed Linux/Windows keychain writes with secret-free argv.
- L2: contract tests binding the auth middleware to the actor-context shape: token-authenticated requests produce actor context with identity, token id, and channel; audit label producers receive it; verification failures are uniform and non-echoing; tokens in query strings, bodies, and cookies are rejected.
- L3: NanoCore black-box tests: fresh server-mode boot emits a bootstrap token with `0600` file permissions, consumption creates the owner atomically and invalidates the bootstrap token, second consumption fails; issued `workspace` tokens pass on bound workspaces and fail elsewhere with typed errors; revocation takes effect on the next request; rotation keeps the old token working through grace and not after; non-loopback plaintext HTTP bearer requests are refused while loopback succeeds; MCP smoke path authenticates end-to-end with `OPENKIT_NANOCORE_TOKEN`. The owned server-mode MCP smoke now covers the bootstrap-backed MCP path on a clean data root.
- L4: not applicable until Web UI token administration screens exist.
- L5: packaged-build smoke that a server-mode boot on a clean data root produces exactly one bootstrap emission and that the MCP server connects with a minted token. The current `@openkit/mcp` server-mode smoke validates the bootstrap emission file permission, consumes the bootstrap token, issues a scoped workspace token, and connects MCP with the minted token.
- L6: story acceptance covering an operator standing up a remote NanoCore, consuming the bootstrap token, issuing a workspace-scoped token, connecting a desktop AI application through MCP, and revoking the token to confirm access ends.

Acceptance criteria: all L1-L3 behaviors pass deterministically; no code path can return a token secret after issuance; the cookie/authorization passthrough is absent from the MCP package; a revoked token fails on the request after revocation with no grace.

## Risks & Mitigations

- Risk: the bootstrap token leaks through operator logs or CI capture of stdout. Mitigation: single emission, bounded expiry, single consumption, `0600` file option for environments where stdout is captured, and the `okt_` prefix so scanners catch accidental persistence.
- Risk: hash verification on every request becomes a hot-path cost. Mitigation: single indexed lookup with an asynchronous last-used update; the deployment shape is one NanoCore, not a token-verification fleet.
- Risk: keychain integration fails unevenly across platforms and users silently land on the encrypted fallback. Mitigation: the mandatory boot-time warning, plus diagnostics in `openkit.read_status`-class surfaces naming the storage backend in use without revealing material.
- Risk: scope checks get mistaken for the permission model and policy work stalls. Mitigation: the contract states scopes are authentication-layer gates; policy enforcement mapping remains a required downstream check, restated at every check site.
- Risk: TLS refusal blocks legitimate proxy deployments that terminate TLS upstream. Mitigation: the deployment-declared fronting-proxy posture is an explicit configuration, not an inference, so operators state their transport intent.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the encrypted fallback file uses a machine-scoped key when OS keychain storage is unavailable; `workspace` tokens bind to an explicit workspace list only, and wildcard workspace binding is deferred until audit, tenancy, and revocation semantics are designed.

## Deferred / Future Work

- OAuth-style device-flow pairing so a desktop AI application can acquire a token through a browser consent step instead of manual issuance.
- Multi-user invitations, membership administration, and role-bearing tokens once tenancy lands; the membership check structure here is built for that addition.
- Fine-grained token scopes (per-capability, per-thread, time-boxed step tokens) beyond the closed v1 set.
- Web UI token administration surfaces projecting the token read models.
- Automation-identity token issuance flows for scheduled and webhook-triggered work.

## Links

- `docs/core/identity.md`
- `docs/deployment.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260617-openkit_ai_interface.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260529-test_strategy.md`
