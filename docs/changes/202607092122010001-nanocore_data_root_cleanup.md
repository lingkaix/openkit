# NanoCore Data Root Cleanup

Type: standalone-change
Status: verified

## Intent

Keep NanoCore runtime state out of the tracked source tree while preserving committed runtime config templates as product assets.

## Scope

- Change the default NanoCore data root from `./data` to `openkit-nanocore-data` under the system temp directory.
- Ignore the legacy tracked `apps/nanocore/data/` runtime root.
- Remove tracked runtime data files from Git without deleting local working copies.
- Keep `apps/nanocore/data-templates/` tracked because NanoCore boot copies those templates into `DATA_ROOT/config`.
- Update user-facing development docs that pointed developers at `./data`.

## Non-Goals

- Do not move `apps/nanocore/data-templates/` in this change.
- Do not add a seed fixture system until a real demo-data workflow needs it.

## Related Context

- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Product Vision](../product-vision.md)
- [Storage Layout and Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [NanoCore DATA_ROOT Config Guide](../nanocore-data-root-config.en.md)

## Verification

- `CI=true pnpm --filter @openkit/nanocore exec vitest run src/config/data-root.test.ts`
- `CI=true pnpm --filter @openkit/nanocore typecheck`
- `CI=true pnpm --filter @openkit/nanocore lint`
- `CI=true pnpm run format:check`
- `CI=true pnpm run check:repo`
- `CI=true pnpm --filter @openkit/nanocore build`
- `git diff --check`
- `git check-ignore -v apps/nanocore/data/server/db/core.sqlite temp/nanocore-data/example`

## Summary

Runtime data is now kept out of the source tree by default, repository-local examples point at ignored `temp/` storage, and committed config templates remain the only tracked NanoCore data-root seed surface.
