---
id: external-agent-grounded-record
title: Explain a recorded result through the remote connection
persona: Team member using an outside agent to understand work on this deployment
entrypoint: remote-mcp
default_tool: cursor-cli
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20261002-remote_mcp_interface.md, docs/specs/20260909-persistent_deployment_acceptance.md, docs/specs/20260704-chat_mode_assistant.md, docs/specs/20260704-remote_auth_credential_bootstrap.md, docs/core/protocol.md, docs/specs/20260703-storage_layout_record_ownership.md, docs/specs/20260909-thread_visibility_and_sharing.md
---

## Intent

Persona: A team member using their own agent against this deployment.

Ask: Find the designated shared thread and explain its latest completed result from what is actually recorded there.

## Starting World

One persistent deployment is already running. One designated shared Thread has one completed result that a public read can show. The helper connection can read that Thread. The actor's host session is fresh and is not the source checkout.

## Setup

The stage manager configures the remote connection in a fresh host session. The stage manager supplies only the persona and the ask. The private parameter file holds the connection facts. The stage manager does not put an access-key value in the story or in the ask.

## Outcome Predicates

- Channel outside-in, tier required. The actor's explanation states the designated Thread's latest completed result, and an independent recompute of that public record agrees. `docs/specs/20260909-persistent_deployment_acceptance.md` owns that recompute.
- Channel inside-out, tier required. The explanation is grounded in that Thread's public record on this deployment, and the run does not change an unrelated resource. The records are the Thread, its completed Turn, and its completed Item. `docs/core/protocol.md` owns their canonical semantics. `docs/specs/20260703-storage_layout_record_ownership.md` owns their storage source of truth. `docs/specs/20260909-thread_visibility_and_sharing.md` owns their audience and read boundary.
- Channel outside-in, tier optional. When connection or operation admission fails, the captured result is the truthful refusal rather than a claim that the product is ready. The judge skips this predicate when admission succeeds.
- Channel inside-out, tier optional. When a simple question is answered on the addressed Thread, that exchange's answer is a meaningful assistant message and that exchange's completed assistant-message Item is on that Thread. This exchange creates no delegated Worker Turn and no handoff Item. That exchange's public `conversation.submit` result has `targetRef=internal-role:assistant`, `outcome=answered`, and `handoff=null`. That exchange's originating and receiving Workspace and Thread are the same. That exchange's completed Turn has `agentId=quick-chat`. The judge skips this predicate when no simple question is answered. The records are that exchange's command result, Turn, and Item. `docs/specs/20260704-chat_mode_assistant.md` owns that boundary. `docs/core/protocol.md` owns those Turn and Item semantics. `docs/specs/20260703-storage_layout_record_ownership.md` owns their storage source of truth. `docs/specs/20260909-thread_visibility_and_sharing.md` owns their audience and read boundary. Dashboard work-status fields do not decide it. Missing guide does not by itself fail it.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager keeps the verbatim actor prompt, the redacted tool descriptions actually supplied, and the requests and responses the actor used. The stage manager also keeps the client identity, the served-guide identity, and the public record the judge recomputes. An operator spot check alone does not prove the flow.

## Cleanup

The stage manager keeps the deployment and removes attempt-owned host state.

## Failure Triage Notes

- A product failure means the explanation contradicts the public record, the run changes an unrelated resource, or a witnessed chat exchange delegates a Worker or breaks the quick-chat result.
- An environment failure means the deployment or the helper connection is missing, or the actor-host model fails before a product result exists.
- A tool failure means the Cursor client or its remote connection fails on its own.
- An inconclusive result means the designated record was never read, or the optional chat result was witnessed only in part.
- The likely lower layer is the remote-connection admission tests and, for the optional result, the chat-mode command tests.
