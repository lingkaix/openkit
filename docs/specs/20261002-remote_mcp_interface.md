---
status: Accepted
implementation: Implemented
kind: boundary
aspect: communication
---
# Remote MCP Interface

This specification owns how NanoCore admits a remote MCP call and dispatches it. Agent-facing IDs and model spellings follow [Operation Definition](20261002-operation_definition.md#names), including its compatibility details and limits. This document owns admission and execution, not a second naming rule.

## Scope

This specification owns the remote MCP endpoint on the configured public origin, its Streamable HTTP posture, and static-bearer admission. It owns whether any MCP transport session is authoritative, the request actor, the recorded channel, which failures are protocol errors, and which product refusals are tool results.

Does not own:

- Tool projection, exclusions and invocation are owned by Operation Definition.
- Token format, issuance, expiration, revocation, browser OAuth, protected-resource metadata, and the challenge pointer. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns them. The static bearer is an ordinary Token of that family.
- Bearer eligibility inside an operation owner, Worker MCP supply, and policy evaluation. [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns Worker supply. Each owner keeps its refusal.
- Release composition and the operations package. [Release Management](20260829-release_management.md) and [Agent Operator Skill](20260910-agent_operator_skill.md) own them.
- The configured public origin. [NanoCore Config And Identity Contract](20260628-nanocore_config_identity_contract.md) owns `server.publicBaseUrl`.

Core: [`docs/core/identity.md`](../core/identity.md), [`docs/core/policy.md`](../core/policy.md), [`docs/core/evidence.md`](../core/evidence.md), [`docs/core/communication.md`](../core/communication.md).

## Contract / Expected Behavior
### Transport

NanoCore serves the endpoint on its App listener. The endpoint is not worker MCP supply and is not the NanoHost listener. The public endpoint URL is the configured public origin plus /mcp. NanoCore MUST NOT derive it from an arbitrary request Host or forwarded header. Bearer transport follows [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md): non-loopback plaintext HTTP is refused with HTTP 400, and loopback plaintext remains available under that owner's rule.

The transport is MCP Streamable HTTP. The endpoint exposes the single Operation Definition Remote MCP Projection; clients need no installed Skill, extension or other remote product tool surface. Initialization carries short Skill discovery guidance.

The endpoint serves `2026-07-28` beside `2025-11-25`. Modern requests use the official SDK's per-request protocol binding; legacy requests retain stateless Streamable HTTP. Both revisions use the same projection and existing bearer admission.

The endpoint changes to a new MCP form as soon as Claude Code, Codex, and the Grok assistant's custom MCP connectors all support that technique by default. A released protocol revision that the official SDK negotiates beside the older one needs no such wait, because no existing client loses anything ([decision](../decisions/20261101-mcp_standard_adoption_policy.md)).

An MCP transport session may exist for the protocol dialogue. It holds no OpenKit authority. If the session is missing, stale, or lost, including when NanoCore restarts, product records stay as they are. The client opens a new transport session. The endpoint does not replay or repair a product effect from session state.

### Static bearer admission

The credential is an ordinary human remote-access Token. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns its kinds, administrator-only issuance, expiration, revocation, and the rule that no refresh token is issued. The user places the Token in the client header configuration. Listing and revocation stay with the administrator.

The Token is accepted only from the `Authorization` header as a bearer. A query string, a request body, and a cookie are not credentials, even when the header is also present.

NanoCore checks the header with the existing verifier before any MCP dispatch. A missing credential and an unusable credential are the same authentication failure. NanoCore responds with HTTP 401 and a Bearer `WWW-Authenticate` challenge, and it does not run an MCP handler. The response body does not distinguish unknown, expired, revoked, and malformed credentials, and it does not echo the presented value. The challenge does not carry a failure reason. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns that body rule.

The first-release challenge does not carry a protected-resource metadata pointer. When the accepted browser OAuth design is implemented, this endpoint serves that metadata and the challenge gains the pointer. It then applies Remote Auth's resource-server requirements, including resource and audience binding. The static-bearer rule does not waive those requirements for an OAuth-issued Token. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns both. This specification does not define their fields.

A usable Token is not given a new audience check on this path. Audience binding belongs to the OAuth design's issuance, which is not implemented now. Retained Tokens stay usable under the existing verifier.

### Actor and attribution

The request actor is the human User who owns the presented Token. An external agent holding that Token acts as that User. The endpoint creates no second actor for the agent.

After successful verification, the Token's last-used summary records the channel `remote-mcp`. It may record the MCP client name supplied at initialization as the coarse source summary. It records no authorization header, no Token secret, and no full request. Audit of the request records the same User, the Token id, and the channel `remote-mcp`. The request AuditEvent contains no tool arguments or results. `docs/core/evidence.md` owns the audit record. The summary fields stay with [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md).

### Operation reach

An admitted request invokes the operation through [Operation Definition](20261002-operation_definition.md), with the actor above.

Remote MCP is a model-facing delivery channel and applies the restricted-Material preflight owned by [Work Resource Interaction Model](20260713-work_resource_interaction_model.md#public-material-read-models) before content invocation; authenticating as the Token's human owner does not convert the delivery into a human-facing App API read. The owner's refusal is a `sensitive_content` tool result with semantic status 409. It is not HTTP 401. The rationale is recorded in [a decision record](../decisions/20261003-restricted_material_channel_boundary.md).

A credential limit stays in force. A `workspace-readonly` Token that calls a mutating operation receives the existing typed authorization refusal as a tool result. The protected effect does not run.

An operation that returns a one-time secret stays unreachable. [Operation Definition](20261002-operation_definition.md) owns that exclusion. This endpoint does not dispatch the operation. The refusal is a tool result.

When an operation's owner does not admit a bearer actor, the call returns that owner's typed refusal as a tool result. The endpoint does not substitute a session, change the actor, or hide the refusal. That refusal remains the result until the owner admits a bearer actor. A currently usable administrator bearer is admitted under the Administrator Eligibility rule in `docs/core/policy.md`; ordinary users' bearer eligibility for session-only operations stays with each operation's owner. A definition whose credential set is only `local-user` or `user-session` is not eligible. The refusal is the tool result `mcp_person_only_operation`. This exclusion does not widen bearer eligibility. [Operation Definition](20261002-operation_definition.md) owns search limits, including query length, result count, `total`, and `hasMore`. This specification does not copy that schema.

### Protocol errors and product refusals

If exposure is disabled at HTTP entry, the endpoint returns HTTP 403 `route_group_unavailable` and records denied audit. Exposure is rechecked before discovery, call, and native entry; disablement caught during a tool call returns the corresponding MCP tool error before the protected invocation. [Runtime Security](20261109-runtime_security.md) owns that switch. A disabled endpoint is not an ordinary protocol failure.

A missing or unusable credential is the authentication failure defined above. It is not a tool result.

A malformed MCP message, an unknown MCP method, or a protocol-version failure is a protocol error. It carries no product effect. A mutating call while boot readiness is not accepting product work returns the tool result `product_work_unavailable` before invocation.

A request that has authenticated, and then fails a product rule, returns that failure as a tool result. Classified operation failures follow the shared error rule in [Operation Definition](20261002-operation_definition.md#invocation); authentication and MCP protocol failures retain this transport boundary. Examples are a read-only Token calling a mutation, a secret-returning operation, and an owner that still refuses a bearer actor. That result is not HTTP 401, and it is not a transport close.

A client's own approval prompt is not an OpenKit decision. [Operation Definition](20261002-operation_definition.md) owns that rule.

## Decision Classes
### Endpoint

The definition and its exclusions are Decision and Contract. The endpoint is Streamable HTTP at `/mcp` on the configured public origin. It excludes OAuth implementation in this release, a refresh token, an authoritative MCP session, worker MCP, and a second tool surface.

The endpoint is the authority for admission and for the channel it records. It is not the authority for the Token, the operation, or the product effect. No durable MCP session record exists, so none can compete with those owners.

Creation, update, termination, and retry of an MCP session record do not apply. The Token lifecycle stays with Remote Auth. A transport session that ends, including on restart, has no product recovery. The client opens a new transport session. Product retry and recovery stay with the effect owner.

A missing or unusable credential fails closed before MCP dispatch. A stale or restarted transport session changes no product record. A conflict between a caller argument and a bound value stays with invocation. A dependency failure of NanoCore or an effect owner stays that owner's outcome. This specification adds no repair.

The contract states the acceptance predicates.

## Product Guide And Retirement Coverage
Guide teaches current Chat, Task and Goal work, Workspace/Thread selection, exact human decisions, knowledge, durable results and bounded recovery. The guide teaches MCP-only Skill discovery, local result deposit and Worker hand-off with durable readback. It contains no retired Skill fallback or unavailable-Goal claim. Public acceptance uses a persistent authorized instance, normal operations, open-ended user intent, no hidden seeding/story answers/fixed call trajectory/new runner, and independent durable readback. Existing task authorization persists; reserved human gates require the exact responsible user's decision. A disconnected client does not cancel work, and an accepted command is not completed execution. Owner-required private audience, restricted Material and App-update model-delivery refusals remain truthful.

Every eligible composed definition is reachable through exactly one native or effect-matched fallback tool with its exact input and authenticated Token actor. Native tools are discoverable by listing and fallback definitions by search and describe. Workspace Skill documents and files are delivered on demand through this same projection. Eligibility follows the definition-derived `operationMcpEligible` contract in [Operation Definition](20261002-operation_definition.md). Person-only credential definitions are excluded as well. The one-time-secret exclusion includes the Web-only Discord pairing challenge. Secret-safe operator procedures and Web/administrator file transfers cover those exclusions; support metadata is outside the operation catalog. Whole-public coverage remains mechanically checked against the checked OpenAPI and typed Core projections, with unique mappings or reason/owner-backed exclusions. Retired user-facing stdio and the retired user-facing Skill packages remain absent without compatibility aliases. Worker capability supply is unaffected.

## Implementation

<a id="current-implementation-projection"></a>

- `apps/nanocore/src/`
- `packages/app-api-schemas/`

## Implementation Gaps

None.

## Decisions

- [Remote MCP ships with a static bearer first](../decisions/20261002-remote_mcp_static_bearer_first.md)
- [Interface unification](../decisions/20261002-interface_unification_rulings.md)
- [Administrator authority](../decisions/20261002-administrator_authority.md)
- [Restricted Material channel boundary](../decisions/20261003-restricted_material_channel_boundary.md)
- [MCP standard adoption](../decisions/20261101-mcp_standard_adoption_policy.md)
