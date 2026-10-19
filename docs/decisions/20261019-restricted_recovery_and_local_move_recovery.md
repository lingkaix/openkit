---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Restricted Restore And Local Move Recovery

## Decision

[Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md) owns these local recovery rules. They refine the [minimal offline scope](20261019-workspace_backup_restore_move.md) without adding remote orchestration.

Move finalization, transferable-bundle return, abandonment, and reactivation share one source-local operation fence. Finalization requires the current matching moved-out revision, backup identity, manifest digest, and open publication right. Reactivation durably closes that right and retires the local candidate/seal before reopening admission. A historical seal fact cannot authorize a later publication or return. Later retries report abandonment/reactivation.

If the current Workspace database is lost, a deployment administrator may explicitly acknowledge restricted recovery from verified backup B. Workspace-owned suppression, restrictions, and holds after B's capture cannot be proven and may be lost. Audit and the report identify B and the unprovable window from capture to detected loss. Automation, channels, schedules, and executable catalog bindings remain disabled until administrator re-admission. Current server membership and grants remain authoritative. No global safety ledger is added.

Target move recovery uses existing administrator-scoped request/provenance owners. The fingerprint binds source deployment, backup identity, manifest digest, resolved owner, and admitted member map. Check the committed same-request result before collision refusal. An exact owned unregistered candidate may be reverified and finished under current authority; changed-input/unrelated candidates conflict. Fenced discard closes the request before retiring its owned candidate.

## Reason

Source: the engineer's delegated coordination instruction on 2026-10-19, including its explicit restricted-recovery ruling after independent review. The review exposed a stale finalizer that could publish after reactivation, a missing post-backup safety authority, and an owned candidate stranded by unconditional collision refusal.

A backup proves its captured state, not the absence of later safety changes. When the current Workspace database is lost, unconditional restoration cannot preserve facts held only there. Restricted recovery makes that possible loss explicit and keeps automatic/executable bindings disabled pending current administrator judgement. It neither reconstructs missing facts nor weakens the current server's authority.

Local fences and existing request identities resolve the preventable publication/retry gaps. They do not change the accepted operator-controlled offline boundary or add a transfer service.

## Rejected Alternatives

- Trust the old backup as current safety authority: rejected because post-capture changes cannot be proven from B.
- Add a global safety ledger: excluded from this minimal recovery scope.
- Finalize from a historical successful seal fact: rejected because reactivation may have revoked publication rights.
- Refuse every owned candidate or delete colliding paths blindly: rejected because exact-operation recovery must remain possible without harming unrelated authority.

## Revisit When

Revisit when operational evidence changes the restricted-recovery trade-off or requires an independently retained safety authority. Any such placement change needs its own accepted design. Runtime fault qualification must still prove the local interleavings and owned-candidate recovery.

## Affected Owners

- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md)
