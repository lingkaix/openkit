---
type: change-plan
status: verified
started: 2026-09-05
completed: 2026-09-05
branch: codex/r058-worker-mcp
---
# Delegated Engineering Governance

## Intent Epoch 1

Source: the engineer's governance discussion and final implementation instruction on 2026-09-05, including the annotated statement about minimizing cognitive cost while faithfully realizing intent and key decisions. The engineer accepted the redesign, required that purpose in Engineering Doctrine, and explicitly retained active human invitation for unresolved direction, disagreement, and authorization. Fresh independent Consultant and Auditor contexts must help detect and correct locally compliant but globally unproductive work; test-author, builder, and reviewer contexts remain independently steerable and replaceable. Independence prevents unsupported self-acceptance, not useful self-correction. The primary writes every document; independent Consultant, Reviewer, and Auditor assist without a delegated writer.

Outcome: align engineering principles, coordination, role instructions, and necessary executable projections around intent fidelity, worthwhile design, correct implementation, early reality contact, and economical human attention. Preserve human control over intent, governing decisions, strict effects, and final acceptance. No new event controller, universal role sequence, global scoring gate, product behavior, CI policy, metadata schema, or compatibility role is requested.

Effect boundary: local governance/documentation and directly affected test/configuration edits, temporary evidence, and focused verification. No commit, push, publication, credential use, or real-host transition is authorized by this task. Preserve concurrent R058 work, including its modified plan.

## Intent Epoch 2

Source: the engineer's additional instruction during this task on 2026-09-05. Permit genuinely optional `proposal.md` in a change bundle for reasons, alternatives, assumptions, evidence, and material Consultant objections and resolutions. Explore under temporary space, curate it when entering implementation, update only for material scheme changes with reasons through Git, and retain it as historical evidence after close. A short plan or a complete Draft specification avoids duplication. The proposal has no independent design authority, new version counter, lifecycle, or approval mechanism; synchronize directory admission and focused tests. This adds the existing documentation validator to the writable scope without introducing a metadata schema.

## Owners

- `AGENTS.md` owns repository execution and the Safety Kernel.
- `docs/engineering-doctrine.md` records the engineering purpose and premises; it is not a behavioral-contract owner.
- `docs/change-execution.md` owns delegated coordination and evidence retention.
- `docs/documentation-model.md` owns document authority, lifecycle, and reading.
- `docs/verification-instruments.md` owns deciding evidence and harness admission.
- `docs/specs/20260719-verification_calibration.md` and `docs/specs/20260811-execution_residue_measurement.md` own independent measurement.
- `.codex/agents/` and `.codex/config.toml` project the registered execution capabilities; local test and document guides own their workflows.

## Working Checkpoint

The accepted work is verified. The primary remained the sole writer, with independent Consultant, Reviewer, and Auditor contexts. Scheme rationale and the Consultant's initial Reframe are retained in `docs/changes/202609050619490001-delegated_engineering_governance/proposal.md`; final fidelity observations are retained in `docs/audits/20260905-delegated_engineering_governance.md`. No unresolved finding remains within this scope, and no further execution action is required. Long-run operating effectiveness remains unmeasured.

## Implementation Summary

Engineering Doctrine now records the engineer-attention objective, source-intent fidelity, the distinct value of fresh independent contexts, and active human invitation. Change Execution separates flexible materiality judgment, early Consultant scrutiny, artifact review, incremental Auditor assurance, and optional durable records. The registered verifier was replaced by Consultant without a compatibility alias; other role prompts preserve independent expectations, dissent, safe replacement, and one writer per path. The Safety Kernel and engineer-owned decisions remain binding.

Documentation governance, audit/change local guides, Verification Instruments, calibration/residue specifications, and necessary tests were aligned. Optional `proposal.md` is admitted as existing non-authorizing bundle evidence, with no new metadata schema, lifecycle state, or index group. Permanent observation infrastructure and formal mutation calibration are no longer automatic consequences of ordinary probes or each material change. Existing required regressions, negative harness evidence, and effect boundaries remain intact.

Independent review corrected four substantive ambiguities before closeout: Doctrine's intent-document/task-intent distinction; applying Change Execution to every material task while keeping record creation conditional; avoiding implicit Consultant/Auditor artifact-acceptance authority in real-host evidence wording; and giving incremental Auditor findings a task-context sink without forcing a change record. The last correction was propagated to the retained proposal. These are recorded as resolved findings in the dated audit, not new scope or authority.

## Final Verification

The pinned toolchain was Node 24.18.0 through mise shims. Before edits, the three focused governance suites had 29 passing tests and one pre-existing failure: the host-manifest assertion expected `manifest.json` after its owner had promoted the exact raw bytes to `apps/nanohost/deploy/host-manifest.json`. The test now names that current path without weakening the digest criterion. The new optional-proposal regression first failed as intended with classification `unknown`, then passed after directory admission was implemented.

| Observation | Exact result |
| --- | --- |
| `node --test tests/agents-root-contract.test.mjs tests/change-execution-contract.test.mjs tests/verification-instruments-contract.test.mjs tests/doc-model.test.mjs` | Exit 0; 99 tests passed, zero failed, skipped, or cancelled. |
| `pnpm -w check:repo` | Exit 0; 220 documents and 2 stories validated, generated index current, reachability/terminology/test-governance checks passed, Biome checked 968 files without fixes, models catalog validation passed. |
| Python 3.11 `tomllib` role/config inspection | All six registered role files parse and match registry identities; every per-role model setting and every non-role registry setting equals the starting Git version. |
| `git diff --check` | Exit 0; no whitespace errors. |
| Independent Consultant | Initial Reframe followed by accepted direction before authority edits; reasons, alternatives, and proposal digest retained in the proposal. |
| Independent Reviewer | Final ACCEPTED, no actionable finding; independently reproduced 99/99 focused tests and successful repository checks on the 220-document corpus. |
| Independent Auditor | Final CONFORMS, no unresolved material finding; independently reproduced 99/99 focused tests and confirmed all review corrections. The dated record's transcription was confirmed separately from artifact acceptance. |

Raw logs and temporary scripts remain under `temp/changes/202609050619490001-delegated_engineering_governance/`, including `baseline-pinned-tests.log`, `proposal-red.log`, `focused-tests.log`, `check-repo-final.log`, and `role-config-check.log`. Structural checks and independent judgments establish artifact alignment; they do not prove live dispatch, fresh attention, detection power, or improved long-run efficiency.

## Effects And Closeout

All changes remain local and uncommitted. No push, publication, real-host contact, credential operation, or product behavior change occurred. The protected `.codex/` updates passed automatic approval review and preserved global execution settings. The unrelated modified `docs/changes/202609031230162442-r058_worker_mcp/plan.md` remained outside this writer's scope. Durable rules and rationale are in their owners; the plan, proposal, and audit remain evidence. Final engineer acceptance and future operating-effectiveness judgments are not claimed here.
