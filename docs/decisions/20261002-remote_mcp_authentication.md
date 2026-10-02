---
status: Accepted
date: "2026-10-02"
decider: Engineer, on the coordinator's recommendation
---
# Remote MCP Authentication

## Decision

The engineer ruled on 2026-10-02 on how users authenticate to NanoCore's remote MCP endpoint.

1. The first remote MCP release authenticates only with a static bearer. The credential is an ordinary existing human remote-access Token, issued by the administrator through the existing administrator-only issuance and placed by the user in the client's header configuration. No refresh token is issued. Token listing and revocation stay with the administrator; no self-service connection management is added in this release.
2. Browser OAuth is written into the owning specification as accepted design and is not implemented now. The design is the authorization code grant with PKCE S256, client identity through Client ID Metadata Documents, consent backed by the existing OpenKit login, and an ordinary Token bound to the MCP resource with a configurable default lifetime after which the user authorizes again through the browser, so that both connection methods end in the same Token, verifier and authorization.
3. Dynamic Client Registration, rotating refresh tokens, and an external identity provider are not designed, together with SSO, OIDC ID tokens, userinfo, JWKS, device flow, the client-credentials grant, remembered consent and an RFC 7009 revocation endpoint.

[Remote Auth Credential Bootstrap](../specs/20260704-remote_auth_credential_bootstrap.md) owns the credential lifecycle and the accepted OAuth design. [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md) owns the endpoint and its authentication admission.

## Reason

Translated from Chinese. The engineer: "Write the browser OAuth design into the specification, but do not implement it now. I agree with all three items you suggested removing. For now we only do static tokens and do not issue refresh tokens. Static tokens are issued by the administrator."

The three removals follow the coordinator's draft, which the engineer accepted. Dynamic Client Registration is deprecated in the current MCP authorization revision and adds a public registration endpoint, persisted client records and an abuse surface, while every client that needs it already supports a static header. Rotating refresh tokens add a durable lifecycle of refresh families, single-use rotation, replay invalidation and lost-response handling, while an opaque Token is already revocable on the next request. No current requirement asks for organization SSO or an external identity provider. The accepted draft deliberately declines MCP's recommendation for short-lived access tokens in favor of a configurable default lifetime and browser reconnection, because opaque Tokens remain revocable on the next request.

The engineer did not state a separate reason for deferring the OAuth implementation. The coordinator notes that the static bearer path reuses what exists: the saved prototype already connected Claude Code and Codex with an ordinary Token, and every named coding client accepts a header.

Consequence accepted with the ruling: until browser OAuth is implemented, a client without per-user static headers, such as claude.ai or Claude Desktop custom connectors, cannot connect as an individual user, and every user's connection depends on the administrator issuing a Token. Not issuing refresh tokens means an expired Token is replaced by the administrator.

Source: change record 202610020440000000-interface_unification, `temp/interface-unification/engineer-r7.md`, draft `temp/interface-unification/remote-mcp-auth-d1.md`.

## Rejected Alternatives

- Browser OAuth implemented in the first release. Deferred by the engineer; the design is kept as accepted.
- Dynamic Client Registration as a fallback for clients without Client ID Metadata Document support. Rejected; those clients use the static bearer.
- Rotating refresh tokens for saved connections. Rejected; the Token's configured lifetime applies.
- An external identity provider as authorization server, or upstream login federation. Rejected; no SSO requirement exists.
- Self-service Token issuance by ordinary users. Rejected; static Tokens are issued by the administrator.

## Revisit When

- A teammate needs to connect from a hosted or desktop client that has no per-user static header, which is the trigger to implement the accepted browser OAuth design.
- A user needs URL-only OAuth from a client that lacks Client ID Metadata Document support, which reopens Dynamic Client Registration.
- Reconnect frequency becomes a user complaint, or a security requirement asks for short-lived access tokens, which reopens refresh tokens.
- Independent agent identities are designed, which may give an external agent its own credential.

## Affected Owners

- docs/specs/20261002-remote_mcp_interface.md
- docs/specs/20260704-remote_auth_credential_bootstrap.md
- docs/specs/20260713-openkit_agent_skill_interface.md
- docs/specs/20261002-operation_definition.md
