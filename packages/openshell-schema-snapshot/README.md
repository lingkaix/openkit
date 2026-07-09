# `@openkit/openshell-schema-snapshot`

This package stores the pinned OpenShell boundary snapshot used by NanoCore's OpenShell worker backend.

It is intentionally separate from NanoCore implementation code. NanoCore may validate generated OpenShell artifacts against this package, but OpenKit product records remain the source of truth.

## Contents

- `snapshots/2026-07-05/metadata.json` records the pinned OpenShell boundary, mapping version, gateway compatibility range, and artifact checksums.
- `snapshots/2026-07-05/provider-profile-surface.json` records the provider profile fields, refresh strategies, material keys, categories, and reserved namespaces OpenKit depends on.
- `snapshots/2026-07-05/policy-surface.json` records the sandbox policy fields, network policy shape, protocol/access enums, and provider-layer reservation OpenKit depends on.
- `snapshots/2026-07-05/cli-surface.json` records the OpenShell CLI subcommands invoked by NanoCore.
- `src/index.ts` exports small conformance helpers for generated OpenShell artifacts.

## Refresh Procedure

1. Confirm the intended OpenShell CLI and gateway version.
2. Inspect the upstream profile, provider, policy, and CLI behavior that NanoCore consumes.
3. Update the dated snapshot files or create a new dated directory.
4. Update `metadata.json` checksums and compatibility range.
5. Review the snapshot diff as an external boundary update before changing NanoCore behavior.
6. Run `pnpm --filter @openkit/openshell-schema-snapshot test`, `pnpm --filter @openkit/openshell-schema-snapshot build`, and dependent NanoCore tests.

Do not refresh this snapshot during NanoCore boot or routine test execution.

## Commands

- `pnpm --filter @openkit/openshell-schema-snapshot test`
- `pnpm --filter @openkit/openshell-schema-snapshot typecheck`
- `pnpm --filter @openkit/openshell-schema-snapshot build`
- `pnpm --filter @openkit/openshell-schema-snapshot lint`
