# Cookbooks

Read `README.md` first. This file contains only local agent execution rules for cookbooks.

## Local Agent Rules

- If a relevant cookbook exists for a task, agents must follow it.
- Cookbook guidance should be treated as the operational source of truth for its scope.
- Use `mise` to install, pin, and manage runtimes and developer tools that a cookbook depends on.
- Keep managed tool versions in the appropriate `mise.toml` for that scope and treat that file as the source of truth.
- Run cookbook commands through `mise exec -- ...` unless the cookbook documents a specific exception.
- If no cookbook exists yet, prefer the official CLI scaffolding tool, framework generator, or an approved template.
- Do not create a new sub-project by manually composing starter files unless a cookbook explicitly requires that workflow.
- When adding or updating a cookbook, keep the index in `README.md` current.
