# NanoCore Mode Resolution

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-nanocore_config_identity_contract.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The NanoCore Config And Identity Contract incorporated mode precedence, authored configuration, identity behavior, and data-root ownership into one active contract. The route-level mode resolver no longer owns policy because its permissive legacy inputs were removed and its valid behavior now follows that consolidated model.

## Retention Reason

This document preserves the original precedence algorithm, implementation tests, and removed compatibility behavior so maintainers can diagnose historical configuration changes without using the old resolver slice as current guidance.

Superseded note: The 20260529 cleanup spec removes top-level `dataRoot` and permissive unknown top-level config handling. Current server config uses `DATA_ROOT/config/server.jsonc` and rejects unknown top-level fields.

## Summary

NanoCore v0.0.2 resolves its runtime mode through a small config module with explicit precedence: environment override, file-backed config, then the development default `local`.

## Goals / Non-goals

- Support exactly `local` and `server` as the boot-time mode values.
- Load `DATA_ROOT/config/server.jsonc` as the operator-facing NanoCore config file.
- Use JSONC so local operators can keep comments and trailing commas in config files.
- Keep this story scoped to resolution and validation; auth middleware and data-root bootstrapping are handled by later stories.

## Design

`apps/nanocore/src/config/jsonc.ts` wraps `jsonc-parser` in `parseJsoncObject(source, sourceName)`. It returns a plain object and raises a typed boot error when parsing fails or the document is not an object.

`apps/nanocore/src/config/openkit-config.ts` loads `DATA_ROOT/config/server.jsonc` from a supplied data root. Missing files return `{}` so fresh local development has no required setup. Present files are validated by Zod:

```json
{
  "mode": "local | server",
  "defaults": {
    "workspaceId": "optional id",
    "agentId": "optional id",
    "coreModel": "optional model",
    "coreProviderId": "optional provider id",
    "gatewayModel": "optional model",
    "gatewayProviderId": "optional provider id"
  }
}
```

Unknown top-level sections are rejected. Future config families must be introduced through an accepted spec and a schema update.

`apps/nanocore/src/config/mode.ts` exports `resolveMode(env, config)`. It uses this order:

1. `OPENKIT_CORE_MODE`
2. `config.mode`
3. `local`

Invalid env values throw `BootConfigError` with code `invalid_core_mode` and a message naming the bad value.

## Dependency Rationale

`jsonc-parser` is the dependency for JSONC parsing because it supports comments, trailing commas, and structured parse errors without evaluating code or requiring TypeScript-based config files.

## Testing Strategy

- `jsonc.test.ts` covers comments, trailing commas, plain-object return values, and invalid JSONC errors.
- `openkit-config.test.ts` covers missing-file defaults, valid `DATA_ROOT/config/server.jsonc`, invalid config values, and rejected unknown top-level fields.
- `mode.test.ts` covers default local mode, config mode, env precedence, env server mode, and invalid env mode errors.
