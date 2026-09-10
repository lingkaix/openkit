# Workspace Repository Resources

This directory owns repository resources attached to a workspace: persistence helpers, path validation, and product-safe diagnostics.

## Boundaries

- Keep repository resource storage, validation, and diagnostics here. Runtime data-source catalogs are separately authored through runtime configuration; linking a Core host repository must not overwrite their network locators or status.
- Root workspace and repository route modules own HTTP behavior and product mutations.
- `../runtime/` owns worker materialization, workspace synchronization, and Git execution; `../storage/` owns canonical workspace records and transfer.
- Do not expand this directory into a general workspace service or duplicate workspace lifecycle ownership.
- Public diagnostics must not expose raw host paths, credentials, or secret-like values.
- Path inspection rejects lexical DATA_ROOT equality and descendants before filesystem validation, treats a DATA_ROOT realpath failure as unresolved, and never puts the canonical host path on public validation results.

## Verification

Run the focused repository store, validation, diagnostics, and route tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
