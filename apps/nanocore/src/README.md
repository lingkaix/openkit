# NanoCore Source

This directory contains NanoCore's composition root and feature owners. `app.ts` mounts middleware and concrete feature registrars; complete product behavior belongs in the nearest cohesive route, runtime, storage, provider, policy, or workspace owner.

## Boundaries

- Keep authentication and middleware order in `app.ts`; do not move product handlers back into the composition root.
- Keep one complete route lifecycle in one feature module when practical, and pass only concrete dependencies that the module cannot import from its real owner.
- Keep protocol and App API schemas in their owning packages; NanoCore validates and executes those contracts rather than defining parallel DTOs.
- Keep runtime execution under `runtime/`, persistence and recovery under `storage/`, provider configuration under `providers/`, authentication under `auth/`, and secret material mechanics under `vault/`.
- Reuse `auth/thread-visibility.ts` after Workspace eligibility for Thread-derived reads and effects. Core routes, conversation counts, attention, recovery lists, and generated presentations admit the current audience before dependent projection; an administrator credential does not grant another user's private Thread. Generated presentations also preserve their source Item's audience instead of widening it through a shared target.
- Do not add controller, service, repository, façade, dependency-container, or compatibility layers unless they remove demonstrated complexity across multiple real consumers.

## Entry Points

- `app.ts` composes middleware, authentication, shared process state, and feature registrars.
- `index.ts` owns process boot and shutdown.
- `telemetry.ts` owns optional stock-SDK request spans and bounded exporter lifecycle; canonical work, audit and evidence remain with their existing owners.
- `openapi.ts` owns the explicit App API operation catalog and generated projection.
- `mode-entry-routes.ts` keeps ordinary Assistant answers on current input and admitted context without ambient Workspace Knowledge pre-reads. Follow-up answers reconstruct ordered user and Assistant messages from the current Thread's canonical Items, including after restart; the current input is appended once. The explicitly selected Knowledge Manager target retains source-traceable retrieval and replay. Provider answers retain Turn-bound model capture. See [the Chat owner](../../../docs/specs/20260704-chat_mode_assistant.md) for the information-source contract.
- Active internal Chat provider work exposes explicit interrupt control to `turn-routes.ts`; HTTP disconnect does not stop that server work. Stop races the provider, persists the same Turn as `interrupted` with `provider_call_aborted`, and retains a submit receipt containing only its Turn pointer. Replay verifies the original actor and narrative lineage without redispatch. Request-derived provider Turn ids prevent redispatch when a required write fails; the existing-attempt check runs before target selection or result creation, so changed input cannot bypass it. Terminalization or receipt refusal returns `recovery_required`. Once both exact-Turn receipts prove complete publication, a fresh Stop retains the ordinary `turn_not_interruptible` conflict; the accepted Stop request still replays. Late provider results cannot publish an answer. Worker interruption retains its existing runtime admission and control checks.
- `*-routes.ts` files own cohesive public feature paths. `repository-routes.ts` also exposes its concrete Git push request and execution owners to the selected built-in MCP route, preserving the same host executor and command receipts.
- `worker-mcp-routes.ts` dispatches the always-supplied `openkit-work` tools through its existing package admission and capability ledger. The [runtime guide](runtime/README.md) describes pending input requests and read-only same-Sandbox peer projections.
- `lib/store.ts` exposes the app-local product store while `storage/` owns durable record placement. After a Turn is a sealed terminal, `updateTurn`, `createItem`, `emitTurnEvent`, and `updateItem` admit only completion of an already-decided publication or a named field-limited display-projection refresh, judged by identity and content.

## Supporting Directories

- `capability/` owns capability-call and usage-ledger operations.
- `context/` owns LLM context projection and its projection policy.
- `diagnostics/` owns product-safe setup and runtime diagnostic projections.
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
