# `@openkit/models-dev-catalog`

This package stores explicit `models.dev` API snapshots used by OpenKit releases.

The snapshots are vendored so NanoCore boot never depends on a live `models.dev` network request.

## Contents

- `snapshots/YYYY-MM-DD/api.json` stores the vendored API snapshot.
- `snapshots/YYYY-MM-DD/metadata.json` records source URL, source project, version, refresh date, checksum, maintenance note, and provider-template mappings.
- `scripts/validate.mjs` validates snapshot metadata, checksums, parseability, provider-template traceability, and the metadata-declared pi-ai price reconciliation scope.

## Refresh Procedure

1. Create a new dated directory under `snapshots/YYYY-MM-DD/`.
2. Fetch `https://models.dev/api.json` into a temporary file.
3. Write the snapshot as formatted JSON to the new directory's `api.json`.
4. Record `sourceUrl`, `sourceProject`, `version`, `refreshedAt`, `checksumSha256`, provider mappings, and a maintenance note in `metadata.json`.
5. Review the snapshot diff before committing.
6. Reconcile NanoCore provider templates when provider ids or starter model ids changed upstream.
7. Update `metadata.json` `piAiReconciliation` when a provider family becomes pi-ai-routed or the pinned pi-ai version changes.
8. Update `scripts/validate.mjs` if the current snapshot version changes.
9. Run `pnpm --filter @openkit/models-dev-catalog test`, `pnpm --filter @openkit/nanocore test`, and `pnpm run check:repo`.

Do not refresh this snapshot as part of normal boot or routine test execution.

## Commands

- `pnpm --filter @openkit/models-dev-catalog test`
- `pnpm --filter @openkit/models-dev-catalog lint`
