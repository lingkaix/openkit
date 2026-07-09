# OpenKit Skills

Read `README.md` first. This file contains only local agent execution rules for OpenKit-authored Skills.

## Local Agent Rules

- Keep each Skill focused on one audience and one operating context.
- Keep Skill folders minimal: `SKILL.md` is required and `agents/openai.yaml` is recommended; do not add README files inside individual Skill folders.
- Keep normal end-user setup in `openkit-setup`, repository-developer setup in `openkit-setup-dev`, normal end-user loop coordination in `openkit-loop`, and repository self-improvement coordination in `openkit-loop-dev`.
- Keep worker-side MCP capability supply out of these Skills.
- Do not teach agents to bypass NanoCore public APIs, Goal Mode, Action Center, approval gates, review gates, repository diagnostics, or human decisions.
- Keep all Skill text in English.
- Validate Skill metadata with the skill-creator quick validator when the local Python environment supports its dependencies.
