---
status: Accepted
date: "2026-10-09"
decider: "Engineer, on a Consultant-reviewed proposal"
---
# Checkpoint-Owned Failed-Start Closeout And Release Hold

## Decision

The engineer chose these two options verbatim on 2026-10-09, as preserved in the writer dispatch:

1. Route: 「(b) 批准窄修订：证据完整证明 Worker 从未提交时，由 checkpoint owner 把原 Turn 发布为 error 并清除 checkpoint，AgentSession 终态保持 failed（推荐）」.
2. Release: 「等：修复并证明后再冻结候选（推荐，Consultant 建议在声称恢复能力就绪前解决）」.

The English translation of ruling 1 is: “Approve the narrow amendment, option (b): when complete evidence proves the Worker was never submitted, the checkpoint owner publishes error on the original Turn and clears the checkpoint; the AgentSession terminal status remains failed.” The English translation of ruling 2 is: “Wait: freeze the candidate after the fix and its proof; the Consultant recommends resolving this before claiming recovery readiness.” The quotations above remain the source wording.

[Worker Turn Reliability Envelope, Failed start before Worker submission](../specs/20260531-worker_turn_reliability_envelope.md#failed-start-before-worker-submission) owns the complete eligibility proof, canonical pre-submission error, existing product failure publication, original Task closeout, applicable receipt or source predicate, checkpoint transition and removal, partial-publication replay, and narrow execution-generated runtime-provenance inapplicability. [Task Mode Worker Delegation, Entry points](../specs/20260704-task_mode_worker_delegation.md#entry-points) references that alternative from its backend-specific complete closeout tuple. The existing lifecycle owners retain authority; this decision introduces no record kind, state, lifecycle, recovery service, or replacement execution.

Terminal retirement of the non-reusable AgentSession uses the existing shared failure mapping to `failed`. It does not select `closed`. Native failed-start maintenance still excludes checkpoints. [Terminal Failed-Start Turn Recovery](20261003-terminal_failed_start_turn_recovery.md) stays unchanged because option (b) preserves its no-checkpoint path; it is not superseded. [Execution Backend Port In NanoCore](20261006-execution_backend_port_in_nanocore.md) and the Durable Scheduler's definite-non-acceptance, exclusion, and backend ownership rules remain intact. The cleaned preparation proof changes no physical cleanup, residency, retained-storage, or exclusion authority.

The release ruling holds `v0.1.0-rc.1`: the candidate waits for this fix and its proof on the candidate before freezing under [Release Management](../specs/20260829-release_management.md#release-exit-criterion). It grants no waiver of other required evidence or reserved engineer gates. Documentation and local structural checks do not prove implemented recovery or release readiness. This ruling authorizes no A2 mutation, deployment, GitHub action, or publication.

## Reason

The user need is a truthful terminal result on the accepted original Turn and a usable Thread afterward. A preparation checkpoint preserves ownership but does not prove Worker submission. Complete definite-non-acceptance proof can establish a deterministic failure through that same checkpoint owner without fabricating an operation, fence, Worker final status, runtime transcript, or receipt. The Consultant recommended option (b) to preserve unique ownership and ordinary Task closeout while preventing false pre-effect classification, premature checkpoint deletion, and incomplete partial-publication recovery. The engineer selected that route and release hold; no separate engineer rationale was recorded.

The retained A2 r43 observations from 2026-10-08 identify Turn `tu_conversation_1db1c34cc5627dc0032d02ce` as running, with an assigned `created` AgentSession without a native handle, an admitted original request, and a matching `running_worker` checkpoint with null StopReason, iteration zero, and null Goal and Task ids. The sole relevant attempt is `closed` with `not_accepted` and first terminal cause `turn-start-failed`; operation, submission deadline, outcome, and fence are null. Its preparation anchor is cleaned with pending handoff; the selected observations show no matching runtime binding or accepted final status. Six passive configured maintenance intervals left the tuple unresolved; they were not a count of successfully invoked recovery calls.

Those selected observations do not certify the complete settlement predicate. Actual owner classification must also validate immutable input, exact finalized package and backend lineage, all process and route-credential absences, package materialization and Workspace-handle absence, the initiating conversation receipt, and absence of competing Gate or pending-delivery authority. Missing or unreadable evidence is not absence. Cleanup proves an attempt cannot continue; by itself it does not prove that no Worker ever ran or that earlier effects did not occur. The approved alternative requires the full positive never-submitted proof and begins with the exact unused cleaned-anchor case.

The independent current-source review found a surviving crash window after `2a9d7e61`. The executor binds `running_worker`, creates and assigns the AgentSession, persists the package, and creates the preparation anchor before incoming effects and operation recording. A post-publication preparation or Epoch-proof failure can close the operation-free attempt as `closed` / `not_accepted` / `turn-start-failed` before awaiting cleanup and publishing product failure. Core exit or failed persistence in that interval leaves the running Turn and checkpoint; later orphan cleanup can leave the unused anchor cleaned with pending handoff. Ordinary handled failure normally invokes product failure publication. This is a source-derived interrupted-closeout trace, not a fresh process-kill reproduction or proof of A2's historical initiating cause. D8's diagnostic explains the checkpoint exclusion but does not settle the Turn, and a fresh data root removes the retained subject rather than the window.

Source material is the 2026-10-09 writer dispatch at `temp/interface-unification/build/write-spec-d8-closeout.md`, the approved independent analysis at `temp/reports/consult-d8/consult.md`, and section 3 of the independent review at `temp/reports/review-fix-stuck-cleaned/review.md`. These temporary sources are evidence, not governing authority. The approved four-paragraph owner amendment and its surrounding refinement determine the narrow scope; the linked specifications state the rules.

## Rejected Alternatives

- Option (b) with AgentSession terminal status `closed`: adds a status change beyond the existing shared failure mapping and ordinary error classifier. The engineer explicitly selected `failed` and terminal retirement of the non-reusable AgentSession.
- Option (a), diagnostic only with release-note disclosure: leaves the Thread indefinitely occupied without a supported finishing action for this tuple. The engineer chose a fix and candidate proof before freezing rather than accepting that residual defect.
- Option (c), native failed-start maintenance taking over the checkpoint: crosses the mode-owned checkpoint boundary and broadens who initiates product closeout. It would still require the classifier, receipt, and provenance changes and a properly recorded partial supersession of the October 3 decision. Option (b) preserves that decision and unique checkpoint ownership.
- The Consultant also considered moving checkpoint binding until acceptance, a manual escape command, or raw database patching. Stage reordering does not repair retained data and relocates the crash exposure; a new supported repair command needs the same proof and adds responsibility, and a raw patch is not a supported lifecycle owner. None was selected.
- Extending the alternative to unresolved physical cleanup: exceeds the demonstrated cleaned-anchor scope. It needs a separate breadth decision rather than deleting a guard or relaxing unknown-effect handling.

## Revisit When

Return to the engineer if the complete classifier cannot prove the never-submitted boundary without fabricating runtime evidence, relaxing unknown-effect or cleanup handling, changing the winning command owner, or synthesizing an outer receipt. A new need to cover unresolved preparation cleanup or other tuples requires a separate amendment. Proof must cover the actual post-binding/pre-operation failure, iteration-zero conversation receipt and direct Task rules, partial publication, requested provenance, no submission on repeated maintenance or replay, and refusal on missing or contradictory authority. Changing the release hold requires a new engineer ruling; existing candidate identity, release evidence, and publication rules remain binding.

## Affected Owners

- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md#failed-start-before-worker-submission)
- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md#entry-points)
- [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md)
- [Pending Requests](../specs/20260930-pending_requests.md)
- [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md)
- [Release Management](../specs/20260829-release_management.md#release-exit-criterion)
