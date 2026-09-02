# Authentication And Authorization

This directory owns NanoCore authentication middleware, Better Auth browser sessions, actor resolution, server access-token authentication, bootstrap credential flow, and request-scope authorization helpers.

## Boundaries

- Browser and product requests use Better Auth session cookies; remote requests from the unified Skill's bundled CLI, other non-browser clients, and administration clients use explicit `okt_` bearer credentials.
- Authentication establishes the actor; workspace membership and token scope still require authorization before any workspace database, store, or mutation is opened.
- Global administration routes require the documented deployment-admin capability and must not be reachable merely because a browser session is valid.
- Server startup must supply a deployment-specific `BETTER_AUTH_SECRET` with at least 32 characters; the local development fallback is never valid for server mode.
- Better Auth public URL, trusted browser origins, and sign-up policy come from the startup `server.jsonc` snapshot, with explicit Better Auth environment variables taking precedence.
- Browser requests with an `Origin` header must match the exact startup allowlist before route work begins; requests without `Origin` remain valid for non-browser clients.
- Remote bearer requests and bootstrap-token consumption must use an actually encrypted Node transport; only a real loopback peer may use plaintext, and request URL or Host text never substitutes for socket state.
- Missing, removed, inactive, or cross-user membership must fail closed before resource existence is revealed.
- Tokens, cookies, password material, OAuth material, and full unique credential identifiers must never enter logs, diagnostics, events, or test output.
- NanoHost transport Tokens reuse the same `okt_` create/hash/verify primitives as human access tokens, but they are a separate Core Token class with closed type and scope `nanohost-transport`. Product App API paths and `server-admin` actor installation MUST reject presented `nanohost-transport` material. Human `OpenKitAccessTokenScope` and `openkit_access_tokens` are not extended.
- NanoHost transport session authority is process-local connection-generation fencing for one configured NanoHost identity: at most one authoritative generation, descending and replayed generations rejected, successor work blocked until the predecessor is fenced, and non-loopback TLS policy consumed by the dedicated native HTTP/2 listener in `index.ts`. Production admission in `nanohost-transport-admission.ts` verifies the dedicated `nanohost-transport` Token and completes a configured-slot rotation only after the successor wins. It reuses the `nanohost-transport` Token class and does not invent a second token table, secret prefix, or actor path.
- NanoHost transport lifecycle helpers in `nanohost-transport-lifecycle.ts` compose store, named-slot clear, and session authority for rotation cutover/abort (exactly one usable slot at steady state), revoke/expiry/decommission fencing of live authoritative work, and truthful restart re-admit (process-local authority resets; durable Tokens require re-admit). Live Runtime Epoch/AgentSession topology remains WP-6.

## File Map

- `middleware.ts` owns actor authentication and request variables, including fail-closed rejection of `nanohost-transport` on product App API paths.
- `better-auth.ts` and `server-flow.ts` own browser authentication and server-mode flows.
- `access-token.ts` / `access-token-store.ts` / `access-token-routes.ts` own human bearer credential lifecycle and validation.
- `admin-recovery.ts` owns the stopped-server active-User discovery and file-first administrator credential recovery command while reusing the existing data-root lock, Token store, and Audit owner.
- `nanohost-transport-token.ts` / `nanohost-transport-token-store.ts` / `nanohost-transport-routes.ts` own the dedicated NanoHost transport Token class, hash-only Core store, server-admin enrollment/lifecycle routes, and the configured RuntimeTarget readiness observation. Enrollment inserts only a lineage-free configured identity or reactivates the exact retained decommissioned identity/deployment pair with one fresh Token; retained Token history without its identity row and every active, missing, duplicate, or cross-bound lineage fail closed.
- `nanohost-transport-sink.ts` owns NanoCore-side safe-sink delivery to the configured A/B credential files (raw `okt_` + companion metadata at mode `0600`), including direct rejection of relative, aliased, or symlinked targets. Enrollment exclusively creates one empty slot without overwrite and conditionally clears only the exact attempted Token after a later transaction failure; issue and opposite-slot rotation explicitly replace their named slot without exposing raw `okt_`; unconditional slot clear remains limited to cutover, abort, and decommission cleanup.
- `nanohost-transport-session.ts` owns process-local NanoHost transport session authority (connection-generation admission, predecessor fencing, `mayCarryWork`, authoritative fence, pending-successor discard) and resolves the configured dedicated listener with its non-loopback TLS requirement. `createApp` installs the store; `index.ts` starts that listener separately from the App HTTP/1.1 listener.
- `nanohost-transport-admission.ts` owns the production NanoHost→NanoCore admission path: hash-only `verifyNanoHostTransportTokenRecord`, session `admit` / `fencePredecessor` / `mayCarryWork`, and HTTP admit/fence routes under `/api/nanohost/transport/session/*` that verify `nanohost-transport` Tokens themselves (not product App API actor paths).
- `nanohost-transport-lifecycle.ts` owns focused rotation cutover/abort, revoke/expiry/decommission fencing, and restart-readmit composition over store + sink + session authority.
- `bootstrap.ts` owns the one-time server owner bootstrap path.
- `actor-store-manager.ts` owns actor-scoped store selection.

## Verification

Run authentication middleware, server flow, access-token, bootstrap, administrator-recovery, membership, and Server route tests relevant to the change, followed by NanoCore typecheck, lint, and build. Administrator-recovery tests use only temporary data roots and process-local lock probes; they must not start, stop, or restart NanoCore. Server-mode tests must cover unauthenticated, wrong-scope, removed-membership, read-only, and server-admin cases where applicable.

## Related Design

- [Remote Auth Credential Bootstrap](../../../../docs/specs/20260704-remote_auth_credential_bootstrap.md)
- [NanoHost Runtime And Transport](../../../../docs/specs/20260802-nanohost_runtime_and_transport.md)
- [Architecture](../../../../docs/core/architecture.md)
