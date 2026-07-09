# Worker Shim Package

Read `README.md` first. This file contains only local agent execution rules for the worker shim package.

## Local Agent Rules

- Keep this package runtime-neutral and usable inside OpenShell sandboxes.
- Do not import NanoCore app internals.
- Keep transcript records aligned with NanoCore's worker transcript importer.
- Use tests first for shim behavior changes.
- Document exported types, functions, classes, and methods with JSDoc.
