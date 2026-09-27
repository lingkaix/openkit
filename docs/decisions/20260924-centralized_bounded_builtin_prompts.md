---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# Centralized And Bounded Built-In Prompts

## Decision

Manage the fixed System Prompt text of every NanoCore built-in agent in one source location. Assemble current Tool definitions and trusted context at admission separately from fixed role text. Each agent's complete fixed text, including any shared preamble and fixed assembly guidance, is limited to 3000 Unicode code points, including whitespace. An executable test enforces the limit.

## Reason

The engineer requested this on 2026-09-24 while approving continuous Goal planning and intent revision. The Orchestrator needs a clear statement of that responsibility. Improved models need concise responsibility and authority boundaries rather than extensive procedural restrictions. Centralized fixed text makes those boundaries discoverable and reviewable. Pi's separation of a fixed preamble from dynamically assembled context is a reference for assembly, not a decision to adopt its runtime.

## Rejected Alternatives

- Scattered inline prompts with a size test covering only selected roles. This leaves new entry points outside governance.
- Moving fixed instructions into dynamic context to fit the ceiling. This changes the count without reducing the instructions.
- Encoding complete Tool schemas and deterministic authorization rules in prose. Their existing executable owners remain more precise.

## Revisit When

Role-relevant evidence shows that a specific agent needs a larger fixed prompt and the engineer approves a new limit.

## Affected Owners

- docs/specs/20260813-internal_agent_runtime.md
- docs/specs/20260704-chat_mode_assistant.md
