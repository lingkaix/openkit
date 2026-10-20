---
type: change-plan
status: implemented
date: 2026-10-20
branch: lane/go-restrictive-policy-warnings
---
# Restrictive MCP Policy Warnings

## Intent Revision 1

The engineer replaced the discovery-admission proposal with a smaller Policy change. Active human ordinary prohibit and require_approval statements may name a Tool before observation. Such restrictions grant nothing. A server-computed warning must remain visible in the exact human-confirmed candidate. Any future admitted allow effect retains its observation requirement.

The engineer approved one optional warnings array in the retained Policy candidate, not in PolicyWriteProposalV1. Absence and empty arrays mean none. No converter is required before the final reset. Apply revalidates Policy and authority, without requiring proposal-time warnings to match a later observation. The coordinator independently reviews and lands; this implementation neither pushes nor lands.

## Owners And Scope

[Policy Enforcement Mapping](../../specs/20260703-policy_enforcement_mapping.md) owns the restrictive subset and exact matching. [Worker MCP Tool Supply](../../specs/20260704-worker_mcp_tool_supply.md#policy-binding) owns exposure and dispatch. [Chat Mode](../../specs/20260704-chat_mode_assistant.md#administration-entry-path) owns the candidate and confirmation boundary.

The change is limited to Policy preparation, the existing candidate schema/producer, fixed Tool failure guidance, their tests and documentation. No discovery command, receipt registry, store, storage, DDL, runtime or shim change is included; the Web review only renders the retained warnings. Existing Policy approval, revisions, author checks and effect gates remain binding.

## Regression And Implementation

Before production edits, the updated real-owner configuration tests failed four cases at policy_mcp_tool_unobserved: both unobserved restrictive effects, later observation before apply, and observation loss before apply. Sixteen controls passed, including observed-name behavior and refusal of active ordinary allow outside the current subset. Initial typecheck failure was missing newly merged telemetry dependencies; offline frozen dependency installation corrected setup before the deciding RED.

The producer now stores typed code, Workspace/server/Tool identifiers and a display message in optional candidate warnings. The same text enters preparation's existing native validation-plan warning list. The proposal response returns that transient plan; it is not a second retained candidate field. The core Policy proposal remains unchanged. The candidate digest covers warning bytes; apply checks the existing Policy/base/authority invariants but does not compare the observation-dependent warning list. Duplicate warnings for one exact Tool are combined.

Tests verify the candidate digest, exact warning content, proposal-input exclusion, both restrictive effects, later exact-name enforcement without another Policy write, observed-name no-warning behavior and apply across observation changes. Typed schema tests preserve absent/empty warnings and reject unknown warning codes or author-supplied metadata. Initial focused tests pass: twenty-four NanoCore cases and four shared-schema cases; typecheck and focused Biome pass. Inspection then strengthened the dry-run oracle from an internal spy to the caller-visible proposal plan: both restrictive cases failed as expected because the plan was discarded. The response now exposes the existing native plan. Final qualification includes focused checks and the full NanoCore suite; the named execution logs and coordinator handoff report their exact results.

## Human Review Boundary

The confirmation view is AdministrationConfigurationReview in the Web settings screen. It shows before/after JSON and the confirmation digest, and now lists retained Policy candidate warnings in the candidate facts and the Apply dialog. A Web test failed before that rendering and passes with it.

## Checkpoint

Main 9fcb468a6 was merged before this piece. RED, corrected focused checks and setup failures remain in named execution logs. Full-suite and exact ready-to-land evidence belong to the execution checkpoint and coordinator handoff. No live Tool, dev, deployment or business effect has been run. There are no interim RC cuts; L-OPS upgrades dev in place after landing, and the approved four-Workspace, thirteen-task, two-layer grok-4.6 protocol still waits for explicit run GO.
