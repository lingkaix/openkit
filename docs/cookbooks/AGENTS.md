# Cookbooks

Read `README.md` first. This file contains only local agent execution rules for cookbooks.

## Local Agent Rules

- Follow the relevant cookbook's procedure, subject to the accepted owner it projects; where they disagree the owner decides and the cookbook is the defect.
- Use `mise` to install, pin, and manage runtimes and developer tools that a cookbook depends on.
- Keep managed tool versions in the appropriate `mise.toml` for that scope and treat that file as the source of truth.
- Run cookbook commands as bare commands. `docs/toolchain.md` owns how the pinned toolchain reaches `PATH`, and a per-command `mise exec --` prefix MUST NOT be reintroduced: it is a no-op whenever the toolchain is already resolvable, so it trains agents to treat it as optional while silently permitting the wrong runtime when it is not.
- Scaffolding source preference and the handcrafted-starter-file prohibition are owned by `docs/toolchain.md` under `## Owns`, Setup And Dependency Procedure, and are not restated here.
- When adding or updating a cookbook, keep the index in `README.md` current.
