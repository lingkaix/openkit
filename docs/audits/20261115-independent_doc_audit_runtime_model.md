---
date: "2026-11-15"
---
# Independent Documentation Audit: Runtime-Model Group

This non-authorizing record holds the runtime-model group of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15). Issue #440 releases this group.
- Core document: `docs/core/runtime-model.md` (RM).
- Specifications: `20260802-nanohost_runtime_and_transport.md` (NRT), `20260703-durable_scheduler_design.md` (DSD), `20260703-runtime_scheduling_scale.md` (RSS), `20260531-worker_turn_reliability_envelope.md` (WTR), and `20260711-worker_runtime_subagent_provenance.md` (WRSP).
- Cited decisions read: `20261019-durable_execution_and_control_store.md`, `20261016-retire_stateless_quick_chat.md`, and `20261114-pre_release_sql_baselines.md`.
- G3 inspection: eight read-only inspector contexts (NRT in four line ranges, DSD, RSS, WTR, WRSP). They read code only and ran no tests. The auditor verified each kept finding against the code at the base SHA.

## G2 Core Against Specifications

- RT-G2-01: RM said that "authorization decisions belong to the permission model". The Policy aspect is titled "Policy Model"; corrected to "the Policy model", as in round-1 finding SUP-C-06.
- RT-G2-02: RM said "The replacement Goal owner admits ordinary Tasks". "Replacement" is history wording; corrected to "The Goal owner". No rule changed.
- RT-G2-03: RM requires one finalized Coordinator reference Item for each admitted Goal worker execution. The Goal specification and code write only a `goal_card_tasks` row (`apps/nanocore/src/storage/control-store-admission.ts:262`) and no Item. Existing issue #623 tracks the missing Item; the Goal specification wording is in the work-model group.
- RT-G2-04: DSD, RSS and NRT delegate the scheduler target to the control-store specification, which has `status: Draft`. This is Question Q-222 in the fault-tolerance group record of this round.
- Kept and noted: the RM rationale sentence "They exist here because each was previously re-derived in more than one place ..." (Question Q-221).

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| RT-NRT-A-01, RT-NRT-D-02 | NRT cites `nanohost-harness-records.ts:326-356` for the two Sandbox runtime removal functions | The functions are at `apps/nanocore/src/runtime/nanohost-harness-records.ts:697,722`; lines 326-356 hold the Harness operation table | Projection drift | Line range removed in both places |
| RT-NRT-A-02, RT-NRT-C-01 | NRT: "Once the schema-version-2 requirement profile and checker are implemented ..." and "Until then, the exact current preconditions ... remain mandatory" | `apps/nanohost/deploy/host-manifest.json:2` is schema version 2; `apps/nanohost/deploy/install.sh:742,766-771` gates live installation with `host_check --installation-check`; a `DESTDIR` build runs `host_check --verify-profile` only | Projection drift | Both places state the implemented gate; the "Until then" sentence is removed with its condition |
| RT-NRT-A-03, RT-NRT-D-04 | NRT frontmatter `updated` | Git history | Metadata | No action |
| RT-NRT-A-04 | NRT (accepted co-residency rule and predicate 38): `SandboxCompatibilityKey` includes Workspace, admitted trust class, Sandbox image, Integration version, declared Harness set, sensitivity class and other members; a missing required input rejects co-residency | `apps/nanocore/src/runtime/nanohost-compatibility.ts:13-148` carries no declared Harness set, Integration version or sensitivity class, and keys trust on the responsible User and actor kind | Code differs from a current accepted document (corrected after review) | Issue #735 (blocking candidate: security) |
| RT-NRT-B-01 | NRT: the NanoHost listener accepts only `/api/nanohost/transport/*` | NRT itself requires the nested-session families `/worker-control/*`, `/inference/*` and `/capabilities/*` on the same listener (Decision and route table); `isNanoHostPrivateRequest` (`apps/nanocore/src/index.ts:789-797`) also admits `/api/worker-capabilities/*`, which NRT does not declare and which skips the family dispatch | Internal contradiction for the three families; code differs from the accepted document for the fifth prefix | Corrected to the transport namespace and the three family prefixes; issue #734 (blocking candidate: security) |
| RT-NRT-B-02 | NRT `reference.import` names five required headers, and `file.export` refers to "the same five headers" | The data-boundary specification owns the header grammar and adds `x-openkit-entry-kind` and `x-openkit-executable`; `apps/nanocore/src/runtime/nanohost-session-dispatch.ts:2649-2660` follows it; the same owner defines the five canonical `file.export` headers | Stale projection of another owner | NRT now defers both header sets to the data-boundary owner |
| RT-NRT-B-03 | NRT heartbeat delay bound "stays at two thirds of the attempt heartbeat deadline" and a different ceiling margin | With the 1 s interval and 30 s deadline of the worker runtime communication model, a 10 s bound gives an 11 s gap | Undecided arithmetic | Question Q-219 |
| RT-NRT-B-04 | NRT "An H1 host observation" | `H1` is defined only in a change record | Undefined label | Question Q-221 |
| RT-NRT-B-05 | NRT per-family 256 KiB DATA rows | `apps/nanohost/src/sandbox_bridge.rs:51-52` has one 512 KiB control and readiness constant; totals agree | Projection naming only | Question Q-221 |
| RT-NRT-B-06 | NRT: wrong-owner or wrong-reference Token material keeps the NanoHost non-ready | `apps/nanohost/src/credential_slots.rs:180-218` checks mode `0600` through `fs::metadata` (which follows links) and no owner; the service unit sets no `User=` | Code differs from a current accepted document | Issue #725 (blocking candidate: credentials) |
| RT-NRT-B-07 | NRT: first issuance names slot `A` | `packages/app-api-schemas/src/nanohost.ts:82-87` makes `A` a default; `B` is accepted | Undecided: rule or default | Question Q-220 |
| RT-NRT-B-08 | NRT: "Hyper/H2" serves the nested HTTP/2 session | `apps/nanohost/src/sandbox_bridge.rs:394` builds the session with `h2::server::Builder`; `apps/nanohost/Cargo.toml` lists `h2` and only `hyper-util`, which the OpenShell client uses | Projection drift | Corrected to the `h2` crate |
| RT-NRT-C-02 | NRT: Harness Logins, Codex host-managed tokens and bearer refresh are not yet implemented | Dormant Harness Login code and a Codex host-managed login path exist | Status depends on activation | Storage-group Question Q-215; no text change |
| RT-NRT-D-01 | NRT: eight NanoHost administration definitions | `packages/app-api-schemas/src/nanohost-operations.ts` has six | Projection drift | Corrected |
| RT-NRT-D-03 | NRT Decision, implementation projection, acceptance predicate 40 and the closed-set bullet name six Harness operations | `NANO_HOST_HARNESS_OPERATIONS` (`nanohost-harness-records.ts:330-338`) has seven, with `turn.steer`; the shim handles it (`packages/worker-shim/src/harness.ts:253`); the [worker-control owner](../specs/20260703-worker_control_protocol.md) defines seven fixed literals | Document outdated by the worker-control owner | All four places corrected to seven; the completed-step history at item 10 is kept (Question Q-221). The worker-control owner's own projection still says that `turn.steer` is not implemented; that document is outside this group and is recorded for the summary |
| RT-DSD-01, -03 | DSD projection: placement plans, leases, pool, capacity and health rows; `maxActiveTurns` | `apps/nanocore/drizzle/core/0000_baseline.sql` has `scheduler_admission_entries` and `scheduler_execution_attempts` and none of the others; the authored key is `maxActiveTurnsPerSandbox` (`packages/config-schema/src/server.ts:175,197`, default 20 from `packages/worker-protocol/src/harness-control.ts:18`) | Projection drift; the amendment is implemented | Paragraph corrected |
| RT-DSD-02 | DSD: an AgentSession "can acquire a lease" | DSD Decision replaces the SessionLease grant with the execution attempt | Projection drift | Corrected to "receives an execution attempt" |
| RT-DSD-04, RT-TMD-04 | DSD and the Task specification: "the configured queue bound" | `apps/nanocore/src/scheduler-records.ts:310,426` use the literal 20; no configuration key exists | Undecided | Question Q-216 |
| RT-DSD-05 | DSD: the control-store engine "is a Draft mechanism, not implemented behavior" | Execution and step journal rows exist (`apps/nanocore/drizzle/workspace/0000_baseline.sql:126,148`), and Worker Turns write them (`apps/nanocore/src/runtime/worker-governance-turn-executor.ts:6197`) beside the scheduler attempt rows; dispatch still uses the scheduler tables | Projection drift; whether the side-by-side write is a dual write that the accepted decision rejects is undecided | Corrected; the Draft status and the dual-write question are Q-222 |
| RT-DSD-06 | DSD: Goal checkpoints are closed "with the Goal implementation" | Goal owner exists; cleanup still refuses Goal rows (`apps/nanocore/src/runtime/cancelled-admission-checkpoint-cleanup.ts:515`) | Tense only | Question Q-221 |
| RT-RSS-01 | RSS frontmatter `updated` | Git history | Metadata | No action |
| RT-RSS-02 | RSS delegates the scheduler target to the Draft | See RT-G2-04 | Draft status | Question Q-222 |
| RT-RSS-03 | No owner states idle Sandbox retirement | `apps/nanocore/src/runtime/turn-executor-factory.ts:967,2727,3728` retire an idle Sandbox on demand | Undecided | Question Q-217 |
| RT-WTR-01 | WTR: exactly five checkpoint stages | `apps/nanocore/src/runtime/worker-stage.ts:9` and `packages/app-api-schemas/src/dashboard.ts:100` keep `waiting_for_user`; five readers branch on it; no writer | Code differs from a current accepted document | Issue #726 |
| RT-WTR-02 | WTR Resolved Decisions: "the current concrete direct Provider function is implementation divergence" | WTR itself says the direct call is not the current path | Document outdated by the [Quick Chat retirement](../decisions/20261016-retire_stateless_quick_chat.md) | Corrected |
| RT-WTR-03 | WTR `quick_chat_not_configured`, `quick_chat_failed` and the Quick Chat replay sentence | Only `chat_mode_*` codes exist for this path (`apps/nanocore/src/mode-entry-routes.ts:4372`); `quick_chat_not_shareable` is a separate live sharing code | Document outdated by the same decision | Corrected; the Resolved Decision names the two removed codes. WTR still names Quick Chat as a role in six other sentences, and the Assistant agent id is still `quick-chat` in code (Question Q-221) |
| RT-WTR-04 | WTR projection SHOULD include token estimates; signature type `OpenKitItem` | `apps/nanocore/src/context/llm-projection.ts:24-34` | SHOULD "when available"; type name only | Question Q-221 |
| RT-WTR-05 | WTR: pending-user-turn residue removed | `pending_user_turn` command kind remains (`apps/nanocore/src/lib/store.ts:615`, `apps/nanocore/src/storage/command-request-codecs.ts:118`) | Code differs from a current accepted document | Issue #726 |
| RT-WRSP-01 | WRSP historical bullet names `packages/worker-shim/src/cli.ts` | File removed in commit `4160bd801` | Dangling path | Path replaced by the removal commit |
| RT-WRSP-02 | WRSP diagram hop "OpenShell credential placeholder and exact REST policy" | WRSP section 5 and the removal of the Cell path; `apps/nanocore/src/runtime/nanohost-session-dispatch.ts:2138` routes `/inference/*` | Internal contradiction | Diagram hop corrected |
| RT-WRSP-03 | WRSP inherited-context signal "when available" | `apps/nanocore/src/llm/worker-inference-runtime-hint.ts:14-30` has no such signal; the extension is not selectable | Conditional on availability | No action |
| RT-WRSP-04 | WRSP frontmatter `updated` | Git history | Metadata | No action |
| RT-WRSP-05 | WRSP L1, L2 and L5 criteria describe App Server v2 capture | `packages/worker-shim/src/adapters/codex.ts:1034-1035` refuses it; WRSP states this in its projection | Status clarity | Question Q-221 |

## Held G1 Probe Findings

| Items | Verdict | Disposition |
| --- | --- | --- |
| M5-G02, M7-G06 | Stand: the scheduler and recurring targets are in the Draft control-store specification, and the code is the pre-cutover baseline | Question Q-222 |
| M5-G21 | Resolved: RM describes Goal worker executions as available | No action |
| M5-G06, M5-G07, M5-G27, M5-G30, M4-G38, M7-G11 | Partly or stand: effect bodies, retained host layouts, closed vocabularies, report and route details and recurring record members exist in code only | Round-1 Question Q-01 (delegated sweep) |
| M5-G18, M7-G29 | Partly: unnumbered limits remain (queue bound) | Question Q-216 and round-1 Question Q-23 |
| M5-G22 | Partly | Question Q-217 |

## G4 Organization

No move, merge, or split is applied. NRT is about 2,000 lines and mixes the current contract, completed rollout steps and acceptance predicates; it is a split-review candidate for the engineer.

## G5 Writing

The RM rationale sentence, the NRT label `H1`, the NRT completed-step history, the DSD tense, the WTR type name and the WRSP acceptance wording are recorded in Question Q-221 under the round-1 delegated sweep for labels and history wording.

## Semantic Preservation

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| RM | 91 unchanged, 1 changed | 3 unchanged | 19 unchanged | 22 unchanged | 11 unchanged |
| NRT | 924 unchanged, 4 changed, 1 added | 142 unchanged, 2 removed (line range) | 461 unchanged, 3 removed, 3 added | 150 unchanged | 49 unchanged |
| DSD | 68 unchanged, 1 changed | 13 unchanged | 59 unchanged, 1 removed, 3 added | 24 unchanged | 17 unchanged |
| RSS | unchanged | unchanged | unchanged | unchanged | unchanged |
| WTR | 148 unchanged, 1 changed, 1 removed | 23 unchanged | 153 unchanged | 33 unchanged | 28 unchanged, 1 added |
| WRSP | 139 unchanged | 30 unchanged | 129 unchanged, 1 removed, 1 added | 45 unchanged | 9 unchanged |

Changed normative sentences:

- RM: the Policy model name (RT-G2-01).
- NRT: the listener prefix sentence (RT-NRT-B-01), the Decision sentence on the Harness operations and acceptance predicate 40 (RT-NRT-D-03), and the profile requirement at the live-installation clause (RT-NRT-A-02). One normative sentence is added: the installation gate at the rollout step (RT-NRT-C-01). The closed-set bullet and the projection sentence also gained `turn.steer` or "seven" and are counted as other sentences.
- DSD: the deleted-mechanism sentence in the amendment paragraph, which now names a non-closed execution attempt as the only active-Turn grant (RT-DSD-01). The AgentSession grant change (RT-DSD-02) is in a sentence that the inventory does not count as normative.
- WTR: the logical-model fallback code (RT-WTR-03). The removed normative sentence "Standalone Quick Chat has no replay contract ..." described the retired operation.

The removed identifiers are `maxActiveTurns` (replaced by `maxActiveTurnsPerSandbox`), the `cli.ts` path, the line range, and `x-openkit-slot` and `x-openkit-relative-path`, which the data-boundary owner still defines in the deferred header grammar. The removed sentence "Until then, the exact current preconditions described under Current Implementation Projection remain mandatory" lost its condition when the gate landed. No acceptance item was removed. No heading changed, no file moved, and RM gained no specification reference.

## Issues Opened

- #725 `[nanohost] Token slot selection does not check the file owner and follows symbolic links`, blocking candidate (credentials).
- #726 `[worker-turn] Remove the unproduced waiting_for_user checkpoint stage and the pending_user_turn command kind`, low.
- #734 `[nanohost] The NanoHost listener admits /api/worker-capabilities/* directly, outside the family dispatch`, blocking candidate (security).
- #735 `[nanohost] SandboxCompatibilityKey does not carry the declared Harness set, the Integration version or the sensitivity class`, blocking candidate (security).
- Existing #623 covers RT-G2-03.

## Questions For The Engineer

### Q-216. Is the scheduler queue bound configured or fixed?

- Context: DSD and the Task specification say that admission checks "the configured queue bound". The code uses the literal 20 at create and retry (`apps/nanocore/src/scheduler-records.ts:310,426`), and no configuration key exists.
- Options: (A) State a fixed contract bound of 20. (B) Add a server configuration key with default 20.
- Recommendation: A until a deployment needs another value, under the round-1 rule for experience-chosen numbers (Q-23).
- Meanwhile: no change.

### Q-217. Which owner states idle Sandbox retirement?

- Context: RSS covers AgentSession idle state and says that a Runtime Epoch may contain zero or more Sandboxes. The code retires an idle Sandbox on demand when another Sandbox needs its capacity (`apps/nanocore/src/runtime/turn-executor-factory.ts:967,2727,3728`). The accepted [AgentSession continuity specification](../specs/20260704-agent_session_continuity.md) states the proof rules for capacity inspection and whole-Sandbox retirement of an idle binding, but no owner states when on-demand retirement starts.
- Options: (A) RSS states the on-demand trigger and its fences. (B) NRT states it with the Sandbox lifecycle and links the continuity proof rules.
- Recommendation: B, because NRT owns the Sandbox lifecycle and the continuity owner already holds the proof rules.
- Meanwhile: no change.

### Q-218. Withdrawn

The independent review showed that an accepted NRT rule and acceptance predicate 38 decide the `SandboxCompatibilityKey` member list. RT-NRT-A-04 is an implementation defect, tracked by issue #735. No question remains.

### Q-219. What margin does the heartbeat delay bound keep?

- Context: NRT says that a 10 s delay bound keeps the worst gap at two thirds of the heartbeat deadline and leaves one third unconsumed; its ceiling row asks for one full heartbeat interval. With the 1 s interval and 30 s deadline, the worst gap is 11 s.
- Options: (A) State the margin as the deadline minus interval minus bound. (B) Keep the fractions and change the numbers.
- Recommendation: A.
- Meanwhile: no change.

### Q-220. Must first NanoHost Token issuance use slot `A`?

- Context: NRT says first issuance names slot `A`. The schema defaults to `A` and accepts `B`.
- Options: (A) Refuse `B` at first issuance. (B) State that `A` is the default.
- Recommendation: B. Rotation works for either slot.
- Meanwhile: no change.

### Q-221. May the runtime-model writing cleanups be applied?

- Context: RT-G2-02 is already applied ("The replacement Goal owner" became "The Goal owner"). RM keeps a rationale sentence about earlier re-derivation; NRT uses the undefined label `H1`, keeps "without changing the six-operation protocol" in a completed step, and names per-row 256 KiB ceilings that the code holds as one 512 KiB constant; DSD keeps a future tense for landed Goal work; WTR names a type `OpenKitItem` that does not exist and still names Quick Chat as a role in six sentences (the Assistant agent id is still `quick-chat` in code); WRSP acceptance criteria describe App Server v2 capture that the code refuses without a pending marker.
- Options: (A) Apply the cleanups. (B) Keep the text.
- Recommendation: A, under the round-1 delegated sweep for labels and history wording.
- Meanwhile: no change.

## Independent Review

A fresh reviewer context received the staged diff, this record and the claim inventory, read the code at the base SHA, and returned "accept with changes" with eleven findings. The auditor verified each finding.

1. The listener sentence added `/api/worker-capabilities/*`, which NRT does not declare and which skips the family dispatch. Accepted; the sentence names only the transport namespace and the three family prefixes, and issue #734 tracks the code.
2. NRT still said "six" Harness operations in the Decision and the implementation projection. Accepted; both corrected. The worker-control owner's projection, which says that `turn.steer` is not implemented, is recorded for the summary.
3. NRT kept "Until then, the exact current preconditions ... remain mandatory" without its condition. Accepted; removed.
4. NRT kept "the same five headers" for `file.export` without an antecedent. Accepted; it now names the five canonical metadata headers of the data-boundary owner.
5. The DSD control-store sentence could be misread, and the side-by-side journal write may be a dual write that the accepted decision rejects. Accepted; the commas are fixed, and the dual-write point is in Question Q-222.
6. "An open execution attempt" could be read as the phase literal `open`. Accepted; "a non-closed execution attempt", as DSD says elsewhere.
7. WTR still names Quick Chat as a role, and `quick_chat_*` also matches the live `quick_chat_not_shareable`. Accepted in part; the Resolved Decision names the two removed codes, and the role naming is in Question Q-221 because the Assistant agent id is still `quick-chat`.
8. RT-NRT-A-04 is decided by an accepted rule and predicate 38. Accepted; issue #735, and Question Q-218 is withdrawn.
9. Question Q-217 missed the AgentSession continuity proof rules. Accepted; the context cites them.
10. Bookkeeping: the inventory classes, the removed header identifiers and the array line range. Accepted; all three corrected.
11. RT-G2-02 was applied without a question. Accepted; Question Q-221 names it as applied.

## Checks

- `node scripts/validate-doc-model.mjs`: passed (715 documents).
- `node scripts/generate-doc-index.mjs`: regenerated `docs/INDEX.md`.
- `pnpm check:repo`: passed (exit 0).
- `git diff --cached --check`: clean.
- Content scan of the staged added lines (emails, tokens, local paths, private hosts, Vietnamese diacritics): no match.
