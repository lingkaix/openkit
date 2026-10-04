---
status: Accepted
implementation: Partial
kind: boundary
date: "2026-10-02"
updated: "2026-10-03"
---
# Operation Definition

## Owns

- The declarative definition of each public operation, the exact implementation join, and the derivation of its projections.
- What a definition table may hold, the closed trusted resolvers and the behaviors they preserve, trusted invocation inputs, and the native invocation seam.
- Canonical operation names, derived transport spelling, and the semantic lifecycle of an operation, including the rules reserved for a later data-defined source.
- Projection rules for remote MCP, internal Tools, worker Tools, the operator CLI, and the JSON product route, including what stays at other owners' boundaries.
- The acceptance criteria for the first implementation slice.

Where this specification describes a migration whose owning-document amendment is pending, it states an accepted target, not an override of that owner's current contract; the current contract remains in force until the amendment lands, before or in the same change as dependent implementation.

## Does Not Own

- Authentication procedures, including browser authentication, the bootstrap secret, and deployment-administrator proof. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns those procedures. This specification only names which of them an operation may select.
- Policy evaluation and policy facts. [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md), [OpenKit Policy Model](20260629-openkit_policy_model.md), and `docs/core/permissions.md` own them. Permission-based blocking is deferred to those owners. They are not amended now.
- Domain records and their lifecycles, including Workspace, Thread, Knowledge, Generative Kernel, and archive records.
- Pending approval execution. [Pending Requests](20260930-pending_requests.md) owns the captured binding and its execution. This specification states only how a retired operation fails a later call through that binding.
- Capability and entry admission. `docs/core/agent-capability.md`, [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md), [Chat Mode Assistant](20260704-chat_mode_assistant.md), [Worker Agent Capability](20260703-worker_agent_capability.md), and [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) own them. Each keeps its current contract for a resource family until that family is cut over, and then applies the accepted target.
- Transport owners for browser authentication, the Core Turn event stream, the OpenAI-compatible Gateway, and worker transport. `docs/core/communication.md`, [LLM Gateway Responses API](20260526-llm_gateway_responses_api.md), and [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) keep those transports.
- Offline host procedures, including stopped-server recovery and restore. [Agent Operator Skill](20260910-agent_operator_skill.md) and [Workspace Backup, Export, and Import](20260704-workspace_backup_export_import.md) own them.
- Replay, effect commitment, and unknown outcomes after a committed effect. The effect owner keeps them. Invocation preserves them and does not replace them.
- Post-launch stability classification. `docs/core/contract-evolution.md` and [Contract Stability Baseline](20260715-contract_stability_baseline.md) own the promise and the current class. This specification owns the operation lifecycle that the promise allows.

- Connection metadata at GET /api/meta, health at GET /health and GET /api/health, raw deployment diagnostics at GET /api/diagnostics, and diagnostic OpenAPI serving at GET /api/openapi.json are support bindings outside the operation definitions. Their existing owners retain authentication, disclosure, response and availability semantics; named product diagnostics operations remain in the definitions. These bindings create no new durable authority or record, so record creation, update, termination, retry and recovery do not apply; existing missing, stale, conflict, restart and dependency-failure outcomes remain with their owners, with no support-layer replay or repair. Acceptance proves the existing responses and access boundaries, including unauthenticated connection metadata and administrator-only raw diagnostics, while the operation projections omit these support bindings.

## Core References

- `docs/core/foundation.md`
- `docs/core/contract-evolution.md`
- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/agent-capability.md`

## Related Docs

- [Operation Definition Rulings](../decisions/20261002-operation_definition_rulings.md)
- [Administrator Authority](../decisions/20261002-administrator_authority.md)
- [Interface Unification Rulings](../decisions/20261002-interface_unification_rulings.md)
- [Multi-User Workspace System](20260715-multi_user_workspace_system.md)
- [Thread Visibility and Sharing](20260909-thread_visibility_and_sharing.md)
- [Quick Chat Workspace](20260709-quick_chat_workspace.md)
- [Generative Kernel Data and Operations](20260908-generative_kernel_data_operations.md)
- [Agent Plugin Packaging and Worker Supply](20260907-agent_plugin_packaging_and_worker_supply.md)
- [Agent Operator Skill](20260910-agent_operator_skill.md)
- [OpenKit Agent Skill Interface](20260713-openkit_agent_skill_interface.md)
- [Release Management](20260829-release_management.md)
- [Codex Worker Adapter](20260716-codex_worker_adapter.md)
- [Core Client Boundary](20260528-core_client_boundary.md)
- [App API OpenAPI Projection](20260704-app_api_openapi_projection.md)

## Declarative Definition

The family definition declares the operation's success status or allowed success statuses, any owner-required invalid-input code that differs from the common code, its JSON or retained streaming binding kind, and whether its result contains a one-time secret. MCP result eligibility derives from these facts and does not replace trusted entry or worker supply selection. A projection consumes these facts without testing a family id, id prefix, output-schema identity or owner error class. Trusted entry assembly selects the bound fields and delivery context; neither caller input nor a schema field's presence establishes authority or changes a delivery channel.

Each cohesive resource family has one release-authored definition table in the shared schema package. The table is keyed by the canonical dotted operation id. NanoCore imports that table and never accepts a caller-supplied descriptor or a caller-supplied authorization result.

The table holds every public contract fact of the operation, and only those facts. The facts are the description, the complete logical input schema, the output schema, credential eligibility, closed typed scope and target descriptors, the primary policy operation, the mutation posture, and, when first needed, lifecycle. Credential eligibility names which trusted authentication procedures and which actor kinds may invoke the operation. An authentication class alone is not eligibility when one operation of that class admits a session and another admits only a bearer, or the reverse. Bootstrap secret, canonical user by session, canonical user by bearer, deployment administrator, and Gateway actor are the current procedures a descriptor may select. The accepted target in Other Projections admits a currently usable administrator credential to every operation through one authorizer rule. A descriptor does not exclude that credential and does not replace the rule.

Core record and command schemas stay the protocol package's schemas. The declaration module expresses operation schemas in Zod, the current schema language, and does not introduce a second schema compiler. Vocabulary the table needs, including policy operation names, lives in the shared schema package. The table's dependency closure stays browser-safe and does not import NanoCore.

The table does not hold private executable configuration, the policy graph, memberships, credentials, deployment paths, or any other live authority fact. Those facts and their procedures stay on the server. A descriptor selects a trusted procedure. It does not replace that procedure and it does not carry the procedure's secret or its result.

The following are not part of the definition and are not built. There is no runtime registration API, no plugin mechanism inside the NanoCore process, no durable operation-registry state, no new permission engine, no generic RPC dependency, no alias for an old id, and no effect taxonomy beyond the mutation posture the operation already declares. The lifecycle field, the retirement mechanism, and a data-defined operation source wait for the conditions in Lifecycle and Data-Defined Sources. Blocking is the deployment decision Lifecycle states, not a definition mechanism waiting in that list.

## Implementation Join

Each family exposes one exact-key implementation map for static composition of its JSON-bound operations and depends only on the services its implementation uses. Domain joins, domain failure classification and family-private output contracts stay behind the family boundary. A handler receives parsed input and the invocation's admitted context, and returns its logical output without a transport object. Common invocation and projection algorithms contain no family dispatch; the release-authored composition and closed trusted resolver wiring may name the family modules they assemble. The rationale is recorded in [a decision record](../decisions/20261003-operation_family_modules_and_error_projection.md).

NanoCore holds, per family, an exact-key map from the same JSON-bound operation ids to transport-free handlers. Each handler is typed for its operation. A missing handler, an extra handler, or a signature mismatch fails to compile. The map repeats no fact that the definition table already holds.

NanoCore also holds the closed set of trusted resolver implementations that the descriptors select. The type join proves coverage and signatures only. Behavioral tests and negative-effect tests prove the declared posture and the resolver semantics. A declaration that does not match the handler's behavior is a defect. It is not authority to perform the effect.

## Trusted Resolvers

Descriptor selection uses only the closed declared scope, target, mutation-target and child-owner strategies. Family record owners implement minimum-lineage reads for those strategies, and shared invocation does not infer an owner from a field shape or an operation spelling. Resolved lineage does not replace current effect authority, audience, approval, capability or mutation-fencing checks.

The descriptor's scope and target kinds are a closed set. An unknown resolver kind fails closed. The implementations preserve the behaviors below. Each behavior already belongs to the cited owning document. Preserving it adds no mechanism. The current modules that implement these behaviors are named in Current Implementation Projection.

Explicit Workspace authority comes from the declared path parameter or from child lineage under that Workspace. [Multi-User Workspace System](20260715-multi_user_workspace_system.md) owns the `path-workspace` and `workspace-child-lineage` shapes. The selected Workspace is authorized before content access. A Workspace derived from an inconsistent child never replaces it. When the child owner can distinguish a globally missing child without scanning another Workspace, a missing child uses that owner's not-found result. When it cannot, a missing child and a mismatched lineage use the same access denial.

A caller-supplied selector is read only from the field the operation declares, and only after the operation's complete logical schema has parsed. [Multi-User Workspace System](20260715-multi_user_workspace_system.md) owns that `body-workspace` rule. A search for a field named like a Workspace id is not resolution.

Opaque-child lineage is the minimum the child family's record owner can return before authorization: the Workspace id and the minimum eligibility context. The pre-authorization read does not load the full record, does not return child content, and does not mutate. [Multi-User Workspace System](20260715-multi_user_workspace_system.md) owns the `opaque-child-workspace` shape. Missing child, contradictory lineage, and an unauthorized Workspace produce the same access denial.

Collection authorization is candidate-first. Candidates come from active membership, or from active registered Workspaces for a currently usable administrator credential under the Administrator Eligibility rule in `docs/core/permissions.md`, then from token intersection and the declared operation. A closed Workspace is excluded before the handler sees the set. Loading Workspace content and filtering afterward is not authorization. [Multi-User Workspace System](20260715-multi_user_workspace_system.md) owns the `authorized-workspace-set` shape.

Quick Chat is derived from the actor. The caller cannot supply a Workspace override. Initialization of that actor's Quick Chat stays the initialization [Quick Chat Workspace](20260709-quick_chat_workspace.md) owns, including initialization for the administrator bearer's own Quick Chat. Admission still requires that user to be the Workspace's current owner. [Multi-User Workspace System](20260715-multi_user_workspace_system.md) owns the `actor-quick-chat-workspace` shape.

An operation that addresses a Thread keeps that audience check. [Thread Visibility and Sharing](20260909-thread_visibility_and_sharing.md) owns audience. An inaccessible Thread is a uniform not-found and discloses no protected content. A Workspace descriptor that omitted the Thread strategy would drop this check, so the definition names the addressed-Thread strategy and the missing-versus-malformed distinction the current check already makes.

Gateway attribution is optional and secondary. The only attributed field is `metadata.openkit.workspaceId`, owned as a wire field by [LLM Gateway Responses API](20260526-llm_gateway_responses_api.md). Absence and malformed input are different results. Absence is not a top-level fallback, and a malformed value is not an absent value. [Multi-User Workspace System](20260715-multi_user_workspace_system.md) owns the `gateway-metadata-workspace` authorization. The Gateway is not an ordinary JSON product route.

Some operations target a Workspace for mutation admission even when their authorization scope is not Workspace membership. Leave, access recovery, invitation response, and deletion fencing are the current cases. [Multi-User Workspace System](20260715-multi_user_workspace_system.md) owns leave, invitation response, and deletion fencing, including the original owner's narrow deletion-retry authority. Workspace access recovery remains with [Multi-User Workspace System](20260715-multi_user_workspace_system.md), including its mutation target and lifecycle checks; the credential owner, [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md), supplies authentication and separately owns credential recovery. Authorization scope alone does not decide the mutation target. The definition names that owned target. It does not invent a second lifecycle.

Bootstrap-secret authentication and current deployment-administrator authentication remain distinct trusted procedures. A descriptor may select one of them. It does not replace either, and bootstrap consumption is not deployment administration. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) and [Multi-User Workspace System](20260715-multi_user_workspace_system.md) own the procedures.

## Trusted Invocation Inputs

A selector is caller input only where the operation lets the caller choose it. Trusted actor, execution lineage, entry scope, the private Turn, and command identities derived by an owner come from the invocation context. The caller and the model cannot supply or override them.

Model-facing schemas are derived from the logical input schema and omit bound fields. The assembled invocation rejects a conflict between a caller argument and a bound value before any effect. A model-controlled copy of a bound identity is that conflict, not a second selector.

## Invocation

A classified operation failure uses one transport-neutral typed error carrying a semantic status, code, safe message and optional safe details; causal errors and stacks remain private. The boundary that owns a failure classifies its known failures, and each family translates its known domain failures inside its execution boundary. An unclassified exception remains unclassified. For classified operation failures, HTTP, remote MCP and built-in worker MCP preserve the same safe code, message, semantic status and optional details using their respective transport framing, without family-specific class, cause or id tests. HTTP carries the status as its response status and uses the existing protocol error body; MCP carries the semantic status in its operation-error data. Authentication, MCP protocol and worker capability or transport failures retain their owning projections. HTTP rethrows an unclassified exception to its error handler instead of converting it to a family fallback. These projections add no retry, receipt, rollback claim or cross-domain atomicity.

One native invocation function is the seam every derived projection uses. Its precondition is a canonical operation id and input that the definition's schema accepts or rejects. It parses that input, resolves the target without disclosing an inaccessible child, and performs one primary admission through the operation's primary policy operation. The existing authorization and policy owners decide that admission. Invocation does not evaluate policy.

The following stay at their owning boundaries. Invocation calls them and does not absorb them. Capability admission, source and audience checks, and mutation fencing, including Workspace deletion admission, stay with their owners. Effect-specific checks stay with the handler and the effect owner. Pending approval execution stays with [Pending Requests](20260930-pending_requests.md) and runs through the captured binding.

Invocation enforces the admission requirements the definition declares. It cannot prove that an implementation is non-mutating. Handlers and effect owners keep their checks. A read declaration on a writing handler is a defect, not permission to write, and not permission to skip the handler's checks.

A successful invocation returns one validated output. A classified failure returns the typed error defined above; an unclassified exception propagates to the entry's error boundary. An unknown outcome after a committed effect stays unknown. Invocation does not claim the mutation rolled back. Cancellation and owner-controlled replay stay as those owners define them. Invocation adds no generic retry and no invocation receipt.

## Names

One canonical dotted semantic id names the operation for discovery, invocation, client typing, and evidence. HTTP placement and a collision-checked transport spelling are derived from that id. They are not a second name an author maintains.

Existing settled semantic ids stay unless a rename is required. Before a rename, retained references that cite the id are disposed of explicitly. Those references include captured Pending bindings, evidence, and audit. An alias that keeps the old id callable under a new meaning is not a rename.

## Lifecycle

What freezes after the launch boundary is the operation's semantic contract. That contract is the input and output meaning, the effects, and the declared authority requirements. Spelling alone is not the contract. `docs/core/contract-evolution.md` owns the promise, the rule that the launch boundary is not yet defined, and the rule that operations stay release-coupled until it is defined. A repair that restores the accepted contract is not a new meaning. Current policy, resource state, revocation, and effect preconditions may still deny an unchanged operation.

New semantics require a new id. An id is never reused. Deprecation keeps the operation callable, records its reason and an optional replacement in discovery and guidance, and never redirects a call. Retirement in a later release removes the operation from discovery and from execution. A call then returns a typed retired error that names the optional replacement when one was recorded. A call through a captured binding, including a Pending approval, fails the same way. Retained records that cite the id stay readable under their continuity owners. Freedom to change definitions before launch does not discard those records or those captured bindings.

The lifecycle field is added to the definition when the first post-launch deprecation or retirement needs it. No lifecycle store and no retirement mechanism are built before that need.

Deprecation and retirement are release decisions. Blocking is a deployment decision and is not a change to the operation definition. An operation the deployment cannot support is an availability condition its owner already reports. That condition is not policy. An owner's or administrator's choice to keep users from an operation is a permission, deferred to the Policy Kernel implementation and later user-configurable. The architecture keeps room for that permission by making the canonical operation id usable as a policy resource and by admitting every invocation once through its primary policy operation. That admission is the one primary admission Invocation performs. This specification does not define the permission and does not evaluate it. Hiding an operation from discovery is not enforcement. `docs/core/permissions.md` and [OpenKit Policy Model](20260629-openkit_policy_model.md) are not amended for blocking in this specification.

## Data-Defined Sources

A data-defined operation source is reserved and is not built. No dynamic source, registry state, universal id grammar, or generic execution engine is added.

A future admitted source may project this specification's browser-safe operation vocabulary from records and immutable component versions that an existing domain already owns. The first candidate is the Generative Kernel's fixed operation. [Generative Kernel Data and Operations](20260908-generative_kernel_data_operations.md) keeps that operation's proposal, validation, activation, retirement, immutable versions, and execution classes. [Agent Plugin Packaging and Worker Supply](20260907-agent_plugin_packaging_and_worker_supply.md) keeps binding admission. This specification does not restate those classes.

Publication of such an operation validates the exact executable binding and the authority, scope, and effect requirements of that binding. The data definition cannot weaken them. It cannot declare itself read-only, choose a weaker credential, substitute a target, or supply code or credentials. Invocation pins the selected revision and checks current authorization. A stale or unsupported binding fails explicitly. There is no generic prompt fallback and no shell fallback.

Discovery of a data-defined operation is an authorized current projection, not an execution grant. Its public descriptor is permission-filtered and never exposes the owner's private executable configuration. Its ids are scoped so they cannot collide with release-authored ids.

Deferred execution classes stay unavailable until their own contracts are accepted and implemented. Entry admission and worker admission continue to select immutable Tool bindings. An operation's existence does not make it a model-visible Tool. Unknown resolver, effect, authority, or required-feature values fail closed.

Until a source is admitted, the creation, update, termination, retry, and recovery of a data-defined definition record do not apply. The rules above are the admission constraints a later source must meet.

## Remote MCP Projection

`search`, `describe`, and `guide` are side-effect free. Their read-only hints are truthful. Invocation is one `call`. The call's annotations are truthful for that operation, including its mutation posture.

Search tokenizes ids and descriptions, ranks a query that matches multiple terms, and tolerates word order. It returns bounded results and indicates when more exist. The bound is a current default of the implementation, chosen so a result stays small enough for a client to read, and this specification does not fix the number. Search returns operation metadata only. It is not a permission decision.

An operation that returns a one-time secret is unreachable through every MCP invocation path. Absence from search is not enough. Access-token issuance, access-token rotation, and bootstrap responses are the current secret-returning cases. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md) owns those operations.

The three Workspace archive operations remain definition-owned and use only their existing streaming bindings. Remote MCP search and describe omit them, and call refuses them before archive processing with a typed unsupported-operation tool result. Guide directs ordinary users to Web and administrators to the administrator CLI. The [archive owner](20260704-workspace_backup_export_import.md) retains sole authority for bytes, admission, staging, import commitment, cleanup and recovery; this exclusion introduces no durable record, so record creation, update, termination, retry and recovery do not apply. Existing collision, missing-export, stale-authority, restart and dependency-failure outcomes remain unchanged. Acceptance proves all three exclusions, no archive effect on refusal, and successful authorized Web and administrator CLI transfers through the retained streams. The rationale is recorded in [a decision record](../decisions/20261003-streaming_archives_use_web_and_admin_cli.md).

A client's own approval prompt is never an exact OpenKit human decision and never substitutes for the server's approval checks. Guidance for an external Codex installation recommends `default_tools_approval_mode` set to approve for the OpenKit server. [Codex Worker Adapter](20260716-codex_worker_adapter.md) owns the same setting on each managed server inside the Sandbox. [Remote MCP Interface](20261002-remote_mcp_interface.md) owns the endpoint. These projection rules stay here.

The projection authenticates through [Remote MCP Interface](20261002-remote_mcp_interface.md) and through the existing credential owners. This specification defines no authentication procedure.

## Other Projections

Classified failures from definition-derived JSON operations use the common protocol error envelope, without family-specific plaintext responses. Unclassified exceptions remain the HTTP error handler's responsibility. Dynamic success status is request-local and must be one of the operation's declared allowed statuses. A deliberate domain fallback remains only where the domain owner requires it, is classified at that owner's execution boundary, and exposes a safe message. It does not wrap shared parsing, primary admission, resolver execution or invocation output validation; otherwise unclassified exceptions propagate. Every response from the HTTP JSON operation projection uses `Cache-Control: no-store`, including successes, typed refusals, unclassified HTTP errors and bodyless 204 responses.

JSON product operations use one HTTP route per canonical operation id. The three Workspace archive operations `workspace.archive-download`, `workspace.archive-import-dry-run`, and `workspace.archive-import` keep their streaming bindings. [Workspace Backup, Export, and Import](20260704-workspace_backup_export_import.md) owns those bindings. Browser authentication, the Core Turn event stream, the OpenAI-compatible Gateway, and worker transport keep the owners named in Does Not Own.

automation.delete, runtime.file-delete and provider-subscription.account-delete return logical null after their existing domain deletion succeeds. Their definition-derived HTTP binding returns 204 with no body and no Content-Type; derived clients map that empty success to logical null, and MCP and CLI project the same logical result. Domain owners retain sole durable authority, admission, deletion ordering and retained-history rules. This response mapping creates no record, so creation, update, termination, retry and recovery of a mapping record do not apply. Conflict, missing target, stale revision, restart, dependency failure and unknown effect outcomes remain the domain owner's outcomes; response conversion adds no idempotency, retry or repair. Acceptance proves these wire and logical results and unchanged protected effects and failures through the derived projections.

Internal Tools, built-in worker MCP Tools, and CLI commands are derived from the definitions and execute through invocation. Trusted entry assembly and worker supply assembly keep their capability admission and their immutable selections. Administration Tools move their per-call administrator check into invocation and keep their revocation and provenance semantics. [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md), [Chat Mode Assistant](20260704-chat_mode_assistant.md), [Worker Agent Capability](20260703-worker_agent_capability.md), [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md), and `docs/core/agent-capability.md` keep their current contracts for a resource family until it is cut over.

Knowledge answer gains the shared `knowledge.read` admission. Task Knowledge preparation and public preparation share retrieval and that admission, and they keep their distinct contracts. [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md), [Knowledge Store Implementation](20260703-knowledge_store_implementation.md), and [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md) carry this admission.

The operator CLI is specified by [Agent Operator Skill](20260910-agent_operator_skill.md). For JSON product operations it talks to the one-route JSON binding with an administrator bearer; the three Workspace archive operations use their retained streaming bindings. It derives online product operations from these definitions, writes one-time secrets to local secret-safe sinks, and keeps bootstrap and offline host procedures separately authorized. Connection probing follows the support-binding exclusion in Does Not Own. An online route cannot replace the separately authorized bootstrap and offline host procedures.

The accepted target is that a currently usable administrator credential, the administrator's Web session or an administrator bearer, is eligible for every operation, including operations on other users' resources, through one rule in the existing authorizer and not through a second permission model. That eligibility includes recovering a resource another user deleted, reading other users' private Threads and private-derived content, answering approvals raised to other users, archive export and import of any Workspace, and managing the administrator's own access tokens. Attribution stays truthful. The administrator is the recorded actor and does not impersonate the affected user, and a recovered resource returns to its original owner. Per-effect authority objects, such as approval records and Vault grants, still exist and are checked, and the administrator may create or issue them. Credential limits and the sandbox boundary are unchanged. A read-only credential stays read-only, revocation and expiry apply, and the sandbox boundary applies to every actor. The Policy Kernel later refines this authority with fine-grained policy. `docs/core/permissions.md` owns this rule as Administrator Eligibility. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md), [Multi-User Workspace System](20260715-multi_user_workspace_system.md), [Workspace Backup, Export, and Import](20260704-workspace_backup_export_import.md), `docs/core/identity.md`, and [Pending Requests](20260930-pending_requests.md) apply it at their boundaries. The ruling is recorded in [Administrator Authority](../decisions/20261002-administrator_authority.md).

[Core Client Boundary](20260528-core_client_boundary.md) and [App API OpenAPI Projection](20260704-app_api_openapi_projection.md) keep route and client projection detail. [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) keeps the policy-operation registry. Each keeps its current contract for a resource family until that family is cut over. `docs/core/communication.md` changes only if a binding changes, and no binding change is made here. [Pending Requests](20260930-pending_requests.md) applies the administrator rule identified above; a separate captured-binding amendment is needed only if that contract must state the retired-operation failure.

Each migrated resource group deletes its old route, its hand-maintained client mapping, and its hand-maintained descriptor in the same cutover. A schema view derived from the definition is not a second contract. A second independently authored semantic schema or handler is a failed cutover.

## Identity

Future independent agent identities enter through the same invocation boundary. Authentication, membership, audience, attribution, and exact-gate implementations change only under their owning documents. This specification creates no identity, credential, or membership.

## Decision Classes

### Operation Definition

The definition and its exclusions are Declarative Definition, including the closed facts the table may hold and the mechanisms that are not built.

The unique authority is the release-authored table for public contract facts. NanoCore's implementation map and resolver implementations are server authority for execution and repeat no declarative fact. Projections are derived and are not a second semantic authority. No durable operation-registry record exists, so this class does not create a stored definition that could compete with the table.

Creation, update, and termination of a stored definition record do not apply, because no lifecycle store is built. Retry of a definition write does not apply for the same reason. The semantic lifecycle that does apply is Lifecycle: free change while operations are release-coupled, then only addition, deprecation, and retirement after the launch boundary, with ids never reused. Recovery of a definition record does not apply. A process restart loads the release-authored table.

A missing handler, an extra handler, or a signature mismatch fails the type join. An unknown resolver, effect, authority, or required-feature value fails closed. A call to a retired id, including through a captured binding, returns the typed retired error. A retained record that cites the id stays readable. Restart recovery of a definition does not apply, as the preceding class states. A dependency failure of NanoCore, the policy owner, or a domain owner remains that owner's failure. This specification does not add a definition-level repair.

The externally observable acceptance predicates are Acceptance Criteria.

### Invocation

The invocation definition and its exclusions are Invocation and Trusted Invocation Inputs. Invocation does not include a generic retry, an invocation receipt, or a proof that a handler is non-mutating.

Invocation is the unique seam for derived projections. It enforces declared admission and is not the policy owner, the effect owner, or the Pending approval owner. Those authorities stay at the boundaries Invocation names.

Creation, update, termination, and retry of an invocation record do not apply. Invocation persists nothing of its own. Cancellation and owner-controlled replay are preserved and stay with their owners. They are not an invocation lifecycle.

A caller argument that conflicts with a bound value is rejected before any effect. Missing authority fails closed through the existing authorization or policy owner. An inaccessible child is not disclosed. A stale or unsupported data-defined binding fails explicitly once that source exists. Until the source exists, that stale case does not apply to a built source. Restart recovery of an in-flight invocation does not apply, because there is no invocation receipt. An unknown outcome after a committed effect stays with the effect owner. A dependency failure stays that owner's typed error or unknown outcome.

The externally observable acceptance predicates that concern invocation are the corresponding predicates in Acceptance Criteria.

## Acceptance Criteria

A classified operation failure preserves its code, message, semantic status and safe details through HTTP, remote MCP and built-in worker MCP operation projections; HTTP carries status in its response framing. These projections expose no cause, stack or secret-bearing submitted input. An injected unclassified failure in both handler execution and resolver execution reaches the HTTP error handler and is never converted to a family not-found or invalid-input result. Every statically included family has an exact implementation join, and duplicate operation ids are rejected. Adding a family that uses the declared strategies changes family modules and static composition without adding a family branch to common invocation or error projection.

The first implementation slice comprises one existing read and one replayable local mutation from the Generative Kernel family, implemented through one declarative definition table, the implementation join, and invocation. That pair is projected to HTTP and Core Client, to remote MCP, to the existing worker projection, and to the retained CLI. One real administration read runs through its actual internal Tool assembly.

The following predicates accept that slice.

- Authorized results and stored records are the same across those projections.
- Replay follows the effect owner's replay rule, and conflicting input is rejected before any effect.
- An otherwise authorized read-only token succeeds on the read and is denied on the mutation before any protected effect; revoking the credential denies subsequent calls, and administrator provenance is visible through the real internal assembly.
- A Workspace selector is distinct from a bound identity.
- A wrong child under an otherwise authorized Workspace is rejected, and a wrong lineage is rejected, with no protected effect.
- The type join covers the slice exactly, and the definition table's dependency closure is browser-safe.
- Invalid output is detected, and detection does not claim that a committed mutation rolled back.
- One real Claude Code loop and one real Codex loop complete against the remote MCP projection.
- A Web readback shows the same authorized result.

Broader migration stops if the slice needs a second independently authored semantic schema or handler, an HTTP self-call, a model-controlled bound identity, or a changed domain outcome. A model-input view that is mechanically derived and omits trusted fields is required, and it is not one of those failures.

## Current Implementation Projection

The eleven Material definitions compose from `packages/app-api-schemas/src/material-operations.ts` with one exact-key implementation map in `apps/nanocore/src/material-operation-implementations.ts`. All public projections derive from the family table; the former registrar, SDK methods, access keys, OpenAPI descriptors and literal CLI rows are removed. The family preserves Workspace and Thread admission, content digest verification, immutable-revision conflict, exact command replay and recovery-required projection. Trusted model delivery refuses restricted content before accessing bytes or entering the command owner; human JSON exact read/edit remains available.

The seven human access-token and bootstrap operations compose from `packages/app-api-schemas/src/access-token-operations.ts` and join their existing owners through `apps/nanocore/src/auth/access-token-operations.ts`. Bootstrap selects the exclusive `bootstrap-secret` credential and actorless trusted HTTP entry after secure-transport admission and bearer/session refusal; native admission rejects either direction of credential/context mismatch, and one-time-secret facts exclude issuance, rotation and bootstrap from every MCP projection before effects.

The shared exact-key implementation join requires only definitions with `binding: 'json'`; streaming definitions use their retained streaming routes exclusively, and the native engine refuses them with typed `unsupported_operation` before admission or effects.

The ten runtime configuration and eleven provider-subscription definitions are composed from `runtime-config-operations.ts` and `provider-subscription-operations.ts`. Their exact dependency-built implementation maps live beside the native configuration and account owners and register through `operation-composition.ts`. File and account deletion use the shared logical-null/bodyless-204 projection; former registrars, client namespaces, access keys, descriptors and literal CLI rows are absent.

Agent, Worker and resource catalog operations derive from the three browser-safe tables in `agent-operations.ts`, `worker-operations.ts` and `catalog-operations.ts`. Their exact native maps live in `agents/agent-operations.ts`, `agents/workspace-workers.ts` and `catalog/catalog-operations.ts`, composed once in `operation-composition.ts`. The seventeen former routes, client members, access keys, OpenAPI descriptors and literal CLI rows are removed. Agent discovery preserves authorized Workspace candidates; Worker reads preserve recorded work, exact immutable package supply, audit-controlled usage and current administrator eligibility for private Thread audiences. Catalog mutations preserve compare-and-set revisions, immutable selections, actor attribution, stdio host authority, credential-binding omission versus replacement, runtime configuration reload and affected MCP session invalidation. Every consumer uses complete canonical inputs, with no archive protocol or credential mechanism added.

The seven Worker environment, two private administration entry and three App-update operations use family-local declaration tables and exact-key implementation maps, statically composed with the existing families. Their former routes, handwritten SDK members, access entries, OpenAPI descriptors and CLI rows are deleted. App-update status keeps its host-owned receipt id as a read selector; mutable commands keep header-carried request identity. Model-mediated App update remains unsupported before effects until its exact approval adapter exists.

The fifteen Workspace synchronization operations are composed from `packages/app-api-schemas/src/sync-operations.ts`, with joins in `apps/nanocore/src/runtime/workspace-sync-operations.ts`. All public projections use these definitions; the former bindings are absent. Public filesystem review apply uses the existing Workspace authorizer again at its effect check, preserving current administrator eligibility and credential limits. The [Workspace Synchronization implementation projection](20260703-workspace_synchronization.md#current-implementation-projection) describes the retained review, recovery and receipt owners.

`AUTOMATION_OPERATION_DEFINITIONS`, `SCHEDULER_OPERATION_DEFINITIONS` and `RECOVERY_OPERATION_DEFINITIONS` are statically composed from browser-safe family modules in `packages/app-api-schemas/src/`. Their nine operations join the existing owners through `automation-operations.ts`, `runtime/scheduler-admission-operations.ts` and `runtime/worker-recovery-operations.ts`. Automation child admission resolves only Workspace and record owner selectors; addressed Turn admission resolves only Workspace and Thread selectors; scheduler child admission selects Workspace and Thread before loading queue content. Current administrator eligibility reaches automation ownership and scheduler/recovery private Thread audiences. The former routes, client members, access declarations, OpenAPI descriptors and literal CLI rows are removed. Generic projections implement automation deletion as logical `null`, bodyless HTTP 204 without Content-Type, and logical `null` in the derived client, MCP and CLI. Queue mutation, checkpoint cleanup, original Turn lineage and exact recovery receipt replay retain their existing owners.

The streaming-archive MCP exclusions and Web/administrator CLI guidance and support-binding exclusions above are implemented. The three archive definitions retain only their existing streaming routes and Core Client stream methods; JSON invocation and client projections select JSON bindings, while exact-key checks preserve that selection and exclude parallel archive handlers. Connection metadata, health, raw deployment diagnostics and OpenAPI serving remain support bindings outside all operation projections. The B4 deletion projections are implemented as described here.

The three server-managed JSON transfer operations `workspace.export`, `workspace.import-dry-run`, and `workspace.import` derive their schemas, HTTP bindings, Core Client methods and CLI entries from `packages/app-api-schemas/src/workspace-transfer.ts`. `apps/nanocore/src/storage/workspace-transfer-operations.ts` joins the existing verifier, collision preview and staged publication owners. Import retains canonical-user admission and source-export effect checks; the three archive operations retain their streaming bindings.

Definition tables are implemented in `packages/app-api-schemas/src/operation-definitions.ts` for the complete Generative Kernel and Generative UI families (the remaining operations in `generative-operations.ts`), Workspace, Thread, Turn, Knowledge, Knowledge Entry, Artifact, Goal, Conversation, Task, Attention, Pending Request, Automation, Scheduler, Recovery, Workspace transfer, Workspace Synchronization and Workspace lifecycle families and for the NanoHost and data-root administration families, composed statically into `OPERATION_DEFINITIONS`. The native invocation seam `apps/nanocore/src/operation-invocation.ts` joins each definition to its existing domain owner, with the Workspace lifecycle joins in `apps/nanocore/src/workspace-sharing-operations.ts` and `apps/nanocore/src/workspace-deletion-operations.ts`, the Workspace synchronization joins in `apps/nanocore/src/runtime/workspace-sync-operations.ts`, the remaining Kernel and Generative UI joins in `apps/nanocore/src/generative-operations.ts`, the Knowledge joins in `apps/nanocore/src/knowledge-operations.ts`, the Artifact joins in `apps/nanocore/src/artifact-operations.ts`, the Goal join in `apps/nanocore/src/runtime/goal-owner.ts`, the Conversation and Task joins in `apps/nanocore/src/mode-entry-routes.ts`, the navigation and attention reads in `apps/nanocore/src/app-dashboard.ts` and `apps/nanocore/src/action-center.ts`, and the Pending Request joins in `apps/nanocore/src/pending-request-operations.ts`, applies the shared operation authorizer, and validates input and output. NanoHost lifecycle joins in `apps/nanocore/src/auth/nanohost-operations.ts` preserve exclusive credential sinks, redacted results and transport fencing; data-root joins in `apps/nanocore/src/storage/data-root-admin-operations.ts` preserve local backup handles and coverage. The JSON-bound operations in `OPERATION_DEFINITIONS` are projected to the one-route JSON binding `POST /api/app/operations/<id>` by `apps/nanocore/src/operation-json-routes.ts` and to OpenAPI, the Core Client operation map and the CLI catalog from that same composition. Workspace creation, Artifact import and introduction declare HTTP 201, Turn and Task start declare HTTP 202, conversation submission preserves its owner's HTTP 200 or 202, and model views preserve owner refinements when omitting trusted fields. The remote MCP endpoint `apps/nanocore/src/remote-mcp-routes.ts` derives discovery and calls from `OPERATION_DEFINITIONS`, and the internal administration Tool derives `nanohost.runtime-target` from `ADMINISTRATION_OPERATION_DEFINITIONS` and selects that exact read without publishing other administration operations to the internal Tool surface. All eleven NanoHost, backup and storage-report operations use the same projections and current deployment-administrator admission; their former routes, SDK members, descriptors and literal CLI rows are deleted. NanoHost sink-writing operations return metadata only and are available through remote MCP under the same authorization and mutation-readiness gate. The sixteen Workspace lifecycle definitions in `packages/app-api-schemas/src/workspace-lifecycle-operations.ts` compose statically into the product table and join existing sharing and deletion owners through `workspace-sharing-operations.ts` and `workspace-deletion-operations.ts`. They retain strict complete inputs, refined deletion confirmation, HTTP 201 invitation creation and HTTP 200/202 deletion results, safe typed refusals through HTTP and MCP, request receipts, truthful actor attribution and all existing lifecycle phases. Canonical-user invitation decisions, leave and deleted recovery remain user-scoped; minimal invitation lineage and addressed Workspace selectors preserve mutation fences independently of authorization scope. Current administrator sessions and bearers can act on another user’s resources without membership or impersonation; deletion keeps the original registry owner and exact-request retry, and deleted recovery restores that original owner while auditing the actual caller. The former sixteen routes, client methods, OpenAPI descriptors, access keys and literal CLI rows are deleted; Web uses complete `client.operations[id](input)` objects. Invitation creation retains secret-input handling in the derived CLI catalog. Operations not yet migrated, including other operations within the named families, retain hand-written routes, client mappings, OpenAPI descriptors and CLI entries. The behaviors Trusted Resolvers preserve are the current NanoCore operation-access declarations, which also project the migrated definitions, and the operation-authorizer module. Native invocation resolves `turn.feedback` through minimal opaque Turn-map lineage before Workspace and Thread admission; native invocation resolves approval ids from minimal canonical or Approval-map lineage after selected-Workspace admission; question answers and Pending Request withdrawals use body-Workspace and addressed-Thread admission. Body selectors currently parse the complete schema of the operation that declares a body Workspace. Public operation schemas currently live in `@openkit/app-api-schemas`, and Core record schemas currently live in `@openkit/protocol`. The declaration module's package placement inside the shared schema packages is an implementation choice provided the dependency closure stays browser-safe and NanoCore imports the table.

The eleven ordinary core commands and Quick Chat are composed from the browser-safe Workspace, Thread, Turn and Conversation family tables. The exact typed joins and Workspace commands live in their respective family implementation modules; Thread and Turn joins reuse their native owners, and Quick Chat uses the transport-free service in `mode-entry-routes.ts`. Their former JSON routes, access keys, OpenAPI descriptors, client members and literal CLI rows are removed. HTTP mutation admission and remote MCP readiness derive from these definitions; the Thread SSE binding remains unchanged.

The bundled CLI and the user-facing Skill still follow [OpenKit Agent Skill Interface](20260713-openkit_agent_skill_interface.md) until the accepted move and the remote-MCP retirement condition are implemented. The administrator-eligibility target is implemented for Workspace admission in the shared Workspace authorizer, including the authorized Workspace set, and for addressed-Thread audience checks in migrated public invocations; `conversation.navigation` and `attention.list` also pass current administrator eligibility to their private-Thread and pending-request projections; the migrated Artifact operations also apply the existing current deployment administrator predicate to private-origin Artifact audiences; the migrated Knowledge operations use that Workspace admission but do not implement an administrator-specific source or audience check. It is not yet established for the per-resource checks of operations that are not yet migrated.

The governance, environment, App search and Vault families are statically composed from `packages/app-api-schemas/src/{governance,environment,app-search,vault}-operations.ts`; exact native maps live beside their NanoCore owners. These 27 JSON operations replace the former route, client, OpenAPI, access-catalog and CLI rows. Vault request material remains sensitive input and every output remains redacted; the existing storage and effect checks stay in the native Vault family.
