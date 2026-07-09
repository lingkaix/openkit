# L6 Story Runner Guidelines

Read `README.md` first. This file contains only local agent execution rules for L6 story runner code.

Before changing runner code, read `docs/specs/20260529-l6_story_acceptance.md`, `tests/story-runner/README.md`, and the story file under `tests/stories/` that the runner executes.

## Rules

- Keep deterministic adapters separate from ordinary Web L4 e2e tests.
- Read and validate the source story metadata before executing a deterministic flow.
- Operate through visible UI controls and accessible selectors whenever practical.
- Use setup or cleanup shortcuts only when the story allows them.
- Attach the source story and assertion summary to the Playwright report.
- Preserve Playwright trace and screenshot evidence on failure.
- Do not call external AI models from deterministic adapters.
- Do not require real provider credentials, real Codex login, browser profile state, or provider quota unless the story metadata explicitly opts in and the command is manual.
- Keep story metadata parsing dependency-free unless the L6 spec is updated to accept a schema change.
- Add tests first for parser, validator, helper, or adapter behavior changes.
- Document every exported function or helper with JSDoc.
- Reduce confirmed deterministic L6 defects into the lowest practical L1-L5 regression test.
