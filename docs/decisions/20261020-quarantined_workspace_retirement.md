---
status: Accepted
date: "2026-10-20"
decider: Engineer
---
# Retained Retirement Of Quarantined Workspaces

## Decision

Add retained-only retirement for a quarantined Workspace. The server registry records terminal `retired` status, and `workspace.retire-quarantined` uses current administrator authority and an exact command receipt. Retirement keeps the original data and reclaims no storage. Operations must distinguish it from deletion. The Workspace lifecycle specification owns the contract.

## Reason

Routine operations need to end a refused Workspace's product authority without resetting server authority or deleting unreadable data. Ordinary deletion requires readable hold evidence and a verified recovery export. Neither can be inferred from quarantine. The engineer approved a distinct retained-only retirement path, preserving existing deletion guarantees and unresolved runtime fences.

## Rejected Alternatives

- Force ordinary deletion through unreadable hold authority: absence of readable evidence does not establish absence of a hold.
- Report deletion without a verified recovery export: this would falsely promise recovery and completion of the existing deletion lifecycle.
- Remove or rename directories outside product authority: filesystem discovery cannot establish authorization, lifecycle outcome or writer absence.
- Reset all server authority to retire one Workspace: the effect is wider than the requested scope.
- Add another durable request family or recovery runner: one registry transaction and the existing receipt, audit and mutation gate serve this non-destructive transition.

## Revisit When

A separate accepted design supplies proof-bearing recovery or erasure for retained retired data, or a concrete need changes the no-reclamation requirement. Retirement alone must not acquire those effects.

## Affected Owners

- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/core/storage.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
