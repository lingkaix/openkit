---
status: Accepted
implementation: Partial
kind: concept
date: 2026-09-22
---
# Delegated Worker Policy Maintenance

## Owns

The bounded class of non-secret worker sandbox/network configuration that an internal operator may inspect, compare, validate and apply under a responsible administrator's delegated maintenance authority; candidate admission, revision binding, revocation, partial outcomes and acceptance of those operations.

## Does Not Own

General Permissions, a new grant store, the internal agent loop, policy language/compiler, AEP authority, Vault secrets or grants, command/evidence storage, Task retry, storage purge, image activation, deployment management or service recovery. Shared failure explanations remain owned by the reliability and evidence specifications.

## Core References

[Permissions](../core/permissions.md), [Sandbox](../core/sandbox.md), [Architecture](../core/architecture.md), [Agent Capability](../core/agent-capability.md), [Audit](../core/audit.md), [Vault](../core/vault.md), [Storage](../core/storage.md), and [Foundation](../core/foundation.md).

## Summary

Simon accepted bounded delegated worker policy maintenance on 2026-09-22: an internal operator may choose and apply ordinary non-secret corrections within explicit administrator-defined workload/resource limits without per-candidate human confirmation. On 2026-10-15, [D06 accepted the first finite apply scope](../decisions/20261015-cleanup_pinning_and_delegated_apply_rulings.md): registered Worker network-policy Git-read corrections only. This owner and the administration owners admit that exact exception. The finite candidate, Policy and application path is implemented; real Sandbox enforcement qualification remains separate.

## Goals / Non-goals

Permit in-system correction of authorized worker network policy without a generic shell or repeated candidate confirmation. Preserve exact authorization, retained data, source audiences and honest unknown results. Whole-service NanoHost/NanoCore recovery, credential injection and widening the operator's authority are non-goals.

## Background

A Git smart-HTTP refusal can arise from a sandbox policy mismatch or an upstream refusal. Configuration comparison alone cannot establish the historical enforcement cause. Diagnosis must remain useful before delegated application exists.

## Decision

Represent maintenance authority in existing Permissions/Policy assignments and evaluation context. Do not create a delegation-token service, grant database, maintenance journal or second configuration writer. The administration owners apply the finite exception below; every other configuration effect keeps its existing human-confirmed boundary.

## Contract / Expected Behavior

### Definition And Authority

Delegation names target Agent/Workspace scope, permitted workload purposes, endpoint/port/protocol and method/resource limits, eligible actions, validity and revocation conditions. It permits independently selecting a correction inside that ceiling, never changing the ceiling itself. Current responsible-administrator authority is rechecked for each effect; local/server identity remains owned by Permissions. Source access and destination audience are independently enforced.

The operator MUST NOT change its own authority, Vault grants, TLS verification, containment boundaries, resource audiences, arbitrary service control or other reserved effects. Git-read path repair cannot authorize push, unrestricted egress or injecting credentials into credential-free materialization. A template difference is not drift without a known intended baseline, and a template update cannot expand delegation.

### First Registered Target And Action

The first delegated application is limited to correcting Git smart-HTTP read rules in the network policy of an existing registered Worker Agent configuration. The exact source identity and affected resource scope come from the existing configuration registry. No caller selects a host path. A Server-owned Agent change is evaluated against its Server scope and all affected scope restrictions; a single Workspace reference cannot authorize a broader effect. Other target families and Worker changes remain outside delegated application.

Reuse the administration configuration capabilities: `administration.configuration.read` inspects the registered Agent source and revision; `administration.schema.read` exposes the allowed change shape; `administration.configuration.propose` takes the registered Agent identity, expected source revision, exact proposed network-rule correction and originating failure reference, validates it and publishes the existing immutable candidate Artifact with its before/after semantic comparison. Comparison and validation are steps of this existing proposal owner, not new writers, stores or independent execution lifecycles. The admitted change shape can alter only `sandbox.network` Git-read rules; no other Agent field or credential binding can change. The candidate retains its exact source scope, revision, normalized change, failure lineage and permitted Git-read purpose.

Admit `administration.configuration.apply` as one additional fixed Tool in the private administration entry only for this candidate class. Its model input contains a command request identity and the exact existing candidate reference (Artifact identity, version and digest); it contains no caller-supplied actor, authorization decision, delegation ceiling or raw replacement file. It invokes the existing configuration application command and revision-protected file owner. App API and administrator CLI projections use that same semantic command. Existing Provider and Gateway candidates still require their exact human confirmation and cannot be applied through this delegated Tool. An inadmissible candidate returns a safe refusal without a write.

The effect context is server-derived and binds the responsible currently authorized administrator, authenticated credential restrictions, internal entry and Thread/Turn, registered source identity and full affected scope, operation `administration.configuration.apply`, purpose `git-read`, exact candidate reference and base revision, originating failure, current Policy assignments and decision snapshot, and the current time. Existing Permissions/Policy must explicitly allow this actor, target, purpose, rule endpoints, ports, protocols, methods, paths, action and validity interval within the administrator-defined ceiling. Current administrator status, ordinary `api.call`, a template match, or model prose alone cannot supply that delegation. Missing, expired, revoked, conflicting or unevaluable mandatory facts fail closed. The Tool cannot write its own authority. No new delegation grant store, token, maintenance journal or generic policy language is admitted.

Recheck that context, exact candidate and source revision immediately before the existing command dispatches a mutation. This bounded Policy allow replaces per-candidate human confirmation only for the admitted Git-read correction. It cannot authorize Git push, unrestricted egress, TLS bypass, credential injection, containment or audience changes, service control, or changes to the operator's own Tools or authority. Configuration validation also checks the complete resulting source, preserving every unrelated authored field and existing denied route. A correction must not turn a Git read grant into a broader write grant.

This is the finite [D06 ruling](../decisions/20261015-cleanup_pinning_and_delegated_apply_rulings.md), not general configuration or host authority.

### Finite Candidate And Failure Evidence

The Agent proposal branch names `targetFamily: agent`, the exact registered `targetId`, `expectedRevision`, `failure: { workspaceId, threadId, turnId }` and `changes: { networkGrantId, rules }`. The rule list is the complete prospective rule list of that existing explicit REST grant, not a replacement Agent document. Endpoint, binary, TLS, credentials and all other change keys are excluded. Existing shorthand grants are outside this first correction shape. Existing non-Git rules retain their exact order and values; eligible Git-read rules are replaced with the failed input repository's GET `info/refs*` and POST `git-upload-pack` pair. The current boundary does not enforce query values, so this contract makes no service-query inspection claim. Unknown authored descriptive sibling fields are preserved in the source.

NanoCore resolves the audience-checked terminal failed Turn, its registered Agent, its exact AgentSession and named retained AEP snapshot. The snapshot must match that Turn, Thread, Agent and AgentSession. Its Git input must be unique because the shared failure record does not identify which of several inputs failed. The input must use an exact credential-free HTTPS repository URL without query, fragment or path aliases. Missing, mismatched or ambiguous lineage refuses the candidate; model selection cannot supply missing causal evidence. The existing structured Git explanation proves an observed failed fetch only, with enforcement cause unavailable. The candidate retains `failureEvidence: { agentSessionId, snapshotId, snapshotDigest, repositoryInputId, explanationDigest }`; the digests bind the retained snapshot and normalized known-field explanation. No failure registry is created.

Candidate preparation requires current administrator, source and private destination authority and the finite correction shape. It does not grant application authority. Application revalidates that same failure evidence, source identity, exact base and semantic after-view; the private projection additionally requires the current loaded finite Policy assignment and trusted current invocation. The Artifact's origin remains source evidence and cannot substitute for the current invocation Turn. Provider and Gateway candidates sent to the private apply projection refuse before dispatch. A human-confirmed Agent candidate uses the same bounded validation and sole writer through the public command, with explicit human authority instead of delegated authority.

### Candidate And Application Lifecycle

Creation records a candidate against an exact registered target and base revision, with its originating failure, permitted purpose and semantic comparison. Validation resolves current target and authority, checks the candidate against the delegated ceiling and binds exact candidate identity to the permission decision. Application uses the existing revision-protected configuration command owner, not a direct file write by a Tool. Existing command receipts, AuditEvents and evidence retain actor, scope, base/candidate/template identities, semantic diff, permission decision, persisted result and reload outcome. Projections do not become a second durable authority.

Immediately before mutation, recheck current authority, candidate identity and base revision. A stale or changed base fails with conflict; expired or revoked authority fails before new dispatch. Missing target, missing authority, invalid candidate or inaccessible source fails closed. An in-flight effect still settles truthfully after revocation. Cancellation before dispatch performs no mutation; after dispatch it cannot claim the effect was undone.

Persistence and reload are separate outcomes. A persisted candidate whose reload fails remains visibly persisted but not loaded; retain last-known-good loaded state under the configuration owner. Lost response or restart requires inspection of the exact command receipt and current authored/loaded revisions. Reuse an exact available receipt; never regenerate a request or reapply an unknown effect. Rollback is a new authorized revision-protected correction, never automatic overwrite of intervening changes.

No running AEP, process environment or historical failed Turn is rewritten. Verify loaded configuration, then permit only a fresh authorized Task after existing cleanup/storage admission accepts it. The new Task proves its own in-sandbox materialization and cannot retroactively establish the original failure's cause. Retained bytes survive.

### Executable Policy Assignment Dependency

Implementation of delegated application depends on the existing Permissions/Policy assignment owner providing an executable assignment and evaluation path for this exact actor, registered target, full affected scope, `git-read` purpose, action, rule bounds, and validity/revocation conditions. The executable assignment and adapter are owned by [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md#finite-worker-git-read-maintenance-assignment), not by this amendment. Until the owning mechanism can produce the exact current allow, delegated apply fails closed. Administrator status, ordinary `api.call`, a template comparison, model prose, and a parallel grant store are not substitutes.

P12 owns shared schema/operation composition, P01 owns configuration persistence, and the administration caller owner owns its entry assembly. Register the bounded Worker candidate branch and its full-source validation in those existing owners before enabling the Tool. Existing Provider/Gateway candidates retain human confirmation. This named dependency blocks delegated execution only; diagnosis and candidate preparation may proceed through their current contracts.

## Proposed Design

Admit finite inspect, compare, validate and apply capabilities into the existing private administration entry, using shared Core implementations for App API, administrator CLI and internal Tool projections. The existing configuration target registry, optimistic revisions, reload semantics, Policy evaluation, command ledger and audit/evidence records remain unique owners. No maintenance runner or new durable lifecycle is proposed.

## Current Implementation Projection

The fixed private administration set includes the finite Git-read apply Tool. It uses the existing configuration candidate and command owners, current loaded finite Server assignment, existing NGAC evaluator, immutable PermissionDecision, linked Audit and revision-protected file writer. Retained-failure, assignment, source, cancellation, receipt replay and reload outcomes have local regression coverage. Real in-Sandbox materialization is still required before claiming enforcement qualification. Other administration application remains human-confirmed.

## Alternatives Considered

Per-candidate human confirmation remains the current implementation but does not fulfill accepted bounded delegation. Generic host shell, implicit template synchronization, broad egress and secret-bearing diagnostics are rejected because they bypass target scope, authority or confidentiality. A new maintenance store would duplicate existing owners.

## Consequences

Routine authorized corrections can become autonomous after operation admission, while consequential expansion still requires its existing owner. Honest partial/unknown outcomes can require inspection instead of automatic repair.

## Rollout / Migration Plan

Implement only the accepted finite Git-read action with the matching Chat Mode and Internal Agent Resource Integration boundaries. Reuse existing configuration, Policy, receipt, and Audit owners. Retain all unrelated administrator-confirmed operations and add no compatibility path.

## Testing Strategy / Acceptance Criteria

An authorized correction of nested Git smart-HTTP paths must persist the exact candidate, expose reload status, and let a new Task materialize its requested commit under sandbox policy. Unauthorized endpoints, push methods, TLS bypass, self-expansion, revoked/expired authority and changed revisions must reject before mutation. Tests must distinguish persisted/reload-failed, lost response, restart inspection and new-request retry. Secret canaries must not appear in evidence, APIs, model input or telemetry. A real sandbox observation, not a host fetch or compiler-derived expected value, decides enforcement acceptance.

Acceptance includes valid delegated Git read, an otherwise identical candidate without delegation, revoked and expired delegation, out-of-scope target, stale source, changed candidate, a Provider/Gateway candidate sent to the delegated Tool, unrelated-field changes, Git push or widened egress, credential/TLS changes, separate persistence and reload failure, exact receipt replay, changed-input conflict and unknown-result inspection without another write. Real Sandbox qualification remains required for enforcement claims; configuration or unit tests alone do not establish a historical cause or working network access.

## Risks & Mitigations

Adversarial diagnostics cannot expand Tools or permissions. Closed normalized evidence, exact revision binding, current source/destination authorization and independently derived policy expectations constrain repair. Dead control/execution services retain existing deployment/human recovery limits; no in-process Tool promises to recover its own failed service.

## Open Questions

None for the accepted Git-read scope. Other delegated targets and actions are outside this contract.

## Deferred / Future Work

Implementation supplies only the admitted Git-read maintenance scope. Full enforcement correlation and product recovery journey remain separate slices. NanoHost/NanoCore whole-service recovery is explicitly deferred and is not an availability promise of this specification.

## Links

[Chat Mode Assistant](20260704-chat_mode_assistant.md), [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md), [Configuration And Identity](20260628-nanocore_config_identity_contract.md), [Worker Reliability](20260531-worker_turn_reliability_envelope.md).
