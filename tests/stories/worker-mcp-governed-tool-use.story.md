---
id: story-worker-mcp-governed-tool-use
title: Complete governed Worker MCP tool use
persona: Product evaluator validating an agent workspace with MCP tool supply
entrypoint: web
default_tool: playwright
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: false
---

# Complete Governed Worker MCP Tool Use

## Purpose

Verify that a user can run a worker task whose resolved Agent Environment Package exposes a catalog-declared MCP server, that the worker can use an allowed MCP tool through NanoCore governance, that approval-required MCP tools raise a human gate before execution, and that audit evidence remains free of credentials and raw tool payloads.

## Preconditions

- NanoCore can boot with a disposable data root.
- Web can boot against that NanoCore instance.
- The test environment can use a deterministic stdio MCP stub server instead of a real external MCP provider.
- The story does not require real Codex, real provider quota, real GitHub credentials, or external network access.
- Worker MCP lower-level L1-L5 coverage is available for schema validation, policy denials, vault grant revocation, gateway result redaction, and built-artifact gateway smoke.

## Setup

- Start NanoCore in local mode with a fresh temporary data root.
- Start the Web UI against that NanoCore instance.
- Register or select an agent configuration that enables the catalog `github` MCP server for a disposable workspace.
- Use only fake credential markers if a vault-backed credential path is seeded.
- Seed the MCP server with deterministic tools named `repos.get` and `issues.list`.
- Mark `issues.list` as approval-required and leave `repos.get` as directly callable after policy allow.
- Collect server logs, browser evidence, and redacted database or API read-model snapshots after the run.

## User-visible Steps

1. Open the Web UI root route.
2. Create or select a disposable workspace and thread.
3. Start a worker task that needs repository information from the MCP catalog server.
4. Observe that the worker-visible MCP server list includes the enabled server without exposing launch commands, endpoint URLs, vault references, or credential hints.
5. Let the worker call `repos.get` and complete the first tool-backed step.
6. Start or continue the task so the worker attempts `issues.list`.
7. Observe a human approval gate explaining the requested MCP tool call without showing tool arguments or credentials.
8. Approve the gate.
9. Let the worker retry with the approval handle and complete the task.
10. Open the relevant diagnostics, audit, or evidence surfaces available in the product.

## Expected Outcomes

- The worker task reaches a terminal successful state after the approved MCP call.
- The normal MCP tool call executes without a human gate when a valid policy decision exists.
- The approval-required MCP tool pauses until the user grants approval.
- The approval row is clearly tied to the requested server and tool name.
- Tool outputs shown to the user are product-safe and do not expose credential-shaped fields.
- Diagnostics and evidence show the capability call chain, schema snapshot identity, policy decision or approval linkage, usage row, and vault-use or injection records when seeded.
- No user-visible surface reveals raw credentials, launch command secrets, raw tool arguments, or native MCP server errors.

## Deterministic Assertions

- The enabled MCP server is visible by id and tool-name summary only.
- A successful `mcp.call_tool` capability call exists for `repos.get`.
- A pending approval exists before `issues.list` executes.
- An approval-linked allow decision exists after the user approves the gate.
- A successful `mcp.call_tool` capability call exists for `issues.list` after approval.
- Exactly one tool-call usage row is recorded for each successful MCP tool call.
- No worker-visible payload, approval payload, audit summary, schema snapshot, or usage row contains the fake credential marker.

## Evidence To Collect

- Story metadata and final assertion summary.
- Browser screenshots or trace around the approval gate and terminal task state.
- Redacted server logs for MCP route calls and typed errors, if any.
- Redacted capability-call, usage, permission-decision, schema-snapshot, and vault-use evidence snapshots.
- Any lower-layer regression references created from confirmed deterministic failures.

## Cleanup

- Stop all spawned NanoCore, Web, and MCP stub processes.
- Remove the temporary data root and any disposable repository or stub files.
- Revoke or discard any fake vault grant and fake credential material seeded during setup.

## Failure Triage Notes

Any confirmed deterministic defect from this story must be reduced into the lowest-layer regression test that can catch it in L1, L2, L3, L4, or L5. Keep this story agentic-only until the Web and worker-task surfaces for MCP evidence are stable enough for a resilient deterministic adapter.
