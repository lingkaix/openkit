---
date: "2026-10-30"
---
# Independent Documentation Audit: Answers For Sandbox And AgentSession

This non-authorizing record answers the assigned questions from the [sandbox audit](20261024-independent_doc_audit_sandbox.md), [AgentSession audit](20261025-independent_doc_audit_agent_session.md), and [supplement](20261025-independent_doc_audit_supplement.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records evidence and dispositions, not new design authority.

## Scope

- Current main inspected: `0be853326bbd8575e5448b65759c269d67691328`. This batch covers 20 questions: 16 DOC, 4 CODE, 0 HELD, 0 NONE, 0 ESCALATE-E.
- Answered by coordinator and consultant consensus under the engineer's delegation of 2026-10-30. The coordinator confirmed the answers and supplied the Q-182 amendment.
- Q-134 was supplied as settled. Its code issue remains a draft; only its matching documentation edit is applied. No code, held document, historical audit record, or other group owner is changed.
- Q-182 is CODE with a matching documentation edit. The coordinator files and routes the CODE drafts and CROSS-PART item.
- Q-23, Q-28 and Q-189 sweeps remain separate. Historical pin evidence is retained where it bounds qualification; editorial changes preserve the owning criteria.

## Answers

| Question | Answer | Fix type | Documents changed |
| --- | --- | --- | --- |
| Q-122 | Git captures provide inspection evidence; only non-Git changes enter Workspace Sync Review and host apply. The hosting decision already settles this boundary. | DOC | SYN |
| Q-123 | Describe persisted outcomes, not a new durable progress machine. Keep review states and include apply `blocked` and recovery `quarantined`; materialization and collection retain their existing lifecycle. | DOC | SYN |
| Q-124 | Verify the three enabled MCP operations on the capability binding. Built-in MCP supply makes the absent/disabled expectation false. | DOC | WRC |
| Q-125 | Worker Control Protocol owns v2 envelopes and private Harness interruption; include both observation event kinds. The unused AEP v1 label and descriptive event list do not select wire admission; document that fact without inventing a separate protocol or migration. | DOC | WRC |
| Q-126 | Test installation into a worker-created environment under `/sandbox`, and name the existing instruction root in the implementation projection. The bootstrap-selector rule already permits inert image metadata. | DOC | IMG |
| Q-127 | Name `/tmp/openkit-bootstrap` as the current writable temporary root. Keep backend refusal of unsupported `http`/`https` grants: the owner permits rejection before launch and does not require an earlier authoring restriction. | DOC | FRE |
| Q-128 | Set implementation to `N/A`: the deleted Cell implementation has no current alignment target. Leave Deprecated status and the separate auditor-owned archive transition unchanged. | DOC | CEL |
| Q-129 | Remove obsolete amendment/progress phrasing while preserving scope and useful qualification evidence. Resolve the touched SYN threshold sentence as a current policy default; leave the general number and label sweeps to their owners. | DOC | SYN, WRC, FRE, IMG, VOL, DPM |
| Q-133 | Use the owned work-slot and retained transcript paths, mark shared working optional, and remove FUSE from the example. Link clearing uncertainty to the existing wider fence; do not turn a retained capture into a disposable spool. | DOC | SSM |
| Q-134 (settled) | Verified the supplied settlement: the image does not produce the carrier, but the launcher still reads it. Apply its document removal and draft deletion of the unproduced carrier branch; do not change code here. | CODE | IMG, PI (matching document edit) |
| Q-135 | Remove amendment headings and duplicate reconnect prose; keep the full failure rule in Exact Reconnect Contract. Preserve pin-specific qualification limits, and leave untouched numbers, labels, and implementation evidence to the coordinated sweeps. | DOC | CON, SSM, CDX, OPC, PI, DSK |
| Q-175 | Record the existing private DeepSeek sidecar and Pi resume representation in their adapter projections. The retained-format register already covers Worker volumes and exact resume slots; add no family, exemption, continuity promise, or native-format parser. | DOC | DSK, PI |
| Q-176 | One normalized final answer does not prohibit native commentary. Fix Codex extraction to distinguish explicit commentary from `final_answer`, preserving unknown-phase behavior and requiring correlated terminal proof. | CODE | None |
| Q-177 | A correlated terminal `contextWindowExceeded` discriminant positively proves a context limit. Preserve `length`; diagnostic text or an unrelated error notification does not suffice. | CODE | None |
| Q-178 | Name Codex ownership of the existing ephemeral hint and link its provenance and compaction consumers. Preserve cross-checked request kind and lineage without a durable field. | DOC | CDX |
| Q-180 | Record the four protected Pi environment names and the host-forced offline/version-check/telemetry values. This describes the existing projection and native package-network behavior. | DOC | PI |
| Q-181 | Replace the literal one-module count with one registry entry plus adapter-owned modules and the already accepted SDK host. Keep the semantic removal boundary; declared protected-name and supply tables do not justify another registry or relocation mechanism. | DOC | WRC, PI |
| Q-182 | Turn diagnostics contain only output produced during that Turn, bounded by the existing prefix size and redacted before exposure. Protocol stdout is never a diagnostic; process-lifetime output stays with host-level diagnostics. | CODE | CDX, PI (matching document edit) |
| Q-183 | Record the current native API, zero cost fields, reasoning flags, and model parameters in the implementation projection. Changed admitted route descriptors need a successor; preference changes inside the same admitted set retain their existing path. | DOC | PI |
| Q-199 | AgentSession identity, retained proof, lifecycle and terminality already have owners; add a link rather than another record or transition matrix. Record the three adapters’ no-relist results and implemented bearer carriers; the stale NanoHost timer sentence is CROSS-PART below. | DOC | CON, CDX, OPC, PI |

Document keys: [WRC](../specs/20260629-worker_runtime_communication_model.md); [SYN](../specs/20260703-workspace_synchronization.md); [CON](../specs/20260704-agent_session_continuity.md); [SSM](../specs/20260704-session_static_workspace_materialization.md); [FRE](../specs/20260709-worker_sandbox_freedom_policy.md); [CEL](../specs/20260715-openshell_disposable_cell_lifecycle.md); [CDX](../specs/20260716-codex_worker_adapter.md); [OPC](../specs/20260716-opencode_worker_adapter.md); [PI](../specs/20260716-pi_worker_adapter.md); [IMG](../specs/20260721-worker_execution_environment_images.md); [VOL](../specs/20260910-persistent_worker_volumes.md); [DPM](../specs/20260922-delegated_worker_policy_maintenance.md); [DSK](../specs/20260930-deepseek_worker_adapter.md).

Owners: [Hosting Goes Through The Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md), [Worker Control Protocol](../specs/20260703-worker_control_protocol.md), [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md), [Documentation Writing](../writing.md), [Specification Lifecycle](../specs/README.md), [Native Compaction Phase Hint](../decisions/20261016-native_compaction_phase_hint.md), and [Four Native Runtime Adapters](../decisions/20260929-four_native_runtime_adapters.md).

## Code Issues

### Q-134 — [worker-image] Remove the unproduced Anthropic API-key carrier branch

The image smoke requires the carrier to be absent, but the sanitized launcher still tests it and conditionally copies `ANTHROPIC_API_KEY`.
Evidence: `containers/workers/openkit-worker-shim:51` and `containers/worker-runtimes/smoke.sh:28`.
Remove that conditional branch and any remaining producer/carrier handling; retain the absence assertion.
Declared runtime-env delivery remains with Agent Manifest And AEP Resolution; add no replacement carrier or launcher exception.
The image and Pi specifications in this batch apply the supplied Q-134 settlement. Qualify the sanitized launcher with the carrier absent.

### Q-176 — [codex] Do not reject a completed Turn for native commentary before its final answer

`assistantTexts` discards native `phase`, then `normalizeCodexAssistant` rejects more than one nonblank message as `malformed-result`.
Evidence: `packages/worker-shim/src/adapters/codex.ts:128,266,1175`; the pinned `packages/codex-app-server-schema/generated-schema/v2/TurnCompletedNotification.json:795` distinguishes commentary, final answer and unknown phase.
Select the explicit final-answer content for the one normalized assistant result and exclude explicit commentary from final-answer counting.
Preserve the existing single-message behavior when phase is unknown; do not infer a final answer from arbitrary text or weaken terminal correlation.
Add pinned-schema fixtures for commentary plus final answer, the item-notification fallback, unknown phase, empty success and contradictory multiple final answers.

### Q-177 — [codex] Preserve a terminal contextWindowExceeded outcome as length

The adapter reads only `error.message` and collapses a typed terminal context-limit error to generic failure.
Evidence: `packages/worker-shim/src/adapters/codex.ts:118,290,1192`; `packages/codex-app-server-schema/generated-schema/v2/TurnCompletedNotification.json:59,1899` carries the discriminant.
Carry the correlated terminal `codexErrorInfo` through normalization and map `contextWindowExceeded` to the existing private `length` outcome.
Authority: `docs/decisions/20261009-truthful_native_stop_classification.md`; retain identity, cancellation, failure and cleanup proofs.
Add tests for correlated context limit, generic failure, unrelated/retryable error notification and contradictory terminal evidence; introduce no retry or new public status.

### Q-182 — [worker-adapters] Keep diagnostics within the addressed Turn

Resident diagnostic prefixes retain earlier Turns' stderr; attaching them to later Turns misattributes output and can disclose output from another Thread.
Evidence: `packages/worker-shim/src/adapters/pi.ts:335,734,830,1141`; `packages/worker-shim/src/adapters/codex-app-server.ts:163,210`; `packages/worker-shim/src/adapters/codex.ts:1113`.
Record stream offsets at Turn start or reset the per-Turn prefixes in the Pi and Codex resident adapters.
Keep the existing byte bound and redaction; exclude protocol stdout and leave process-lifetime output with host-level diagnostics.
Add a two-Turn test for each adapter proving that the second Turn's diagnostics exclude the first Turn's stderr.
Add no diagnostic channel or configuration; the Native Output Mapping sections in the Codex and Pi specifications state the rule.

## Held Fixes

None. Existing Worker-volume and exact-reference coverage in the [Retained Format Register](../specs/20261017-retained_format_register.md) needs no new family for Q-175. No held storage or evidence owner is amended.

## Cross-Part

Q-199, CROSS-PART (architecture): in `docs/specs/20260802-nanohost_runtime_and_transport.md:1797`, replace only “Poll and result header waits are bounded to 1 s; body collection uses the remaining outage budget.” with “Poll and result response headers and body collection share the remaining original request outage allowance under [Worker Control Protocol](../specs/20260703-worker_control_protocol.md#harness-pull-and-result-envelopes).” The accepted `docs/decisions/20261020-harness_carriage_deadline.md:10` and Worker Control Protocol line 244 already decide this. No new timer decision is needed; this file belongs to another group and was not edited.

## Escalated

None. No answer changes an authority holder, release scope, retention or reset policy, durability, security model, publication rule, AGENTS.md, or product vision. The cross-part timer correction follows an accepted decision.
