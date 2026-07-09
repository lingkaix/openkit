# Core Client Package

Read `README.md` first. This file contains only local agent execution rules for the Core client package.

## Local Agent Rules

- Validate Core protocol payloads with `@openkit/protocol`.
- Validate NanoCore App API payloads with `@openkit/app-api-schemas`.
- Keep App API schemas out of this package.
- Keep HTTP and SSE helpers small and composable.
- Centralize sequence handling and event decoding here instead of duplicating it in the UI.
- Use tests first for behavior changes.
