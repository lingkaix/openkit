---
status: Accepted
implementation: Partial
updated: 2026-09-02
---
# Remote Auth Credential Bootstrap

## Owns

- The human remote-access token format, lifecycle, and closed v1 scope set.
- The server-mode first-boot bootstrap ceremony that establishes the owner `User` and the first credential.
- The human remote-access channel authentication contract for the bundled `openkit` CLI and any remote coordinator calling NanoCore with a human remote-access token.
- Client-side credential storage rules for Skill-capable AI applications and the bundled CLI process.
- Transport requirements for accepting human remote-access bearer tokens on non-loopback interfaces.
- Human remote-access token rotation, revocation, and the independence of human-owned `Token` and `AuthSession` revocation.
- The actor-context resolution and audit-label binding for human remote-access token-authenticated requests.
- The stopped-server local operator procedure for discovering active Users and recovering one new `server-admin` credential after every usable administrator credential is unavailable.

## Does Not Own

- Canonical identity concepts. `docs/core/identity.md` owns `User`, `AuthSession`, `Token`, `WorkspaceMember`, `AutomationIdentity`, and actor-context terminology; this spec realizes only the current human-`User`-owned remote-auth contract.
- Authorization policy evaluation, roles, or permission decisions. Those belong to `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`.
- Canonical Workspace membership and user lifecycle, which are owned by `docs/core/identity.md`. Multi-user invitation, fixed-role, and owner-transfer mechanics belong to `docs/specs/20260715-multi_user_workspace_system.md`.
- User-owned external-service secrets and provider credentials. Those belong to the vault specs (`docs/specs/20260703-vault_secret_injection.md`).
- Better Auth implementation details, table layout, or session-cookie mechanics beyond their appearance in the Current Implementation Projection.
- Worker sandbox session tokens and lease-bound worker authentication, owned by the scheduler and worker control protocol specs.
- The NanoHost transport token family owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`: its tokens belong to a configured NanoHost `IntegrationIdentity`, use the distinct `nanohost-transport` token type and scope, authenticate only the NanoCore-to-NanoHost transport, and follow that specification's lifecycle. Reuse is limited to the `okt_` opaque-secret format, CSPRNG generation, hashing, constant-time verification, and redaction primitives; that reuse transfers no authority to this specification.
- Workspace content recovery or membership bypass. The local operator procedure may issue deployment administration authority but does not make its target a Workspace member or authorize an ordinary Workspace read or write.

## Core References

- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

This spec fills the remote-auth gap deferred by `docs/specs/20260628-nanocore_config_identity_contract.md`: how a server-mode NanoCore deployment mints its first credential, how the bundled CLI and remote coordinators authenticate afterward, how Skill-capable clients store credential material safely, and how an operator with exclusive stopped-server control recovers one administrator credential without reopening bootstrap.

The clean target for human remote access is a single credential family: server-issued opaque access tokens owned by a responsible human `User` and realizing the `Token` identity concept. Tokens carry a `okt_` prefix for leak scanning, are stored hashed, are shown exactly once at issuance, and belong to the small closed human remote-access scope set below. Server mode mints a one-time owner bootstrap token on first boot and delivers it only through the secure operator mechanism defined below; local mode keeps its implicit local-user posture unchanged. The bundled CLI authenticates with `OPENKIT_NANOCORE_TOKEN` as an explicit ephemeral bearer-token override or resolves a persistent token from supported credential storage. Clients prefer a secret-safe OS credential-store writer and otherwise use the permitted encrypted fallback, never plaintext config. Bearer tokens are refused over non-loopback plaintext HTTP.

## Goals

- Define one token format and lifecycle precise enough to implement, test, and audit.
- Make a fresh server-mode deployment reach an authenticated owner without any out-of-band credential provisioning.
- Give the bundled CLI a first-class, scoped, revocable credential instead of forwarded raw headers.
- Bind every token-authenticated request to an explicit actor context that flows into audit labels.
- Keep client machines free of plaintext token material at rest.
- Intersect every Workspace-addressed bearer request with current multi-user membership and policy facts, per the NGAC direction in the policy specs.

## Non-goals

- Do not design OAuth flows, device pairing, browser login UX, or federated identity for v1.
- Do not change local-mode loopback trust or the implicit local user posture.
- Do not define permission policy semantics; scopes here are authentication-layer coarse gates, not the policy model.
- Do not preserve the raw cookie/authorization env-var passthrough as a compatibility alias.
- Do not design worker-side sandbox token minting, which stays lease-bound in the scheduler design.
- Do not define `AutomationIdentity` token issuance, responsible-user binding, or Workspace membership for V1.

## Background

`docs/specs/20260628-nanocore_config_identity_contract.md` accepts Better Auth as the current server-mode browser auth implementation and explicitly defers remote NanoCore auth bootstrap, client credential storage, and audit labels for remote coordinator operations. The legacy MCP channel previously shipped with deployment-supplied raw cookie and authorization-header forwarding; the implemented token substrate replaced that stopgap, and the accepted Agent Skill Interface now carries it forward through the bundled CLI. `docs/core/identity.md` already names the conceptual records this spec needs: `Token` with status values `active`, `expired`, `revoked`, `rotated`, and the invariant that raw token secret material must not be exposed after issuance.

The historical gap was the absence of a safe way to stand up a remote NanoCore and authenticate without hand-crafting a Better Auth session and pasting header values into environment variables. NanoCore now implements the token and bootstrap substrate, and the bundled CLI implements endpoint-scoped credential resolution, storage, deletion, and secret-safe bootstrap consumption.

## Decision

NanoCore owns opaque access-token issuance and verification as the remote channel credential:

- Tokens are server-issued opaque secrets realizing the `Token` concept, verified by hash lookup on every request. There is no client-verifiable or stateless token format in v1.
- Server mode self-bootstraps: an empty deployment mints exactly one owner bootstrap token through the secure operator delivery defined below, consumed exactly once.
- The bundled CLI and remote coordinators authenticate with `Authorization: Bearer` carrying a scoped token resolved from supported credential storage or supplied through the explicit ephemeral `OPENKIT_NANOCORE_TOKEN` override. The raw cookie/authorization passthrough remains removed, per the internal development compatibility rule.
- Clients use an OS credential store only where the implementation has a secret-safe write path that keeps token material out of process arguments; otherwise they use the permitted encrypted file fallback and never plaintext config files.
- Bearer authentication and bootstrap-token consumption over non-loopback plaintext HTTP are refused; server mode MUST present TLS on non-loopback interfaces before either secret is accepted there.
- Rotation is overlap-based, revocation is immediate, and `AuthSession` and `Token` revocation are independent.
- A locked-out operator recovers by holding the existing data-root exclusive lock for one complete stopped-server command, publishing one private resumable credential envelope, and committing the matching Token and redacted AuditEvent. The file and SQLite are separate effect domains and are never described as one atomic transaction.

## Contract / Expected Behavior

### Token format and record

- A token secret MUST be the fixed prefix `okt_` followed by a random secret with at least 256 bits of entropy from a cryptographically secure source, encoded so the full secret is a single URL-safe string. The prefix exists so secret scanners and redaction filters can match OpenKit tokens; redaction tooling SHOULD treat any `okt_`-prefixed string as credential material.
- NanoCore MUST store only a strong one-way hash as durable credential authority. Access-token plaintext MUST be returned exactly once over its protected issuance response and MUST NOT be persisted, logged, or retrievable afterward. The bootstrap credential may exist only in the owner-readable one-time file or explicitly secure delivery destination defined below.
- The human remote-access `Token` record MUST carry: token id (UUIDv7), owner user id (the responsible human `User` in V1), scope, issued time, expiration time, revocation time, rotation lineage (predecessor token id and rotation grace expiry when rotated), status (`active`, `expired`, `revoked`, `rotated` per `docs/core/identity.md`), and a last-used summary (last-used time, channel, and coarse source summary; no full request logs). This human owner field does not apply to NanoHost transport tokens, whose owner is the configured NanoHost `IntegrationIdentity` under their owning specification.
- Token read models MUST expose the token id and a short non-secret display fragment at most; they MUST NOT expose the hash or any recoverable secret material.

### Scopes

Human remote-access token scopes are a small closed set in v1:

- `server-admin`: deployment-administration authority, including token issuance and revocation, user administration, server config, backup, recovery, and data-root operations; it does not imply Workspace content authority.
- `workspace`: read and write product operations bound to an explicit list of workspace ids recorded on the token.
- `workspace-readonly`: read-only product operations bound to an explicit list of workspace ids.

This closed set applies only to the human remote-access token family. It neither includes nor governs the NanoHost token type and scope `nanohost-transport`.

Rules:

- A human remote-access token MUST carry exactly one scope. Human remote-access `workspace` and `workspace-readonly` tokens MUST carry at least one workspace id; human remote-access `server-admin` tokens MUST NOT carry workspace bindings.
- Scope checks are authentication-layer gates. Passing a scope check MUST NOT be treated as a permission decision; policy evaluation still applies downstream, per `docs/core/permissions.md`.
- Requests outside a token's scope MUST fail with a typed authorization error that does not reveal whether the target resource exists.
- Every Better Auth session actor and human remote-access bearer-token actor, including a `server-admin` token actor, MUST be checked against the human token owner's current active Workspace membership and product role on every workspace-addressed product request. A missing membership verifier MUST fail closed. Human remote-access Workspace-scoped tokens MUST additionally be bound to the addressed Workspace; `server-admin` tokens are exempt only from the token-binding field, never from membership or policy evaluation.
- Membership tombstones, implicit-revival prohibition, and explicit reactivation follow `docs/core/identity.md`. Workspace creation and workspace import MUST record the owner membership transactionally and MUST NOT replace the first workspace registry owner.
- Global App Search requests made by `workspace` or `workspace-readonly` tokens MUST search only token-bound workspaces with active membership. The same visible workspace set MUST constrain workspace, thread, knowledge, artifact, and item results; removing active membership MUST remove that workspace from subsequent search results and the removal MUST survive NanoCore restart.
- Deployment-wide administration routes MUST accept the implicit local actor in local mode, a presented `server-admin` token actor, or a Better Auth session actor whose active canonical User owns at least one currently usable `server-admin` Token. A Better Auth session alone, a `workspace` token, or a `workspace-readonly` token MUST NOT confer deployment administration authority.

### Server-mode bootstrap ceremony

- `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns startup sequencing: bootstrap issuance MUST occur only after authoritative integrity verification and migrations succeed and before normal listener admission. This spec owns the zero-user predicate, credential lifecycle, delivery, and consumption ceremony.
- When NanoCore reaches that server-mode hook with zero `User` records, it MUST mint one owner bootstrap token and deliver it exactly once through an owner-readable one-time file with `0600` permissions inside the data root or another explicitly secure operator delivery mechanism. The credential MUST NOT be written to stdout, stderr, ordinary logs, diagnostics, or artifacts, and the non-secret notice MUST state that the credential is one-time, expires, and cannot be recovered from NanoCore.
- The bootstrap token MUST be consumable exactly once, MUST expire unconsumed after a bounded window (default 24 hours), and MUST self-invalidate immediately on consumption. A restart with zero users and an expired unconsumed bootstrap token MUST mint a fresh one and invalidate the old emission file.
- Consuming the bootstrap token MUST atomically create the owner `User` and either the owner's first `AuthSession` or the first `server-admin` token, then invalidate the bootstrap token in the same transaction. Partial consumption MUST NOT leave a consumed-but-ownerless state.
- Once at least one `User` exists, NanoCore MUST NOT mint bootstrap tokens again. Recovery of a locked-out deployment is an operator data-root procedure, not a re-bootstrap.
- Local mode keeps the implicit local user posture from `docs/specs/20260628-nanocore_config_identity_contract.md`: no bootstrap token, no ceremony, loopback trust unchanged.

### Channel authentication

In `Channel authentication`, `Transport requirements`, and `Rotation and revocation`, every unqualified token, bearer-token, token actor, and `Token` record means only the human remote-access token family. The NanoHost transport token family remains outside every route, actor, TLS, rotation, revocation, and `AuthSession`-interaction rule in those subsections.

- The bundled CLI and any remote coordinator MUST authenticate to server-mode NanoCore with a scoped token presented as `Authorization: Bearer <token>`.
- The bundled CLI MUST resolve the token from the client credential store or the explicit ephemeral `OPENKIT_NANOCORE_TOKEN` override. The `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` raw passthrough variables remain removed with no compatibility alias, per the internal development compatibility rule.
- Every authenticated request under this V1 contract MUST resolve to an actor context containing: the acting human `User`, the token id (or `AuthSession` id for session-authenticated requests), and the channel. The actor context MUST flow into audit labels for CLI-originated operations so audit records can answer which identity, credential, and channel caused an action, per `docs/core/audit.md`. `AutomationIdentity` token actors remain undefined until a separate specification owns their issuance and membership rules.
- Token verification failures MUST be indistinguishable between unknown, expired, revoked, and malformed tokens in the response body, and MUST NOT echo the presented value.
- Tokens MUST NOT be accepted from query strings, request bodies, or cookies. The bearer header is the only token transport.
- Better Auth session cookies remain a valid authentication path for browser product surfaces; this spec adds token authentication beside it, and both resolve to the same actor-context shape.

### Client credential storage

- Skill-capable clients and future installers MUST prefer the OS credential store only when their adapter can write without placing token material in argv or another observable process surface. The current safe writers use stdin-backed Windows Credential Manager and Linux Secret Service commands; existing macOS Keychain entries may be read, but new macOS writes use the encrypted fallback until a safe non-argv writer exists.
- When no secret-safe keychain writer is available, the fallback MUST be an encrypted file under the user's OpenKit config directory, and any process using the fallback MUST emit a boot-time warning naming the degraded storage. Implementations MUST NOT add a dependency solely to force keychain storage when the existing encrypted fallback satisfies this contract.
- Plaintext tokens in config files, agent configuration committed to disk, repository files, examples, artifacts, or change records are prohibited. Environment-variable delivery (`OPENKIT_NANOCORE_TOKEN`) is permitted only as an explicit ephemeral process override; documentation MUST steer users toward supported persistent storage, preferring a secret-safe OS credential writer when one exists.
- The bundled CLI MUST read persistent tokens from supported credential storage and MUST NOT echo them in result envelopes, stderr, logs, diagnostics, artifacts, knowledge, or error payloads.
- An operation that receives one-time token material MUST store it directly through a supported credential destination and return only redacted storage metadata, or fail with a typed setup error when secure storage is unavailable; it MUST NOT print the token for an agent to copy.
- `credential.store` accepts exactly one of two strict JSON shapes: the existing `{ "token": "okt_..." }` input or the complete stopped-server recovery envelope defined below. In either case it passes only the `token` field to the existing endpoint credential store; recovery request, Token, owner, and expiry metadata do not enter the keychain or encrypted fallback.

### Stopped-server administrator recovery

- The procedure is exposed only by the local `openkit-operator` executable. `admin recovery-users --data-root <absolute-path>` lists active canonical Users as strict redacted records containing exact `userId`, normalized `email`, and `displayName`; it reads no Workspace content, membership, session, Token secret, password, or credential-store material. `admin recover-access --data-root <absolute-path> --owner-user-id <id> --expires-at <instant> --output <absolute-path> --confirm <literal>` targets exactly one listed active User, and `literal` MUST equal `issue-server-admin-token:<ownerUserId>:<expiresAt>` byte for byte so the operator explicitly confirms the credential-bearing authorization change and its exact subject and expiry.
- Each command MUST acquire the existing data-root exclusive lock before opening any database and retain that same acquisition through its complete read or mutation, credential file and parent-directory `fsync`, database close, and command completion. It never stops another process. A lock held by NanoCore or another operator command, an unproved stale holder, or an unknown lock state fails before database or output mutation; NanoCore cannot acquire the same lock during recovery.
- Recovery MUST create one ordinary active `server-admin` Token through the existing token-record owner. On first creation, `expiresAt` MUST be strictly later than the locked command's current time and no later than 24 hours after that time; the exact 24-hour boundary is accepted, while a current, past, or later instant is rejected before output or database mutation. Recovery MUST NOT create or reactivate a User, create an AuthSession, modify a password, reopen or consume bootstrap, revoke another Token, select another owner, grant Workspace membership, or infer that a durable Token is unusable merely because its plaintext is unavailable.
- The output path is the unique attempt identity. On an absent path the command generates the request id, Token id, and secret once and publishes one strict UTF-8 JSON object `{ "kind": "openkit-admin-recovery", "requestId": <id>, "tokenId": <id>, "ownerUserId": <id>, "expiresAt": <instant>, "token": <okt-secret> }`; callers do not select a request id. The command creates the exact output path once as a non-link regular file with `O_CREAT|O_EXCL` and mode `0600`, writes the complete envelope, and `fsync`s the file and parent directory before beginning the SQLite transaction. It never writes the secret, output path, token hash, or envelope to stdout, stderr, ordinary logs, diagnostics, Audit, artifacts, or another file.
- After durable file publication, one Core SQLite transaction inserts the exact preselected Token id and hash and one immutable server `AuditEvent` with action `auth.admin-recovery.issue`, system operator actor, target User subject, Token resource id, request id, expiry, and redacted succeeded outcome. That transaction contains no plaintext or path. Commit completes before the database closes and the data-root lock releases.
- A crash after file publication but before SQLite commit leaves an inactive credential envelope. An exact retry names the same output path and repeats the same owner, expiry, and confirmation; it validates the complete envelope, requires its expiry still to be future, recomputes its Token hash, proves the Token and AuditEvent absent, and commits them without generating new material. A crash after SQLite commit leaves a valid envelope and active Token; the same-path retry verifies the file, Token, hash, owner, expiry, generated request, and AuditEvent and returns the completed redacted summary.
- A Token row without the exact attempted output file, a file whose fields or secret hash contradict Core or the repeated command inputs, a mismatched or missing AuditEvent after Token commit, an occupied non-regular or linked output path, an inactive envelope whose expiry is no longer future, or any other unprovable half-state returns `recovery_required` without overwrite, deletion, revocation, repair, or credential disclosure. If a previously completed credential file is later lost, the operator may issue another Token only through a different absent output path, which generates a new request id.
- The operator command result contains only `tokenId`, `ownerUserId`, `expiresAt`, `auditEventId`, and `status` with value `completed`; it contains no token, path, hash, email, or display name. User discovery output and the final command summary are the only stdout JSON for their respective commands.

### Transport requirements

- NanoCore MUST refuse bearer-token authentication over plaintext HTTP on non-loopback interfaces. Server mode MUST present TLS — either natively or via a fronting proxy that the deployment declares — before tokens are accepted on non-loopback addresses.
- Loopback interfaces continue to accept tokens over plaintext HTTP for local development and desktop-embedded operation.
- The refusal MUST be a typed startup or request error naming the transport requirement, not a silent downgrade or a warning-only acceptance.

### Rotation and revocation

- Rotation MUST be overlap-based: rotating a token issues a new token (returned once), marks the old token `rotated` with a grace expiry (default 24 hours, configurable down to zero), and records rotation lineage on both records. During grace, the old token still authenticates; after grace it behaves as expired.
- Revocation MUST take effect immediately at the auth layer: the next verification of a revoked token fails. There is no revocation grace.
- `AuthSession` records and `Token` records MUST be revocable independently. Revoking a user's sessions MUST NOT revoke their tokens, and vice versa; an owner-initiated "revoke all credentials" action is a composite of both.
- A rotated or revoked token MUST NOT be reactivatable; recovery is issuing a new token.
- `server-admin` authority MUST be able to list, issue, rotate, and revoke Tokens through public App API routes; those routes are the only Token administration surface, and bundled CLI Token-administration operations MUST be facades over them. Issuance MAY name another exact active canonical `ownerUserId`; Workspace-scoped issuance MUST validate the target owner's active membership in every bound Workspace rather than the administrator's membership.
- NanoCore MAY derive deployment-admin authority for a Better Auth session from the active canonical User's currently usable owned `server-admin` Tokens. The session remains the authenticating credential and `kind=session`; a distinct non-secret derived-authority Token ID MAY be attached for attribution, MUST NOT be represented as a presented bearer `tokenId`, and MUST NOT update that Token's `last_used_*` fields.
- A User MAY own multiple `server-admin` Tokens and MAY select one usable owned Token as the attribution default. NanoCore stores only that non-secret Token ID, validates ownership, scope, and usability on every read, and otherwise deterministically selects a usable owned Token; the default pointer never creates authority, a sole usable Token is automatically effective, and a dangling or unusable pointer falls back or denies without repair. A Token rotated within its existing grace period remains usable under the same Token lifecycle rules.
- A durable human access-token row whose scope is outside the closed set above is not a historical read-model variant and MUST NOT be projected, authenticated, rewritten into a current scope, or retained behind a compatibility filter. The one accepted internal-development retirement is a one-way Core migration that deletes an exact `workspace-readwrite` row only when its durable status is already `revoked` and no surviving Token row names it as `predecessorTokenId`. The same transaction MUST append one redacted server-owned system `AuditEvent` for each retired Token, preserve every pre-existing audit row, delete the candidate, prove no unsupported scope remains, and publish the migration ledger entry. Any unproved lineage, audit-publication failure, non-revoked `workspace-readwrite` row, or other unsupported scope MUST roll back Token deletion, new audit rows, and ledger publication and block product startup without deleting, reissuing, rotating, or repairing a Token. A later retry is a new boot after explicit operator correction through a separately accepted recovery owner; normal boot invents no recovery authority.

## Accepted Design

Token verification is a NanoCore auth-middleware concern beside the existing Better Auth session resolution: the middleware extracts the bearer value, rejects non-`okt_` shapes early, hashes and looks up the token, checks status, expiry, rotation grace, transport class, and scope-to-route class, then attaches the actor context used by downstream policy enforcement and audit producers. The same socket-derived transport gate runs before the public bootstrap-consumption handler reads its request body. The last-used summary is updated after successful verification and remains a redacted read model.

Bootstrap is a pre-listen startup hook placed by the bootstrap-readiness spec after authoritative integrity verification and migrations succeed. On server-mode boot with zero users, NanoCore mints the bootstrap secret, stores its hash with a `bootstrap` marker distinct from the public scope set, and writes the secret once to the owner-readable file or explicitly secure operator destination defined above. A single public consumption endpoint accepts the bootstrap token and the owner profile payload and performs the atomic owner-creation transaction.

The client side ships a small credential-store helper used by the unified Skill's bundled CLI: resolve order is explicit ephemeral environment override, then OS keychain entry keyed by NanoCore endpoint URL, then any platform fallback explicitly permitted by the Agent Skill Interface, with a warning on degraded storage.

## Current Implementation Projection

The NanoCore token, bootstrap, authorization, audit, `@openkit/core-client`, and bundled CLI credential substrate is implemented. Generic token creation and rotation remain intentionally excluded from the Agent Skill Interface until a safe named destination exists. The stopped-server administrator-recovery contract above is accepted but not yet implemented, so this spec remains Partial.

- The bundled CLI reads `OPENKIT_NANOCORE_URL`, resolves `OPENKIT_NANOCORE_TOKEN` first, an endpoint-scoped OS keychain token second, and an encrypted fallback file third, maps the token to `Authorization: Bearer <token>`, and exposes `bootstrap.consume`, `credential.store`, and `credential.delete`. Linux and Windows writes use stdin-backed platform credential commands; macOS reads existing Keychain entries but writes new credentials to the encrypted fallback because the built-in writer would expose the secret in argv. Bootstrap consumption preflights credential storage, never returns the minted token in its result envelope, and reports `credential_storage_failed` if the one-time token was consumed but its returned credential could not be stored. The old raw `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` passthrough variables remain removed without aliases.
- Server mode uses Better Auth for session authentication; `apps/nanocore/src/auth/middleware.ts` attaches actor context and enforces server-mode auth for protected APIs. Token verification lands beside it in the same middleware layer.
- Local mode resolves the implicit local user via `LOCAL_USER_ID`; this spec does not change that path.
- NanoCore implements `okt_` opaque secret generation with at least 256 bits of entropy, versioned SHA-256 token hashing, constant-time verification, closed v1 scope-shape validation, active / expired / revoked / rotated usability checks, durable server-scope `openkit_access_tokens` records, and server-mode bearer verification in `apps/nanocore/src/auth/middleware.ts`. Current token records are owned by a human `User`; no `AutomationIdentity` token owner or membership path is implemented. Protected routes resolve token actors without exposing token material, and NanoCore refuses bearer tokens over non-loopback plaintext HTTP before verification.
- NanoCore exposes `GET /api/app/auth/tokens`, `POST /api/app/auth/tokens`, `POST /api/app/auth/tokens/:tokenId/revoke`, and `POST /api/app/auth/tokens/:tokenId/rotate`; presented `server-admin` token actors and session actors with Token-derived deployment-admin authority can administer Tokens, list/revoke/rotate responses expose only redacted records, and create/rotate return plaintext once. Canonical-session-only self-service routes expose the signed-in User's redacted `server-admin` Token metadata and effective default ID and accept an owned usable default selection; they never expose a hash or plaintext. `@openkit/core-client` exposes the same routes, while the bundled CLI exposes `token.list` and `token.revoke` and machine-checks create/rotate as explicit exclusions until a safe named destination exists. Successful CLI-authenticated requests send stable `openkit-cli` / `agent-skill` channel metadata for the redacted last-used summary.
- The closed-scope write and response schemas and the one-way Core migration are implemented. The migration removes only exact unreferenced revoked `workspace-readwrite` history, appends one redacted server system audit event per removal, rejects every other unsupported durable scope, and publishes its ledger entry in the same transaction; the token-list route and exact presented-secret authentication remain unchanged.
- Better Auth session actors and every bearer-token actor, including `server-admin`, require active membership for workspace-addressed requests; a missing membership verifier fails closed, workspace-scoped tokens additionally enforce route-level workspace bindings, and workspace-readonly tokens reject mutating methods with non-echoing `core.auth.scope_forbidden` failures. Server-mode first boot issues a distinct one-time bootstrap token when the OpenKit `users` table is empty, writes the plaintext only to an owner-readable data-root emission file, and exposes `POST /api/app/auth/bootstrap/consume` as the public one-shot route that atomically creates the owner `User` and returns the first `server-admin` access token once.
- Successful bootstrap consumption, access-token issuance, token revocation, and token rotation now emit server-owned general `AuditEvent` rows through the existing audit recorder. The rows use stable token lifecycle action names and redacted token ids, scopes, owners, and authenticated actor ids when present; they do not store bootstrap token values, plaintext `okt_` secrets, token hashes, keychain material, fallback encrypted-file contents, or authorization headers.
- Token records target the server-scope database in the layout owned by `docs/specs/20260703-storage_layout_record_ownership.md`.
- Current middleware preserves deployment administration while keeping Token-derived session authority distinct from the authenticating credential and requiring the active session User to pass the same Workspace membership and policy checks as every other session actor before accessing Workspace content.

## Alternatives Considered

- JWT or other stateless self-verifying tokens. Rejected: immediate revocation requires a server-side denylist anyway, which erases the statelessness benefit; opaque server-checked tokens are simpler, keep no claims to version, and match the single-NanoCore deployment shape. Revocation and simplicity win.
- OAuth 2.0 device authorization flow for desktop pairing. Deferred: it is the right long-term UX for pairing an AI application with a remote NanoCore, but it needs a browser surface, client registration, and consent UI that do not exist yet. The token contract here is the substrate a device flow would mint into.
- Keeping the raw cookie/authorization env-var passthrough beside tokens. Rejected under the internal development compatibility rule: two parallel channel-auth contracts guarantee drift, and the passthrough has no scoping, rotation, or audit identity.
- Better Auth API-key plugin as the token implementation. Not rejected as an implementation choice — it MAY satisfy this contract — but the contract is owned here in OpenKit terms so the provider remains swappable, consistent with the Better Auth posture in the config identity contract.
- mTLS client certificates for channel auth. Rejected for v1: certificate provisioning and renewal on end-user desktops is heavier than the problem requires; TLS remains a transport requirement, not an identity mechanism.

## Consequences

- A fresh remote deployment becomes self-service: boot, read the bootstrap token once, consume it, issue scoped tokens.
- The end-user Agent Skill Interface gains a revocable, scoped, auditable credential, and CLI-originated operations gain a real actor identity in audit labels.
- The raw header passthrough remains absent; the bundled CLI reuses the implemented token substrate without a compatibility path for the removed MCP channel.
- NanoCore takes on hash-verification on every token-authenticated request and a small token administration API surface.
- Client tooling reuses secret-safe platform credential commands where available and otherwise uses the encrypted-file fallback; this contract adds no keychain dependency.

## Rollout / Migration Plan

This is new machinery plus one same-change removal, not a compatibility migration:

1. Token record, hashing, verification middleware, scope checks, and transport refusal land together in NanoCore, with token administration routes behind `server-admin`.
2. Server-mode bootstrap ceremony lands next, gated on the zero-user condition.
3. The former MCP server switched to `OPENKIT_NANOCORE_TOKEN` and deleted the cookie/authorization passthrough before the user-facing MCP package was removed.
4. The client credential-store helper reads OS keychain entries first and encrypted fallback files second. Linux and Windows setup writes use stdin-backed keychain commands; macOS setup uses encrypted fallback until a safe non-argv keychain writer is available, without adding a dependency solely for that write.
5. The bundled CLI adopted the credential-store and bootstrap contracts, added secret-safe direct storage for one-time token material, and replaced the former MCP credential path without a compatibility surface.
6. One Core migration deletes only unreferenced revoked rows with the exact retired `workspace-readwrite` scope, appends one redacted server system audit event per deletion, then proves no unsupported scope remains before publishing its migration id. The migration transaction rolls back on surviving rotation lineage, audit failure, any non-revoked retired row, or any unknown scope; the App API schema and list query gain no legacy branch.
7. The stopped-server operator commands reuse the existing data-root lock, active User query, Token creator, Audit recorder, and CLI credential store. They add no public recovery API, database table, password flow, bootstrap branch, or compatibility reader.

Fresh dogfooding deployments authenticate by consuming the one-time bootstrap token. Existing data roots whose active canonical User owns a usable `server-admin` Token require no migration for Token-derived session administration. If no usable administrator credential remains, the operator uses the stopped-server procedure above; this does not allow a Better Auth session without owned usable Token authority to elevate through Token-administration routes.

## Testing Strategy / Acceptance Criteria

Mapped to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: repository checks that no plaintext `okt_` secret appears in committed files, examples, or fixtures other than clearly fake documented placeholders; schema-drift checks for the `Token` record shape.
- L1: unit tests for secret generation entropy and prefix shape, hash-and-lookup verification, status transitions (`active` to `expired`/`revoked`/`rotated`), rotation-grace math, scope-to-route gating, bootstrap single-consumption logic, and credential-store resolve order including fallback warning emission, encrypted fallback non-plaintext storage, and stdin-backed Linux/Windows keychain writes with secret-free argv.
- L1: Core migration tests seed one current Token plus unreferenced revoked `workspace-readwrite` history and prove only the retired row is removed, one redacted retirement audit is appended, every pre-existing audit row and every column of the current Token including hash and lineage is unchanged, the migration id is published once, a second boot is idempotent, and the migrated list route returns the current record through the unchanged closed response schema. Separate surviving-lineage, non-revoked-retired, unknown-scope, and audit-publication-failure cases MUST leave every Token row, audit row, and migration-ledger row unchanged.
- L2: contract tests binding the auth middleware to the actor-context shape: token-authenticated requests produce actor context with identity, token id, and channel; audit label producers receive it; verification failures are uniform and non-echoing; tokens in query strings, bodies, and cookies are rejected.
- L3: NanoCore black-box tests cover fresh server-mode bootstrap, single consumption, scoped-token isolation, revocation, rotation, and plaintext transport refusal; bundled CLI black-box coverage must authenticate end to end through supported credential resolution.
- L3: stopped-server recovery tests hold one real temporary data-root lock across the command, prove a concurrent NanoCore lock acquisition fails without service startup, reject missing or mismatched confirmation, reject current, past, and over-24-hour expiry while accepting the exact 24-hour boundary, cover generated request identity, same-output file-before-database and database-after-file crash boundaries, every contradictory or expired-inactive half-state, `0600` exclusive output, redacted discovery and summaries, strict `credential.store` union consumption, and one authenticated request with the recovered Token.
- L4: not applicable until Web UI token administration screens exist.
- L5: packaged-build smoke that a server-mode boot on a clean data root produces exactly one owner-readable bootstrap emission after authoritative integrity and migration success but before listener admission, writes no credential to stdout or stderr, and lets the bundled CLI store and use the minted token without exposing it.
- L6: story acceptance covering an operator standing up a remote NanoCore, consuming the bootstrap token through the end-user Skill flow, connecting through the bundled CLI, issuing a workspace-scoped token, and revoking the token to confirm access ends.

Acceptance criteria: all L1-L3 behaviors pass deterministically; no agent-visible CLI path prints one-time or persistent token material; no bootstrap or recovery credential reaches stdout, stderr, ordinary logs, diagnostics, Audit, or artifacts; recovery never runs without holding one data-root lock for its complete command; the cookie/authorization passthrough and user-facing MCP package are absent; a revoked token fails on the request after revocation with no grace.

## Risks & Mitigations

- Risk: the bootstrap token leaks through operator process capture or an incorrectly protected delivery destination. Mitigation: prohibit stdout, stderr, and ordinary logs; require one owner-readable `0600` file or an explicitly secure destination; retain bounded expiry, single consumption, and leak-scanner matching.
- Risk: hash verification on every request becomes a hot-path cost. Mitigation: single indexed lookup with an asynchronous last-used update; the deployment shape is one NanoCore, not a token-verification fleet.
- Risk: keychain integration fails unevenly across platforms and users silently land on the encrypted fallback. Mitigation: the mandatory warning, plus `openkit doctor` diagnostics naming the storage backend in use without revealing material.
- Risk: scope checks get mistaken for the permission model and policy work stalls. Mitigation: the contract states scopes are authentication-layer gates; policy enforcement mapping remains a required downstream check, restated at every check site.
- Risk: TLS refusal blocks legitimate proxy deployments that terminate TLS upstream. Mitigation: the deployment-declared fronting-proxy posture is an explicit configuration, not an inference, so operators state their transport intent.
- Risk: NanoCore starts after a recovery preflight and races the operator's write. Mitigation: the operator holds the existing data-root exclusive lock from before database open through file durability, transaction commit, database close, and command completion.
- Risk: a crash leaves the only plaintext credential on one side of the file/SQLite boundary. Mitigation: publish the `0600` envelope first, bind deterministic Token facts, resume only an exact file-before-database state, and return `recovery_required` for every contradiction rather than overwriting or deleting material.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the encrypted fallback file uses a machine-scoped key when no secret-safe OS credential writer is available; `workspace` tokens bind to an explicit Workspace list only, and wildcard Workspace binding is deferred until its audit and revocation semantics are designed.

## Deferred / Future Work

- OAuth-style device-flow pairing so a Skill-capable AI application can acquire a token through a browser consent step instead of manual issuance.
- Dedicated `AutomationIdentity` token issuance, responsible-user binding, administration, and Workspace-membership rules after a separate owning specification is accepted.
- Fine-grained token scopes (per-capability, per-thread, time-boxed step tokens) beyond the closed v1 set.
- Web UI token administration surfaces projecting the token read models.

## Links

- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/core/audit.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260529-test_strategy.md`
