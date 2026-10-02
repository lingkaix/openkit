---
status: Accepted
implementation: Implemented
kind: boundary
date: "2026-10-02"
updated: "2026-10-02"
---
# Remote MCP Interface

## Owns

- The remote MCP endpoint on the configured public origin, its Streamable HTTP posture, and static-bearer admission.
- Whether any Model Context Protocol (MCP) transport session is authoritative for OpenKit.
- The request actor for an admitted call, and the channel recorded in the Token's last-used summary and in audit.
- Which failures are protocol errors and which product refusals are tool results.
- The acceptance predicates for that admission.

Where a rule below names another owner, that owner keeps the rule. This specification states only how the endpoint admits a request and dispatches it.

## Does Not Own

- The `search`, `describe`, `guide`, and `call` tool surface, secret-returning exclusion, and invocation. [Operation Definition](20261002-operation_definition.md) owns that projection. This specification does not restate it.
- Token format, kinds, issuance, expiration, revocation, the verifier, and indistinguishable authentication-failure bodies. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns them. The remote MCP static bearer is an ordinary Token of that family.
- The accepted browser OAuth design, including protected-resource metadata and the challenge pointer. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns that design. This specification states only where the endpoint serves it once it is implemented.
- Operation eligibility inside an owner that does not yet admit a bearer actor. That owner keeps the refusal. This specification says the endpoint returns the refusal.
- Worker MCP supply. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns it. This endpoint is not that supply.
- Retirement of the user-facing Skill stays with [OpenKit Agent Skill Interface](20260713-openkit_agent_skill_interface.md); ownership and relocation of the retained bundled CLI stay with [Agent Operator Skill](20260910-agent_operator_skill.md), and this specification performs neither transition.
- The configured public origin's authorship. [NanoCore Config And Identity Contract](20260628-nanocore_config_identity_contract.md) owns `server.publicBaseUrl`.
- Policy evaluation, private-audience semantics, and per-effect authority objects. Their owners keep them.

## Core References

- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/communication.md`

## Summary

NanoCore serves one remote MCP endpoint so a user's own agent client can call the same operations the user can call. The first release authenticates only with a static bearer. Browser OAuth is accepted design, is owned by Remote Auth, and is not implemented now.

## Goals / Non-goals

### Goals

- Admit a user's agent with an ordinary Token the administrator has already issued.
- Attribute the call to that Token's user, in the Token's last-used summary and in audit.
- Dispatch an admitted call through Operation Definition's invocation and return product refusals as tool results.
- Offer the projection's plain tools where a client does not yet support a newer MCP mechanism.

### Non-goals

- Do not implement browser OAuth, protected-resource metadata, or a refresh token in this release.
- Do not design Dynamic Client Registration, rotating refresh tokens, an external identity provider, SSO, OIDC ID tokens, userinfo, JWKS, device flow, the client-credentials grant, remembered consent, or an RFC 7009 revocation endpoint. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) records that cut.
- Do not add a second tool surface, a second authorizer, or an MCP session record.
- This endpoint adds no Token-administration API of its own; existing Token operations are projected through Operation Definition under Remote Auth's credential rules and Operation Definition's secret-returning exclusion.

## Background

Users connect their own agent clients to NanoCore over MCP. The interface-unification rulings require that endpoint, with a plain MCP call where a client does not yet support a newer mechanism such as loading Skills over MCP. The remote-MCP authentication ruling requires a static bearer for the first release and records browser OAuth as accepted design that is not implemented now. Those rulings are [Interface Unification](../decisions/20261002-interface_unification_rulings.md) and [Remote MCP Ships With A Static Bearer First](../decisions/20261002-remote_mcp_static_bearer_first.md).

## Decision

The endpoint is MCP over Streamable HTTP on the deployment's configured public origin. Its path is `/mcp`. The public URL is that origin plus this path. NanoCore must not derive the public URL from an arbitrary request Host or forwarded header.

No MCP transport session is authoritative. The session does not admit the caller, choose the actor, or retain a product effect. Product authority is Operation Definition's invocation and the durable records the effect owners already keep. This specification adds no session store.

The first release authenticates only with the static bearer defined below. The endpoint does not issue a refresh token.

## Contract / Expected Behavior

### Transport

NanoCore serves the endpoint on its App listener. The endpoint is not worker MCP supply and is not the NanoHost listener. Bearer transport follows [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md): non-loopback plaintext HTTP is refused, and loopback plaintext remains available under that owner's rule.

The transport is MCP Streamable HTTP. A client is not required to use Skills over MCP, progressive tool loading, or any MCP feature the plain `search`, `describe`, `guide`, and `call` tools do not need. The tool surface is the Remote MCP Projection in [Operation Definition](20261002-operation_definition.md). This endpoint does not define a second tool. Where a client does not support a newer MCP mechanism, the endpoint offers that projection's plain tools, and it adopts the standard mechanism once protocol, SDKs, and clients support it well.

An MCP transport session may exist for the protocol dialogue. It holds no OpenKit authority. If the session is missing, stale, or lost, including when NanoCore restarts, product records stay as they are. The client opens a new transport session. The endpoint does not replay or repair a product effect from session state.

### Static bearer admission

The credential is an ordinary human remote-access Token. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns its kinds, administrator-only issuance, expiration, revocation, and the rule that no refresh token is issued. The user places the Token in the client header configuration. Listing and revocation stay with the administrator.

The Token is accepted only from the `Authorization` header as a bearer. A query string, a request body, and a cookie are not credentials, even when the header is also present.

NanoCore checks the header with the existing verifier before any MCP dispatch. A missing credential and an unusable credential are the same authentication failure. NanoCore responds with HTTP 401 and a Bearer `WWW-Authenticate` challenge, and it does not run an MCP handler. The response body does not distinguish unknown, expired, revoked, and malformed credentials, and it does not echo the presented value. The challenge does not carry a failure reason. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns that body rule.

The first-release challenge does not carry a protected-resource metadata pointer. When the accepted browser OAuth design is implemented, this endpoint serves that metadata and the challenge gains the pointer. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns both. This specification does not define their fields.

A usable Token is not given a new audience check on this path. Audience binding belongs to the OAuth design's issuance, which is not implemented now. Retained Tokens stay usable under the existing verifier.

### Actor and attribution

The request actor is the human User who owns the presented Token. An external agent holding that Token acts as that User. The endpoint creates no second actor for the agent.

After successful verification, the Token's last-used summary records the channel `remote-mcp`. It may record the MCP client name supplied at initialization as the coarse source summary. It records no authorization header, no Token secret, and no full request. Audit of the request records the same User, the Token id, and the channel `remote-mcp`. `docs/core/audit.md` owns the audit record. The summary fields stay with [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md).

### Operation reach

An admitted request invokes the operation through [Operation Definition](20261002-operation_definition.md), with the actor above.

A credential limit stays in force. A `workspace-readonly` Token that calls a mutating operation receives the existing typed authorization refusal as a tool result. The protected effect does not run.

An operation that returns a one-time secret stays unreachable. [Operation Definition](20261002-operation_definition.md) owns that exclusion. This endpoint does not dispatch the operation. The refusal is a tool result.

When an operation's owner does not admit a bearer actor, the call returns that owner's typed refusal as a tool result. The endpoint does not substitute a session, change the actor, or hide the refusal. That refusal remains the result until the owner admits a bearer actor. A currently usable administrator bearer is admitted under the Administrator Eligibility rule in `docs/core/permissions.md`; ordinary users' bearer eligibility for session-only operations stays with each operation's owner.

### Protocol errors and product refusals

A missing or unusable credential is the authentication failure defined above. It is not a tool result.

A malformed MCP message, an unknown MCP method, or a protocol-version failure is a protocol error. It carries no product effect.

A request that has authenticated, and then fails a product rule, returns that failure as a tool result. Examples are a read-only Token calling a mutation, a secret-returning operation, and an owner that still refuses a bearer actor. That result is not HTTP 401, and it is not a transport close.

A client's own approval prompt is not an OpenKit decision. [Operation Definition](20261002-operation_definition.md) owns that rule.

## Proposed Design

The contract above is the design. The browser OAuth flow, its kept behaviors, and its cut list live in [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md). When browser OAuth is implemented, this endpoint applies Remote Auth's resource-server requirements, including resource and audience binding, protected-resource metadata, and the challenge pointer; the current static-bearer rule does not waive those requirements for OAuth-issued Tokens.

## Decision Classes

### Endpoint

The definition and its exclusions are Decision and Contract. The endpoint is Streamable HTTP at `/mcp` on the configured public origin. It excludes OAuth implementation in this release, a refresh token, an authoritative MCP session, worker MCP, and a second tool surface.

The endpoint is the authority for admission and for the channel it records. It is not the authority for the Token, the operation, or the product effect. No durable MCP session record exists, so none can compete with those owners.

Creation, update, termination, and retry of an MCP session record do not apply. The Token lifecycle stays with Remote Auth. A transport session that ends, including on restart, has no product recovery. The client opens a new transport session. Product retry and recovery stay with the effect owner.

A missing or unusable credential fails closed before MCP dispatch. A stale or restarted transport session changes no product record. A conflict between a caller argument and a bound value stays with invocation. A dependency failure of NanoCore or an effect owner stays that owner's outcome. This specification adds no repair.

The externally observable acceptance predicates are Testing Strategy / Acceptance Criteria.

## Current Implementation Projection

The App listener serves stateless Streamable HTTP at `/mcp` from `apps/nanocore/src/remote-mcp-routes.ts`, registered in `apps/nanocore/src/app.ts` behind the existing authentication middleware. Admission accepts only an `Authorization: Bearer` Token through the existing Token verifier, in both local and server mode. A missing or unusable credential, a query, body or cookie credential, a browser session, and implicit local authority receive HTTP 401 with `WWW-Authenticate: Bearer` and no MCP dispatch. Non-loopback plaintext is refused from the Node socket before verification. Successful verification records last-used channel and source `remote-mcp` before any caller channel or source header is read. The tools are `search`, `describe`, `guide`, and `call`, derived from the composed operation definition tables with no maintained operation list. `call` uses the native operation invocation with the presented Token actor, and product refusals are tool results. A definition whose output schema is the access-token issuance or rotation schema is refused before dispatch, and the bootstrap response schema is that issuance schema; a new secret-returning output contract must join that predicate before it joins the tables. Request audit is an existing server AuditEvent recording the Token user, the Token id, and `remote-mcp`, without tool arguments or results. The endpoint has no MCP session store, refresh token, protected-resource metadata, or browser OAuth route.

## Alternatives Considered

Rejected alternatives for authentication and for retiring the Skill before the endpoint covers it are recorded in [Remote MCP Ships With A Static Bearer First](../decisions/20261002-remote_mcp_static_bearer_first.md) and [Interface Unification](../decisions/20261002-interface_unification_rulings.md). This specification does not restate them.

## Consequences

- A client with a per-user static header can connect. A client that cannot place that header cannot connect until browser OAuth is implemented.
- An expired Token is replaced by the administrator. This endpoint does not refresh it.
- The former stdio MCP package is not revived as a compatibility alias for this endpoint.
- An administrator Token remains a deployment-wide credential under [Administrator Authority](../decisions/20261002-administrator_authority.md). A read-only Token stays read-only.

## Rollout / Migration Plan

The endpoint is new. It adds no compatibility reader, alias, or dual write for the deleted stdio MCP package. Retained Tokens stay usable under the existing verifier. No Token migration is required for this release.

## Testing Strategy / Acceptance Criteria

These predicates accept the endpoint. They do not accept the saved prototype.

- A request with no credential, and a request with an unknown, expired, revoked, or malformed credential, each receive HTTP 401, a Bearer `WWW-Authenticate` challenge, and no tool dispatch. The bodies do not reveal which failure occurred and do not echo the credential. The challenge carries no failure reason and no protected-resource metadata pointer.
- A Token presented only in the query string, the body, or a cookie is not accepted.
- A usable Token's call acts as that Token's user. The Token's last-used summary and the audit record name that user, that Token, and the channel `remote-mcp`.
- A `workspace-readonly` Token succeeds on a read the operation allows and is refused on a mutation before any protected effect. The refusal is a tool result.
- A secret-returning operation is not dispatched. The refusal is a tool result.
- An operation whose owner refuses a bearer actor returns that owner's typed refusal as a tool result. The actor is unchanged.
- The tools are the Operation Definition projection's `search`, `describe`, `guide`, and `call`, and the endpoint adds no further product tool.
- No success response issues a refresh token. Protected-resource metadata is absent.

## Risks & Mitigations

- Risk: an administrator Token on this endpoint can perform every operation that credential may perform. Mitigation: the accepted consequence in [Administrator Authority](../decisions/20261002-administrator_authority.md) stands. Revocation, expiry, and read-only issuance stay in force. This endpoint does not widen a credential.
- Risk: a hosted client without a per-user static header cannot connect. Mitigation: that limit is the accepted first release. Browser OAuth remains the accepted, unimplemented design in Remote Auth.

## Open Questions

None.

## Deferred / Future Work

Implementation of the accepted browser OAuth design is not this release. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns that design and the cut list. When browser OAuth is implemented, this endpoint applies Remote Auth's resource-server requirements, including resource and audience binding, protected-resource metadata, and the challenge pointer; the current static-bearer rule does not waive those requirements for OAuth-issued Tokens.

## Links

Peers are listed in Related Docs.

## Related Docs

- [Remote MCP Ships With A Static Bearer First](../decisions/20261002-remote_mcp_static_bearer_first.md)
- [Interface Unification](../decisions/20261002-interface_unification_rulings.md)
- [Administrator Authority](../decisions/20261002-administrator_authority.md)
- [Operation Definition](20261002-operation_definition.md)
- [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md)
- [OpenKit Agent Skill Interface](20260713-openkit_agent_skill_interface.md)
- [NanoCore Config And Identity Contract](20260628-nanocore_config_identity_contract.md)
- [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md)
