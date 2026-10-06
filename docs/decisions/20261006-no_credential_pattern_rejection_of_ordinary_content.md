---
status: Accepted
date: "2026-10-06"
decider: Engineer
---
# No Credential-Pattern Rejection Of Ordinary Content

## Decision

Remove recursive credential-pattern rejection from ordinary-content retained records and their public and retained-read projections in one change. Workspace synchronization and persistent Worker environment owners preserve ordinary bytes without substitution or fixture exemptions. Structural credential exclusions, exact injected-value protections, backend-private redaction, integrity, containment and review authority remain required. Secret-adjacent surfaces keep the existing pattern guard as defense in depth: Vault references, grants, injection plans and receipts, Vault use, Token metadata, NanoHost authored configuration, runtime configuration and diagnostics. Storage, export/import and app-update wrappers retain their guards.

## Reason

On 2026-10-06 the engineer ruled: “两点我都同意。” English translation: “I agree with both points.” The credential-pattern point accepted the coordinator's recommendation to remove the heuristic from every ordinary-content retained record, amend the two explicit owners with the Consultant's text, and retain it on secret-adjacent surfaces. Source: the credential-pattern scope recommendation and engineer ruling in the interface-unification builder brief and coordinator engineer queue.

A2 round 32 issue #108 demonstrated that a public test fixture could fail a Turn. Task mode on repositories whose tests contain fake keys would also fail at Workspace review. Pattern heuristics damage ordinary content, consistent with the LB-01 [exact-value ruling](20261005-transcript_item_exact_value_guard.md) and the [2026-09-24 sensitive-data ruling](20260924-sensitive_data_handled_outside_the_system.md). Secret-adjacent surfaces contain identifiers and metadata, where the guard remains defense in depth. This decision does not remove expressly owned exact credential checks or extend the scope of generic sensitive-data processing.

## Rejected Alternatives

- Marker substitution: corrupts ordinary bytes and their evidence.
- Fixture exemptions or generated-path exceptions: preserve an arbitrary heuristic boundary that rejects other ordinary content.
- Keeping the heuristic everywhere: public fixture literals continue to fail ordinary work and review.
- Removing it everywhere: unnecessarily removes defense in depth from secret-adjacent configuration and metadata.

## Revisit When

The engineer changes the boundary between ordinary content and credential-bearing configuration or accepts a new sensitive-data processing responsibility.

## Affected Owners

- [Workspace Synchronization](../specs/20260703-workspace_synchronization.md)
- [Persistent Worker Volumes And Environment Replacement](../specs/20260910-persistent_worker_volumes.md)
