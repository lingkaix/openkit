# Authentication And Authorization

This directory owns NanoCore authentication middleware, Better Auth browser sessions, actor resolution, server access-token authentication, bootstrap credential flow, and request-scope authorization helpers.

## Boundaries

- Browser and product requests use Better Auth session cookies; remote, MCP, and administration requests use explicit `okt_` bearer credentials.
- Authentication establishes the actor; workspace membership and token scope still require authorization before any workspace database, store, or mutation is opened.
- Global administration routes require the documented deployment-admin capability and must not be reachable merely because a browser session is valid.
- Server startup must supply a deployment-specific `BETTER_AUTH_SECRET` with at least 32 characters; the local development fallback is never valid for server mode.
- Better Auth public URL, trusted browser origins, and sign-up policy come from the startup `server.jsonc` snapshot, with explicit Better Auth environment variables taking precedence.
- Browser requests with an `Origin` header must match the exact startup allowlist before route work begins; requests without `Origin` remain valid for non-browser clients.
- Remote bearer requests and bootstrap-token consumption must use an actually encrypted Node transport; only a real loopback peer may use plaintext, and request URL or Host text never substitutes for socket state.
- Missing, removed, inactive, or cross-user membership must fail closed before resource existence is revealed.
- Tokens, cookies, password material, OAuth material, and full unique credential identifiers must never enter logs, diagnostics, events, or test output.

## File Map

- `middleware.ts` owns actor authentication and request variables.
- `better-auth.ts` and `server-flow.ts` own browser authentication and server-mode flows.
- `access-tokens.ts` and `access-token-auth.ts` own bearer credential lifecycle and validation.
- `bootstrap.ts` owns the one-time server owner bootstrap path.
- `actor-store-manager.ts` owns actor-scoped store selection.

## Verification

Run authentication middleware, server flow, access-token, bootstrap, membership, and Server route tests relevant to the change, followed by NanoCore typecheck, lint, and build. Server-mode tests must cover unauthenticated, wrong-scope, removed-membership, read-only, and server-admin cases where applicable.

## Related Design

- [Remote Auth Credential Bootstrap](../../../../docs/specs/20260704-remote_auth_credential_bootstrap.md)
- [Architecture](../../../../docs/core/architecture.md)
