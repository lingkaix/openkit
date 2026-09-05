---
id: worker-mcp-governed-tool-use
title: Complete governed Worker MCP tool use
persona: Product evaluator validating an agent workspace with MCP tool supply
entrypoint: web
default_tool: playwright
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: true
contracts: docs/specs/20260704-worker_mcp_tool_supply.md, docs/specs/20260629-openkit_policy_model.md
---

# Complete Governed Worker MCP Tool Use

## Purpose

Define the acceptance proof that a user can run a worker task whose resolved Agent Environment Package exposes a catalog-declared MCP server, that the worker can use an allowed MCP tool through NanoCore governance, that approval-required MCP tools raise a human gate before execution, and that audit evidence remains free of credentials and raw tool payloads. This story is the acceptance contract; retained run evidence decides current conformance.

## Preconditions

- An exact candidate NanoCore deployment can provide a fresh story-owned Workspace, either in a disposable deployment or in engineer-designated retained staging.
- Web can boot against that NanoCore instance.
- The test environment can use a deterministic local Responses provider and stdio MCP stub server instead of real provider quota or an external MCP provider.
- A packaged Codex worker and real NanoHost/OpenShell lifecycle are available; real provider quota, real GitHub credentials, and external MCP network access are not required.
- The worker capability plane and MCP gateway must have passed their L1-L5 checks for schema validation, policy denials, vault grant revocation, gateway result redaction, and built-artifact smoke before this L6 run begins.

## Setup

- Start or reuse the exact candidate NanoCore and Web deployment and create fresh story-owned Workspace state.
- Use the deployed real NanoHost/OpenShell and packaged Codex worker without mutating private runtime state during the actor flow.
- Register or select an agent configuration that enables the catalog `github` MCP server for the story-owned Workspace.
- Use only fake credential markers if a vault-backed credential path is seeded.
- Seed the MCP server with deterministic tools named `repos.get` and `issues.list`.
- Mark `issues.list` as approval-required and leave `repos.get` as directly callable after policy allow.
- Collect redacted browser evidence and public API read-model snapshots after the run.

## User-visible Steps

1. Open the Web UI root route.
2. Create or select the story-owned Workspace and Thread.
3. Start a worker task that needs repository information from the MCP catalog server.
4. Let the worker complete the repository-information portion of the task.
5. Continue the task to obtain the current issue list.
6. Observe any human approval gate explaining the requested action without showing arguments or credentials.
7. Approve the gate when the requested action matches the task.
8. Continue through the supported task surface until the requested result is complete.
9. Open the relevant diagnostics, audit, or evidence surfaces available in the product.

## Expected Outcomes

- The worker task reaches a terminal successful state after the approved MCP call.
- The normal MCP tool call executes without a human gate when a valid policy decision exists.
- The approval-required MCP call terminates denied without upstream contact, while the Task waits at its human Gate until the user grants approval.
- The approval row is clearly tied to the requested server and tool name.
- Tool outputs shown to the user do not contain the exact seeded fake credential bytes.
- Diagnostics and evidence show the capability call chain, schema snapshot identity, policy decision or approval linkage, usage row, and vault-use or injection records when seeded.
- No user-visible surface reveals raw credentials, launch command secrets, raw tool arguments, or native MCP server errors.

## Deterministic Assertions

- Required, outside-in: the actor record shows a successful terminal Task after the user approved the visible `github/issues.list` Gate. The browser transcript and final screenshot decide this assertion.
- Required, outside-in: the approval card names only the requested server and tool and exposes no tool arguments, endpoint, launch command, credential hint, or exact seeded fake credential bytes. The Gate screenshot and browser transcript decide this assertion.
- Required, inside-out: the selected AEP exposes `github` by id with only the selected `repos.get` and `issues.list` tool names and no upstream topology or credential material. The public AEP read model decides this assertion.
- Required, inside-out: one successful `mcp.call_tool` capability call exists for `repos.get`. The public capability-usage read model decides this assertion.
- Required, inside-out: the first `issues.list` call has a denied CapabilityCall and exact pending Approval with no matching UsageRecord before approval. The public Item, permission-decision, capability-usage, and usage read models decide this assertion.
- Required, inside-out: granting the Gate closes the source Turn, terminal teardown evidence exists for its AgentSession identity, and the successful `issues.list` call belongs to a fresh Task Turn with a different AgentSession identity. The public Thread, Turn, runtime-evidence, AEP, and capability-usage API records decide this assertion.
- Required, inside-out: the approved `issues.list` call has an approval-linked allow decision and one matching tool-call usage row, while each other successful MCP tool call also has one matching usage row. The public permission-decision and capability-usage read models decide this assertion.
- Required, outside-in: worker-visible and approval payloads expose neither raw MCP arguments nor the exact seeded fake credential bytes. The browser transcript and screenshots decide this assertion.
- Required, inside-out: public audit summaries, permission decisions, CapabilityCalls, and usage rows expose neither raw MCP arguments nor the exact seeded fake credential bytes, and each observed `mcp.call_tool` CapabilityCall carries a schema snapshot id. The redaction and identity scan over those named public read models decides this assertion.

## Evidence To Collect

- Story metadata and final assertion summary.
- Browser screenshots or trace around the approval gate and terminal task state.
- Redacted Codex and MCP observation summaries, without raw arguments or provider payloads.
- Public capability-call, usage, permission-decision, runtime-evidence, AEP, Thread, Turn, and Item snapshots, including each CapabilityCall schema snapshot id.
- Any lower-layer regression references created from confirmed deterministic failures.

## Cleanup

- End run-owned actor, judge, and browser processes, and verify that completed Worker-owned MCP subprocesses have settled through their normal lifecycle.
- For a disposable deployment, stop its spawned NanoCore and Web processes, remove its temporary data root and disposable repository or stub files, and discard its fake vault grants and credentials.
- For engineer-designated retained staging, preserve normal App and NanoHost services, data, users, configuration, credentials, and subscriptions. Record their retained state and active data-root identities separately from transient-process completion; do not claim retained product state was removed or restored.

## Failure Triage Notes

Any confirmed deterministic defect from this story must be reduced into the lowest-layer regression test that can catch it in L1, L2, L3, L4, or L5. Keep this story agentic-only; repeated deterministic setup or assertions belong at a lower test layer instead of a committed story runner.
