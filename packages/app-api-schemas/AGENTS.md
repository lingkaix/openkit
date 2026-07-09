# App API Schemas Package

Read `README.md` first. This file contains only local agent execution rules for the App API schemas package.

## Local Agent Rules

- Keep schemas runtime-neutral and free of NanoCore implementation logic.
- Do not import from apps.
- Do not export stable Core protocol records from this package; import them from `@openkit/protocol`.
- Use tests first for schema behavior changes.
- Document exported types and functions with JSDoc.
