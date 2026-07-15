# Shared packages (`packages/`)

This directory holds reusable libraries, shared configuration packages, internal CLIs published to npm, and other workspace packages.

## Rules

- Each package must live in its own subdirectory (for example `packages/ui`, `packages/utils`).
- Each important package directory must include a local `README.md` once it is scaffolded.
- Add a local `AGENTS.md` only when the package has local agent execution rules that are not already covered by the root `AGENTS.md` or its local `README.md`.
- Scaffold new packages with an official CLI or approved template. Do not hand-compose starter files unless a cookbook explicitly allows it.

## After scaffolding

1. Add or generate `README.md` next to the package code.
2. Wire the package into the workspace (`pnpm-workspace.yaml` is already set up for `packages/*`).
3. Ensure `package.json` scripts align with root Turborepo tasks (`build`, `test`, `lint`, `format`, and others as needed).
4. Add `AGENTS.md` only when local agent execution rules are needed.

## Current packages

- `@openkit/protocol`: stable Core protocol schemas and generated JSON Schema outputs.
- `@openkit/app-api-schemas`: shared NanoCore App API payload schemas for dashboards, diagnostics, runtime config, OAuth, auth, automations, quick chat, search, feedback, Agent Catalog wrappers, and Action Center read models.
- `@openkit/core-client`: composed typed HTTP and SSE client for the SPA and protocol integration tests.
- `@openkit/config-schema`: shared OpenKit config schemas, policy metadata, and workspace root materialization helpers.
- `@openkit/policy-kernel`: shared standard-aligned NGAC subset policy kernel for relation-backed authorization decisions and decision traces.
- `@openkit/worker-protocol`: canonical `Core <-> Worker` schemas for governed container worker records, control envelopes, transcript records, capability summaries, workspace-change manifests, and worker errors.
- `@openkit/openshell-schema-snapshot`: vendored exact-version boundary snapshot for the stock OpenShell `0.0.80` provider profile, sandbox policy, CLI surface, and reserved namespace consumed by NanoCore.
- `@openkit/codex-app-server-schema`: vendored Codex app-server JSON Schema snapshot for the NanoCore host adapter boundary.
- `@openkit/models-dev-catalog`: vendored `models.dev` catalog snapshots for provider-template traceability.

## Related documentation

- Repository overview: [README.md](../README.md)
- Cookbook index: [docs/cookbooks/README.md](../docs/cookbooks/README.md)
