# `@openkit/openshell-schema-snapshot`

This legacy package stores the exact stock OpenShell `0.0.80` boundary snapshot retained solely for the current NanoCore OpenShell policy renderer's YAML conformance check.

It is immutable and is not refreshed. It is not the current runtime pin and grants no CLI, Gateway, Cell, or execution authority; the NanoHost application owns the current stock OpenShell `0.0.99` pin. Delete this package only when the policy owner migrates its remaining conformance consumer.

## Contents

- `snapshots/2026-07-11/metadata.json` records the pinned OpenShell release provenance, mapping version, exact required gateway version, source paths, and artifact checksums.
- `snapshots/2026-07-11/provider-profile-surface.json` separates the upstream provider surface from OpenKit's exact OpenShell 0.0.80 inference-relay profile shape and pins snake-case fields, array declarations, placeholder resolution, and the two exact worker-inference POST rules.
- `snapshots/2026-07-11/policy-surface.json` separates the upstream protocol, enforcement, and access surface from OpenKit's narrower emitted sandbox policy mapping and pins exact REST `method` and `path` allow rules.
- `snapshots/2026-07-11/cli-surface.json` records the historical stock `0.0.80` CLI command surface consumed by the deleted Cell path. It is retained evidence and does not describe a current NanoCore runtime capability.
- `src/index.ts` exports small conformance helpers for generated OpenShell artifacts.

## Legacy Retention Rules

- Do not refresh, repair, regenerate, or otherwise modify the package source, tests, snapshots, or metadata.
- Retain the package only while `apps/nanocore/src/runtime/openshell-policy.ts` uses its conformance helper.
- Delete the package when that policy consumer moves to a current owner; do not move the NanoHost pin here.
- Run the retained commands only to validate the immutable historical package.

## Commands

- `pnpm --filter @openkit/openshell-schema-snapshot test`
- `pnpm --filter @openkit/openshell-schema-snapshot typecheck`
- `pnpm --filter @openkit/openshell-schema-snapshot build`
- `pnpm --filter @openkit/openshell-schema-snapshot lint`
