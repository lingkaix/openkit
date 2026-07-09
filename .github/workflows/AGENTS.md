# Workflow Guidelines

Read `README.md` first. This file contains only local agent execution rules for workflow definitions.

Before changing workflows, read `docs/specs/20260529-test_strategy.md`, `docs/specs/20260529-l6_story_acceptance.md`, and this directory's `README.md`.

## Rules

- Keep pull request CI lightweight.
- Do not add ordinary branch-push CI by default.
- Keep version-tag CI focused on the release gate: L0-L3 and L5.
- Keep L4 Web e2e manual unless release policy changes.
- Keep L6 story acceptance manual unless release policy changes.
- Name L6 jobs clearly as deterministic or agentic.
- Do not wire real-provider, real-Codex, subscription-auth, or quota-consuming tests into default CI.
- Install Playwright browsers only in jobs that need browser execution.
- Upload Playwright artifacts on browser or story failures.
- Use named jobs that map clearly to the test strategy layers.
