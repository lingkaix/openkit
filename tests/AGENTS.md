# Repository Test Guidelines

Read `README.md` first. This file contains only local agent execution rules for repository-level tests.

## Rules

- Keep each invariant at the lowest sufficient test layer and do not repeat L0 corpus validation in root unit tests.
- Keep shared support limited to behavior with current cross-package consumers.
- Keep Story Runner policy tests focused on default-off and prerequisite gates, shared safety support, and validation before runner-owned external effects.
- Do not assert source text, internal helper shape, or story-specific fake mirrors. The finite exemptions are `agents-root-contract.test.mjs`, which projects root `AGENTS.md` and only the declared seams in `.codex/agents/builder.toml`, `.codex/agents/reviewer.toml`, and `.codex/agents/test-author.toml`; `change-execution-contract.test.mjs`, which projects `docs/change-execution.md`, the fresh-context and durable-commitment seams in `.codex/agents/verifier.toml` and `.codex/config.toml`, the change-plan bundle and findings-type seams in `docs/documentation-model.md`, and exactly the findings, route-log, and temporary-placement seams it names in `docs/changes/README.md` and `docs/changes/AGENTS.md`; and `verification-instruments-contract.test.mjs`, which projects `docs/verification-instruments.md` plus exactly the ownership-release and cross-reference seams it names in `docs/specs/20260529-test_strategy.md`, `docs/specs/20260719-verification_calibration.md`, `docs/toolchain.md`, `docs/change-execution.md`, `docs/documentation-model.md`, and `.codex/agents/test-author.toml`. These tests hold no authority.
- Follow the nested `README.md` and `AGENTS.md` files before changing `stories/` or `story-runner/`.
