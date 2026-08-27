# L6 Story Artifact Guidelines

Read `README.md` first. This file contains only local agent execution rules for L6 story artifacts.

Before changing stories, read `docs/specs/20260529-l6_story_acceptance.md` and this directory's `README.md`.

## Rules

- Keep every story in English Markdown with a `*.story.md` suffix.
- Use only scalar front matter supported by `scripts/lib/story-metadata.mjs`; `contracts` stays one comma-separated scalar line.
- Include the required metadata fields: `id`, `title`, `persona`, `entrypoint`, `default_tool`, `timeout_seconds`, `requires_real_provider`, `requires_real_codex`, and `contracts`.
- Keep the body inside the normative section list owned by `docs/specs/20260529-l6_story_acceptance.md`.
- Keep story bodies human-readable and agent-readable.
- Describe user-visible workflow steps instead of implementation shortcuts.
- Put setup, cleanup, and evidence requirements in explicit sections.
- Do not include real credentials, raw secrets, private account data, or host-specific state.
- Do not add a committed runner, adapter, or per-story command. A mechanical proof belongs at L3 or L4 with the owning app.
- If an L6 run finds a confirmed deterministic defect, add or request the lowest-layer L1-L5 regression test that can catch it.
