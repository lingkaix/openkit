# Policy Enforcement Mapping

Status: Accepted
Implementation: Partial

## Summary

This spec maps the OpenKit policy kernel into NanoCore product enforcement.

The clean target is one policy truth and many enforcement points. `@openkit/policy-kernel` owns standard-aligned NGAC subset authorization semantics. NanoCore maps product objects into NGAC facts, records decisions, creates approval gates when policy requires them, and compiles derived backend policy for OpenShell or future runtimes.

## Owns

- Product fact vocabulary for mapping NanoCore subjects, actions, resources, and context into policy evaluation.
- `PermissionDecision` as the durable bridge between policy evaluation, product workflow, approvals, audit, and backend policy derivation.
- Mapping policy decisions to product behavior, approval gates, Action Center rows, launch blocking, degraded readiness, and fail-closed errors.
- Deriving runtime backend policy from canonical NanoCore decisions without making backend policy canonical.
- Current implementation projection across `@openkit/policy-kernel`, config policy, AEP policy blocks, gateway policy, OpenShell policy YAML, and approval lifecycle records.

## Does Not Own

- The internal policy-kernel graph algorithm.
- Authentication, identity session lifecycle, or membership storage.
- Approval UI copy or Action Center UI layout.
- Sandbox implementation details beyond derived policy input.
- Vault secret storage or credential injection mechanics.
- Audit event schema outside permission-decision linkage.

## Core References

- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
- `docs/core/agent-session.md`

## Goals

- Define the subject, action, resource, and context vocabulary used by NanoCore.
- Define `PermissionDecision` as the durable bridge between policy and product workflow.
- Map policy outcomes to allow, deny, approval, escalation, degraded launch, or blocked launch.
- Define how backend enforcement policy is derived from NanoCore decisions.
- Keep approval, sandbox, capability, vault, and audit boundaries distinct.

## Non-goals

- Do not change the policy kernel theory or package design in this spec.
- Do not redefine NGAC concepts through NanoCore product vocabulary.
- Do not make OpenShell policy YAML canonical.
- Do not define UI copy for policy decisions.
- Do not require a full organization role model in the first implementation.
- Do not preserve runtime-native approval prompts as the long-term permission model.

## Policy Fact Vocabulary

NanoCore product vocabulary is adapter input, not kernel truth. Subjects, actions, resources, and context MUST be translated into the standard-aligned NGAC subset owned by `docs/specs/20260629-openkit_policy_model.md`. Product actions may remain stable API names, but the policy-kernel request must evaluate the required NGAC access rights and restrictions rather than treating product actions as association rights.

Subjects:

- user
- service identity
- automation
- agent
- agent profile
- agent session
- worker sidecar
- MCP client
- external integration

Actions:

- call app API
- call MCP tool
- start worker session
- materialize workspace
- read workspace file
- propose workspace change
- apply workspace change
- call capability
- call LLM provider
- call external API
- use vault reference
- inject secret
- read knowledge
- propose knowledge change
- register artifact
- read artifact
- approve request
- change policy

Resources:

- server
- user
- workspace
- thread
- turn
- item
- artifact
- knowledge page
- source
- context package
- file path
- provider instance
- capability catalog entry
- MCP tool
- vault reference
- agent manifest
- AEP snapshot
- sandbox backend
- runtime pool

Context:

- core mode
- workspace membership
- agent session state
- package snapshot id
- requested runtime placement
- backend capability summary
- path sensitivity
- knowledge sensitivity
- provider category
- vault grant lifetime
- current approval state
- budget state
- request origin
- time and retention class

## PermissionDecision

`PermissionDecision` should carry:

- decision id
- policy engine version
- policy snapshot id
- subject summary
- action
- resource summary
- context summary
- result
- reason code
- enforcement point
- required approval kind when applicable
- approval id when applicable
- audit event id
- created timestamp

Decision results:

- `allow`
- `deny`
- `require_approval`
- `require_escalation`
- `defer`
- `not_applicable`
- `error`

Decisions are immutable.

## Enforcement Points

NanoCore should evaluate policy at:

- app API command handlers
- MCP operation handlers
- worker scheduling
- AEP resolution
- workspace materialization
- agent capability gateway projection
- LLM gateway
- vault grant resolution
- secret injection
- knowledge retrieval and read
- workspace review and apply
- artifact registration
- runtime teardown when destructive

Backend adapters enforce derived runtime policy, but they do not decide product authorization.

## Outcome Mapping

Policy outcome to product behavior:

| Decision | Product behavior |
| --- | --- |
| `allow` | Execute and audit. |
| `deny` | Reject, audit, and optionally create a blocked Action Center row. |
| `require_approval` | Create an approval gate and pause the operation. |
| `require_escalation` | Create a higher-authority attention row and do not execute. |
| `defer` | Mark the operation pending because required context is missing. |
| `not_applicable` | Continue to the next applicable policy domain. |
| `error` | Fail closed and audit the policy error. |

Approvals satisfy policy requirements; they do not replace policy.

## Approval Linkage

When policy requires approval, NanoCore creates:

- a permission decision with `require_approval`
- an approval request
- an Action Center row
- an audit event

When approval resolves, NanoCore records:

- approval decision
- responsible user
- policy requirement satisfied or denied
- follow-up permission decision when execution resumes

Runtime-native approval prompts may still be imported as item-backed requests, but the target model is policy-originated approval.

## Current Implementation Projection

The V1 enforcement bridge exists, but full alignment with the standard-aligned policy-kernel contract is partial:

- `packages/policy-kernel` implements the first standard-aligned NGAC subset evaluator over policy elements, assignments, process-to-user mappings, operation-to-access-right mappings, associations, prohibitions, and access requests. It returns `allow` or `deny` plus structural traces.
- `POLICY_CATALOG` in `packages/config-schema/src/policy.ts` governs config-layer override, merge, reload, and secret-handling behavior. It is separate from the product authorization policy engine targeted here.
- `packages/config-schema/src/agent-environment.ts` defines first-slice AEP policy blocks for filesystem, network, process, inference, secrets, artifacts, and resources, and requires every AEP policy block to carry a policy snapshot id.
- `apps/nanocore/src/bootstrap/policy.ts` maps the baseline NanoCore process to an NGAC user, loads a baseline boot policy kernel from `@openkit/policy-kernel`, and verifies minimum allow and restriction-deny behavior during NanoCore boot. A failed self-check fails the critical policy subsystem before product work is admitted.
- `apps/nanocore/src/policy/permission-decisions.ts` records the first durable product-level `PermissionDecision` rows. The current producer records boot policy self-check decisions for Core API allow and baseline vault-use deny in the server-scope `permission_decisions` table, linking low-level policy-kernel effects to product-shaped result, reason code, subject summary, resource summary, context summary, and enforcement point.
- `apps/nanocore/src/llm/gateway-routes.ts` enforces the runtime config's LLM Gateway enabled flag and provider allowlist directly, without a parallel process-local policy store. The routes record durable `PermissionDecision` rows for enabled/disabled and provider allowlist allow/deny outcomes through the same recorder; migration of that route-local evaluation to `@openkit/policy-kernel` remains future work.
- The local deterministic Goal Mode supervise route records a workspace-scoped durable `runtime.launch` allow decision in the owning `workspace.sqlite` before starting its worker turn through `startGoalTaskWorkerTurn`, giving the worker-launch path its first product permission-decision producer.
- `runWorkerTurnLoop` now records a workspace-scoped durable `runtime.launch` allow decision in the owning `workspace.sqlite` after creating the worker turn and before starting the worker boundary, so the real bounded worker loop also leaves a product permission-decision row.
- The governed worker executor stores the same first worker-launch policy snapshot id on the created agent session and the resolved AEP policy block, binding the durable session lineage and backend launch snapshot to the `runtime.launch` decision snapshot for that turn.
- `apps/nanocore/src/runtime/openshell-policy.ts` renders derived OpenShell filesystem, process, and network policy YAML from NanoCore runtime inputs.
- `recordProductPermissionDecision` persists the accepted product decision result set, including `require_approval` and `require_escalation`, fails closed when a `require_approval` decision does not name the required approval kind, and emits linked server- or workspace-scoped `AuditEvent` rows with `permissionDecisionId` filled. Server-owned decisions are exposed through `GET /api/app/permission-decisions`, `client.app.listServerPermissionDecisions`, `openkit.read_server_permission_decisions`, and `openkit://permission-decisions`; workspace-owned decisions are exposed through `GET /api/app/workspaces/:workspaceId/permission-decisions`, `client.app.listWorkspacePermissionDecisions`, `openkit.read_workspace_permission_decisions`, and `openkit://workspaces/{workspaceId}/permission-decisions`.
- `apps/nanocore/src/policy/approval-gates.ts` creates the first policy-originated approval gate by recording a `require_approval` permission decision, creating the matching `ApprovalRequest`, creating the item-backed `approval-request`, and pausing the turn with `humanGate.kind: "approval"` so the existing Action Center projection can surface it. No current enforcement point produces a `require_escalation` workflow or higher-authority Action Center row.
- The Git push executor now treats durable `repo.push` permission decisions as target-bound authority. Before invoking the Git command runner, `executeGitPushAttempt` requires an immutable workspace-scoped `allow` decision whose resource summary matches the current workspace id, repository resource id, and target branch, and it records a terminal `refused-policy` push record when the selected decision is missing or belongs to a different push target.
- `ApprovalStatus` in `packages/protocol/src/models/approval.ts` and `ApprovalDecision` in `apps/nanocore/src/runtime/types.ts` represent current approval states and decisions.
- App and runtime code already emits approval requests, approval decisions, and Action Center rows for human attention.

The V1 policy enforcement bridge is implemented as product workflow infrastructure. The boot policy kernel is a startup trust check plus the first kernel-backed durable decision producer; the LLM gateway, deterministic Goal Mode worker-launch path, real bounded worker-turn loop, governed worker session and AEP policy snapshot binding, durable approval/escalation result storage, first policy-originated approval gate helper, MCP approval-required tool gates, Git push approval gates, and target-bound Git push permission checks are the first non-boot product enforcement producers. Broader product fact mapping into standard-aligned `@openkit/policy-kernel` facts, a real fail-closed `require_escalation` workflow, every future product action, every future worker-session family, and complete backend enforcement material compilation remain future extensions over the same bridge.

## Backend Policy Derivation

NanoCore compiles derived backend policy from:

- permission decisions
- AEP snapshot
- vault grants
- capability catalog
- workspace materialization plan
- sandbox requirements
- runtime placement

For OpenShell, derived policy may become OpenShell policy YAML, provider attachments, network rules, and file rules.

Derived backend policy is evidence and enforcement material. It is not canonical OpenKit policy.

## Policy Snapshot

Each worker session should bind to a policy snapshot id.

The snapshot includes:

- policy kernel version
- relevant assignments
- relevant associations
- relevant access right mappings
- server policy
- workspace policy
- user restrictions when applicable
- request-time restrictions

If policy changes during a worker session, NanoCore decides whether:

- the change is dynamic and can update future checks
- the session should be marked stale
- the session must be interrupted
- the next bounded step must use a new snapshot

## Minimum Server-Mode Membership Facts

Server mode needs explicit membership facts before workspace policy can be enforced safely.

Minimum facts:

- authenticated actor id
- actor kind: user, service identity, automation, agent, sidecar, or integration
- responsible user id when an agent, automation, sidecar, or integration acts on behalf of a user
- workspace id
- membership status: active, invited, suspended, removed, or service-bound
- workspace role or policy principal set
- workspace owner or admin authority marker
- explicit grants and restrictions relevant to the request
- request origin: app, MCP, worker sidecar, internal scheduler, webhook, or integration
- policy snapshot id or policy version used for evaluation
- authentication assurance level when policy depends on it
- time and retention class when policy depends on it

If any required membership fact is unavailable, the permission outcome should be `defer` when the missing fact can be supplied by normal lookup, or `deny` when the missing fact means the actor is not authorized. Server mode must not silently fall back to local implicit-owner assumptions for workspace policy.

## Resolved Decisions

- Permission decision result names use underscores: `require_approval`, `require_escalation`, and `not_applicable`.
- Approval is not the permission engine. Approval may satisfy a policy requirement only when linked to a specific permission decision.
- Backend-native policy, including OpenShell policy YAML, is derived enforcement material and evidence. It is not canonical OpenKit policy.
- Policy snapshots should be file-backed for inspectability and replay, while immutable `PermissionDecision` rows may be SQLite source-of-truth ledgers for query and transactional enforcement.
- Launch must be blocked for denied runtime placement, workspace root access, secret injection, vault grant, sandbox containment, or required capability routing. Optional capability degradation may produce degraded readiness instead of blocking launch when policy marks the capability optional.
- Product diagnostics may include decision id, result, reason code, enforcement point, redacted subject/resource/context summaries, policy snapshot id, and matched policy ids. They must not expose secret values, unrestricted path lists, raw membership graphs, raw provider payloads, or sensitive source contents.
- Policy changes during an active worker session should update future checks when safe, mark the session stale when setup or resource assumptions changed, and interrupt or recycle the session when a newly denied high-risk action would otherwise remain possible.
- Server mode requires explicit actor, responsible user, workspace membership, role or principal, grant or restriction, request-origin, policy snapshot, assurance, and time facts before enforcing workspace policy. Missing required facts produce `defer` or `deny`, not implicit local-owner behavior.

## Deferred / Future Work

- Add full product fact mapping from NanoCore objects to `@openkit/policy-kernel` policy state and access requests.
- Add product-action to NGAC-access-right mapping before using product actions as kernel inputs.
- Extend or wrap the policy kernel itself to produce `require_approval`, `require_escalation`, `defer`, `not_applicable`, and policy errors instead of mapping those product outcomes in NanoCore helper code.
- Bind future worker-session families and future AEP snapshot producers to policy snapshot ids as they ship.
- Replace remaining runtime-native approval prompts with policy-originated approval gates when their owning runtime surfaces are migrated.
- Add policy-change handling for stale, interrupted, or recycled worker sessions.
- Compile complete backend enforcement material from canonical policy-kernel outcomes once full fact mapping exists.

## Testing Strategy

- Fact mapping tests for each product object family.
- Decision tests for allow, deny, approval, and escalation outcomes.
- Approval linkage tests proving approval satisfies a specific policy requirement.
- Capability gateway policy tests.
- Vault grant policy tests.
- OpenShell derived policy fixture tests.
- Fail-closed tests for policy engine errors.
- Audit linkage tests for every decision.

## Risks & Mitigations

- Risk: Approval stays runtime-driven forever. Mitigation: make policy-originated approval the target and treat runtime prompts as imported compatibility signals.
- Risk: OpenShell policy becomes product truth. Mitigation: store derived backend policy as evidence linked to NanoCore decisions.
- Risk: Policy vocabulary becomes too generic. Mitigation: use product nouns from core docs and keep every action resource-scoped.
- Risk: Decisions are hard to debug. Mitigation: retain redacted decision traces for development and audit.

## Links

- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
