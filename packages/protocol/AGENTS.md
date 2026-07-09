# Protocol Package

Read `README.md` first. This file contains only local agent execution rules for the protocol package.

## Local Agent Rules

- Author schemas in TypeScript + Zod.
- Keep schema files free of business logic and runtime-specific adapters.
- Prefer discriminated unions and closed enums.
- Generate JSON Schema from the Zod source and keep generated artifacts in sync.
- Use tests first for schema behavior changes.
