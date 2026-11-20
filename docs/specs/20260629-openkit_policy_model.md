---
status: Accepted
implementation: Partial
kind: mechanism
aspect: policy
---
# OpenKit Policy Model

This specification owns the `@openkit/policy-kernel` package: the NGAC subset evaluator, its graph vocabulary, and its allow or deny decision.

## Scope

The package owns policy elements, assignments, associations, prohibitions, access requests, allow or deny decisions, and structural traces.

It does not own:

- Product enforcement, approvals, and durable permission decisions. [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) owns them.
- OpenShell policy rendering. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns it.
- Authentication and membership storage. [Identity](../core/identity.md) owns them.
- Secret values. [Vault](../core/vault.md) owns them.
- Knowledge content. [Knowledge](../core/knowledge.md) owns it.

Core: [Policy](../core/policy.md).

An implemented kernel concept matches NGAC definitions and terminology. The package does not claim complete NGAC conformance. An unimplemented NGAC definition stays out of the package.

## Naming

The shared package is named `@openkit/policy-kernel`, not `@openkit/ngac`.

The package is an OpenKit package. Its implemented kernel concepts are an NGAC-aligned subset. It does not claim complete NGAC conformance. Product and protocol surfaces use `knowledge.*` for knowledge capability and policy vocabulary.

## Boundary

`@openkit/policy-kernel` is a pure TypeScript package.

It owns:

- policy elements
- assignment and containment relations
- association-based grants
- explicit prohibitions
- access requests
- access decisions
- decision traces
- small deterministic evaluation algorithms

It must not own:

- NanoCore routes
- database storage
- HTTP handlers
- transport-neutral operation-catalog entries, bundled CLI commands, and remote MCP guidance
- worker-side MCP tools
- Web UI concepts
- OpenShell policy rendering
- vault secret values
- Knowledge Store content
- audit record persistence
- product-specific helper names

NanoCore or a future OpenKit policy adapter maps product objects into policy facts and maps policy decisions back into product-shaped responses.

## Relationship To OpenShell Runtime Policy

OpenKit's policy model and OpenShell's sandbox policy model operate at different layers.

`@openkit/policy-kernel` is the canonical low-level evaluator for OpenKit authorization facts after product adapters map them into standard-aligned NGAC facts. It answers graph-level questions such as whether a user, through a process when process context is relevant, holds the required access rights for a protected policy element in a workspace or policy domain.

OpenShell policy is a backend enforcement artifact. It constrains filesystem access, process identity, binary execution, network endpoints with authorized executable-and-descendant scope, credential projection, `inference.local` routing, and related sandbox behavior for one concrete worker runtime. [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape) defines that network scope and its observation limits.

The intended flow is:

1. `policy-kernel` evaluates OpenKit policy facts and returns an allow or deny decision with a structural trace.
2. NanoCore or a future OpenKit policy adapter maps the kernel decision, policy requirements, and request context into product workflow outcomes such as allow, deny, require human approval, create Action Center row, attach vault grant, or refuse runtime launch.
3. The Agent Environment Package and runtime materializer compile approved runtime intent into backend-native artifacts such as OpenShell `filesystem_policy`, `landlock`, `process`, `network_policies`, credential injections, and inference routing settings. Network projection preserves the resolved binary-path list, its executable-and-descendant scope, and the endpoint's exact destination and REST restrictions.
4. OpenShell enforces those artifacts inside the selected sandbox and returns backend evidence such as policy apply status, network deny events, supervisor logs, OCSF records, transcript files, artifacts, and collected workspace changes. Network enforcement matches the socket-owning executable or an executable in its observed ancestor chain against the grant's listed paths while enforcing the same endpoint restrictions.
5. NanoCore normalizes backend evidence back into OpenKit audit, usage, review, artifact, and worker session records.

OpenShell `0.0.99` is the current NanoHost release pin. The runtime has one loopback-only stock Gateway. Aggregate active-worker capacity is authored configuration owned by [Runtime Scheduling And Scale](20260703-durable_scheduler_design.md#scale-limits); its current default is 20. That capacity is not a Kernel limit. Each session keeps its own single-flight. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns the runtime topology.

Stock ancestor matching implements the authorized executable-and-descendant scope; it does not require a self-only matcher or custom rules ([decision](../decisions/20261004-egress_grant_descendant_scope.md)).

OpenShell must not become the canonical OpenKit permission model. Public App API, end-user CLI, Web UI, Action Center, storage records, and audit records must not require consumers to understand OpenShell-native sandbox ids, gateway names, provider handles, raw policy YAML, supervisor logs, or backend-private environment values.

The acceptable dependency is an adapter boundary: OpenKit-owned policy and runtime records compile into OpenShell-native artifacts, and OpenShell-native evidence normalizes back into OpenKit-owned records.

The unacceptable dependency is durable OpenKit product state or public protocol shapes that embed OpenShell policy YAML as the source of truth. NanoHost renders that YAML. The kernel does not import the renderer. The kernel does not authorize a Cell, an SSH path, Gateway forwarding, or a direct worker endpoint.

### Runtime Enforcement Responsibilities

NanoCore owns policy decisions, audit linkage, product lineage, approval workflow, and redacted user-facing explanations.

OpenShell owns sandbox-local runtime enforcement only for OpenShell-backed worker sessions. That enforcement includes backend isolation, file transport, filesystem policy, process policy, network policy, credential projection, and inference routing. The NanoHost is the sole OpenShell lifecycle authority; its Sandbox Integration projects worker-local APIs onto the distinct `/worker-control/*`, `/inference/*`, and `/capabilities/*` route families without merging their credentials or semantics. Runtime cleanup and uncertain-operation invalidation remain exclusively owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.

A publicly or remotely exposed Gateway, insecure Gateway mode, custom OpenShell binary, fork, patch, replacement artifact, custom multiplexer, or historical compatibility path is outside the runtime-policy contract.

Backend portability is capability-based. A backend that cannot enforce a required runtime policy capability, including the authorized executable-and-descendant scope and its destination and REST restrictions, should fail before launch with a redacted diagnostic instead of silently weakening OpenKit authorization guarantees.

### Decision And Enforcement Examples

If `policy-kernel` denies `vault.use` for an agent process, NanoCore must not materialize the corresponding OpenShell credential injection.

If `policy-kernel` allows `network.egress` to a specific provider endpoint, an OpenShell materializer may compile that into a `network_policies` endpoint entry scoped to the selected executables and their observed descendants, within the endpoint's exact destination and REST restrictions.

If OpenShell reports a network deny, NanoCore should treat that as backend enforcement evidence and may create audit or Action Center records, but the deny event does not rewrite the canonical OpenKit policy graph by itself.

If a human approval grants a temporary capability, NanoCore should record the approval, grant scope, expiry, and audit lineage in OpenKit-owned records before compiling any OpenShell runtime policy widening.

### Guardrails

- Do not treat OpenShell policy YAML as a persisted OpenKit permission record.
- Do not expose raw OpenShell policy YAML, gateway ids, sandbox ids, provider handles, or backend-private paths through public product APIs.
- Do not let dynamic OpenShell policy updates bypass NanoCore authorization, approval, vault grant, or audit recording.
- Do not use OpenShell service forwarding as the canonical OpenKit worker control channel.
- Do not require `@openkit/policy-kernel` to import OpenShell types, render OpenShell YAML, shell out to OpenShell, or know backend-specific policy schema fields.
- Do not assume OpenShell enforcement exists in future non-OpenShell backends.
- Keep generated OpenShell policy files as derived materialization output that can be regenerated from OpenKit-owned state.

## Core Vocabulary

### Policy Element

A policy element is a typed node in the authorization graph. Kernel-internal policy elements MUST follow NGAC policy element membership: users, user attributes, object attributes including objects, and policy classes.

The closed element-kind set is `PolicyElementKind` in `packages/policy-kernel/src/index.ts`.

An agent Turn supplies the actual process context for the evaluated principal. A direct User request may omit process context; adapters MUST NOT invent a Turn. Processes are not policy elements. When a product request has process context, adapters MUST represent it through NGAC process-to-user facts and process-scoped restrictions rather than assigning a process into the policy element graph. The terms `userAttribute` and `objectAttribute` are inherited from NGAC. OpenKit-facing adapters may project friendlier names such as subject group, capability group, resource group, trust domain, or policy domain.

For an agent principal, request facts MUST resolve the responsibility chain defined by [Policy](../core/policy.md#subject). The Kernel MUST check that its terminal human remains current and authorized over the domain. A broken or no-longer-authorized chain suspends the agent's grants until human reassignment. This check supplies no inherited human rights and does not change the process-to-user relation.

### Assignment

An assignment states that one element is contained by another element. If a user is assigned to a user attribute, that user inherits the attribute's policy meaning. If an object is assigned to an object attribute, access rules over that object attribute may apply to that object. If an attribute is assigned to a policy class, it belongs to that trust domain.

The standard-aligned kernel target treats assignments as directed containment edges, validates NGAC assignment constraints, and computes transitive closure from request policy elements.

### Association

An association allocates access rights from a user attribute to an attribute. In OpenKit terms, it is the positive authorization fact behind "users contained by this user attribute may hold these access rights over policy elements represented by this target attribute."

The standard-aligned kernel target treats associations as `UA × 2AR × AT`, where `AT = UA ∪ OA`. A request can be allowed only when the relevant user is contained by the association's user attribute, the requested operation's required access rights are present in the association's access right set, and the target policy element is contained by the association target attribute under the applicable policy-class semantics.

### Prohibition

A prohibition is an explicit deny. It removes or blocks privileges that would otherwise be granted by associations.

OpenKit needs prohibitions for agent safety because many cases are "generally allowed except in this context." Examples include a worker that may read workspace files except secret-bearing paths, an agent that may use network egress except private IP ranges, or a user who may inspect audit summaries but not raw credential mediation events.

The standard-aligned kernel models prohibitions as NGAC restrictions over access rights. User-based, process-based, and user-attribute-based prohibitions use conjunctive or disjunctive inclusion and exclusion ranges. Prohibitions win over privileges when the matching NGAC restriction exists.

### Operation And Access Right

An operation is a requested mode of access. An access right is the authorizable unit of authority used in NGAC associations and restrictions. OpenKit adapters own the product operation namespace. The kernel evaluates access rights. It does not treat a product operation as an association right. The product operation set is `PRODUCT_OPERATION_ACCESS_RIGHTS` in `packages/config-schema`.

### Decision

A policy decision is the result of evaluating a request against policy state.

The closed low-level effect set is `PolicyDecisionEffect` in `packages/policy-kernel/src/index.ts`. That boundary is pure allow or deny.

OpenKit adapters may map a kernel decision plus product policy requirements into `PermissionDecision` results such as `require_approval`, `require_escalation`, `defer`, `not_applicable`, or `error`. Those are product permission outcomes, not low-level policy-kernel effects.

### Decision Trace

A decision trace explains why a request was allowed or denied. It records the subject closure, object closure, matching associations, matching prohibitions, and reason codes. Missing privilege and a matching prohibition MUST remain distinguishable. The Kernel trace uses `missing-privilege` and `restriction`; the product adapter maps them to `not_granted` and `prohibited`, respectively. The product adapter preserves `require_approval` as a separate requirement reason; the Kernel does not emit a product approval result.

A product API redacts a trace before exposing it to a user or an agent.

## NGAC Coverage Matrix

| NGAC or Policy Machine Concept | Subset | Implementation Rule |
| --- | --- | --- |
| Policy elements | in subset | Typed element records. |
| Assignment relation | in subset | Transitive containment closure and relation validation for the NGAC assignment relation. |
| Association relation | in subset | Access right allocation from user attributes to attributes. |
| Derived privileges | in subset | Derive at decision time from assignment closure, access rights, associations, and policy-class semantics. |
| Prohibitions | in subset | User, process, and user-attribute restrictions over access rights with conjunctive and disjunctive attribute ranges. |
| Policy classes | in subset | Elements, plus the NGAC policy-class semantics required for derived privileges. |
| Access request decision function | in subset | Evaluate process or user, operation, object or policy element, required access rights, privileges, restrictions, and trace. |
| Process context | Existing subset, including native Goal/Task projection | Map the actual process to the evaluated principal's NGAC user element, outside the policy-element graph. Record the responsible human separately for accountability; that identity supplies no inherited rights. |
| Agent principal accountability | Bounded agent-gate subset | Validate the finite, acyclic responsibility chain and current terminal human domain authority under Policy; suspend grants on failure until human reassignment. General grants are outside this subset. |
| Administrative operations | Native human Policy candidate path | The `policy.write` review path is owned by Policy Enforcement Mapping. Full standard administrative routines remain outside the implemented subset. |
| Obligations | outside this subset | `react` participation after successful access stays out until later activation under the defining author's current authority. Commit obligations such as credential injection are not NGAC post-success Policy obligations. |
| Dynamic policy mutation | Native human Policy update | The evaluator receives immutable state and stays pure and synchronous. The Policy owner validates and commits new revisions outside it. |
| Delegated administration | Native Goal-domain and bounded Coordinator subset | Plan approval creates a delegated Goal domain administered by the Coordinator under Policy. This does not claim full standard delegated-administration support. |
| Functional architecture entities | outside this subset | PEP, PDP, PAP, PIP, RAP, and EPP are not public OpenKit product concepts. |
| Standards-level API and full conformance | outside this subset | The package claims only the implemented NGAC subset. It does not claim complete ANSI/INCITS NGAC compatibility. |

## Joint Goal-Domain Publication

The Coordinator proposes the exact inactive Goal-domain delegation with its exact Plan in one existing approval Pending Request. `governedIntent.goalDomain` contains the full typed `PolicyDelegationV1Schema` statement and `policyDigest(statement)`. Its purpose is `goal-domain`; its source identifies the Workspace, Goal, Plan version, exact Plan digest and approval request. A single authenticated human approves the joint preview. A separate human Policy candidate/apply is not required. Plan or Task-card prose supplies no authority.

After the Goal transaction commits, the native Policy owner rereads that request and requires resolved, granted, finished and approved-executed. It verifies the exact current active Plan and retained bytes, the capture digest and source, the actual deciding user and full deciding credential context, and that user's current authority over the declared resources and actions. It may stamp the authenticated deciding human and decision time as author/authority/authoredAt. Approved scope, lifetime, delegate and source do not widen. The Goal's responsible human remains separate from the deciding human.

The existing Policy collection and sole configuration CAS own publication. Existing PermissionDecision and Audit writers record its admission; reload must admit the saved revision before current readback supplies authority. Goal SQL completion and Policy publication are separate effects. A publication failure grants no Task authority, and a retry inspects current recorded state. No second grant store, receipt or recovery loop exists.

The native read path rechecks the exact Plan, deciding credential, lifetime and saved/loaded revision on each use. An obsolete Plan, closed Goal, ended lifetime or lost human authority supplies no domain; a failed dependency read is an error. The close path withdraws only the Goal's statements and remains available after its old Plan or credential ends. Its current inactive statement prevents reactivation through the old approval. A new joint Plan approval may replace the Goal-owned identity. Generic Server Policy candidates must preserve these statements; the Goal owner supplies publication and withdrawal.

Acceptance requires one joint human approval, no authority before successful publication, current readback inside Task admission, refusal after the human or Plan loses authority, closure without the old human credential, and truthful CAS/reload failures. Native consumers of that publication do not establish complete Goal acceptance. The Goal owner retains that acceptance.

## OpenKit Policy Domains

OpenKit adapters should map product surfaces into these policy domains.

### API Domain

The API domain governs which users or clients may call App API, remote MCP and administrator CLI operations, automation, and future channel operations.

### Workspace Domain

The workspace domain governs workspace visibility, workspace settings, repository links, workspace files, and workspace-level defaults.

### Agent Domain

The agent domain governs which agent processes may act in a workspace, which tools they receive, which runtime they may launch, and which thread or turn they may affect.

### Tool Domain

The tool domain governs remote MCP and administrator CLI operations, worker-side MCP tools, local tools, shell-like tools, browser tools, filesystem tools, and future external tools.

### Knowledge Domain

The knowledge domain governs who or what may read, write, propose, approve, redact, supersede, archive, or delete Knowledge Store records. Knowledge policy must distinguish human-visible knowledge, agent-injectable knowledge, private notes, sensitive sources, and review-pending proposals.

### Audit Domain

The audit domain governs audit summary access, raw audit event access, evidence access, usage records, and policy decision traces.

### Vault Domain

The vault domain governs vault reference use and administration. Secret values must never be represented as ordinary policy objects. The policy object is a vault reference, credential capability, or mediation permission, not the secret material itself.

### Artifact Domain

The artifact domain governs report, diff, patch, evidence, generated file bundle, design asset, and exported document access.

### Runtime Domain

The runtime domain governs container launch, local or remote placement, backend selection, backend capability requirements, and future managed-runtime placement decisions.

#### Governed Repair Action

`repair.model-call` v1 is a restricted Policy action for the authenticated repair role under a bounded current grant. Bind the original actor, attempt and invocation to a kernel step. Check that grant and its current scope at the final effect boundary. The ordinary role context and a model-supplied identity confer no repair authority. Revocation denies new calls. Keep Policy, Vault and shared Budget predicates independent. A Policy allow or linked `permission.decision` event does not by itself reserve a call or permit Provider contact. Use the [Gateway repair owner](20260526-llm_gateway_responses_api.md#governed-repair-call) for reservation and [Audit](20260703-audit_usage_evidence_records.md#server-work-publication-and-kernel-repair-evidence) for evidence.

Channel publication permission is decided by Policy under current User, Workspace, request and destination authority. Communication establishes the binding and applicable disclosure; it does not issue a Policy grant. Historical Audit and restored bindings cannot supply current authority.

### Network Domain

The network domain governs network targets, provider egress, package registries, Git hosts, private IP ranges, and external API reachability.

## Target Package API

The package exports a low-level evaluator. Input facts map to NGAC terms. They do not redefine those terms.

```ts
evaluateAccess(policyState, request): PolicyDecision
```

A product adapter translates product terms into those kernel facts. The names `canCallApi`, `canUseTool`, `canReadKnowledge`, `canWriteKnowledge`, `canProposeKnowledge`, `canReadAudit`, `canUseVaultRef`, `canAccessArtifact`, `canEgressTo`, and `canApplyWorkspaceReview` are not exported API promises.

## Performance Model

Each `evaluateAccess` builds its lookup maps for that call. `PolicyDecision.trace` is required output. The package has no public prepared-snapshot index and no trace-suppression API.

## Explanation And Redaction

The policy kernel returns structural traces. These traces are not automatically safe to expose.

NanoCore, the transport-neutral operation catalog, bundled CLI, remote MCP, worker-side MCP, Web, and audit APIs must project traces into redacted product reasons. A product response may say that a subject lacks `tool.use` on a tool in the workspace, but it should not leak hidden policy graph nodes, vault reference metadata, private knowledge labels, or internal runtime topology.

## Package Acceptance Criteria

The package proves allow through assignment plus association over access rights, deny when the required right is absent, and validation of the implemented assignment pairs. A process is not a policy element. An operation is not an access right. A decision includes a trace that distinguishes a missing privilege from a prohibition.

## Security Principals And Context Envelopes

Agent operations MUST evaluate the agent grant intersected with the on-behalf-of principal's current authority and context envelope. Only an explicitly established agent-initiated trigger context omits the on-behalf-of grant; missing initiators elsewhere refuse execution. Existing responsibility, domain and credential restrictions remain mandatory.

The Kernel uses existing proposal attributes for surface, conversation, initiative and destination audience. The preset set is closed: owner direct message, Workspace members, agent-initiated, and external group. The first three are the v0.1.0 set. External-group activation is not part of this subset. Every shared-Thread or channel reply MUST bound reads by its `OutputAudience` before generation.

Editable defaults MUST include the investigation principal's read-and-propose grant, the review principal's input-disclosure-only grant, the trigger's delegated grant, a separate fixed alarm grant, and the separately approved deterministic containment preset. Restrict-only gates contribute no allow or approval and need no shadow period.

Every `policy.write` MUST classify the full resulting diff, including deleted prohibitions and weakened gates. Every widened element MUST fit the author's current effective authority, and authors MUST NOT approve their own widening. Writes MUST retain scope and classification in Audit. [Runtime Security](20261109-runtime_security.md) defines the statements, presets, and gate behavior. [Policy](../core/policy.md) remains the semantic owner.

The containment preset MUST apply only narrowing changes to the exact suspect principal/run and exclusively owned resources. The distinct acting automation accepts only validated sensor/execution facts, not untrusted material or model proposals. It gains no generic Policy editing, widening or recovery authority; readers retain no effect/egress grant. Current responsibility/domain checks and the full-diff ceiling remain mandatory. [Runtime Security](20261109-runtime_security.md#deception-and-a1-containment-e12) owns its operations and stop/recovery rules.

Route-group switches are administrator-scoped denies on exact registered operation families/resources, enforced at admission and the final effect boundary. Mapping stays in the existing operation catalog; switch state stays in Server Policy. Shared-surface flips and every clearing decision require a person in v0.1.0 ([runtime switch contract](20261109-runtime_security.md#route-group-switches-e13)).

### Quarantine Lifetime

[Policy](../core/policy.md#delegated-goal-domain-and-statement-lifetime) admits a restrict-only exception to author-bound expiry. Represent it in the existing lifetime object: `anchor.owner` is Server, `anchor.kind` is `quarantine`, `anchor.id` is the original trusted sensor AuditEvent id. The lifetime MUST omit both `notAfter` and `uses`. Policy rejects a quarantine-anchored statement that carries notAfter or uses. The exact target remains in the statement's existing scope; author, authority and activation revision preserve original provenance. No new field, table, record or allocation is added. `quarantine` is the single new retained lifetime anchor value.

At activation, current Policy validates the approved template, author/delegation, scope, exclusion and cumulative caps. After commit, author/delegation revocation, monitor stop, source-run end, restart and review deadline processing MUST NOT release this prohibition. The mandatory review/escalation deadline lives in the existing `control.deadlineUnixNano` of a non-effect `human-wait` step in the containment consumer's Server journal. It is not a Policy expiry. Missing or late handling can delay a reminder but cannot lift the deny. Action steps keep their separate bounded deadlines; the review step extends no effect authority. Human review may keep the restriction or explicitly release it through the full-diff widening check. Deadlines never restore credentials or resume execution. Ordinary grants and statement lifetimes retain their existing semantics. An allow, binding or delegation using this value is invalid; an unsupported required anchor kind fails closed.

Acceptance rejects quarantine statements carrying `notAfter`, `uses`, or both. Exercise generic expiry processing against a valid quarantine with neither field; it remains effective. Test a missing, late or elapsed journal review deadline without releasing quarantine. Also prove delegation loss, monitoring off, restart and action-deadline expiry after both failed and unknown stops. Every case preserves the deny while refusing new unauthorized actions; only a current authorized human may clear it.

## Implementation

- `packages/policy-kernel/`
- `apps/nanocore/src/policy/`
- `apps/nanocore/src/bootstrap/`
- `apps/nanohost/src/`

## Implementation Gaps

- Restricted repair-model admission - The `repair.model-call` v1 action and its separation of permission from shared Budget reservation await implementation - #766

- General agent-principal grants beyond the bounded gate - not implemented - #152
- A generic `policy.write` retains no classification, and direct narrowing apply is absent - unmet on main - #627
- External-group preset activation - not active - #720
- Post-success `react` participation - excluded until a later activation - #375

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [Unified mediation and policy](../decisions/20261018-unified_mediation_and_policy.md)
- [Egress grant descendant scope](../decisions/20261004-egress_grant_descendant_scope.md)
