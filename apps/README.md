# Applications (`apps/`)

This directory holds product applications (web apps, APIs, CLIs, agents, and similar).

## Rules

- Each application must live in its own subdirectory (for example `apps/web`, `apps/api`).
- Each important application directory must include a local `README.md` once it is scaffolded.
- Add a local `AGENTS.md` only when the application has local agent execution rules that are not already covered by the root `AGENTS.md` or its local `README.md`.
- Scaffold new apps with an official CLI or approved template. Do not hand-compose starter files unless a cookbook explicitly allows it.

## After scaffolding

1. Add or generate `README.md` next to the app code.
2. Wire the app into the workspace (`pnpm-workspace.yaml` is already set up for `apps/*`).
3. Ensure `package.json` scripts align with root Turborepo tasks (`build`, `test`, `lint`, `format`, and others as needed).
4. Add `AGENTS.md` only when local agent execution rules are needed.

## Related documentation

- Repository overview: [README.md](../README.md)
- Cookbook index: [docs/cookbooks/README.md](../docs/cookbooks/README.md)
