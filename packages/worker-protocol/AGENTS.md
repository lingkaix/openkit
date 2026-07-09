# Worker Protocol Package

Read `README.md` first. This file contains only local agent execution rules for the worker protocol package.

## Local Agent Rules

- Author schemas in TypeScript and Zod.
- Keep this package backend-neutral and runtime-adapter-neutral.
- Do not import NanoCore app internals, worker sidecar internals, OpenShell clients, Codex adapters, or storage code.
- Prefer discriminated unions and closed enums for worker-originated records.
- Keep schemas focused on canonical OpenKit records, not runtime-native output shapes.
- Use tests first for schema behavior changes.
- Document exported types, schemas, functions, classes, and methods with JSDoc.
