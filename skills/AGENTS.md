# OpenKit End-User Skill

Read `README.md` first. This file contains only local agent execution rules for OpenKit-authored Skills.

## Local Agent Rules

- Implement one end-user-only Skill at `skills/openkit/`; do not create developer, self-improvement, setup-only, or loop-only variants.
- Do not reintroduce user-facing MCP, setup-only, loop-only, developer, or self-improvement Skill variants.
- Keep the Skill folder minimal: `SKILL.md` is required, `agents/openai.yaml` is generated, the CLI entrypoint belongs under `scripts/`, and detailed guidance belongs in directly linked one-level `references/`; do not add a README or nested reference chain inside the Skill folder.
- Keep `SKILL.md` as a concise router and default loop rather than copying the complete capability catalog into context.
- Keep the bundled CLI thin, deterministic, JSON-only, and limited to the transport-neutral operation catalog over public NanoCore contracts.
- Keep worker-side MCP capability supply out of the Skill and do not restore a user-facing MCP transport.
- Do not teach agents to bypass NanoCore public APIs, Goal Mode, Action Center, approval gates, review gates, repository diagnostics, credential safeguards, or human decisions.
- Keep all Skill text in English.
- Validate Skill metadata with the skill-creator quick validator when the local Python environment supports its dependencies.
