---
date: "2026-10-24"
---
# Independent Documentation Audit: Sandbox Group

This non-authorizing record holds the sandbox group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `b648f860e3eeab8bf1a7a419f16b674882ed7a55` (`main` on 2026-10-24). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/sandbox.md`.
- Specifications: `20260709-worker_sandbox_freedom_policy.md` (FRE), `20260715-openshell_disposable_cell_lifecycle.md` (CEL, Deprecated), `20260721-worker_execution_environment_images.md` (IMG), `20260910-persistent_worker_volumes.md` (VOL), `20260922-delegated_worker_policy_maintenance.md` (DPM), `20260703-workspace_synchronization.md` (SYN), and `20260629-worker_runtime_communication_model.md` (WRC).
- G3 inspection: four read-only inspector contexts (SB-FRE for FRE, CEL, and DPM; SB-IMG for IMG and VOL; SB-SYN for SYN; SB-WRC for WRC). They read code only and ran no tests. The auditor verified each kept finding against the code.

## G2 Core Against Specifications

- SB-G2-01: Core Sandbox line 32 says a Sandbox MAY permit broad ordinary process execution; FRE says worker process execution SHOULD be broad. A specification may be stricter than a Core permission; not a conflict.
- SB-G2-02: FRE says wildcard hosts, unrestricted ports, and private ranges should be rejected unless an operator-only escape hatch exists; the code rejects them with no escape hatch (`packages/config-schema/src/agent-environment.ts:886-897`). The hatch is optional; not a conflict.
- SB-G2-03: SYN owns independent per-AgentSession state for workers that share a Sandbox; Core Sandbox line 82 defaults to one AgentSession per Sandbox and admits sharing explicitly. Compatible; no action.
- SB-G2-04: IMG called `/openkit` ephemeral with two retained targets, while the later accepted VOL retains `/openkit/threads` as a third target. Corrected in IMG (see G3).

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| SB-FRE-01, 03 | FRE: materialized network policy equals the AEP allowlist; an unenforceable rule fails launch | `apps/nanocore/src/runtime/worker-governance-backend.ts:1483-1504` maps ids with `replaceAll('-', '_')` and returns no endpoint for reserved or malformed rules; `apps/nanohost/src/openshell_policy.rs:277` inserts without a duplicate check | Code differs from a current accepted document | Issue #493 |
| SB-WRC-02 | WRC Static Supply Projection: `worker_logical_model_not_allowed` | `apps/nanocore/src/llm/gateway-routes.ts:1118-1123,1158-1161` return `worker_inference_lineage_mismatch` | Code differs from a current accepted document | Issue #494 (low) |
| SB-SYN-01, 02 | SYN: a nonempty candidate produces a change set and a staged review; the manifest comes from the accepted scan | `apps/nanocore/src/runtime/turn-executor-factory.ts:4785-4786` returns no changes; `linkWorkspaceSnapshotReview` and `stageWorkspaceChangeSet` have no production caller; `apps/nanocore/src/runtime/workspace-sync-records.ts:265` writes the manifest only with a review | Accepted behavior not implemented, and the projection claimed more | Issue #495 (enhancement); projection corrected |
| SB-SYN-03, 04 | SYN projection: the materializer parses manifests and stages reviews; no snapshot-chain files named | `apps/nanocore/src/runtime/workspace-materializer.ts` exports only the two builders and the uncalled stager; the chain lives in `workspace-snapshot-chain.ts`, `workspace-collect-wire.ts`, `apps/nanohost/src/workspace_collect.rs`, and migration `0011` | Projection drift | Corrected |
| SB-SYN-05 | SYN Review And Apply and Recovery Records stage and apply Git candidates | `apps/nanocore/src/runtime/worker-governance-turn-executor.ts:3896` stages no review for a Git source; `workspace-review-application.ts` refuses Git apply; SYN Git Strategy and Resolved Decisions say Git output is not applied to a NanoCore checkout | Two parts of one accepted document disagree | Question Q-122 |
| SB-SYN-06 | SYN State Model lists stored states | `packages/app-api-schemas/src/workspace-sync.ts:381,409` store outcomes (`applied`, `conflicted`, `blocked`; `recovered`, `requires-human`, `unrecoverable`, `quarantined`) | Not decided | Question Q-123 |
| SB-SYN-07 | SYN Non-Git Filesystem Strategy: a snapshot manifest before execution | `turn-executor-factory.ts:4573-4590` admits only one pinned Git source or an empty slot for a read-write input | The projection already says complete non-Git behavior is not established | No action; recorded with Q-122 |
| SB-WRC-03 | WRC NanoHost Adapter Liveness: heartbeat interval "current default 10 seconds" | `packages/worker-shim/src/lifecycle-deadline.ts:19`, consumed at `packages/worker-shim/src/turn.ts:1769`, uses 1 second; WRC says to preserve today's values | Projection drift in a stated current default | Corrected to 1 second |
| SB-WRC-04, 05 | WRC: the production registry is empty; three adapters | `packages/worker-shim/src/adapter-registry.ts:230-235` registers four, with `deepseek.ts`; the DeepSeek adapter specification exists | Projection drift | Corrected; the fourth owner link is added |
| SB-WRC-06 | WRC projection: a disabled capability plane when MCP supply is empty | `apps/nanocore/src/runtime/agent-environment.ts:488-495,697-706` always append the built-in supply | Projection drift; WRC lines 203 and 284 already require the three routes | Projection corrected; the real-host verification line that expects `/capabilities/*` absent is Question Q-124 |
| SB-WRC-01 | WRC Control Plane: `openkit-worker-control-v2` end to end | The AEP literal is `openkit-worker-control-v1` (`packages/config-schema/src/agent-environment.ts:607`, `apps/nanocore/src/runtime/agent-environment.ts:641`); `20260703-worker_control_protocol.md` defines v2 | Not decided whether the AEP literal and the envelope version are one identifier | Question Q-125 |
| SB-WRC-07, 08 | WRC: nine candidate event types; interrupt as a control family | `packages/worker-protocol/src/index.ts:570-596` has eleven; the AEP declares six and nothing enforces them; interrupt travels over the Harness `turn.interrupt` | SHOULD list and wording | Question Q-125 |
| SB-IMG-01, 02 | IMG: two declared volumes; `/openkit` ephemeral; the declarations "remain part of the pending implementation" | `containers/workers/Dockerfile:166-214` declares `/workspace`, `/sandbox`, `/openkit/threads` and the bootstrap layout | Document outdated by the later accepted VOL; projection drift | Corrected |
| SB-IMG-03 | IMG: Python package writes go to the seeded `/sandbox/.venv` | `Dockerfile:78,187` put the base environment under `/opt/openkit/venv`; tests assert `/sandbox/.venv` is absent; VOL places the base environment under immutable `/opt` | Document outdated by the later accepted VOL | Body and the writable-layout list (the base environment is not writable) corrected; the acceptance line "The writable Python virtual environment accepts package installation" is Question Q-126 |
| SB-IMG-04 | IMG Topology: the leaf directories and the smoke path "do not exist yet"; the catalog "still lists" the three removed image ids | `containers/` has `worker-runtimes/smoke.sh` and no leaf directories; `containers/images.json` has only `app`, `worker-common`, `worker-runtimes`, and `test-env`; IMG projection lines 218 and 234 say they are removed | Projection drift inside the document | Corrected |
| SB-IMG-06, 07 | IMG: no `ENTRYPOINT` or `CMD` as a selector; the writable layout list | `Dockerfile:211-212` keep inert `ENTRYPOINT` and `CMD`; `Dockerfile:168` creates `/openkit/instructions` | Wording and an unnamed directory | Question Q-126 |
| SB-VOL-06 | VOL projection names only the operation files | `apps/nanohost/src/persistent_volume.rs`, `turn-executor-factory.ts:3180-3183`, `apps/nanocore/src/runtime/worker-image-settlements.ts` implement the clauses that VOL Implementation Status calls implemented | Projection drift (incomplete) | The three owners are added |
| SB-FRE-02, 04 | FRE: writable temporary directories; HTTPS REST presets | The read-write roots have no general `/tmp` (`openshell_policy.rs:142-148`); authoring admits `http` and `https` protocol values that launch refuses (`agent-environment.ts:861-863`, `worker-governance-backend.ts:76`) | Not decided | Question Q-127 |
| SB-CEL-01 | CEL: Deprecated, says the implementation is deleted, keeps `implementation: Partial` | No Cell helper or controller in `apps` or `packages` | Metadata of a Deprecated record; the audit does not change terminal metadata | Question Q-128 |
| SB-VOL-05 | VOL: five added Worker environment operations | Only seven definitions exist; VOL Implementation Status calls the five accepted targets | Consistent | No action |
| SB matches | FRE default-deny, rule shape, encoded slash, filesystem roots, process default; DPM tool, candidate, apply; IMG catalog, labels, pins, layout; VOL root, seeding, targets, refusal, settlement; SYN fifteen operations, chain causes, manifest format, credential window, review decisions; WRC backend port, liveness deadlines, Harness operations, transport, bounds | The inspectors' tallies in the audit working space | Match | None |

## G4 Organization

No move, merge, or split is applied.

## G5 Writing

- Hard line breaks inside paragraphs and list items (NONNEG-002): SYN had 109 wrapped continuation lines in its Owns, Does Not Own, Background, Decision, Git Strategy, Non-Git, and Recovery Records sections. They are joined. A word-level comparison with the base shows no change except the projection edits.
- Amendment and history wording: SYN "narrow amendment", "data-boundary amendment", "As pre-amendment implementation evidence", and "is now persisted in first-slice form"; WRC "this amendment adds no NanoHost Rust stop timer", "This amendment does not fix #108", and the change narrative at its opening; DPM "not by this amendment", the "Proposed Design" heading, and "Simon accepted ... on 2026-09-22"; FRE "The 2026-07-21 refinement" and "The correction preserves"; IMG "Superseded 2026-08-12", the dated build records, and "The accepted baseline as of 2026-08-28"; VOL "These amendments govern implementation after `v0.1.0-rc.1`". Question Q-129.
- Experience-chosen numbers not marked as a current default: SYN "binary payloads over 1 MiB" (and its conflict with "The exact artifact-only size threshold remains policy"); WRC 16 MiB and 16 KiB output limits; VOL "once per second" redelivery. Question Q-129.
- Undefined labels: SYN "A1 Unit F gate"; WRC S33, R058, A1, #108, "#179 ruling"; VOL and IMG A2. As Q-28: Question Q-129.

## Semantic Preservation

The inventory tool compared each changed file with the group base; it compares sentences after whitespace normalization, so the SYN line joins count as unchanged.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260629-worker_runtime_communication_model.md` (WRC) | 163 unchanged, 1 changed (capability-plane projection) | 10 unchanged, 1 changed (heartbeat default) | 209 unchanged, 4 added | 42 unchanged | 53 unchanged |
| `20260721-worker_execution_environment_images.md` (IMG) | 74 unchanged, 1 changed (the declared targets) | 0 | 316 unchanged, 1 removed (`/sandbox/.venv`), 6 added | 29 unchanged | 15 unchanged, 2 added |
| `20260910-persistent_worker_volumes.md` (VOL) | 144 unchanged | 0 | 139 unchanged, 4 added | 24 unchanged | 26 unchanged |
| `20260703-workspace_synchronization.md` (SYN) | 155 unchanged | 2 unchanged | 564 unchanged, 6 added | 45 unchanged | 21 unchanged |

Other changed sentences: the IMG Inherited Volume Layout, Topology, catalog, and Python sentences; the WRC registry bullet, the package listing, and the adapter owner list; the VOL and SYN projections. The IMG MUST sentence now names the third target that VOL requires; the IMG Python sentence follows VOL's immutable `/opt` placement. No other design rule changed.

## Issues Opened

- #493 `[sandbox] OpenShell policy projection merges or drops AEP network grants instead of failing launch`, ordinary.
- #494 `[gateway] A disallowed worker logical model fails with worker_inference_lineage_mismatch instead of worker_logical_model_not_allowed`, low.
- #495 `[sync] Captured Workspace snapshot candidates never become a change set, a review, or a worker output manifest`, ordinary (label `enhancement`).

## Questions For The Engineer

### Q-122. Do Git candidates get a Workspace Sync Review?

- Context: SYN Review And Apply stages one review for each collected link with a delta, and Recovery Records names "accepted Git patch" apply; SYN Git Strategy and Resolved Decisions say Git output is not applied to a NanoCore checkout and hosting goes through Gateway MCP; the code stages no Git review and refuses Git apply. Non-Git read-write sources also cannot reach a first Turn yet.
- Options: (A) Add the Git carve-out to Review And Apply and Recovery Records: Git candidates produce inspection evidence only. (B) Stage Git reviews that can never be applied.
- Recommendation: A.
- Meanwhile: no change.

### Q-123. Is the SYN State Model a stored state machine?

- Context: SYN lists materialization, collection, apply, and recovery states; the code stores only outcomes, including `blocked` and `quarantined`, which the lists omit.
- Options: (A) Trim the model to the persisted outcome values. (B) Implement the full state machine.
- Recommendation: A, under SCOPE-013.
- Meanwhile: no change.

### Q-124. Should real-host verification expect `/capabilities/*` absent?

- Context: WRC lines 203 and 284 and the code enable the three MCP routes for every worker package; the WRC Testing section still requires proving `/capabilities/*` absent and disabled.
- Options: (A) Change the verification line to prove the three enabled routes and nothing more. (B) Keep it.
- Recommendation: A.
- Meanwhile: no change.

### Q-125. Which worker-control protocol identifier and event list are current?

- Context: WRC and `20260703-worker_control_protocol.md` name `openkit-worker-control-v2`; the AEP literal is `openkit-worker-control-v1`. WRC lists nine candidate event types; the protocol package has eleven, and the AEP declares six that nothing enforces. WRC calls interrupt a control family, but it travels over the Harness.
- Options: (A) State the identifier once in the Worker Control Protocol owner and say whether the AEP literal is a separate record version; align the event list with the protocol package; reword interrupt. (B) Change the code.
- Recommendation: A.
- Meanwhile: no change.

### Q-126. How should the IMG acceptance and layout lines read?

- Context: IMG acceptance still asks that "The writable Python virtual environment accepts package installation" although the base environment is immutable under `/opt`; IMG acceptance says no `ENTRYPOINT` or `CMD`, while the image keeps them inert; the image creates `/openkit/instructions`, which IMG does not name.
- Options: (A) Prove installation into a user-created environment under `/sandbox`, state that inert `ENTRYPOINT` and `CMD` are never read, and name or remove `/openkit/instructions`. (B) Keep the text.
- Recommendation: A.
- Meanwhile: no change.

### Q-127. Which temporary directory is writable, and when are `http` and `https` grants refused?

- Context: FRE grants writable temporary directories, but the read-write roots have no general `/tmp`; authoring admits `http` and `https` access-mode protocols that launch refuses.
- Options: (A) Name the writable temporary root in FRE, and refuse non-`rest` protocols at authoring. (B) Keep the late refusal.
- Recommendation: A.
- Meanwhile: no change.

### Q-128. Should the Deprecated Cell specification keep `implementation: Partial`?

- Context: CEL is Deprecated, says the legacy implementation was deleted, and its own rollout step sets `N/A` on supersession.
- Options: (A) Set `implementation: N/A` in a governance-approved metadata change. (B) Keep it.
- Recommendation: A.
- Meanwhile: no change.

### Q-129. How should the sandbox history, numbers, and labels be fixed?

- Context: the G5 items above.
- Options: (A) As Q-28: remove amendment and history wording or move it to change records, mark experience-chosen numbers as current defaults, resolve the SYN 1 MiB conflict, and replace each label with its meaning or a link. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code and issues #493 to #495 itself. Verdict: accept with fixes. Dispositions:

1. IMG Topology still said the catalog lists `worker-codex`, `worker-opencode`, and `worker-pi`, but `containers/images.json` has none of them. Accepted; the sentence says the catalog no longer lists them and keeps the rule that they are not aliases, and the SB-IMG-04 row names it.
2. The IMG writable-layout list still named the Python virtual environment, against the corrected base-environment sentence and VOL. Accepted; the list no longer names it, under the same VOL justification as SB-IMG-03.
3. The record cited WRC line 289 for the every-package MCP rule. Accepted; it cites line 284.
4. The heartbeat row cited the Gateway inference-stream keepalive. Accepted; the row cites `lifecycle-deadline.ts:19` and its consumer `turn.ts:1769` only.
5. The record called #495 an enhancement while its body says ordinary. Accepted; the record and the summary say ordinary, with the `enhancement` label.
6. A contract sentence at the end of the last SYN projection bullet could be its own paragraph. Not applied: the base had the same lazy continuation, and the audit keeps the rendered structure.

The Reviewer confirmed the other edits, issues #493 and #494 against the code, that the IMG MUST adds no intent (VOL decides the retained `/openkit/threads` target and its refusal), that every question is open, and, by a word-level comparison, that the SYN joins preserve the text with no merged list item, table, heading, or fence. It found no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (672 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
