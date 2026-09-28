---
type: change-plan
status: verified
date: "2026-09-22"
branch: codex/engineering-quality-pilot
---
# Engineering Quality Batch Two

## Intent Epoch 1 — 2026-09-22

The engineer asked whether the audit rules and cleanup method have stabilized, requested a working note recording that framework, then ten fast cleanup/refactoring rounds followed by one final assessment of improvement or degradation and its magnitude. Over-engineering must be considered both in this batch and in future prevention. This supersedes the previous batch's per-pair scoring cadence, not its behavioral or safety obligations. Existing authorization for Herdr collaboration, PI GPT-6 astra, and independent Claude Code assessment continues. Local changes are authorized; commits, publication, deployment, and product behavior changes are not.

## Owners And Method

[Root execution](../../../AGENTS.md), [Change Execution](../../change-execution.md), [Verification Instruments](../../verification-instruments.md), [Documentation Model](../../documentation-model.md), and [Test Strategy](../../specs/20260529-test_strategy.md) retain authority. The Chinese working note at `temp/quality-governance/working-note.md` (uncommitted local evidence, absent from a clean checkout) freezes the batch observations before implementation. This change record preserves execution and conclusions, never architecture authority.

Continue the existing branch. The accepted previous batch remains uncommitted and is this batch's baseline: 35 dirty/new files are copied under the same-name temp/changes directory, with an initial SHA-256 manifest and patch. Snapshot every additional clean path before its first edit. Compare this batch to those bytes, not cumulatively to HEAD. No changes from the previous batch are discarded.

The Consultant examined the actual working note and verified the baseline. Preserve raw before/after observations and direction judgments; omit the previous ordinal scale, aggregate scores, and project-wide improvement percentages. Retain G1 behavior preservation and G2 authority/safety separately; D1 measures independently authored decisions, D2 named caller obligations, and D3 requires a credible fresh-context discovery experiment, otherwise N/A. O1 records unnecessary structures removed or introduced, including this batch's own code, tests, documentation, and procedure; overlap with D1/D2 is disclosed. This is a weak explanatory oracle under Demote, not an automatic acceptance gate or cross-task calibration.

Prefer existing owners and standard-library operations over new abstractions. Exclude Safety Kernel protection deletion from fast candidate selection. Characterization checks and consumer closure precede edits; focused checks follow each slice, and affected-package typecheck/lint/build may be consolidated at the end. The primary inspects actual diffs; the independent Claude Code Auditor inspects all ten slices and deciding evidence once at the end. No implementation is accepted solely from its producer's report.

## Working Checkpoint

All ten slices are implemented and independently accepted. The three PI GPT-6 astra builders finished through Herdr; source/test paths remain frozen. Primary completed guides, generated CLI integration, and coordinated checks. One independent Claude Code assessment followed all ten slices under the pre-implementation framework, with a bounded reporting correction afterward. No implementation correction was required by the final assessment. This batch remains uncommitted, with no stage, commit, push, or deployment issued by Primary or its workers.

During discovery, HEAD advanced to 39a6891e0bcbd79e201cc90fe77b1eed9d8ae42b, titled 1turn. Neither Primary nor the dispatched workers issued a commit or index command. Direct hashing shows all 35 initial baseline paths match that commit exactly; no prior-batch content changed. Preserve that history. This makes the retained batch baseline also available as a commit without altering the observation or attributing the commit to an unverified actor.

## Preregistered Slices

| Round | Named target | Expected observation and preserved boundary |
| --- | --- | --- |
| 1 | Web workspace/data.ts useWorkspaceDashboard and its key | Remove an unconsumed hook/key; retain live dashboard API and current Overview queries. |
| 2 | NanoCore agents/agent-shape.ts AgentProfileShapeSchema | Remove an orphan schema only after reconciling the AgentProfile owner with live authored-schema parsing and resolution; preserve current validation. |
| 3 | NanoCore scheduler-dispatch-service.ts runSchedulerDispatchRetryOnce | Remove a policy-free forwarding function and input alias; retain real loop, timer, snapshot, errors, defaults, and all callers. |
| 4 | Web portability/data.ts result aliases | Remove two unused result names; retain schema-owned inferred results and all live command types. |
| 5 | Core Client events.ts URL builders | Two identical URL policies share a private owner; retain base normalization frequency, cursor reads, encoding, transport lifecycle, and reconnect behavior. |
| 6 | config-schema tree-digest.ts compareUtf8 | Replace manual unsigned byte ordering with Buffer.compare; retain the exact order, path validation, framing, and digest vectors. Comparator sign, not magnitude, is consumed. |
| 7 | Web Goal BoardLens card rendering | Three repeated card trees share one local fixed-column iteration; retain ordering, counts, hue, labels, clicks, and classification rules. |
| 8 | Web Badge and PhaseStepper status pairs | Reuse existing STATUS_CLASS entries only for exact whole-pair matches; preserve accent and foreground-only states. |
| 9 | Web Composer size prop | Remove the ignored option and its sole supplied argument; preserve markup, submissions, keyboard, and sizing. |
| 10 | Web CompletedView onOpenArtifact prop | Remove unconnected optional callback plumbing; preserve noninteractive Artifact rows and the shared ArtifactRow component. |

The selected product owners include Web projection/UI stack, Core Client boundary, agent supply and manifest resolution, durable scheduler design, and Skill catalog tree versioning. Governance preparation is not one of these ten rounds. Round numbers identify independent responsibilities, not a fabricated serial execution order; disjoint work can overlap. Shared tests are reused across related UI slices, not counted as independent test totals.

## Verification

Runtime: Node 24.18.0 and pnpm 10.33.3. The following counts overlap where related checks reuse suites; do not sum them into coverage or quality. No full-repository or deployed-product validation is claimed.

| Surface | Exact check | Observed result |
| --- | --- | --- |
| Workspace and Portability | pnpm --filter @openkit/web exec vitest run --no-cache --configLoader runner src/screens/workspace/workspace.test.tsx src/screens/portability/portability.test.tsx | 215 passed before and after |
| Agent parsing and setup | pnpm --filter @openkit/nanocore exec vitest run --no-cache --configLoader runner src/config/agents-loader.test.ts src/agents/setup-resolver.test.ts | 13 passed before and after |
| Scheduler | pnpm --filter @openkit/nanocore exec vitest run --no-cache --configLoader runner src/runtime/scheduler-dispatch-service.test.ts src/runtime/scheduler-dispatch-loop.test.ts src/runtime/scheduler-restart-recovery.test.ts | 75 passed before and after; existing assertions retained |
| Client events | pnpm --filter @openkit/core-client test --no-cache --configLoader native src/client.test.ts | 79 baseline tests; 81 including two characterization cases passed before and after extraction |
| Tree digest | pnpm --filter @openkit/config-schema test --no-cache --configLoader native src/tree-digest.test.ts | 7 baseline tests; 8 with the fixed Unicode digest vector passed before and after replacement |
| Comparator equivalence | node temp/changes/202609220100000001-engineering_quality_batch2/builder-two-r6-equivalence.mjs | 324 comparator-sign and 36 exact-digest comparisons passed; source containment checked |
| Goal, primitives, Chat | pnpm --filter @openkit/web exec vitest run src/screens/goal/goal.test.tsx src/primitives/primitives.test.tsx src/screens/chat/chat.test.tsx | 277 baseline and 283 final tests passed; characterization assertions passed before their source refactors |
| Package checks | Each of @openkit/web, @openkit/nanocore, @openkit/core-client, and @openkit/config-schema: pnpm --filter package typecheck, lint, build | All final exits 0; existing lint information/warning and build chunk advisory retained |
| CLI integration | pnpm build:openkit; node --test tests/openkit-skill-interface.test.mjs tests/openkit-public-redaction.test.mjs | CLI regenerated; 46 tests passed |
| Governance | node --test tests/agents-root-contract.test.mjs tests/change-execution-contract.test.mjs tests/verification-instruments-contract.test.mjs | 31 passed |
| Documents | node scripts/validate-doc-model.mjs; node scripts/validate-spec-lifecycle.mjs; node scripts/generate-doc-index.mjs --check | 286 documents valid; lifecycle valid; index current |
| Containment | git diff --check; SHA-256 comparison with candidate-source-manifest.json | Passed; 24 tracked paths frozen against the batch baseline |

The new Goal plan-order fixture initially mocked a GET disabled after approval; seeding the existing query-cache path corrected that setup before production edits. Formatting findings in new tests/Board rendering were corrected without weakening assertions. A PI transport interruption supplied no test result; the worker reconciled retained output and resumed only missing checks. Source checks ran in the shared checkout, not isolated worktrees. No strict-effect guard, accepted lifecycle, schema format, or existing test assertion was removed to make a check pass.

Raw observations, original failures, actual diffs, and independent assessment are retained under temp/changes/202609220100000001-engineering_quality_batch2. The profile instruction-supply conformance question remains in findings.md; previous-batch packaging failures remain outside this batch's validation and are not fixed or relabeled as passing.

## Closeout

The independent Claude Code Auditor accepted all ten slices, with G1 and G2 PASS for each and no blocking finding. It verified the 24-path candidate freeze and the baseline provenance, then independently reproduced Web UI 283, Workspace/Portability 215, Scheduler 75, Agent parsing/setup 13, Core Client 81, Tree digest 8, and governance 101 passing tests. Document model validation covered 286 documents, spec lifecycle passed, and the index was current. The independently rebuilt CLI was byte-identical to the candidate. The initial empty grep-filtered test output was rejected as evidence; plain reruns captured the underlying exit status. Other package gates, the 46 CLI tests, and the comparator probe retain producer output rather than a claim of independent rerun.

| Dimension | Observed direction | Raw magnitude and boundary |
| --- | --- | --- |
| D1 | Improved in R5, R7, R8; unchanged in seven; no degradation found | URL rule sites 2 to 1; card rendering sites 3 to 1; notice, neutral, informative pair sites respectively 3 to 1, 2 to 1, 2 to 1. |
| D2 | Conservative final report: unchanged in ten; no necessary obligation reduction established | R9 removes one actually supplied optional ignored flag at one caller. It was never mandatory. R3 preserves the same input and single call; R10 had no callback suppliers. |
| D3 | N/A | No fresh-context discovery experiment in this batch. |
| O1 | Named unnecessary structures removed in every slice | R1 one hook and key; R2 one orphan schema module; R3 one forwarder and alias; R4 two aliases; R5 one duplicate closure; R6 one manual byte loop; R7 two duplicate rendering trees; R8 four pair restatements; R9 one ignored option and argument; R10 one unconnected callback and conditional plumbing. Overlaps with D1 are not additional independent benefits. |

The original final-audit.txt and subsequent final-audit-correction.txt preserve the classification discussion. The Auditor withdrew its initial D2 gains for R3 and R10 after Primary applied the frozen actual-obligation definition. A narrow interpretation difference remains for R9: the Auditor counts the removed supplied flag as a small D2 improvement but explicitly accepts that a strictly necessary-obligation reading yields no gain. Primary reports the latter, consistent with the frozen wording, while retaining both readings and the exact delta. This does not alter artifact acceptance, change the framework after observing results, or justify a project-quality score.

Production source created no files, deleted one, and introduced two local constructs with present consumers: the shared private URL builder and fixed board-column mapping. The broader footprint also includes two formal change records, 122 net lines of characterization tests, the requested working note and summary, and temporary evidence. These have present behavioral, intent-retention, and verification purposes; they are costs to retain in O1 scrutiny, not invisible overhead. Source line delta is 66 additions and 150 deletions, net minus 84; line count is context, not quality or efficiency evidence.

The reusable direction is owner and consumer discovery, present-need judgment, deletion or existing-owner/stdlib reuse, behavior examples before editing, proportionate checks, and independent inspection where consequence warrants it. Over-engineering is now explicitly named in existing QUALITY-003 and reviewer Code Smell judgment, including structures introduced by a cleanup itself. No new governance layer, generic Domain/Service architecture, or mandatory ten-round process was introduced. This working framework fixes observation questions and evidence boundaries; optional-flag classification illustrates why it is not a calibrated scoring instrument.
