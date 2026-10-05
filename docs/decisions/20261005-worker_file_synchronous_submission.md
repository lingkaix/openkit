---
status: Accepted
date: "2026-10-05"
decider: Engineer
---
# Synchronous Submission Of Worker Files

## Decision

On 2026-10-05 the engineer approved Round 2's synchronous file-submission design. A Worker deliberately submits one file through `work_submit_artifact` on the existing `openkit-work` MCP supply. The agent supplies a request id, path, existing Artifact kind, title, one of the admitted media types, and an optional Material proposal. Core derives the physical target, admitted output slot, relative path, request identity and byte bound from trusted context. NanoHost captures that one file through the existing `file.export` effect during the active Turn. Core verifies the exported bytes, applies the shared exact-value guard, and creates the Artifact, its `artifact-reference` Item, its Review and the command receipt before answering with the Artifact id. A proved ordinary path or format refusal is a fixable error in the same Turn; uncertain capture or incomplete publication remains a truthful fail-closed outcome.

The engineer approved two governing changes to the existing owners: active-Turn export of one admitted output-slot path, with terminal transcript and evidence export unchanged; and a per-call failure unit in place of whole-Turn candidate-set rejection. Each call validates before publication. Earlier committed Artifacts survive a later submission rejection. Exact-value checking retains its existing strength on every submitted byte, including required comparison evidence and loopback-digest checks.

The 16 MiB per-Turn limit counts successfully published Worker Artifact bytes. Each transfer is bounded to remaining capacity plus one sentinel byte. Rejected calls publish nothing, and corrected calls can transfer again, so total attempted transfer bytes can exceed the publication limit. Quota checking and publication are serialized under existing authority; this design adds no durable byte counter or reservation record.

Artifact identity derives from the authenticated producing package and Turn plus the submission request id. The same request and path/metadata replay the committed original Artifact before another export; changed input under that request conflicts. Later changes to the file do not update the Artifact, and a corrected file or new version uses a new request. A complete tuple and receipt with a lost response replay the same Artifact id. Partial authority or authority without its receipt follows the existing `recovery_required` compromise rather than reconstructing a receipt or repeating the effect.

Success guarantees the exact verified exported copy captured during the call, rather than a filesystem snapshot or the file's contents at invocation time. The agent finishes writing before submission; later writes do not change the immutable Artifact. Publication rechecks active admission after capture and commits before terminalization can win. Cancellation keeps committed Artifacts and writes nothing uncommitted; a late result cannot publish on a sealed Turn. Submission does not accept Task or Goal completion.

## Reason

The agent gets an intentional, inspectable deliverable and can correct a wrong path or format in the same Turn, without new pending-declaration state. Returning an Artifact id after durable publication makes the response useful immediately. Existing Core Artifact authority and NanoHost file capture provide independent byte verification without requiring four runtime-specific submission implementations.

Source: the engineer's 2026-10-05 ruling reproduced in the writer brief write-decisions-1005, approving Round 2 of the Worker output consultation. Round 1 proposed deferred registration; Round 2 replaced that recommendation after scrutiny of its durable intent, deferred errors and closeout obligations. The consultation supplies analysis, not implementation acceptance.

## Rejected Alternatives

- Deferred Turn-end collection with a durable declaration set: it adds pending intent and recovery state and delays errors beyond the agent's repair opportunity.
- Collecting every file under an eligible root: eligibility does not express intentional submission, and scratch files or retained files can become unwanted deliverables.
- Agent-authored transcript JSONL declarations: they impose private protocol identity and sequencing on the agent and retain a second submission path instead of the selected MCP interface.
- Publishing Workspace capture as a Sync Review: capture evidence and source-diff review do not provide the intended standalone Artifact handoff.
- Inline content: it proves the Tool argument's bytes, rather than independently captured Worker file bytes, and would add another submission mode outside this slice.

## Revisit When

Proposed revisit conditions, not a separate engineer ruling: live submission cannot preserve independent heartbeat and cancellation, real use requires an atomic filesystem snapshot or whole-set publication, or the engineer changes the need from independently captured files to inline authored content. Any change to the export boundary, failure unit or credential guard returns to the engineer.

## Affected Owners

- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md): the implementation landing replaces the declaration source and amends identity, publication timing, per-call failure and published-byte budget text.
- [NanoHost Workspace Data Boundary](../specs/20260801-nanohost_workspace_data_boundary.md): the implementation landing admits active-Turn export of the selected output-slot file, variable bounded reads and proved ordinary file refusals while preserving terminal transcript and evidence export.
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md): the implementation landing aligns live export admission, request-derived capture identity, bounded transfer and typed refusal carriage.
- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md): the implementation landing adds the synchronous command's lineage and replay projection under the existing Artifact/reference/Review and receipt compromise.
- [Worker Agent Capability](../specs/20260703-worker_agent_capability.md) and [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md): the implementation landing adds the Tool to the existing supply and defines durable success, admission, replay and error semantics.
