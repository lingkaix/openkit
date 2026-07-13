# OpenKit MCP Package Removal Rules

Read `README.md` first. This file contains only local agent execution rules for the MCP package.

## Local Agent Rules

- Treat this package as removal-only under `docs/specs/20260713-openkit_agent_skill_interface.md` and `docs/changes/202607131935040001-openkit_agent_skill_interface.md`.
- Do not add tools, resources, prompts, configuration, compatibility paths, consumers, or product behavior.
- Keep only the minimum existing thin facade behavior needed to prove operation-catalog parity before deletion.
- Put the unified end-user Skill and bundled CLI under `skills/openkit/`, not inside this package.
- Do not import NanoCore implementation modules, storage modules, runtime modules, worker checkpoint modules, or legacy/internal adapter modules.
- Do not read or mutate SQLite tables, `DATA_ROOT` files, provider secrets, OAuth state, raw environment variables, or process internals.
- Do not expose generic shell execution, generic commit, tag, publish, deploy, or internal admin tools.
- Keep push exposure limited to the approval-gated, GitHub-only NanoCore `workspace.git.push` contract.
- Keep server and workspace setup tools mapped to public Core and runtime config client routes only.
- Use existing MCP tests only as removal-parity evidence; new behavior and acceptance tests belong to the transport-neutral operation catalog, bundled CLI, and unified Skill.
- Document every exported type, class, function, and method with JSDoc.
