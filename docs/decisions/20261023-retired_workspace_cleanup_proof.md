---
status: Accepted
date: "2026-10-23"
decider: Engineer, through the coordinator's DIAG-444A2 ruling
---
# Retired Workspace Cleanup Proof

## Decision

Recognize an already-recorded native proof under its exact historical Workspace for resident cleanup. Prefer native AgentSession metadata. When that row is absent, cleanup alone may read the exact retained V1 session through the existing schema and all original lineage, digest, Epoch and storage checks. A non-admitted Workspace never invokes a writing proof recorder and receives no migration or backfill. Missing or conflicting proof refuses with a bounded cause code. Physical cleanup still precedes storage release.

## Reason

The coordinator accepted DIAG-444A2 on 2026-10-23. An offline replay of deployed production code on copied retained data showed a retired resident with valid original V1 session proof and no native Workspace or AgentSession projection. Historical package validation succeeded, but the default recorder attempted ordinary executable owner discovery and refused. Ending a Workspace's execution authority must not erase its retained cleanup evidence or require a write to that Workspace.

## Rejected Alternatives

- Use an owner-scoped native-only lookup: the diagnosed original native row is absent.
- Run the default recorder through another lookup: the recorder writes, and the retired Workspace cannot accept that write.
- Backfill native metadata or restore executable admission: cleanup proof grants neither effect.
- Ignore missing proof or infer absence from same-Epoch readiness: neither establishes the original proof or physical release.
- Add a continuity registry or general legacy fallback: the existing exact owner, retained schema and cleanup lifecycle serve this bounded case.

## Revisit When

An accepted retained-data migration proves that no required resident cleanup depends on the original V1-only metadata, or another retained shape requires a separate owner decision. A readable historical record alone never grants current execution or attachment authority.

## Affected Owners

- `docs/specs/20260704-agent_session_continuity.md`
- `docs/specs/20260910-persistent_worker_volumes.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
