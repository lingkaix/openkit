# Codex App Server Schema Package

Read `README.md` first. This file contains only local agent execution rules for the Codex app-server schema package.

## Local Agent Rules

- Keep this package limited to externally generated Codex app-server schema artifacts and snapshot metadata.
- Do not add OpenKit `UI <-> Core` protocol schemas here; those belong in `@openkit/protocol`.
- Do not add NanoCore adapter business logic here; consumers should treat this package as a read-only external boundary snapshot.
- Refresh snapshots only through explicit maintenance work with a reviewed schema diff.
- Keep `metadata.json` in sync with the generated files, per-file checksums, consumed implementation values, consumed-surface dispositions, and the generator command.
