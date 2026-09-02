# Repository Test Support

This directory owns repository-level tests, shared cross-package test support, smoke checks, and L6 story artifacts that do not belong to one app or package.

Package and app unit, contract, integration, and browser tests remain with their owning package or app. Root tests must not duplicate a lower-layer invariant or turn shared support into a parallel product implementation.

## Layout

- `story-metadata.test.mjs` provides focused unit coverage for the shared scalar Story parser in `scripts/lib/story-metadata.mjs`.
- `toolchain-version-mirrors.test.mjs` checks the configuration invariants owned by `docs/toolchain.md` Toolchain Provisioning Boundary, Test Execution Environment, and Version Maintenance: `.mise.toml` defines no tasks; every mirrored Node and pnpm declaration across `.mise.toml`, root `package.json`, `.node-version`, `.nvmrc`, and `containers/test-env/Dockerfile` names the same exact version; the Biome pins in `.mise.toml` and root `package.json` agree on the exact supported version; `.github/workflows/ci.yml` does not provision Node or pnpm itself or bypass the NanoHost-scoped Rust pin with `rustup`; every `any` CI gate runs inside the test execution image; and the admitted NanoHost installer `host` leaf runs in its named non-container job. It asserts configuration values rather than document prose, so it stays inside the `AGENTS.md` rule against asserting source text.
- `web-user-operation-surface-contract.test.mjs` imports runtime `PUBLIC_OPERATION_ACCESS` and published Tier-A titles from `apps/web/src/app/surfaces.ts`. It checks a grouped disposition inventory accounts for every canonical-user and Workspace operation, excludes server and Gateway-actor operations, rejects duplicates, and admits a `live` or `workflow` row only when its surface title is a published Tier-A catalog title. A `roadmap` disposition is permitted only for the four unpublished Automation CRUD operations (`R092`), Knowledge proposal drafting (`R070`), and Knowledge proposal reversal (`R072`). This is catalog, disposition, and published-surface admission only; it does not prove UI behavior.
- `release-preflight.test.mjs`, `release-image-state.test.mjs`, `package-release-assets.test.mjs`, `release-workflow.test.mjs`, and the isolated `support/nanohost-release-installer-live.sh` gate enforce release identity, registry failure handling, portable Skill and NanoHost packaging, digest-pinned inputs, fixed-path installer safety, and the candidate-smoke-promotion workflow structure owned by `docs/specs/20260829-release_management.md`.
- `support/` contains cross-package test data and setup support with demonstrated consumers.
- `smoke/` contains built-artifact health checks.
- `stories/` contains versioned L6 Story Markdown artifacts.

## Commands

Run root JavaScript unit tests, including Story parser tests, through the root unit gate:

```bash
pnpm -w test:unit
```

Run the Story schema L0 check and focused parser unit test directly:

```bash
node scripts/validate-story-schema.mjs
node --test tests/story-metadata.test.mjs
```

Mechanical acceptance tests stay with the app layer that owns their boundary. Run the root L4 gate with:

```bash
pnpm -w test:e2e:web
```

The app-owned L3 real-provider, real-subscription, real-task-mode, and NanoCore-restart gates are documented in `apps/nanocore/README.md` and remain default-off.
