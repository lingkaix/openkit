# OpenKit MCP Package

Read `README.md` first. This file contains only local agent execution rules for the MCP package.

## Local Agent Rules

- Keep this package as a thin channel facade over NanoCore public App API, Core protocol, schemas, and `@openkit/core-client`.
- Keep Skill artifacts in the top-level `skills/` directory, not inside this package.
- Do not import NanoCore implementation modules, storage modules, runtime modules, worker checkpoint modules, or legacy/internal adapter modules.
- Do not read or mutate SQLite tables, `DATA_ROOT` files, provider secrets, OAuth state, raw environment variables, or process internals.
- Do not expose generic shell execution, generic commit, tag, publish, deploy, or internal admin tools.
- Keep push exposure limited to the approval-gated, GitHub-only NanoCore `workspace.git.push` contract.
- Keep server and workspace setup tools mapped to public Core and runtime config client routes only.
- Use tests first for MCP tools, resources, prompts, redaction, request IDs, and NanoCore client mapping.
- Document every exported type, class, function, and method with JSDoc.
