---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/web
---
# Web Server Operations

## Intent

Intent revision 1, 2026-10-16: L-WEB delivers the supported P28 administration and recovery surfaces, followed by P26 and P27 after their backend dependencies land. This increment adds a server-scoped operations destination for current health, Policy readiness, process and Telemetry configuration, update readiness, and bounded cleanup observations. Existing settings remain the owners of their actions. Whole-server recovery, new Policy administration semantics, P20 Skills and P29 update orchestration are outside this increment.

## Owners

- [Web product surface projection](../../specs/20260628-web_product_surface_projection.md).
- [Operational telemetry](../../specs/20260731-operational_telemetry_standardization.md#app-diagnostics-operational-sample).
- [App update delivery](../../specs/20260910-app_update_delivery.md).
- [Multi-user Workspace system](../../specs/20260715-multi_user_workspace_system.md).
- [Permissions](../../core/permissions.md) and [Audit](../../core/audit.md).

## Route and decisions

Reuse `diagnostics.app` and `administration.cleanup-read` through the composed Core Client. These operations already own current server-admin admission. Web adds no store, public operation, credential input, Policy file, cleanup action or host probe. Keep health and cleanup reads independent so a source failure remains local. Project known safe fields before caching. Refresh and retry only read current authority and state; denied or failed observations cannot remain visible as current. Show recorded cleanup state, unknown evidence and incomplete source coverage separately. Terminal product work and host Epoch observations do not prove physical cleanup or deployment idleness.

The cleanup helper owns only its new panel and regression file on `lane/web-cleanup` in a separate worktree. After the coordinator increased capacity to two helpers, an audit helper owns the existing Server audit screen, its regressions and its data hook on `lane/web-audit` in another worktree. The primary owns health, routing, documentation and browser acceptance. Merge the helper branch; obtain separate independent review after implementation. This record is execution evidence, not design authority.

## Checkpoint

Active. Initial main `a1f2c6b8`; P19, P17 and P14 not yet landed at initial inspection. Current P28 APIs are available. Expected regression: the health and cleanup panels are missing, so focused component imports fail before implementation. Subsequent deciding checks must reach behavior assertions for current authority, missing readiness, source uncertainty and safe cache projection. Run local Web e2e with the isolated stack. No a1 or a2 access.

## Verification and closeout

Pending. Before landing, merge current main, regenerate OpenAPI and CLI, run repository check, lint, typecheck and affected Web suites, obtain independent exact-head review, push lane/web and run exact-head full CI. Acquire the landing window only after that CI succeeds. Deferred dependency surfaces remain in the lane checkpoint.
