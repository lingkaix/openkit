# User Manuals

This folder holds the User Manual documents. The [User Manuals type](../documentation-model.md#user-manuals) owns its audience, authority, lifecycle, and naming rules. Read that definition before adding or changing a page here; this file adds only what is local to the directory.

## Contents

- `nanocore-deployment-modes.en.md` — deploy, configure, start, and verify NanoCore across supported product modes and the container worker runtime.
- `nanocore-data-root-config.en.md` — the user-editable files under `DATA_ROOT/config`.
- `sandbox-container-tests.en.md` — structure tests that need a container runtime when the worker sandbox cannot start a container.

## Local Conventions

- One page per operator-facing surface. Adding a page needs no validator or model edit, because this type classifies by directory.
- Write what an operator can execute and inspect: exact commands, file paths, config shapes, and expected output. When a design sentence and a reproducible command say the same thing, keep the command.
- Name the release or behavior version a page documents when it is version-sensitive, so a reader can tell whether the page has fallen behind.
- Link the owning specification or core document for any contract a page projects, so a reader who needs the authoritative answer can reach it in one hop.
- Pages may send an operator into `docs/cookbooks/` for procedures the cookbooks own, such as release tagging and container image builds. Do not copy those procedures here.

## Related Docs

- `docs/documentation-model.md`
- `docs/deployment.md`
- `docs/app-api.md`
- `apps/nanocore/README.md`
