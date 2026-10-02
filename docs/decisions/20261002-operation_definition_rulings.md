---
status: Accepted
date: "2026-10-02"
decider: Engineer, on a Consultant-reviewed proposal
---
# Operation Definition Rulings

## Decision

The engineer ruled on the single operation definition on 2026-10-02: on draft 2 of the coordinator's proposal, then on a question about it with a principle and two further questions, then by approving draft 3's direction and sending it to Consultant review, and finally on blocking after that review. The specification carries the Consultant's corrections as draft 4.

1. Unifying scattered mechanisms and interfaces is mandatory, and every later design and implementation follows it. It means one semantic owner per mechanism with surfaces derived from it; it does not merge distinct authentication, storage, effect, lifecycle, or offline host authorities.
2. Static, code-owned operation definition tables are not the registry that the interface unification rulings exclude. Each resource family has one browser-safe declarative definition table holding every public contract fact of its operations; the server holds only an exact-key typed implementation map and a closed set of trusted resolvers, and repeats no declarative fact.
3. JSON product operations use one HTTP route per canonical operation id. The three Workspace archive operations keep their streaming bindings, and browser authentication, Core Turn event streaming, the OpenAI-compatible Gateway, and worker transport keep their owners.
4. Operations that return a one-time secret, such as access token issuance and rotation and bootstrap responses, are not projected to MCP. The user-facing Skill is retired once the remote MCP endpoint covers it. The bundled CLI is not deleted: it moves under the operator skill, is used with an administrator token, covers every operation including administration and maintenance so that an external agent can operate and maintain an OpenKit deployment through it, writes one-time secrets to local secret-safe sinks instead of model output, and is derived from the same definitions. This amends rule 7 of the [interface unification rulings](20261002-interface_unification_rulings.md), which deleted the CLI with the Skill.
5. After the system launches, a settled operation is never changed; operations are only added, deprecated, or retired, and ids are never reused. Before launch, operations change freely without compatibility. Deprecation and blocking are different concepts. Deprecation is a release decision that a function is no longer needed or has been replaced. Blocking is a deployment decision: an operation the deployment cannot support is an availability condition that its owner reports, and an owner's or administrator's choice to keep users from an operation is a permission, expressed later by rejecting that operation through the Policy Kernel and eventually configurable by users. Permission-based blocking is deferred to the Policy Kernel implementation; the architecture keeps room for it by making the canonical operation id usable as a policy resource and by admitting every invocation once through the primary policy operation.
6. A Codex App Server inside the OpenKit sandbox runs every operation, including MCP tool calls, without client approval; permission control belongs at the sandbox boundary and in NanoCore. Where no elegant mechanism exists, the smallest maintainable configuration is used.
7. The design leaves room for operations that come from data, for example operations produced through use and evolution in a server, Workspace, or user scope through the Generative Kernel, to be added and exposed without a code release, through the owners that already govern their records and execution.

Foundation owns rule 1. The operation definition boundary specification owns rules 2, 3, 5, and 7 as composition and projection rules, Contract Evolution and the Contract Stability Baseline own the post-launch promise of rule 5, the Agent Operator Skill and Release Management own rule 4's CLI, and the Codex Worker Adapter owns rule 6.

## Reason

Translated from Chinese. On unification: "I agree with unifying all the mechanisms and interfaces that are scattered in various places, and it is mandatory; it is a principle that our whole system must follow from now on, in design and in implementation." On tables: "static tables are not within the restriction against adding a registry." The engineer then asked whether two identical tables could be one, because two tables add maintenance burden and can hide inconsistencies; the coordinator's draft 3 answered with one declarative table and a typed implementation map, and the engineer agreed and sent it to Consultant review, which confirmed the direction with corrections that the specification carries.

On the CLI: "the operation skill should be able to do all of these operations through the CLI tool with an admin token. The idea is that we want our OpenKit system to be usable by an external agent that performs all management and maintenance through the CLI tool, so this operation skill should be given full functionality." The engineer confirmed the coordinator's reading: the user-facing Skill is retired, the CLI moves under the operator skill with an administrator token and full coverage, including token issuance and rotation and archive transfer, one-time secrets go to local secret-safe sinks, and the CLI derives from the same definitions.

On change after launch: "once operations are settled and we have launched, we do not modify them again; we only add and deprecate. Of course we have not launched any version yet, so we can change freely without considering compatibility." The engineer also named, as needs the design must meet, deprecating or blocking operations for a new version, adding operations as features improve, and operations produced by use and self-evolution within server, Workspace, user, and other scopes being added and exposed dynamically or semi-statically. Asked whether blocking needs its own mechanism, the engineer said: "deprecation and blocking are two concepts. Deprecation means this part of the function is no longer needed in the new version, or has been replaced. Blocking means that for some reason the deployed system does not support it, or the owner and admin do not want users to use some function, so it is blocked. This can be implemented later, because my idea is that users may configure it themselves in future, and that configuration can be deferred and land together with the Policy Kernel implementation, since a user can reject the operation through permissions, which already blocks it."

On Codex: "the target principle is that a Codex App Server started inside the sandbox should preferably allow every operation without approval. Our permission controls are better placed at the sandbox boundary and in the NanoCore layer. If there really is no elegant solution, land a minimal implementation following KISS and ease of maintenance." A Codex researcher then found that the generated full-access configuration already skips MCP approval, and that setting `default_tools_approval_mode` to approve on each managed server makes it explicit and independent of the sandbox profile.

Rules 2 and 3 originated in the coordinator's proposal and were accepted by the engineer; rules 1, 4, 5, 6, and 7 state the engineer's own principles and requirements.

Source: change record 202610020440000000-interface_unification.

## Rejected Alternatives

- Two independently maintained tables repeating public declarative contract facts, a contract table in the shared package and a server binding table. Rejected after the engineer's question about maintenance burden and hidden inconsistency; the accepted server map supplies only implementations under the definition's exact keys.
- REST placement derived from the definitions (H1). Not chosen; one route per id removes the method, path, query, and header placement layer for the JSON majority.
- Content references or a fallback operation for every non-JSON shape. Rejected; the three archive operations keep their streaming bindings.
- Deleting the CLI with the user-facing Skill. Superseded by rule 4.
- A per-tool approval list or separate read and call MCP tools so Codex skips approval for reads. Rejected; one server-level approve setting covers every tool with no tool-name plumbing.
- A runtime registration API, plugin mechanism in NanoCore, or durable operation registry for data-defined operations. Rejected; rule 7 goes through existing record and execution owners.

## Revisit When

- The launch boundary is defined, which starts rule 5's freeze.
- The first post-launch deprecation or retirement is needed, which adds the lifecycle field.
- The Policy Kernel implementation lands, which makes rule 5's permission-based blocking executable and user-configurable.
- The Generative Kernel's fixed operation is implemented, which activates rule 7.
- Codex changes its MCP approval semantics, which reopens rule 6's configuration.

## Affected Owners

- docs/core/foundation.md
- docs/core/contract-evolution.md
- docs/specs/20260715-contract_stability_baseline.md
- docs/specs/20260910-agent_operator_skill.md
- docs/specs/20260829-release_management.md
- docs/specs/20260713-openkit_agent_skill_interface.md
- docs/specs/20260716-codex_worker_adapter.md
- docs/specs/20260908-generative_kernel_data_operations.md
- docs/specs/20260528-core_client_boundary.md
- docs/specs/20260704-app_api_openapi_projection.md
- docs/specs/20260704-remote_auth_credential_bootstrap.md
- docs/specs/20260715-multi_user_workspace_system.md
- docs/specs/20260704-workspace_backup_export_import.md
- docs/specs/20260703-policy_enforcement_mapping.md
