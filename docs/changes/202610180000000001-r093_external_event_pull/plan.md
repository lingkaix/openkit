---
type: change-plan
status: in-progress
date: "2026-10-18"
branch: lane/go
---
# Governed External Events Through Scheduled Pull

## Intent

### Intent Revision 1 — Coordinator GO

Source: the coordinator approved R093 pull and isolated per-event Worker admission on 2026-10-18, with no new schedule source or fixed target fields.

R093 admits one isolated bounded Worker case for each observed external event through the existing scheduler. The coordinator approved pull and rejected new source and target Thread fields. Existing new-task-worker admission creates an isolated execution Thread and native conversation for each event.

## Owners

- [Runtime Model](../../core/runtime-model.md) owns ordinary execution and admission.
- [Scheduler Recurring Triggers](../../specs/20260711-scheduler_recurring_event_triggers.md#external-events-through-scheduled-pull) owns the retained join and duplicate boundary.
- [Worker Agent Capability](../../specs/20260703-worker_agent_capability.md#scheduled-poll-event-admission) owns the context-bound Worker Tool.
- [Task Mode Worker Delegation](../../specs/20260704-task_mode_worker_delegation.md#scheduled-external-event-entry) owns bounded case isolation.
- [Workspace Backup, Export And Import](../../specs/20260704-workspace_backup_export_import.md#external-trigger-admission-history) owns inert portable history.

## Scope And Ablation

Reuse RecurringSchedule unchanged. ExternalTriggerAdmission retains only scheduleId (key scope), eventKey (source duplicate identity), sourceTurnId (original poll lineage) and queueEntryId (ordinary work authority). One context-bound event-admit operation supplies the missing admission bridge. No source field, target Thread field, event queue, per-poll uniqueness, retry runner, recovery owner, automatic Goal creation or B01-specific type is added. The canonical operation follows the accepted naming grammar. Naming-held integration paths wait for the L-ID landing.

## Verification And Completion

Pending: lowest-sufficient regressions for duplicate/restart/receipt expiry, isolated concurrent cases, current-authority refusal, atomic queue/join acceptance, accepted unknown/failure refusal and inert import. Complete touched-module suites and shared tool/operation inventories run on the exact committed head. Independent Sol review and express landing require naming on main and green main. The external B01 probe is updated for the operator; no host acceptance is claimed here.

## Integration Seams And Test Ownership

The storage builder owns the Core SQL/Drizzle join and its transaction/reopen checks. The runtime builder owns the existing product admission transaction hook and the source-to-isolated-Worker seam, with actual Core/Store/package authority regressions. The primary owns scheduler dispatch recognition, request/Tool projections, portable remapping and deletion capture/purge; its tests use real queue, canonical Turn, export/import graph and closure owners. An independent Sol reviewer checks all seams and the accepted scope against the final diff. No test or receipt substitutes for Worker or external-effect evidence.

## Checkpoint

Core storage and isolated admission helpers are merged. Focused checks cover 43 storage/scheduler cases, 23 new admission cases, 23 provider-readiness cases, 13 portable-history cases and two closure cases. These are implementation evidence, not the exact landing gate. Existing Task admission has one base fixture failure because Worker Context Package storage admission is absent; the required L-ID naming branch also changes that test, so this lane leaves its bytes to that merge. Operation and native Tool composition, naming-held guides, exact complete-suite gate and final review wait for naming on main. The B01 recipe contains the R093 alternative; live execution remains unverified.
