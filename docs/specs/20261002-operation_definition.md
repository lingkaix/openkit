---
status: Accepted
implementation: Not Started
kind: boundary
date: "2026-10-02"
updated: "2026-10-02"
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

Each cohesive resource family has one release-authored definition table in the shared schema package. The table is keyed by the canonical dotted operation id. NanoCore imports that table and never accepts a caller-supplied descriptor or a caller-supplied authorization result.

The table holds every public contract fact of the operation, and only those facts. The facts are the description, the complete logical input schema, the output schema, credential eligibility, closed typed scope and target descriptors, the primary policy operation, the mutation posture, and, when first needed, lifecycle. Credential eligibility names which trusted authentication procedures and which actor kinds may invoke the operation. An authentication class alone is not eligibility when one operation of that class admits a session and another admits only a bearer, or the reverse. Bootstrap secret, canonical user by session, canonical user by bearer, deployment administrator, and Gateway actor are the current procedures a descriptor may select. The accepted target in Other Projections admits a currently usable administrator credential to every operation through one authorizer rule. A descriptor does not exclude that credential and does not replace the rule.

Core record and command schemas stay the protocol package's schemas. The declaration module expresses operation schemas in Zod, the current schema language, and does not introduce a second schema compiler. Vocabulary the table needs, including policy operation names, lives in the shared schema package. The table's dependency closure stays browser-safe and does not import NanoCore.

The table does not hold private executable configuration, the policy graph, memberships, credentials, deployment paths, or any other live authority fact. Those facts and their procedures stay on the server. A descriptor selects a trusted procedure. It does not replace that procedure and it does not carry the procedure's secret or its result.

The following are not part of the definition and are not built. There is no runtime registration API, no plugin mechanism inside the NanoCore process, no durable operation-registry state, no new permission engine, no generic RPC dependency, no alias for an old id, and no effect taxonomy beyond the mutation posture the operation already declares. The lifecycle field, the retirement mechanism, and a data-defined operation source wait for the conditions in Lifecycle and Data-Defined Sources. Blocking is the deployment decision Lifecycle states, not a definition mechanism waiting in that list.

## Implementation Join

NanoCore holds, per family, an exact-key map from the same operation ids to transport-free handlers. Each handler is typed for its operation. A missing handler, an extra handler, or a signature mismatch fails to compile. The map repeats no fact that the definition table already holds.

NanoCore also holds the closed set of trusted resolver implementations that the descriptors select. The type join proves coverage and signatures only. Behavioral tests and negative-effect tests prove the declared posture and the resolver semantics. A declaration that does not match the handler's behavior is a defect. It is not authority to perform the effect.

## Trusted Resolvers

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

One native invocation function is the seam every derived projection uses. Its precondition is a canonical operation id and input that the definition's schema accepts or rejects. It parses that input, resolves the target without disclosing an inaccessible child, and performs one primary admission through the operation's primary policy operation. The existing authorization and policy owners decide that admission. Invocation does not evaluate policy.

The following stay at their owning boundaries. Invocation calls them and does not absorb them. Capability admission, source and audience checks, and mutation fencing, including Workspace deletion admission, stay with their owners. Effect-specific checks stay with the handler and the effect owner. Pending approval execution stays with [Pending Requests](20260930-pending_requests.md) and runs through the captured binding.

Invocation enforces the admission requirements the definition declares. It cannot prove that an implementation is non-mutating. Handlers and effect owners keep their checks. A read declaration on a writing handler is a defect, not permission to write, and not permission to skip the handler's checks.

The postcondition is one validated output or one typed error from the operation's owner. An unknown outcome after a committed effect stays unknown. Invocation does not claim the mutation rolled back. Cancellation and owner-controlled replay stay as those owners define them. Invocation adds no generic retry and no invocation receipt.

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

A client's own approval prompt is never an exact OpenKit human decision and never substitutes for the server's approval checks. Guidance for an external Codex installation recommends `default_tools_approval_mode` set to approve for the OpenKit server. [Codex Worker Adapter](20260716-codex_worker_adapter.md) owns the same setting on each managed server inside the Sandbox. [Remote MCP Interface](20261002-remote_mcp_interface.md) owns the endpoint. These projection rules stay here.

The projection authenticates through [Remote MCP Interface](20261002-remote_mcp_interface.md) and through the existing credential owners. This specification defines no authentication procedure.

## Other Projections

JSON product operations use one HTTP route per canonical operation id. The three Workspace archive operations `workspace.archive-download`, `workspace.archive-import-dry-run`, and `workspace.archive-import` keep their streaming bindings. [Workspace Backup, Export, and Import](20260704-workspace_backup_export_import.md) owns those bindings. Browser authentication, the Core Turn event stream, the OpenAI-compatible Gateway, and worker transport keep the owners named in Does Not Own.

Internal Tools, built-in worker MCP Tools, and CLI commands are derived from the definitions and execute through invocation. Trusted entry assembly and worker supply assembly keep their capability admission and their immutable selections. Administration Tools move their per-call administrator check into invocation and keep their revocation and provenance semantics. [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md), [Chat Mode Assistant](20260704-chat_mode_assistant.md), [Worker Agent Capability](20260703-worker_agent_capability.md), [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md), and `docs/core/agent-capability.md` keep their current contracts for a resource family until it is cut over.

Knowledge answer gains the shared `knowledge.read` admission. Task Knowledge preparation and public preparation share retrieval and that admission, and they keep their distinct contracts. The amendments of [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md), [Knowledge Store Implementation](20260703-knowledge_store_implementation.md), and [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md) are pending.

The operator CLI is specified by [Agent Operator Skill](20260910-agent_operator_skill.md). It talks to the one-route JSON binding with an administrator bearer, derives online operations from these definitions, writes one-time secrets to local secret-safe sinks, and keeps bootstrap and offline host procedures separately authorized. An online route cannot replace those procedures.

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

The first implementation is not started. It is one existing read and one replayable local mutation from the Generative Kernel family, implemented through one declarative definition table, the implementation join, and invocation. That pair is projected to HTTP and Core Client, to remote MCP, to the existing worker projection, and to the retained CLI. One real administration read runs through its actual internal Tool assembly.

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

No definition table, implementation join, or native invocation seam is implemented. The behaviors Trusted Resolvers preserve are the current NanoCore operation-access declarations and the operation-authorizer module. Opaque-child dispatch in that module currently resolves automation, Turn feedback, and approval records through their record owners. Body selectors currently parse the complete schema of the operation that declares a body Workspace. Public operation schemas currently live in `@openkit/app-api-schemas`, and Core record schemas currently live in `@openkit/protocol`. The declaration module's package placement inside the shared schema packages is an implementation choice provided the dependency closure stays browser-safe and NanoCore imports the table.

The bundled CLI and the user-facing Skill still follow [OpenKit Agent Skill Interface](20260713-openkit_agent_skill_interface.md) until the accepted move and the remote-MCP retirement condition are implemented. The administrator-eligibility target is not implemented.
