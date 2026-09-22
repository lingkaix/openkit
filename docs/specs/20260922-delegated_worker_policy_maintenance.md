---
status: Draft
implementation: Not Started
date: 2026-09-22
---
# Delegated Worker Policy Maintenance

## Owns

The proposed bounded class of non-secret worker sandbox/network configuration that an internal operator may inspect, compare, validate and apply under a responsible administrator's delegated maintenance authority; candidate admission, revision binding, revocation, partial outcomes and acceptance of those operations.

## Does Not Own

General Permissions, a new grant store, the internal agent loop, policy language/compiler, AEP authority, Vault secrets or grants, command/evidence storage, Task retry, storage purge, image activation, deployment management or service recovery. Shared failure explanations remain owned by the reliability and evidence specifications.

## Core References

[Permissions](../core/permissions.md), [Sandbox](../core/sandbox.md), [Architecture](../core/architecture.md), [Agent Capability](../core/agent-capability.md), [Audit](../core/audit.md), [Vault](../core/vault.md), [Storage](../core/storage.md), and [Foundation](../core/foundation.md).

## Summary

Simon accepted bounded delegated worker policy maintenance on 2026-09-22: an internal operator may choose and apply ordinary non-secret corrections within explicit administrator-defined workload/resource limits without per-candidate human confirmation. This Draft preserves that accepted governing boundary while leaving finite operation admission for later acceptance and Slice 5 implementation. It does not currently enable write Tools or override active administration contracts.

## Goals / Non-goals

Permit in-system correction of authorized worker network policy without a generic shell or repeated candidate confirmation. Preserve exact authorization, retained data, source audiences and honest unknown results. Whole-service NanoHost/NanoCore recovery, credential injection and widening the operator's authority are non-goals.

## Background

A Git smart-HTTP refusal can arise from a sandbox policy mismatch or an upstream refusal. Configuration comparison alone cannot establish the historical enforcement cause. Diagnosis must remain useful before delegated application exists.

## Decision

Represent maintenance authority in existing Permissions/Policy assignments and evaluation context. Do not create a delegation-token service, grant database, maintenance journal or second configuration writer. Accepted administration contracts continue to govern executable operations until their narrow amendments and this contract are accepted together.

## Contract / Expected Behavior

### Definition And Authority

Delegation names target Agent/Workspace scope, permitted workload purposes, endpoint/port/protocol and method/resource limits, eligible actions, validity and revocation conditions. It permits independently selecting a correction inside that ceiling, never changing the ceiling itself. Current responsible-administrator authority is rechecked for each effect; local/server identity remains owned by Permissions. Source access and destination audience are independently enforced.

The operator MUST NOT change its own authority, Vault grants, TLS verification, containment boundaries, resource audiences, arbitrary service control or other reserved effects. Git-read path repair cannot authorize push, unrestricted egress or injecting credentials into credential-free materialization. A template difference is not drift without a known intended baseline, and a template update cannot expand delegation.

### Candidate And Application Lifecycle

Creation records a candidate against an exact registered target and base revision, with its originating failure, permitted purpose and semantic comparison. Validation resolves current target and authority, checks the candidate against the delegated ceiling and binds exact candidate identity to the permission decision. Application uses the existing revision-protected configuration command owner, not a direct file write by a Tool. Existing command receipts, AuditEvents and evidence retain actor, scope, base/candidate/template identities, semantic diff, permission decision, persisted result and reload outcome. Projections do not become a second durable authority.

Immediately before mutation, recheck current authority, candidate identity and base revision. A stale or changed base fails with conflict; expired or revoked authority fails before new dispatch. Missing target, missing authority, invalid candidate or inaccessible source fails closed. An in-flight effect still settles truthfully after revocation. Cancellation before dispatch performs no mutation; after dispatch it cannot claim the effect was undone.

Persistence and reload are separate outcomes. A persisted candidate whose reload fails remains visibly persisted but not loaded; retain last-known-good loaded state under the configuration owner. Lost response or restart requires inspection of the exact command receipt and current authored/loaded revisions. Reuse an exact available receipt; never regenerate a request or reapply an unknown effect. Rollback is a new authorized revision-protected correction, never automatic overwrite of intervening changes.

No running AEP, process environment or historical failed Turn is rewritten. Verify loaded configuration, then permit only a fresh authorized Task after existing cleanup/storage admission accepts it. The new Task proves its own in-sandbox materialization and cannot retroactively establish the original failure's cause. Retained bytes survive.

## Proposed Design

Admit finite inspect, compare, validate and apply capabilities into the existing private administration entry, using shared Core implementations for App API, Skill CLI and internal Tool projections. The existing configuration target registry, optimistic revisions, reload semantics, Policy evaluation, command ledger and audit/evidence records remain unique owners. No maintenance runner or new durable lifecycle is proposed.

## Current Implementation Projection

No delegated maintenance apply Tool is implemented. The first delivery adds failure projection only. Existing Chat Mode Assistant and Internal Agent Resource Integration administration gates remain effective; this Draft is not execution authority.

## Alternatives Considered

Per-candidate human confirmation remains the current implementation but does not fulfill accepted bounded delegation. Generic host shell, implicit template synchronization, broad egress and secret-bearing diagnostics are rejected because they bypass target scope, authority or confidentiality. A new maintenance store would duplicate existing owners.

## Consequences

Routine authorized corrections can become autonomous after operation admission, while consequential expansion still requires its existing owner. Honest partial/unknown outcomes can require inspection instead of automatic repair.

## Rollout / Migration Plan

Slice 5 is later. Before implementation, accept this Draft's finite operation contract and amend only its explicit bounded exception in Chat Mode Assistant and Internal Agent Resource Integration together. Do not introduce backward compatibility or write Tools in the first failure-projection PR.

## Testing Strategy / Acceptance Criteria

An authorized correction of nested Git smart-HTTP paths must persist the exact candidate, expose reload status, and let a new Task materialize its requested commit under sandbox policy. Unauthorized endpoints, push methods, TLS bypass, self-expansion, revoked/expired authority and changed revisions must reject before mutation. Tests must distinguish persisted/reload-failed, lost response, restart inspection and new-request retry. Secret canaries must not appear in evidence, APIs, model input or telemetry. A real sandbox observation, not a host fetch or compiler-derived expected value, decides enforcement acceptance.

## Risks & Mitigations

Adversarial diagnostics cannot expand Tools or permissions. Closed normalized evidence, exact revision binding, current source/destination authorization and independently derived policy expectations constrain repair. Dead control/execution services retain existing deployment/human recovery limits; no in-process Tool promises to recover its own failed service.

## Open Questions

- [Blocking] The finite inspect/compare/validate/apply operation signatures and their exact Policy evaluation context must be settled with the existing configuration and administration owners before acceptance and Slice 5 implementation. Simon's acceptance of the delegation ceiling is settled, not an open question.

## Deferred / Future Work

Slice 5 implements admitted delegated maintenance after contract acceptance. Full enforcement correlation and product recovery journey remain separate slices. NanoHost/NanoCore whole-service recovery is explicitly deferred and is not an availability promise of this specification.

## Links

[Chat Mode Assistant](20260704-chat_mode_assistant.md), [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md), [Configuration And Identity](20260628-nanocore_config_identity_contract.md), [Worker Reliability](20260531-worker_turn_reliability_envelope.md).
