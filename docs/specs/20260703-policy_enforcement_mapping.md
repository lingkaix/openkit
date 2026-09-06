---
status: Accepted
implementation: Partial
---
# Policy Enforcement Mapping

## Summary

This spec maps the OpenKit policy kernel into NanoCore product enforcement.

The clean target is one policy truth and many enforcement points. `@openkit/policy-kernel` owns standard-aligned NGAC subset authorization semantics. NanoCore maps product objects into NGAC facts, records decisions, creates approval gates when policy requires them, and compiles derived backend policy for OpenShell or future runtimes.

## Owns

- Product fact vocabulary for mapping NanoCore subjects, actions, resources, and context into policy evaluation.
- `PermissionDecision` as the durable bridge between policy evaluation, product workflow, approvals, audit, and backend policy derivation.
- Mapping policy decisions to product behavior, approval gates, Action Center rows, launch blocking, degraded readiness, and fail-closed errors.
- Deriving runtime backend policy from canonical NanoCore decisions without making backend policy canonical.
- Current implementation projection across `@openkit/policy-kernel`, config policy, AEP policy blocks, gateway policy, structured OpenShell policy, and approval lifecycle records.

## Does Not Own

- The internal policy-kernel graph algorithm.
- Authentication, identity session lifecycle, or membership storage.
- Workspace invitation, owner-transfer, and fixed product-role lifecycle.
- Approval UI copy or Action Center UI layout.
- Sandbox implementation details beyond derived policy input.
- Vault secret storage or credential injection mechanics.
- Audit event schema outside permission-decision linkage.

## Core References

- `docs/core/permissions.md`
- `docs/core/identity.md`
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
- Do not make OpenShell policy artifacts canonical.
- Do not define UI copy for policy decisions.
- Do not add organizations, tenants, custom roles, groups, or a second RBAC engine; the first implementation projects the fixed owner/editor/viewer product roles into the policy kernel.
- Do not preserve runtime-native approval prompts as the long-term permission model.

## Policy Fact Vocabulary

NanoCore product vocabulary is adapter input, not kernel truth. Subjects, actions, resources, and context MUST be translated into the standard-aligned NGAC subset owned by `docs/specs/20260629-openkit_policy_model.md`. Product actions may remain stable API names, but the policy-kernel request must evaluate the required NGAC access rights and restrictions rather than treating product actions as association rights.

Subjects:

- user
- service identity
- automation
- agent
- agent profile
- AgentSession
- worker shim
- external integration

Actions:

- call app API
- invoke an Agent Skill operation
- invoke a worker-supplied tool
- manage workspace membership
- transfer workspace ownership
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
- import, introduce, or create an artifact through its owning operation
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
- workspace membership status and fixed access level
- AgentSession state
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

## V1 Product Operation And Access-Right Registry

The following registry is the unique owner of the closed V1 product-operation to access-right mapping for centralized Workspace authorization and the governed effects already named by current specifications. A concrete public operation maps to exactly one primary product operation below. Operation identifiers and access-right identifiers are intentionally distinct. Fixed-role associations are owned separately by `docs/specs/20260715-multi_user_workspace_system.md` and may only narrow through current policy and lifecycle facts.

| Product operation | Required access right | Operation boundary |
| --- | --- | --- |
| `api.call` | `ar:core-api-call` | Boot and deployment API calls. |
| `workspace.read` | `ar:workspace-read` | Ordinary Workspace content and collection reads. |
| `workspace.write` | `ar:workspace-write` | Ordinary Workspace content mutation. |
| `thread.read` | `ar:thread-read` | Thread, Turn-status, and event reads. |
| `turn.run` | `ar:turn-run` | Turn start, steering, interrupt, and retry admission. |
| `artifact.read` | `ar:artifact-read` | Artifact metadata, content, and review-list reads. |
| `artifact.write` | `ar:artifact-write` | Artifact import, introduction, and accepted mutation. |
| `review.apply` | `ar:review-apply` | Human review decisions; exact eligibility remains with the durable review owner. |
| `approval.respond` | `ar:approval-respond` | Human Approval response; exact eligibility remains with the durable Approval owner. |
| `knowledge.read` | `ar:knowledge-read` | Knowledge reads and retrieval. |
| `knowledge.write` | `ar:knowledge-write` | Knowledge authority mutation. |
| `knowledge.propose` | `ar:knowledge-propose` | Knowledge proposal creation. |
| `audit.read` | `ar:audit-read` | Audit, usage, evidence, backend-handle, and permission-decision readback. |
| `workspace.configure` | `ar:workspace-configure` | Repository, data-source, agent-supply, and Workspace policy configuration; Vault is excluded. |
| `workspace.export` | `ar:workspace-export` | Portable Workspace export. |
| `workspace.lifecycle` | `ar:workspace-lifecycle` | Archive, delete, and ordinary ownership transfer. |
| `membership.manage` | `ar:membership-manage` | Invitation creation or revocation and non-owner membership access or removal; ownership transfer is excluded. |
| `invitation.respond` | `ar:invitation-respond` | List the authenticated user's own invitations and accept or decline one exact bound invitation before membership exists. |
| `workspace.leave` | `ar:workspace-leave` | Active non-owner self-removal. |
| `deployment.recover` | `ar:deployment-recover` | Explicit deployment-administrator recovery only; never ordinary content access. |
| `vault.use` | `ar:vault-use` | Target-issued Vault grant use. |
| `vault.admin` | `ar:vault-admin` | Existing owner-only Workspace Vault reference list/rebind and non-secret grant, injection-plan, and injection-receipt listing. It does not authorize a grant issue/revoke surface. |
| `tool.use` | `ar:tool-use` | Governed tool invocation. |
| `tool.grant` | `ar:tool-grant` | Tool or capability grant administration. |
| `runtime.launch` | `ar:runtime-launch` | Governed worker launch. |
| `network.egress` | `ar:network-egress` | Governed external network access. |
| `llm.gateway.use` | `ar:llm-gateway-use` | Workspace-attributed public LLM Gateway use. |
| `repo.push` | `ar:repo-push` | Approval-gated repository publication. |

A handler may enforce a durable lifecycle precondition such as exact invitee, responsible user, expected revision, or winning Approval claimant, but it must not define a competing role table. Ownership transfer maps only to `workspace.lifecycle`; the existing Workspace Vault reference list/rebind and `VaultGrant`, `VaultInjectionPlan`, and `VaultInjectionReceipt` metadata lists map only to `vault.admin`; `VaultUse` and other audit, usage, evidence, backend-handle, and permission-decision reads map only to `audit.read`. None of those read permissions turns evidence into injection authority.

Mutation posture is separate from the product operation. It describes whether a public request may change protected product state or cause an external effect and is the authority for `workspace-readonly` token enforcement. It MUST NOT be inferred from the HTTP method. Incidental redacted audit or usage evidence does not turn an otherwise read-only operation into a content mutation, while an operation such as Knowledge retrieval may be marked mutating when its accepted contract updates authoritative indexes or traces.

Owner-only reads, user-scoped invitation discovery and response, self-leave, and deployment recovery demonstrate why neither HTTP method nor a generic `workspace.read` or `workspace.write` split is sufficient. Owner-visible member and invitation collections map to `membership.manage`; the authenticated invitee's own invitation collection and exact accept or decline map to `invitation.respond`. A new product-operation family or access-right identifier requires an owning-spec update before it is added to runtime metadata. A route-level authorization allow never substitutes for a deeper effect check such as `runtime.launch`, `vault.use`, `network.egress`, or `repo.push`.

## PermissionDecision

`docs/core/permissions.md` owns the `PermissionDecision` definition and closed result categories. This specification projects that concept with these exact fields:

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

Decisions are immutable.

When one governed effect depends on multiple mandatory policy inputs, NanoCore first omits neutral `not_applicable` inputs when at least one policy domain applies, then combines the applicable Core-owned results with the exact precedence `error > deny > require_escalation > require_approval > defer > not_applicable > allow`. Missing mandatory facts and mandatory evaluation failures map to `error`; all-`not_applicable` inputs produce `not_applicable`; and `allow` is valid only when every applicable mandatory input allows. Only the final `allow` authorizes the effect. Every other result blocks it, and all-`not_applicable` blocks because no applicable authority allowed the effect. A producer that evaluates only one policy input records that single result and does not imply that absent mandatory inputs allowed the effect.

A portable Workspace import preserves immutable permission decisions and their linked Approval rows only as historical evidence. `apr_imported_` and `grant_imported_` are reserved non-authorizing import namespaces and target-side authority creation rejects them. An effect consumer MUST require current-deployment authority: any decision linked to the Approval remint, any Vault grant carrying the VaultGrant remint, and any effect decision missing the target-issuance identity required by its owning contract is non-authorizing regardless of target repository or Vault-reference re-binding. The enforcement point applies one stateless target-issuance predicate before external mutation or secret resolution; it does not rewrite history, synthesize a deny row, infer missing origin, or create an import-specific policy state machine. Fresh target-issued authority is the only promotion path.

## Enforcement Points

NanoCore should evaluate policy at:

- the centralized workspace access resolver before any workspace-addressed handler performs lookup or mutation
- app API command handlers
- worker MCP capability handlers
- worker scheduling
- AEP resolution
- workspace materialization
- agent capability gateway projection
- LLM gateway
- vault grant resolution
- secret injection
- knowledge retrieval and read
- workspace review and apply
- artifact import, introduction, or verified worker-output creation
- runtime teardown when destructive

Backend adapters enforce derived runtime policy, but they do not decide product authorization.

The centralized Workspace request resolver uses the low-level kernel only for a transient `allow` or `deny`. Missing registry, membership, role, token, lineage, policy, or dependency facts and any policy-evaluation error fail closed as the same non-enumerating access denial. This ordinary request check never creates `defer`, a pending workflow, an Action Center row, an Approval, or a per-request durable `PermissionDecision`. Existing enforcement points that intentionally own a governed effect may continue to record their accepted durable decisions and linked redacted audit evidence. Stage 4 adds no access-decision ledger or new audit owner.

## Outcome Mapping

Policy outcome to product behavior:

| Decision | Product behavior |
| --- | --- |
| `allow` | Execute and audit. |
| `deny` | Reject, audit, and optionally create a blocked Action Center row. |
| `require_approval` | Create an approval gate and pause the operation. |
| `require_escalation` | Create a higher-authority attention row and do not execute. |
| `defer` | Mark the operation pending because required context is missing. |
| `not_applicable` | Continue evaluation in another mandatory policy domain; if none applies, retain `not_applicable` and block because no authority allowed the effect. |
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

The V1 enforcement bridge exists, but full alignment with the standard-aligned policy-kernel contract remains partial:

- `packages/policy-kernel` implements the first standard-aligned NGAC subset evaluator over policy elements, assignments, process-to-user mappings, operation-to-access-right mappings, associations, prohibitions, and access requests. It returns `allow` or `deny` plus structural traces.
- `POLICY_CATALOG` in `packages/config-schema/src/policy.ts` governs config-layer override, merge, reload, and secret-handling behavior. It is separate from the product authorization policy engine targeted here.
- `packages/config-schema/src/agent-environment.ts` defines first-slice AEP policy blocks for filesystem, network, process, inference, secrets, artifacts, and resources, and requires every AEP policy block to carry a policy snapshot id.
- `apps/nanocore/src/bootstrap/policy.ts` maps the baseline NanoCore process to an NGAC user, loads a baseline boot policy kernel from `@openkit/policy-kernel`, and verifies minimum allow and restriction-deny behavior during NanoCore boot. A failed self-check fails the critical policy subsystem before product work is admitted.
- `apps/nanocore/src/policy/permission-decisions.ts` records the first durable product-level `PermissionDecision` rows. The current producer records boot policy self-check decisions for Core API allow and baseline vault-use deny in the server-scope `permission_decisions` table, linking low-level policy-kernel effects to product-shaped result, reason code, subject summary, resource summary, context summary, and enforcement point.
- `apps/nanocore/src/llm/gateway-routes.ts` enforces the runtime config's LLM Gateway enabled flag and provider allowlist directly, without a parallel process-local policy store. The routes record durable `PermissionDecision` rows for enabled/disabled and provider allowlist allow/deny outcomes through the same recorder; migration of that route-local evaluation to `@openkit/policy-kernel` remains future work.
- The local deterministic Goal Mode supervise route records a workspace-scoped durable `runtime.launch` allow decision in the owning `workspace.sqlite` before starting its worker turn through `startGoalTaskWorkerTurn`, giving the worker-launch path its first product permission-decision producer.
- `runWorkerTurnLoop` now records a workspace-scoped durable `runtime.launch` allow decision in the owning `workspace.sqlite` after creating the worker turn and before starting the worker boundary, so the real bounded worker loop also leaves a product permission-decision row.
- The governed worker executor stores the same first worker-launch policy snapshot id on the created AgentSession and the resolved AEP policy block, binding the durable session lineage and backend launch snapshot to the `runtime.launch` decision snapshot for that turn.
- `apps/nanocore/src/runtime/openshell-policy.ts` validates NanoCore-authored filesystem and network intent and projects it as the structured policy consumed by NanoHost. NanoHost strictly parses that input into the current OpenShell SDK type before requesting a sandbox, so malformed, unknown, or unsupported policy fails before an OpenShell effect.
- `recordProductPermissionDecision` persists the accepted seven-value product decision result set, including `require_approval` and `require_escalation`, fails closed when a `require_approval` decision does not name the required approval kind, and emits linked server- or workspace-scoped `AuditEvent` rows with `permissionDecisionId` filled. Current producers record individual outcomes; no shared implementation currently combines multiple mandatory results under the Core precedence, so a future multi-input enforcement point must add that conformance before admitting effects. Server-owned decisions are exposed through `GET /api/app/permission-decisions`, `client.app.listServerPermissionDecisions`, and the unified Skill/CLI `permission.server-list` operation; workspace-owned decisions are exposed through `GET /api/app/workspaces/:workspaceId/permission-decisions`, `client.app.listWorkspacePermissionDecisions`, and the unified Skill/CLI `permission.workspace-list` operation.
- `apps/nanocore/src/policy/approval-gates.ts` creates the first policy-originated approval gate by recording a `require_approval` permission decision, creating the matching `ApprovalRequest`, creating the item-backed `approval-request`, and pausing the turn with `humanGate.kind: "approval"` so the existing Action Center projection can surface it. No current enforcement point produces a `require_escalation` workflow or higher-authority Action Center row.
- The Git push executor now treats durable target-issued `repo.push` permission decisions as target-bound authority. Before invoking the Git command runner, `executeGitPushAttempt` requires an immutable workspace-scoped `allow` decision whose resource summary matches the current workspace id, repository resource id, and target branch and whose linked Approval id is not the portable-import remint; it records a terminal `refused-policy` push record when the selected decision is missing, imported, or belongs to a different push target. Secret-injection plan creation applies the same target-issuance predicate to the VaultGrant id, so Vault-reference re-binding cannot reactivate an imported grant.
- `ApprovalStatus` in `packages/protocol/src/models/approval.ts` and `ApprovalDecision` in `apps/nanocore/src/runtime/types.ts` represent current approval states and decisions.
- App and runtime code already emits approval requests, approval decisions, and Action Center rows for human attention.

The V1 policy enforcement bridge is implemented as product workflow infrastructure. The boot policy kernel is a startup trust check plus the first kernel-backed durable decision producer; the LLM gateway, deterministic Goal Mode worker-launch path, real bounded worker-turn loop, governed worker session and AEP policy snapshot binding, durable approval/escalation result storage, first policy-originated approval gate helper, Git push approval gates, and target-bound Git push permission checks are the first non-boot product enforcement producers. Broader product fact mapping into standard-aligned `@openkit/policy-kernel` facts, a real fail-closed `require_escalation` workflow, every future product action, every future worker-session family, and complete backend enforcement material compilation remain future extensions over the same bridge.

## Backend Policy Derivation

NanoCore compiles derived backend policy from:

- permission decisions
- AEP snapshot
- vault grants
- capability catalog
- workspace materialization plan
- sandbox requirements
- runtime placement

For OpenShell, derived policy may become structured sandbox policy, credential injections, network rules, and file rules.

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
- actor kind: user, deployment administrator, service identity, automation, agent, worker shim, or integration
- responsible user id when an agent, automation, worker shim, or integration acts on behalf of a user
- workspace id
- current membership status: active or removed
- fixed product access: owner, editor, or viewer
- owner authority derived from the canonical workspace registry rather than a second membership-role copy
- current token workspace binding and scope when a bearer token is used
- explicit grants and restrictions relevant to the request
- request origin: app, bundled CLI, Agent Skill, worker tool, internal scheduler, webhook, or integration
- policy snapshot id or policy version used for evaluation
- authentication assurance level when policy depends on it
- time and retention class when policy depends on it

If any required membership fact is unavailable to the ordinary centralized Workspace resolver, it denies the request. `defer` is available only to an already accepted governed workflow whose owning specification defines how the missing fact becomes available; it is not a request-authorization fallback. Server mode must not silently fall back to local implicit-owner assumptions for Workspace policy.

Invitation state is not active membership and must never satisfy a Workspace access request. A `server-admin` credential proves deployment-administration authority only; it does not synthesize Workspace membership or an owner/editor/viewer role. Any future break-glass content path requires a separate accepted design, an explicit reason, a bounded grant, and durable audit.

The fixed product roles are adapter vocabulary. The centralized resolver converts the authenticated actor, current membership, owner relationship, token intersection, action, resource, and request context into one policy-kernel request. Handlers consume that decision and must not reimplement role tables or rely on route path/body heuristics.

## Resolved Decisions

- Permission decision result names use underscores: `require_approval`, `require_escalation`, and `not_applicable`.
- Approval is not the permission engine. Approval may satisfy a policy requirement only when linked to a specific permission decision.
- Backend-native policy, including structured OpenShell sandbox policy, is derived enforcement material and evidence. It is not canonical OpenKit policy.
- Policy snapshots should be file-backed for inspectability and replay, while immutable `PermissionDecision` rows may be SQLite source-of-truth ledgers for query and transactional enforcement.
- Launch must be blocked for denied runtime placement, workspace root access, secret injection, vault grant, sandbox containment, or required capability routing. Optional capability degradation may produce degraded readiness instead of blocking launch when policy marks the capability optional.
- Product diagnostics may include decision id, result, reason code, enforcement point, redacted subject/resource/context summaries, policy snapshot id, and matched policy ids. They must not expose secret values, unrestricted path lists, raw membership graphs, raw provider payloads, or sensitive source contents.
- Policy changes during an active worker session should update future checks when safe, mark the session stale when setup or resource assumptions changed, and interrupt or recycle the session when a newly denied high-risk action would otherwise remain possible.
- Server mode requires explicit actor, responsible user, Workspace membership, role or principal, grant or restriction, request-origin, policy snapshot, assurance, and time facts before enforcing Workspace policy. Missing required facts deny ordinary requests; only an owning governed workflow may use its explicitly accepted `defer` outcome.
- Owner/editor/viewer are fixed product roles projected into the NGAC-aligned kernel, not a second authorization engine.
- Deployment-administrator authority and Workspace content authority are separate; `server-admin` has no implicit content bypass.

## Deferred / Future Work

- Extend the accepted V1 product-operation registry only when a new owning specification introduces a materially different authorization family.
- Add broader product fact mapping from NanoCore objects to `@openkit/policy-kernel` policy state and access requests outside the fixed-role Workspace authorization slice.
- Extend or wrap the policy kernel itself to produce `require_approval`, `require_escalation`, `defer`, `not_applicable`, and policy errors instead of mapping those product outcomes in NanoCore helper code.
- Bind future worker-session families and future AEP snapshot producers to policy snapshot ids as they ship.
- Replace remaining runtime-native approval prompts with policy-originated approval gates when their owning runtime surfaces are migrated.
- Add policy-change handling for stale, interrupted, or recycled worker sessions.
- Compile complete backend enforcement material from canonical policy-kernel outcomes once full fact mapping exists.

## Testing Strategy

- Fact mapping tests for each product object family.
- Decision tests for allow, deny, approval, and escalation outcomes.
- Approval linkage tests proving only a target-issued approval satisfies a specific policy requirement and imported authority remains readable but effect-inert after repository or Vault re-binding.
- Capability gateway policy tests.
- Vault grant policy tests.
- OpenShell derived-policy tests that assert NanoCore-authored intent, trust-boundary rejection, and acceptance of the structured fixture by NanoHost's current SDK parse boundary.
- Fail-closed tests for policy engine errors.
- Audit linkage tests for every decision.
- Role-matrix tests for owner, editor, viewer, removed member, invitee, unrelated user, token-bound actor, and deployment administrator.
- Coverage tests proving every workspace-addressed public operation declares the metadata consumed by the centralized resolver.

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
- `docs/specs/20260715-multi_user_workspace_system.md`
