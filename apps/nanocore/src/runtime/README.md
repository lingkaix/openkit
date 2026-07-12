# Runtime

This directory owns accepted-turn execution, scheduler dispatch integration, worker lifecycle, runtime recovery, worker-control transport, context preparation, and runtime-specific App API feature paths.

## Boundaries

- Scheduler records and capacity transitions live in `../scheduler-records.ts`; runtime code consumes that owner instead of duplicating lease state.
- Product turn HTTP ownership lives in `../turn-routes.ts`; `product-turn-start.ts` owns scheduler admission and dispatch after route validation.
- Repository, workspace-root, and source-context preparation lives in `turn-workspace-context.ts`.
- Worker backends must make their declared `TurnExecutor.capabilities` truthful and reject unsupported operations before store mutation.
- Runtime-private sessions, host paths, credentials, raw worker payloads, and backend handles must not enter protocol events or public responses.
- Recovery code must preserve workspace, thread, turn, request, package, and scheduler lineage before changing terminal state.

## File Groups

- `worker-*-executor.ts`, `worker-*-backend.ts`, and `worker-*-gateway.ts` own governed worker execution and transport.
- `scheduler-*.ts` files coordinate dispatch and lease maintenance without owning scheduler persistence.
- `goal-*.ts`, `pending-user-turns.ts`, and `worker-recovery*.ts` own long-running work and recovery lifecycles.
- `idempotent-command.ts` owns process-local duplicate collapse and delegates durable command records to storage.
- `agent-session-read-model.ts` owns product-safe live session projection.

## Verification

Run the nearest focused tests first, followed by NanoCore typecheck, lint, build, and the complete NanoCore test suite for runtime behavior changes. Governed-worker changes should also run worker-control, recovery, scheduler, and Server route coverage relevant to the changed lifecycle.

## Related Design

- [Agent Session](../../../../docs/core/agent-session.md)
- [Storage Layout And Record Ownership](../../../../docs/specs/20260703-storage_layout_record_ownership.md)
- [Worker Context Package](../../../../docs/specs/20260703-worker_context_package.md)

