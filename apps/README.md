# Applications (`apps/`)

This directory holds product applications (web apps, APIs, CLIs, agents, and similar).

## Rules

- Each application must live in its own subdirectory (for example `apps/web`, `apps/api`).
- Each important application directory must include a local `README.md` once it is scaffolded.
- Add a local `AGENTS.md` only when the application has local agent execution rules that are not already covered by the root `AGENTS.md` or its local `README.md`.
- Scaffolding source preference and the handcrafted-starter-file prohibition are owned by `docs/toolchain.md` under `## Owns`, Setup And Dependency Procedure.

## After scaffolding

1. Add or generate `README.md` next to the app code.
2. Wire the app into the workspace (`pnpm-workspace.yaml` is already set up for `apps/*`).
3. Ensure `package.json` scripts align with root Turborepo tasks (`build`, `test`, `lint`, `format`, and others as needed).
4. Add `AGENTS.md` only when local agent execution rules are needed.

## NanoHost

`apps/nanohost` (`@openkit/nanohost`) is the Rust execution-host binary. Its app-local `mise.toml` pins the Rust version for developers; the same exact version is mirrored into `containers/test-env` as `ENV RUST_VERSION` for deterministic gates. Package scripts `build`, `test`, `lint`, and `format` invoke Cargo and participate in ordinary root `pnpm build`, `pnpm test`, `pnpm lint`, and `pnpm fmt` through `turbo run` in any permitted test environment; CI selects the test execution image. Do not add a parallel root command surface for NanoHost.

## Related documentation

- Repository overview: [README.md](../README.md)
- Cookbook index: [docs/cookbooks/README.md](../docs/cookbooks/README.md)
- NanoHost guide: [nanohost/README.md](nanohost/README.md)
- Test execution image: [docs/cookbooks/docker-test-env.md](../docs/cookbooks/docker-test-env.md)
