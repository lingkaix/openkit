# OpenKit Skills

This directory contains repository-authored Skills used by desktop AI applications to operate OpenKit through the OpenKit MCP server.

## Skills

| Skill | Audience | Phase | Use when |
|---|---|---|---|
| `openkit-setup` | end user | setup | an agent helps a human connect a desktop AI app to an existing local or remote NanoCore backend and configure MCP |
| `openkit-setup-dev` | OpenKit developer | setup | an agent works inside this repository and needs local NanoCore plus MCP configured for dogfooding |
| `openkit-loop` | end user | loop | setup is already available and an agent should coordinate bounded work on the user's selected workspace |
| `openkit-loop-dev` | OpenKit developer | loop | developer setup is already available and an agent should coordinate review-gated OpenKit self-improvement |

## Handoff Rules

- Use `openkit-setup` before `openkit-loop` when the user-facing MCP connection is not configured or verified.
- Use `openkit-setup-dev` before `openkit-loop-dev` when this repository is not prepared for local NanoCore and MCP dogfooding.
- Keep setup Skills focused on connection, diagnostics, and readiness verification.
- Keep loop Skills focused on Goal Mode, bounded worker steps, Action Center review, artifacts, evidence, and human decisions.

## Boundary

Skills provide operating guidance. They are not worker-side tool supply, NanoCore installers, backend supervisors, or internal admin APIs.
