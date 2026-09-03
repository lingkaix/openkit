# Runtime

This directory owns accepted-turn execution, scheduler dispatch integration, worker lifecycle, runtime recovery, worker-control transport, context preparation, and runtime-specific App API feature paths.

## Boundaries

- Scheduler records and capacity transitions live in `../scheduler-records.ts`; runtime code consumes that owner instead of duplicating lease state.
- Product turn HTTP ownership lives in `../turn-routes.ts`; `product-turn-start.ts` owns scheduler admission and dispatch after route validation.
- Workspace-root preparation lives in `turn-workspace-context.ts`; after Agent selection it resolves one credential-free HTTPS Git source and exact commit before scheduler admission. `scheduler-dispatch-loop.ts` selects the data-source and MCP catalogs by the dequeued entry's Workspace, derives its authored source references, projects no NanoCore host path or MCP topology into the AEP, and binds that exact context through preparation and launch.
- `agent-environment.ts` owns NanoCore-to-AEP projection. NanoHost is the sole production runtime target and consumes that immutable package through the fixed image, sandbox, bridge, import, and export effect vocabulary instead of a direct OpenShell CLI path. After sandbox creation, NanoCore strictly reparses and canonically serializes the AEP as the first `package-config/package.json` import, then serially imports the sorted generated Context Package before bridge bootstrap.
- Explicit `worker.runtime-provenance.v1` requirements project bounded raw-stream, manifest, and native-origin-index transcript outputs. NanoCore requests declared path-only exports only after accepted terminal status; NanoHost independently proves process-group absence before returning verified staged bytes to the existing canonical storage owners.
- Worker backends must make their declared `TurnExecutor.capabilities` truthful and reject unsupported operations before store mutation.
- Runtime-private sessions, host paths, credentials, raw worker payloads, and backend handles must not enter protocol events or public responses.
- Worker-control and inference authenticate through distinct live-memory route tokens. The scheduler lease stores only their separate lowercase SHA-256 projections, while the non-secret sandbox binding remains lineage rather than a credential; restart rebuilds hash-bound serving state without restoring a raw token.
- `nanohost-session-dispatch.ts` binds fixed session readiness, the eight runtime effects, and the existing worker-control and inference HTTP semantics to one authoritative physical HTTP/2 connection. For exact `{}` on private `POST /api/nanohost/transport/session/readiness` it derives native physical identity, configured identity and deployment, the current admission-allocated generation, predecessor fence, and server time, then projects `ready` and `freshEmpty` directly through the existing RuntimeTarget owner before returning empty `204`; admission allocation remains the sole generation writer. The same owner retains only the last accepted fresh-empty timestamp across physical close so strictly later readiness can settle an unknown cleanup fence after current readiness returns to false. A successor repeats readiness before effect carriage, while physical close or failure fences its exact generation non-ready; NanoCore restart applies that same close projection before product admission because process-local transport authority is gone. Bridge launch evidence is published only after the authenticated sequence-zero `starting` heartbeat, and an accepted bridge is monitored across connection successors without relaunch.
- `nanohost-session-dispatch.ts` retains the validated inline Dockerfile bytes, projects byte-free `image.build` metadata below the unchanged 512-KiB control ceiling, serves them once on private same-authoritative-ready-connection `POST /api/nanohost/transport/effects/image.build/input` through the existing single file-data reservation, removes them on settlement, and never refetches them for a successor.
- Workspace materialization records and backend handles bind the AEP package snapshot separately from the backend worker session id; terminal events, teardown, and stale-lease recovery correlate by package lineage, and review persistence rejects missing materialization lineage instead of inferring it from a change set.
- Recovery code must preserve workspace, thread, turn, request, package, and scheduler lineage before changing terminal state. The post-migration phase-8 checkpoint scan reopens only the existing Workspace database because the same boot already verified its complete layout.

## File Groups

- `worker-*-executor.ts`, `worker-*-backend.ts`, and `worker-*-gateway.ts` own governed worker execution and transport.
- `nanohost-session-dispatch.ts` owns fixed-effect correlation, sensitive bridge-command disposal after acceptance, present raw file transfer validation, exact optional-absence JSON validation for the Workspace change manifest, and the two private semantic route projections on the authoritative NanoHost connection.
- `worker-runtime-provenance.ts` owns bounded capture verification, product-safe normalization, package-scoped gateway reconciliation, and portable index ref reminting.
- `nanohost-epoch-audit.ts` rejects private or secret-shaped references before projecting redacted epoch invalidation and readiness boundaries directly into the existing server-owned audit event store.
- `scheduler-*.ts` files coordinate dispatch and lease maintenance without owning scheduler persistence.
- `goal-*.ts` and `worker-recovery*.ts` own long-running work and recovery lifecycles.
- `idempotent-command.ts` owns process-local duplicate collapse and delegates durable command records to storage.
- `agent-environment.ts` owns the metadata-only pre-lease SessionCompatibilityKey projection and the full effect-owning AEP construction; scheduler and runtime owners revalidate that one key before launch.
- MCP catalog supply remains non-executable while the capability plane is disabled; transport topology and Vault grant bindings never enter the AEP.

## Verification

Run the nearest focused tests first, followed by NanoCore typecheck, lint, build, and the complete NanoCore test suite for runtime behavior changes. Governed-worker changes should also run worker-control, recovery, scheduler, and Server route coverage relevant to the changed lifecycle.

## Related Design

- [AgentSession](../../../../docs/core/agent-session.md)
- [Storage Layout And Record Ownership](../../../../docs/specs/20260703-storage_layout_record_ownership.md)
- [Worker Context Package](../../../../docs/specs/20260703-worker_context_package.md)
- [Worker Runtime Sub-agent Provenance](../../../../docs/specs/20260711-worker_runtime_subagent_provenance.md)
