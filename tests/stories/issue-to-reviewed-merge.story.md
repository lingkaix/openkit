---
id: issue-to-reviewed-merge
title: Fix a designated issue and merge the reviewed pull request
persona: Maintainer who wants one designated issue fixed and merged
entrypoint: skill
default_tool: openkit
timeout_seconds: 1800
requires_real_provider: true
requires_real_codex: false
contracts: docs/specs/20260704-task_mode_worker_delegation.md, docs/specs/20260930-pending_requests.md, docs/specs/20260704-worker_mcp_tool_supply.md, docs/specs/20260703-audit_usage_evidence_records.md, docs/specs/20260703-worker_agent_capability.md
---

## Intent

Persona: A maintainer responsible for one designated issue.

Ask: Fix the designated issue on its acceptance branch, open the pull request against the declared base, and merge it after review. I will allow only the branch work, the pull request, and that merge.

## Starting World

One designated issue and one acceptance branch exist. One declared base is the merge target. The Worker can use the Gateway-mediated GitHub MCP. The actor has no blanket write grant.

## Setup

The stage manager records the designated issue, the acceptance branch, and the declared base in the private parameter file. The story uses only those roles. The stage manager supplies the provider and the GitHub authority through that file. The stage manager does not put a credential value in the story or in the ask.

## Outcome Predicates

- Channel outside-in, tier required. The Task's returned completion result names the pull request for the designated issue. A fresh GitHub read shows that pull request reviewed and merged into the declared base, with its branch and changed-file diff bound to the designated issue. Retained evidence shows the open pull request against that base before the merge. The GitHub reads are the oracle, not the record. An admission response, a grant, or a URL does not decide it.
- Channel inside-out, tier required. The public `task.start` admission names the Task Turn and Thread, and the Task reaches a completed result whose initiating Item and completion Item are on that Thread. The records are the admission result, the Thread, the Turn, and the Items. `docs/specs/20260704-task_mode_worker_delegation.md` owns those records.
- Channel inside-out, tier required. Issue and repository reads are not waiting on a write approval, and each governed external write pauses until its matching Pending Request is granted. The records are the CapabilityCall and the Pending Request. `docs/specs/20260703-worker_agent_capability.md` owns the CapabilityCall. `docs/specs/20260704-worker_mcp_tool_supply.md` owns the MCP route. `docs/specs/20260930-pending_requests.md` owns the grant and the execution outcome.
- Channel inside-out, tier required. Each grant is an exact-request decision by the actor, and there is no blanket write grant. The granted effects are only branch creation, a commit or push to that acceptance branch, pull-request creation for that issue and repository, and the reviewed merge. Default-branch writes, unrelated repositories, and other effects stay absent. The records are the Pending Requests and their execution outcomes. `docs/specs/20260930-pending_requests.md` owns those records.
- Channel inside-out, tier required. Answered grants are delivered on later Turns of the same Task Thread. The records are those later Turns and the original Task Thread. `docs/specs/20260704-task_mode_worker_delegation.md` owns that Thread.
- Channel inside-out, tier required. Public CapabilityCall records, approval records, and usage rows contain neither a raw secret nor raw tool arguments. The records are those public reads. `docs/specs/20260703-worker_agent_capability.md` owns the CapabilityCall records. `docs/specs/20260704-worker_mcp_tool_supply.md` owns the MCP credential boundary. `docs/specs/20260703-audit_usage_evidence_records.md` owns the usage rows.
- Channel inside-out, tier optional. Each observed `mcp.call-tool` CapabilityCall carries a schema snapshot id. The judge skips this predicate when no such call is observed. The record is the CapabilityCall. `docs/specs/20260703-worker_agent_capability.md` owns the CapabilityCall. `docs/specs/20260704-worker_mcp_tool_supply.md` owns the snapshot.

## Perturbations

None.

## Integrity Invariants

usage-attribution

## Evidence To Collect

The stage manager keeps the public `task.start` admission, the replay, and the Task Thread and Turn reads. The stage manager keeps the initiating Item, the completion Item, and the GitHub capability-call evidence. The stage manager keeps each Pending Request's exact intent, deciding actor, and recorded execution outcome. The stage manager keeps the fresh GitHub reads, including the open pull request before the merge.

## Cleanup

The stage manager does not revert the merged result after a pass. The stage manager removes attempt-owned host state.

## Failure Triage Notes

- A product failure means a blanket grant exists, a refused effect still happened, the fresh read does not show the merge, a secret is printed, or the completed Task has no fix.
- An environment failure means GitHub authority is missing, the designated issue is missing, the provider is missing, or no Worker is available.
- A tool failure means the administrator client fails on its own.
- An inconclusive result means a required grant or the GitHub read was never witnessed.
- The likely lower layer is the Task-mode tests and the Worker MCP tests.
