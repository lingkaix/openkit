---
type: change-plan
status: verified
started: 2026-09-09
branch: main
---
# Agent Execution Autonomy Clarification

This record preserves execution evidence and has no design or governance authority.

## Intent Epoch 1

Source: the engineer's instruction in this task on 2026-09-09, rendered in English. Implement only recommendations 1–3 from the instruction review: distinguish reserved final approval from completing authorized ordinary work; distinguish new design decisions from implementation inside accepted contracts; and resolve document authority and scope before requirement strength, with cookbooks subordinate to their owners. Use an independent Claude Code Consultant through Herdr to confirm the scheme and wording, then independent Reviewer and Auditor contexts to inspect the result, and commit after review.

The engineer explicitly excluded recommendation 4 because the repository's OpenKit Skill is a future end-user deliverable, and excluded recommendations 5–12 because the installed agent Skills are outside this repository's engineering governance scope. No Skill, product behavior, product vision, unrelated working-tree change, publication, or deployment is part of this change.

## Owners And Scope

Root `AGENTS.md` owns repository execution. `docs/documentation-model.md` owns document types and precedence; `docs/change-execution.md` owns material coordination and completion. `docs/core/foundation.md` preserves human final authority, bounded delegation, and strict safety. `docs/cookbooks/AGENTS.md` projects directory-local procedure under those owners.

The primary is the only writer of `AGENTS.md`, `docs/change-execution.md`, `docs/cookbooks/AGENTS.md`, and this record. The existing contract tests and all Skill files stay unchanged. Consultant, Reviewer, and Auditor inspect without editing these paths.

## Verification Evidence

- Ordinary execution within existing authorization can finish without a new approval; reporting completion cannot satisfy a reserved human gate.
- Implementing an accepted contract reuses its owner. A new governing decision without an accepted owner still blocks dependent implementation, while authorized investigation and unaffected work continue.
- Requirement strength applies only after authority and scope are settled. A cookbook cannot override its accepted owner or authorize unrelated repairs.
- Same-concern governing conflicts, explicit approvals, the Safety Kernel, independent acceptance, and concurrent-write protection remain intact.
- Baseline: `bash scripts/test-env.sh any node --test tests/agents-root-contract.test.mjs tests/change-execution-contract.test.mjs` passed 14 tests; `bash scripts/test-env.sh any node scripts/validate-doc-model.mjs` validated 237 documents.
- After the instruction edits, `bash scripts/test-env.sh any bash -c 'node scripts/validate-doc-model.mjs && node scripts/generate-doc-index.mjs --check && node --test tests/agents-root-contract.test.mjs tests/change-execution-contract.test.mjs tests/doc-model.test.mjs'` validated 238 documents, found the documentation index current, and passed 82 tests with no failures or skips. Raw output is retained in `temp/changes/202609091357490001-agent_execution_autonomy/verification.log`.
- `git diff --check` passed. `wc -w AGENTS.md` reported 1567, below the unchanged 2100-word ceiling.
- TEST-009 proof choice: this change modifies instructions, not product runtime behavior. Existing structural checks plus independent semantic examination of the final clauses are stronger than new substring assertions that could remain green after a contradictory exception is appended. No new harness, classifier, or textual acceptance oracle is introduced.

## Closeout Summary

The four-path change is verified and ready for the engineer-authorized scoped commit. No unresolved finding remains. The three instruction files match the hashes independently inspected by Reviewer and Auditor; only this record's status and evidence were closed out afterward. The containing Git commit identifies the landing revision. No publication, deployment, Skill change, or modification of the 25 pre-existing changed paths was performed.

Baseline HEAD is `e3ecaee7f6ef7a95dbf1043a82af0ba34d5231f5`; the 25 existing changed paths, their SHA-256 values, the empty starting staged diff, and clean target hashes are retained in `temp/changes/202609091357490001-agent_execution_autonomy/baseline.json`. The reviewed instruction hashes are retained beside it in `reviewed-instructions.json`.

## Independent Review

An independent Claude Code Consultant, started through Herdr as `autonomy-consultant`, inspected the source instruction, owners, and candidate wording. Its Continue verdict led to an active reserved-gate guard, repository-only precedence wording, a single important-residual-risk qualifier, and one subordinate-cookbook rule. A follow-up confirmed the final DOC-002 wording: retain the existing non-trivial design threshold and exempt implementation choices that do not change an accepted contract. The observed responses are retained in `temp/changes/202609091357490001-agent_execution_autonomy/consultant.txt`.

Independent registered Reviewer `/root/autonomy_reviewer` returned no actionable findings after inspecting the actual diff, surrounding owners, record, and evidence. Independent registered Auditor `/root/autonomy_auditor` returned Continue with no actionable findings after its own intent, scope, authority, and preservation checks. Both independently reran the documentation model, index, and 82-test suite successfully, confirmed the frozen instruction hashes and 1567-word root contract, and accepted the stated TEST-009 proof choice. The Auditor additionally confirmed every pre-existing changed-path hash, the empty staged diff, the four-path scope, and the unchanged root contract test. Their responses are retained beside the Consultant evidence in `reviewer.txt` and `auditor.txt`.

## Residual Risk

Ordinary work and implementation within an accepted contract still require judgment. Existing owner, conflict, acceptance, and safety rules constrain that judgment; this change adds no risk classifier and claims no measured reduction in future agent interruptions.
