# OpenKit Skills

Read `README.md` first. This file contains only local agent execution rules for OpenKit-authored Skills.

## Local Agent Rules

- Keep one public product Skill at `skills/openkit/` and one independently packaged operations Skill at `skills/openkit-ops/` under their owning specifications. Host operations stay outside the public CLI; do not create developer, self-improvement, setup-only, or loop-only variants.
- Do not reintroduce the deleted user-facing stdio MCP package, setup-only, loop-only, developer, or self-improvement Skill variants. This does not prohibit the accepted remote MCP endpoint owned by [Remote MCP Interface](../docs/specs/20261002-remote_mcp_interface.md).
- Keep the Skill folder minimal: `SKILL.md` is required, `agents/openai.yaml` is generated, the CLI entrypoint belongs under `scripts/`, and detailed guidance belongs in directly linked one-level `references/`; do not add a README or nested reference chain inside the Skill folder.
- Keep `SKILL.md` as a concise router and default loop rather than copying the complete capability catalog into context.
- Keep the bundled CLI thin, deterministic, JSON-only, and limited to the transport-neutral operation catalog over public NanoCore contracts.
- Keep worker-side MCP capability supply out of the Skill and do not restore the deleted user-facing stdio MCP transport. This does not prohibit the accepted remote MCP endpoint owned by [Remote MCP Interface](../docs/specs/20261002-remote_mcp_interface.md).
- Do not teach agents to bypass NanoCore public APIs, Goal Mode, Action Center, approval gates, review gates, repository diagnostics, credential safeguards, or human decisions.
- Keep Skill entrypoints in English; localized operator references follow `docs/documentation-model.md`.
- Validate Skill metadata with the skill-creator quick validator when the local Python environment supports its dependencies.
