# L6 Story Artifact Guidelines

Read `README.md` first. This file contains only local agent execution rules for L6 story artifacts.

Before changing stories, read `docs/specs/20260529-l6_story_acceptance.md` and this directory's `README.md`.

## Rules

- Keep every story in English Markdown with a `*.story.md` suffix.
- Use only scalar front matter supported by `tests/story-runner/story-metadata.mjs`.
- Include the required metadata fields: `id`, `title`, `persona`, `entrypoint`, `default_tool`, `timeout_seconds`, `requires_real_provider`, and `requires_real_codex`.
- Keep story bodies human-readable and agent-readable.
- Describe user-visible workflow steps instead of implementation shortcuts.
- Put setup, cleanup, and evidence requirements in explicit sections.
- Do not include real credentials, raw secrets, private account data, or host-specific state.
- Do not require a deterministic runner for every story.
- If a story gets a deterministic adapter, update `tests/story-runner/` documentation and keep the story attached to the adapter report.
- If an L6 run finds a confirmed deterministic defect, add or request the lowest-layer L1-L5 regression test that can catch it.
