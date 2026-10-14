# Diagnostics

This directory owns redacted NanoCore diagnostics projections; canonical public response schemas remain in `@openkit/app-api-schemas`.

## Boundaries

- `snapshot.ts` projects runtime mode, authentication state, migrations, providers, and agent readiness.
- `setup.ts` projects configuration and agent-setup readiness from current runtime inputs.
- `process-sample.ts` samples authorized process observations and local telemetry configuration without persistence or host-health claims.
- `release-identity.ts` reads the App image release identity file at boot. A missing file is a non-release build. A present malformed file fails boot with `invalid_release_identity`. The file supplies an independent immutable build identity. App updates replay environment overrides while the candidate supplies its own defaults.
- Do not duplicate public response DTOs, expose host paths or secret material, or read deployment-owned state before deployment-admin authorization.
- Diagnostics are projections only; configuration, OAuth, provider, storage, and readiness owners remain in their respective modules.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/diagnostics.test.ts src/diagnostics` and the App API schema tests, then regenerate and validate OpenAPI when a public shape changes.

See [NanoCore Bootstrap And Readiness](../../../../docs/specs/20260704-nanocore_bootstrap_readiness.md).

`diagnostics-operations.ts` joins the JSON `diagnostics.app` and `diagnostics.setup` definitions to the existing samples and setup owner. Common admission requires deployment-administrator authority in server mode before sampling. Raw `GET /api/diagnostics` keeps its support-binding authentication and response outside operation discovery.

`readiness.ts` separates service availability, product admission, update configuration and prepare-required qualification, and content-free maintenance safety. It includes the configured execution-host observation time and age without a live-probe claim; `freshEmpty` is not deployment idleness. Future-dated host observations retain their timestamp but report unknown readiness, null age and null `freshEmpty`. Completed index rebuilds remain informational on ready storage; `boot-index-readiness.test.ts` evaluates the actual entrypoint migration phase with storage effects substituted, rather than injecting a preclassified snapshot.
