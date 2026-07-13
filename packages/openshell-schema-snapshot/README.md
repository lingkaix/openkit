# `@openkit/openshell-schema-snapshot`

This package stores the pinned OpenShell boundary snapshot used by NanoCore's OpenShell worker backend.

It is intentionally separate from NanoCore implementation code. NanoCore may validate generated OpenShell artifacts against this package, but OpenKit product records remain the source of truth.

## Contents

- `snapshots/2026-07-11/metadata.json` records the pinned OpenShell release provenance, mapping version, exact required gateway version, source paths, and artifact checksums.
- `snapshots/2026-07-11/provider-profile-surface.json` separates the upstream provider surface from OpenKit's exact OpenShell 0.0.80 inference-relay profile shape and pins snake-case fields, array declarations, placeholder resolution, and the two exact worker-inference POST rules.
- `snapshots/2026-07-11/policy-surface.json` separates the upstream protocol, enforcement, and access surface from OpenKit's narrower emitted sandbox policy mapping and pins exact REST `method` and `path` allow rules.
- `snapshots/2026-07-11/cli-surface.json` records the OpenShell CLI subcommands invoked by NanoCore, including immutable provider-profile export/import and transient provider deletion.
- `src/index.ts` exports small conformance helpers for generated OpenShell artifacts.

## Refresh Procedure

1. Confirm the intended OpenShell CLI and gateway version.
2. Inspect the upstream profile, provider, policy, and CLI behavior that NanoCore consumes.
3. Update the dated snapshot files or create a new dated directory, keeping upstream capabilities separate from OpenKit-emitted mappings.
4. Update `metadata.json` release tag, resolved commit, reviewed source paths, checksums, mapping version, and exact required version.
5. Review the snapshot diff as an external boundary update before changing NanoCore behavior.
6. Run `pnpm --filter @openkit/openshell-schema-snapshot test`, `pnpm --filter @openkit/openshell-schema-snapshot build`, and dependent NanoCore tests.

Do not refresh this snapshot during NanoCore boot or routine test execution.

## Commands

- `pnpm --filter @openkit/openshell-schema-snapshot test`
- `pnpm --filter @openkit/openshell-schema-snapshot typecheck`
- `pnpm --filter @openkit/openshell-schema-snapshot build`
- `pnpm --filter @openkit/openshell-schema-snapshot lint`
