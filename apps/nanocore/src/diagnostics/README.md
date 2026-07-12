# Diagnostics

This directory owns redacted NanoCore diagnostics projections; canonical public response schemas remain in `@openkit/app-api-schemas`.

## Boundaries

- `snapshot.ts` projects runtime mode, authentication state, migrations, providers, and agent readiness.
- `setup.ts` projects configuration and agent-setup readiness from current runtime inputs.
- Do not duplicate public response DTOs, expose host paths or secret material, or read deployment-owned state before deployment-admin authorization.
- Diagnostics are projections only; configuration, OAuth, provider, storage, and readiness owners remain in their respective modules.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/diagnostics.test.ts src/diagnostics` and the App API schema tests, then regenerate and validate OpenAPI when a public shape changes.

See [NanoCore Bootstrap And Readiness](../../../../docs/specs/20260704-nanocore_bootstrap_readiness.md).
