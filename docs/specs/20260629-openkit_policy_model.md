---
status: Accepted
implementation: Implemented
---
# OpenKit Policy Model

## Summary

This spec defines the `@openkit/policy-kernel` package contract: a strict NGAC subset evaluator for OpenKit policy facts, access rights, low-level allow or deny decisions, and structural decision traces.

It keeps canonical product permission semantics in `docs/core/permissions.md` and leaves NanoCore enforcement mapping, approval routing, Action Center behavior, backend policy artifacts, and durable permission-decision records to `docs/specs/20260703-policy_enforcement_mapping.md`.

## Purpose

OpenKit needs one coherent authorization model for API access, workspace work, agent capabilities, unified Skill operations, worker-side MCP tools, knowledge, audit, vault references, artifacts, runtime placement, network egress, and future workspace services. This document defines a policy model that follows NGAC and Policy Machine definitions for every implemented kernel concept while keeping OpenKit's product language focused on workspace, agent, tool, approval, vault, knowledge, audit, and review concepts.

The goal is not to implement or claim the complete NGAC standard. OpenKit MAY leave NGAC definitions, functions, relations, and functional entities unimplemented. The rule is stricter for implemented concepts: any NGAC concept implemented by `@openkit/policy-kernel` MUST match NGAC definitions, standard terminology, and described semantics instead of becoming an OpenKit-specific redesign.

This spec owns the policy-kernel model and package boundary. `docs/core/permissions.md` owns the canonical product permission concept, and `docs/specs/20260703-policy_enforcement_mapping.md` owns how NanoCore maps policy decisions into product workflow, approvals, Action Center rows, backend policy artifacts, and durable permission-decision records.

## Owns

- The `@openkit/policy-kernel` package concept and scope.
- The selected NGAC graph vocabulary used inside the policy kernel.
- Policy elements, assignments, associations, prohibitions, access requests, allow/deny decisions, and structural traces.
- OpenKit operation namespaces and policy domains at the conceptual level.
- The boundary between canonical OpenKit authorization semantics and derived backend enforcement artifacts.
- The first package API and package-level acceptance criteria.

## Does Not Own

- NanoCore enforcement-point mapping, durable `PermissionDecision` records, approval routing, or Action Center behavior.
- OpenShell policy YAML rendering, sandbox policy files, or backend-specific enforcement schemas.
- Authentication, identity sessions, membership storage, organization roles, or UI copy.
- Vault secret values, Knowledge Store content, audit record persistence, runtime session storage, or protocol record schemas.
- Runtime scheduling, workspace synchronization, agent capability gateway routing, or AEP resolution.
- Runtime Epoch lifecycle, OpenShell operations, Sandbox Integration, or runtime transport, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- Product-level `PermissionDecision` result categories beyond the low-level kernel's allow or deny effect.

## Core References

- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/vault.md`
- `docs/core/knowledge.md`
- `docs/core/agent-capability.md`
- `docs/core/sandbox.md`

## Product Fit

OpenKit's architecture already assigns permission decisions, sandbox policy summary, agent capability routing and gateway projection, vault reference mediation, storage coordination, audit, and usage records to Core. The product model also makes workspace the top-level product environment that controls permissions, vault references, sandbox defaults, and audit scope. A unified policy model belongs below those Core surfaces and above storage, routes, runtime adapters, and user interfaces.

The model must serve product needs without making users think in NGAC terms. Product surfaces should continue to show ordinary concepts such as workspace access, agent capabilities, tool grants, approvals, vault usage, knowledge visibility, audit visibility, artifact access, and network policy.

## Naming

The shared package is named `@openkit/policy-kernel`, not `@openkit/ngac`.

This name is intentional. The package is an OpenKit package, not a general-purpose NGAC product surface, but its implemented kernel concepts must be an NGAC-standard-aligned subset. The package must document deferred concepts and must not suggest complete NGAC standards conformance.

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
- transport-neutral operation-catalog entries, bundled CLI commands, and unified Skill guidance
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

OpenShell policy is a backend enforcement artifact. It constrains filesystem access, process identity, binary execution, network endpoints, credential projection, `inference.local` routing, and related sandbox behavior for one concrete worker runtime.

The intended flow is:

1. `policy-kernel` evaluates OpenKit policy facts and returns an allow or deny decision with a structural trace.
2. NanoCore or a future OpenKit policy adapter maps the kernel decision, policy requirements, and request context into product workflow outcomes such as allow, deny, require human approval, create Action Center row, attach vault grant, or refuse runtime launch.
3. The Agent Environment Package and runtime materializer compile approved runtime intent into backend-native artifacts such as OpenShell `filesystem_policy`, `landlock`, `process`, `network_policies`, credential injections, and inference routing settings.
4. OpenShell enforces those artifacts inside the selected sandbox and returns backend evidence such as policy apply status, network deny events, supervisor logs, OCSF records, transcript files, artifacts, and collected workspace changes.
5. NanoCore normalizes backend evidence back into OpenKit audit, usage, review, artifact, and worker session records.

This layering is compatible with the accepted OpenShell-first target. Official, unmodified OpenShell `0.0.99` is the first-class target container backend inside the configured NanoHost's private Runtime Epoch, with one loopback-only stock Gateway and the current one active worker slot. It should strongly influence runtime policy materialization, provider vocabulary, endpoint declarations, binary allowlists, and enforcement evidence without becoming lifecycle authority outside the NanoHost.

OpenShell must not become the canonical OpenKit permission model. Public App API, end-user CLI, Web UI, Action Center, storage records, and audit records must not require consumers to understand OpenShell-native sandbox ids, gateway names, provider handles, raw policy YAML, supervisor logs, or backend-private environment values.

The acceptable dependency is an adapter boundary: OpenKit-owned policy and runtime records compile into OpenShell-native artifacts, and OpenShell-native evidence normalizes back into OpenKit-owned records.

The unacceptable dependency is durable OpenKit product state or public protocol shapes that embed OpenShell policy YAML as the source of truth.

### Runtime Enforcement Responsibilities

NanoCore owns policy decisions, audit linkage, product lineage, approval workflow, and redacted user-facing explanations.

OpenShell owns sandbox-local runtime enforcement only for OpenShell-backed worker sessions. That enforcement includes backend isolation, file transport, filesystem policy, process policy, network policy, credential projection, and inference routing. The NanoHost is the sole OpenShell lifecycle authority; its Sandbox Integration projects worker-local APIs onto the distinct `/worker-control/*`, `/inference/*`, and `/capabilities/*` route families without merging their credentials or semantics. Runtime cleanup and uncertain-operation invalidation remain exclusively owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.

A publicly or remotely exposed Gateway, insecure Gateway mode, custom OpenShell binary, fork, patch, replacement artifact, custom multiplexer, or historical compatibility path is outside the runtime-policy contract.

Other backends may enforce the same OpenKit decisions through different artifacts. For example, Docker may use container options and copied workspaces, Kubernetes may use pod security context and network policy, and a hosted sandbox may use provider file APIs and managed egress rules.

Backend portability is capability-based. A backend that cannot enforce a required runtime policy capability should fail before launch with a redacted diagnostic instead of silently weakening OpenKit authorization guarantees.

### Decision And Enforcement Examples

If `policy-kernel` denies `vault.use` for an agent process, NanoCore must not materialize the corresponding OpenShell credential injection.

If `policy-kernel` allows `network.egress` to a specific provider endpoint, an OpenShell materializer may compile that into a `network_policies` endpoint entry scoped to selected binaries.

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

The standard-aligned kernel target supports these element kinds:

- `user`: an authenticated human, service identity, automation identity, or product actor mapped into NGAC user semantics.
- `object`: a protected resource instance.
- `userAttribute`: a container for users or other user attributes.
- `objectAttribute`: a container for objects or other object attributes.
- `policyClass`: a trust domain or policy boundary.

Processes are not policy elements. When a product request has process context, adapters MUST represent it through NGAC process-to-user facts and process-scoped restrictions rather than assigning a process into the policy element graph. The terms `userAttribute` and `objectAttribute` are inherited from NGAC. OpenKit-facing adapters may project friendlier names such as subject group, capability group, resource group, trust domain, or policy domain.

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

An operation is a requested mode of access. An access right is the authorizable unit of authority used in NGAC associations and restrictions. OpenKit adapters own the product operation namespace, but the kernel MUST evaluate access rights rather than treating product operations as association rights.

Expected OpenKit operation families include:

- `api.call`
- `workspace.read`
- `workspace.write`
- `thread.read`
- `turn.run`
- `artifact.read`
- `artifact.write`
- `review.apply`
- `tool.use`
- `tool.grant`
- `knowledge.read`
- `knowledge.write`
- `knowledge.propose`
- `audit.read`
- `vault.use`
- `vault.admin`
- `runtime.launch`
- `network.egress`

### Decision

A policy decision is the result of evaluating a request against policy state.

The low-level kernel returns:

- `allow`
- `deny`

OpenKit adapters may map a kernel decision plus product policy requirements into `PermissionDecision` results such as `require_approval`, `require_escalation`, `defer`, `not_applicable`, or `error`. Those are product permission outcomes, not low-level policy-kernel effects.

### Decision Trace

A decision trace explains why a request was allowed or denied. It records the subject closure, object closure, matching associations, matching prohibitions, and reason codes.

Decision traces are required for development, tests, audit projection, and future support tooling. Product APIs must redact traces before exposing them to users or agents.

## NGAC Coverage Matrix

| NGAC or Policy Machine Concept | OpenKit Status | Implementation Rule |
| --- | --- | --- |
| Policy elements | Implement now | Implement as typed element records. |
| Assignment relation | Implement now | Implement transitive containment closure and relation validation for the NGAC assignment relation. |
| Association relation | Implement now | Implement access right allocation from user attributes to attributes. |
| Derived privileges | Implement now | Derive at decision time from assignment closure, access rights, associations, and policy-class semantics. |
| Prohibitions | Implement now | Implement user, process, and user-attribute restrictions over access rights with conjunctive and disjunctive attribute ranges. |
| Policy classes | Implement now | Represent as elements and implement the NGAC policy-class semantics required for derived privileges. |
| Access request decision function | Implement now | Evaluate process or user, operation, object or policy element, required access rights, privileges, restrictions, and trace. |
| Administrative operations | Document and defer | Do not implement full admin routines until product policy administration needs them. |
| Obligations | Model and defer | Reserve the concept for event-triggered audit, Action Center, cleanup, and temporary grant workflows, but do not mutate policy state automatically in the first package. |
| Dynamic policy mutation | Defer | Policy state is caller-supplied and immutable from the evaluator's perspective. |
| Delegated administration | Defer | Future team and organization work may need this. |
| Functional architecture entities | No current plan | Do not make PEP, PDP, PAP, PIP, RAP, or EPP public OpenKit product concepts unless a future product need requires it. |
| Standards-level API and full conformance | No current plan | Do not claim complete ANSI/INCITS NGAC compatibility. Claim only the implemented NGAC subset that is verified against the standard. |

## OpenKit Policy Domains

OpenKit adapters should map product surfaces into these policy domains.

### API Domain

The API domain governs which users or clients may call App API, unified Skill and bundled CLI operations, automation, and future channel operations.

### Workspace Domain

The workspace domain governs workspace visibility, workspace settings, repository links, workspace files, and workspace-level defaults.

### Agent Domain

The agent domain governs which agent processes may act in a workspace, which tools they receive, which runtime they may launch, and which thread or turn they may affect.

### Tool Domain

The tool domain governs unified Skill operations, worker-side MCP tools, local tools, shell-like tools, browser tools, filesystem tools, and future external tools.

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

### Network Domain

The network domain governs network targets, provider egress, package registries, Git hosts, private IP ranges, and external API reachability.

## Target Package API

The package exports a low-level generic evaluator. The evaluator API may stay product-neutral, but its input facts must map to NGAC terms without redefining them.

```ts
evaluateAccess(policyState, request): PolicyDecision
```

Future OpenKit adapters should provide product-shaped helpers over the low-level evaluator. These helpers may use product terms such as agent process, tool, vault reference, and network target, but the adapter must translate those terms into standard-aligned kernel facts.

```ts
canCallApi(subject, apiOperation)
canUseTool(agentProcess, tool, workspace)
canReadKnowledge(subject, knowledgeRecord)
canWriteKnowledge(subject, knowledgeRecord)
canProposeKnowledge(subject, proposal)
canReadAudit(subject, auditRecord)
canUseVaultRef(agentProcess, vaultRef, operation)
canAccessArtifact(subject, artifact, operation)
canEgressTo(agentProcess, networkTarget)
canApplyWorkspaceReview(subject, review)
```

Business code should prefer product-shaped helpers once they exist. New ad hoc authorization checks should not be added for domains already covered by policy adapters.

## Performance Model

The first evaluator may compute closures directly because expected policy states are small. Future adapters should add snapshot indexes before high-volume route integration.

Expected indexes:

- element id to element
- child id to parent assignments
- subject attribute to associations
- object attribute to associations
- user, process, or user attribute to prohibitions
- object id to object closure
- subject id to subject closure

Decision traces may be collected by default for package tests and early development. Future hot paths may expose a trace mode so production callers can choose compact decisions when full traces are unnecessary.

## Explanation And Redaction

The policy kernel returns structural traces. These traces are not automatically safe to expose.

NanoCore, the transport-neutral operation catalog, bundled CLI, unified Skill, worker-side MCP, Web, and audit APIs must project traces into redacted product reasons. A product response may say that a subject lacks `tool.use` on a tool in the workspace, but it should not leak hidden policy graph nodes, vault reference metadata, private knowledge labels, or internal runtime topology.

## Package Acceptance Criteria

The package is acceptable when:

- It compiles as a workspace package.
- It has local `AGENTS.md` and `README.md`.
- It tests allow decisions from NGAC assignment plus association over access rights.
- It tests deny decisions when no association grants the required access rights.
- It tests NGAC assignment relation validation for implemented assignment pairs.
- It does not model processes as policy elements.
- It does not collapse operations and access rights.
- It returns decision traces that make the result explainable.

## Follow-Up Integration Plan

After the package is standard-aligned, the next work should add an OpenKit adapter layer in NanoCore or a separate package. The first integration should be low risk and easy to verify, such as NanoCore App API authorization enforcement or a network egress policy summary.

The integration should not begin by migrating every permission check. It should prove that the policy kernel reduces duplicated authorization logic and produces clearer deny reasons before broader adoption.

The first runtime-policy integration should map one OpenKit policy decision into one OpenShell materialization artifact without making OpenShell canonical. Good candidates are `network.egress` for additional OpenShell endpoint policy entries, `runtime.launch` for selecting a container placement or backend, or `vault.use` for deciding whether a credential injection may be included in the Agent Environment Package.

## Current Implementation Projection

The current package implements the first standard-aligned subset in this spec:

- `packages/policy-kernel` exists as `@openkit/policy-kernel`.
- The current package implements typed NGAC policy elements, assignments, associations, operation-to-access-right mappings, user/process/user-attribute prohibitions, process-to-user mappings, access requests, allow or deny decisions, and structural traces.
- The current package uses `user` rather than product-level `principal`, and processes are mapped to users instead of being modeled as policy elements.
- The current package grants NGAC access rights from associations and evaluates product operations only through their required access rights.
- The current package implements prohibition restrictions over access rights with conjunctive or disjunctive inclusion and exclusion ranges.
- Tests cover allow through NGAC assignment plus association over access rights, deny without a required access right, process-to-user mapping outside the policy element graph, user-attribute association targets, assignment relation validation, and process prohibition restrictions.
- NanoCore depends on `@openkit/policy-kernel` during boot through `apps/nanocore/src/bootstrap/policy.ts`, which maps the baseline process to an NGAC user, loads a baseline policy state, and verifies minimum allow and restriction deny behavior before product work is admitted.
- NanoCore records the boot policy self-check decisions into durable `PermissionDecision` rows through `apps/nanocore/src/policy/permission-decisions.ts`; broader product enforcement integration remains owned by the policy enforcement mapping spec.
- The kernel intentionally does not produce `require_approval`, `require_escalation`, `defer`, `not_applicable`, or `error` outcomes. Those are product enforcement outcomes owned by the policy enforcement mapping spec.
- NanoCore does not yet route all product authorization through `@openkit/policy-kernel`; that integration remains tracked by `docs/specs/20260703-policy_enforcement_mapping.md` rather than by this package-level policy model spec.
- OpenShell policy YAML rendering exists as derived runtime policy code in NanoCore, not as a dependency of `@openkit/policy-kernel`.
- Current product and protocol surfaces use `knowledge.*` naming for knowledge-related capability and policy vocabulary.

The Runtime Epoch and stock RelayStream plus nested standard HTTP/2 transport are implemented by NanoHost. The policy kernel and derived OpenShell policy renderer remain policy projections and do not authorize a Cell, SSH, Gateway-forward, or direct worker endpoint alternative.

## Deferred / Future Work

- Add product-shaped policy adapters over the low-level evaluator.
- Add durable policy snapshot identity and policy state loading.
- Add NanoCore enforcement-point integration through `PermissionDecision` records.
- Add product-safe trace redaction helpers.
- Add indexes for higher-volume policy evaluation paths.
- Add administrative policy update APIs only after product policy administration needs are explicit.
