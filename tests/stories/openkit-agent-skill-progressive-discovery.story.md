---
id: story-openkit-agent-skill-progressive-discovery
title: Discover and complete one bounded OpenKit operation through the unified Skill
persona: End user asking a Skill-capable agent to create and confirm an OpenKit workspace
entrypoint: skill
default_tool: codex-cli
timeout_seconds: 300
requires_real_provider: true
requires_real_codex: true
contracts: docs/specs/20260713-openkit_agent_skill_interface.md, docs/specs/20260704-app_api_openapi_projection.md
---

# OpenKit Agent Skill Progressive Discovery

## Purpose

Prove that a real Skill-capable agent can begin with only the `openkit` Skill metadata, progressively load the minimum guidance, discover a current operation absent from `SKILL.md`, call it through the bundled CLI, and confirm the durable result without MCP, direct HTTP, repository source imports, or the full operation catalog in context.

## Preconditions

- A clean supported host provides Node.js 24, real Codex access, and the packaged `openkit` Skill.
- A temporary local NanoCore is reachable through `OPENKIT_NANOCORE_URL` and requires no bearer token.
- The workspace name chosen for the run is unique and contains no secret or private data.
- The executor captures only redacted Codex events, the final response, and public CLI envelopes.

## Setup

1. Install only the packaged `skills/openkit/` artifact into the agent host's Skill directory.
2. Start a temporary local NanoCore with an empty data root.
3. Expose the `openkit` Skill metadata to the agent without preloading `SKILL.md`, references, source modules, or catalog contents.
4. Ask the agent to create one workspace with the chosen name, confirm it appears in the durable workspace list, and stop.

## User-visible Steps

1. The agent selects the `openkit` Skill from its metadata.
2. The agent loads `SKILL.md` and `references/loop.md`, but does not load every reference.
3. The agent runs `scripts/openkit doctor`.
4. The agent searches for workspace creation, describes `workspace.create`, and calls it with one JSON object through stdin.
5. The agent searches for or describes the public workspace-list operation, calls it, and confirms the created workspace is present.
6. The agent reports the confirmed workspace name and stops without starting unrelated work.

## Expected Outcomes

- The agent progresses from Skill metadata to a confirmed durable workspace using only progressive disclosure and the bundled CLI.
- The created workspace is durably visible through the public list operation.
- The agent stops after confirming the result without starting unrelated work.

## Deterministic Assertions

- The redacted Codex event stream shows the agent starts from Skill metadata and reads only `SKILL.md` plus `references/loop.md` before invoking the product.
- The event stream and the recorded actor prompt show `workspace.create` is discovered through CLI search and inspected through CLI describe, not copied from `SKILL.md` or supplied in the user prompt.
- The event stream shows every product request uses the packaged `scripts/openkit` CLI, with no MCP tool, MCP resource, MCP prompt, direct HTTP call, raw storage access, or repository source module.
- The captured `doctor` envelope reports the exact supported NanoCore protocol contract.
- The captured `workspace.create` envelope succeeds and the subsequent public `workspace.list` envelope contains the same workspace record.
- The event stream shows the agent does not load the complete operation inventory and performs no second mutation.
- The evidence leak scan finds no credential, token, local private path, or unrelated environment value.

## Evidence To Collect

- The verbatim actor prompt.
- Redacted Codex JSONL events sufficient to show Skill/reference reads and CLI command order.
- The final agent response.
- The successful public `workspace.create` and `workspace.list` envelopes, or equivalent redacted command evidence within the Codex event stream.

## Cleanup

- Stop the temporary NanoCore.
- Delete the temporary data root, temporary agent workspace, and installed test Skill copy.
- Retain the redacted evidence package under the L6 retention policy after the result has been recorded in the owning change plan.

## Failure Triage Notes

- A missing or incompatible packaged CLI is a WP-1 interface defect.
- A NanoCore rejection is inspected through its typed error and request id; the story does not bypass the public interface.
- An agent that loads all references, guesses an operation, uses MCP or direct HTTP, or fails to re-read durable state fails this story without adding runner behavior.
- Reduce any deterministic product defect to the lowest sufficient L1-L5 regression before rerunning this story.
