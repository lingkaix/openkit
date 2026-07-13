# Runtime

This directory owns accepted-turn execution, scheduler dispatch integration, worker lifecycle, runtime recovery, worker-control transport, context preparation, and runtime-specific App API feature paths.

## Boundaries

- Scheduler records and capacity transitions live in `../scheduler-records.ts`; runtime code consumes that owner instead of duplicating lease state.
- Product turn HTTP ownership lives in `../turn-routes.ts`; `product-turn-start.ts` owns scheduler admission and dispatch after route validation.
- Repository, workspace-root, and source-context preparation lives in `turn-workspace-context.ts`.
- `agent-environment.ts` owns NanoCore-to-AEP projection. Direct worker control derives its adapter transport from the canonical NanoCore endpoint scheme. Trusted inference packages bind the resolved provider/model, derive the worker-inference URL from that endpoint origin, and leave inference egress ownership to the transient OpenShell provider profile instead of duplicating it in the base sandbox policy.
- Explicit `worker.runtime-provenance.v1` requirements project bounded raw-stream, manifest, and native-origin-index transcript outputs and require the trusted inference relay. Capture, import, product-safe correlation, and turn-end reconciliation are implemented, but no production backend advertises the feature until the same-target executable and cross-surface conformance gates pass.
- Worker backends must make their declared `TurnExecutor.capabilities` truthful and reject unsupported operations before store mutation.
- Runtime-private sessions, host paths, credentials, raw worker payloads, and backend handles must not enter protocol events or public responses.
- Recovery code must preserve workspace, thread, turn, request, package, and scheduler lineage before changing terminal state.

## File Groups

- `worker-*-executor.ts`, `worker-*-backend.ts`, and `worker-*-gateway.ts` own governed worker execution and transport.
- `worker-runtime-provenance.ts` owns bounded capture verification, product-safe normalization, package-scoped gateway reconciliation, and portable index ref reminting.
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
- [Worker Runtime Sub-agent Provenance](../../../../docs/specs/20260711-worker_runtime_subagent_provenance.md)
