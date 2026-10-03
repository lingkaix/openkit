# NanoCore Source

This directory contains NanoCore's composition root and feature owners. `app.ts` mounts middleware and concrete feature registrars; complete product behavior belongs in the nearest cohesive route, runtime, storage, provider, policy, or workspace owner.

## Boundaries

- Keep authentication and middleware order in `app.ts`; do not move product handlers back into the composition root.
- Keep one complete route lifecycle in one feature module when practical, and pass only concrete dependencies that the module cannot import from its real owner.
- `catalog/catalog-routes.ts` carries optional Vault credential bindings through the existing MCP update-binding operation, preserving them on omission and replacing them when supplied. The catalog owner validates the proposed effective entry before publication; malformed request bodies and invalid proposed bindings return JSON 400 `invalid_request`. Retained-record and response-schema failures keep the route's error code and status with the fixed message "The retained record could not be read."
- `api-errors.ts` owns `publishedErrorMessage` at the existing response and durable failure publishers. It bounds `SyntaxError` and Zod errors recursively through causes and cleanup aggregates before their retained input can enter public messages, while keeping authored errors and caller fallbacks. Request-body validation, sharing request detail, authored configuration warnings and operator process logs keep their existing diagnostics. Historical records are not rewritten.
- Keep protocol and App API schemas in their owning packages; NanoCore validates and executes those contracts rather than defining parallel DTOs.
- Keep runtime execution under `runtime/`, persistence and recovery under `storage/`, provider configuration under `providers/`, authentication under `auth/`, and secret material mechanics under `vault/`.
- Reuse `auth/thread-visibility.ts` after Workspace eligibility for Thread-derived reads and effects. A current usable administrator Web session or bearer receives owner admission on active Workspaces without a manufactured membership; migrated private reads pass that eligibility into `isThreadVisible` through `isThreadIdVisible`. Read-only credentials stay read-only. Retained route guards and the Turn event stream keep the ordinary audience check until those routes are cut over. Conversation counts, attention, recovery lists, and generated presentations admit their current audience before dependent projection; generated presentations also preserve their source Item's audience instead of widening it through a shared target.
- Do not add controller, service, repository, façade, dependency-container, or compatibility layers unless they remove demonstrated complexity across multiple real consumers.

## Entry Points

- `app.ts` composes middleware, authentication, shared process state, and feature registrars.
- `remote-mcp-routes.ts` serves the four plain Operation Definition tools through per-request stock Streamable HTTP transports after bearer admission in the existing auth middleware. Discovery and schemas derive from the composed tables, and call crosses `operation-invocation.ts` directly. Credential issuance/rotation response schema identity, including bootstrap's issuance alias, excludes those secret-returning contracts before dispatch without an operation-id list or a speculative definition field. The credential-family cutover must reuse those owning schemas; a new secret-returning contract needs its exclusion aligned before it joins the tables. Request audit uses the existing server audit owner, keeps the Token id and `remote-mcp` channel in its redacted summary, and stores no arguments or results. The plain guide preserves product workflow and explicit human-decision guidance; the Skill remains available for the unmigrated surface.
- `index.ts` owns process boot and shutdown.
- `telemetry.ts` owns optional stock-SDK request spans and bounded exporter lifecycle; canonical work, audit and evidence remain with their existing owners.
- `openapi.ts` owns the explicit App API operation catalog and generated projection.
- `mode-entry-routes.ts` keeps ordinary Assistant answers on current input and admitted context without ambient Workspace Knowledge pre-reads. Follow-up answers reconstruct ordered user and Assistant messages from the current Thread's canonical Items, including after restart; the current input is appended once. The explicitly selected Knowledge Manager target retains source-traceable retrieval and replay. Provider answers retain Turn-bound model capture. See [the Chat owner](../../../docs/specs/20260704-chat_mode_assistant.md) for the information-source contract.
- Active internal Chat provider work exposes explicit interrupt control to `turn-routes.ts`; HTTP disconnect does not stop that server work. Stop races the provider, persists the same Turn as `interrupted` with `provider_call_aborted`, and retains a submit receipt containing only its Turn pointer. Replay verifies the original actor and narrative lineage without redispatch. Request-derived provider Turn ids prevent redispatch when a required write fails; the existing-attempt check runs before target selection or result creation, so changed input cannot bypass it. Terminalization or receipt refusal returns `recovery_required`. Once both exact-Turn receipts prove complete publication, a fresh Stop retains the ordinary `turn_not_interruptible` conflict; the accepted Stop request still replays. Late provider results cannot publish an answer. Worker interruption retains its existing runtime admission and control checks.
- `*-routes.ts` files own cohesive public feature paths. Host repository routes and execution owners are removed; hosted writes use selected vendor MCP through the Gateway.
- `worker-mcp-routes.ts` dispatches the always-supplied `openkit-work` tools through its existing package admission and capability ledger. The [runtime guide](runtime/README.md) describes pending input requests and read-only same-Sandbox peer projections.
- `lib/store.ts` exposes the app-local product store while `storage/` owns durable record placement. After a Turn is a sealed terminal, `updateTurn`, `createItem`, `emitTurnEvent`, and `updateItem` admit only completion of an already-decided publication or a named field-limited display-projection refresh, judged by identity and content.

`operation-invocation.ts` is the transport-free seam for the shared operation-definition slice. Its exact-key handler join adds executable bindings only; existing authorizers, mutation admission and domain effects remain their current owners. The Kernel owner resolves children inside the authorized Workspace and preserves its unavailable read entry or unavailable mutation error for missing authority; invocation does not preclassify child availability. `kernel-routes.ts` and `openapi.ts` derive canonical JSON bindings for that slice, while the remaining operations retain their current projections. `operation-projections.test.ts` checks one invariant across HTTP, typed client, actual selected Worker MCP and CLI catalog execution, including wrong-child and missing-app owner outcomes and admitted Worker credential revocation.

## Supporting Directories

- `capability/` owns capability-call and usage-ledger operations.
- `context/` owns LLM context projection and its projection policy.
- `diagnostics/` owns product-safe setup and runtime diagnostic projections.
- `knowledge-operations.ts` joins the two Knowledge definition tables to the existing domain owners without HTTP context. Public and trusted Task preparation share definition admission and retrieval; their output views remain distinct. `knowledge-operation-projections.test.ts` exercises all 23 operations through real HTTP, client and CLI projections, readonly refusal, eligible administration, Source lineage, restricted content, retired routes and trusted Task preparation.
- `knowledge/` owns OKF parsing and validation helpers; knowledge workflows remain with their cohesive root owners.
- `policy/` adapts product approval gates and permission decisions while canonical authorization semantics remain in `@openkit/policy-kernel`.
- `docker/` contains source-adjacent contract tests for application and worker container assets.
- `test-support/` contains shared test fixtures only.
- `lib/` contains the existing app-local stores and simulator; do not expand it with new general helpers, and place new behavior with its concrete owner.

## Change Workflow

Read [the NanoCore package guide](../README.md), the repository `AGENTS.md`, and the nearest directory README before editing. Characterize behavior before moving a route or ownership boundary, keep registration order stable, and separate semantic repairs from mechanical extraction.

## Verification

```bash
pnpm --filter @openkit/nanocore run typecheck
pnpm --filter @openkit/nanocore run lint
pnpm --filter @openkit/nanocore run test
pnpm --filter @openkit/nanocore run build
```

Run `openapi:generate` and `openapi:validate` whenever a documented App API operation or schema projection changes.

Gateway consumers in Administration, Goal planning and Quick Chat open their existing capability IDs before logical route planning and finish once, including failures without measurements. Usage retains the measured Provider while the logical call has no Provider reference. The Workspace capability-usage audit reader applies Thread visibility and exposes only the redacted route explanation.

Quick Chat passes the same executor deadline on every inference transport and keeps a submitted Chat command’s normalized request ID in its logical call and measurements. It uses logical dispatch and may span members, so the new call reference stays null while UsageRecord retains the measured Provider.

`operation-json-routes.ts` projects the composed product and administration family tables onto the native `operation-invocation.ts` seam. Exact typed family joins bind Workspace reads, Thread creation/history/dashboard and Turn reads to the existing domain owners. The central authorizer supplies candidate-first collections and current administrator eligibility; Thread audience checks follow Workspace admission. Deleted routes have no aliases. Run `pnpm --filter @openkit/nanocore exec vitest run src/operation-projections.test.ts src/workspace-child-lineage.test.ts src/core-thread-audience.test.ts` for the cross-projection and lineage regressions.

`artifact-operations.ts` joins the six Artifact definitions to the existing catalog, store, command receipt and version-owned Review owners without HTTP context. `artifact-operation-projections.test.ts` verifies real HTTP, typed client and CLI parity, current Workspace authority, immutable origin audience, administrator eligibility, readonly refusal, closed product admission and retired routes. The former `artifact-routes.ts` registrar is deleted.

Goal entry lives in the derived operation invocation and JSON registrar. `runtime/goal-owner.ts` is its sole domain owner; `runtime/goal-coordinator.ts` uses the ordinary internal-agent loop, and Task admission and terminal-fact modules retain Task ownership. The focused regressions are `runtime/goal-owner.test.ts`, `runtime/goal-wake.test.ts`, `runtime/goal-pending-cutover.test.ts`, `storage/goal-cutover-migration.test.ts` and `operation-projections.test.ts`.

`pending-request-operations.ts` joins Pending Request decisions to the existing runtime owner. `mode-entry-routes.ts` retains Quick Chat HTTP registration and exposes transport-free conversation and Task handlers; `app-dashboard.ts` and `action-center.ts` own navigation and attention reads. The former eight routes are absent.

`automation-operations.ts`, `runtime/scheduler-admission-operations.ts` and `runtime/worker-recovery-operations.ts` join nine definition-derived operations to existing domain owners. The former route registrars are deleted. Native admission uses minimum automation and Turn selectors and the existing queue/Thread audience predicate. `operation-json-routes.ts` projects a declared HTTP 204 without body or Content-Type. Automation validates the admitted Workspace record before projection or mutation and retains its former failure status. Scheduler joins carry typed, transport-neutral refusals; HTTP retains its plain 404 and MCP receives the known not-found refusal. The retirement, automation projection and remote MCP regressions cover real owner records and closed product admission.

Workspace JSON transfer joins live in `storage/workspace-transfer-operations.ts` and execute through `operation-invocation.ts`; `storage/workspace-transfer-routes.ts` retains the native transfer owners and the three archive streaming bindings.
