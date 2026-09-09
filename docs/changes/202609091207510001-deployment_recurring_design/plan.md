---
type: change-plan
status: verified
date: 2026-09-09
---
# Deployment Requirements And Recurring Scheduling Design

## Intent Epoch 1

Source: the engineer's 2026-09-09 annotated request to resolve Pathway B1 and B2 through two document writers, each with an independent reviewer, adversarial verifier, and auditor. This explicitly permits delegated writing for this change. Verifiers remain independent Claude Code agents through Herdr, as requested earlier in the conversation. Product Vision must not change. This is design/documentation work, not implementation, deployment, installation, runtime qualification, or a commit.

For B1, Linux or macOS should run the relevant supported stack. NanoCore and NanoHost may reside on different machines; NanoHost requires OpenShell. Two CPU cores, 8 GiB memory, and 30 GiB storage are the engineer's empirical recommended shape, not proven hard limits. Inspect the actual repository and authoritative upstream requirements, distinguish source development from installed runtime requirements, and distinguish NanoCore from NanoHost and combined deployment. Docker/Podman are examples to verify, not an authorization to claim unproved backend support.

For B2, use one NanoCore-local five-second soft timer, persist registered schedules, trigger/run status and history, retry unsuccessful triggering within a bounded attempt count, resume scans after restart, and record an occurrence as expired when it has not successfully triggered within ten minutes of its scheduled time. Failed or expired occurrences must remain in the database. The engineer described a three-failure threshold; the exact attempt count and admission-versus-execution retry boundary are being clarified. Existing scheduler admission owns actual execution; no second worker executor is implied.

## Owners And Write Ownership

Design owners: [Deployment Host Requirements](../../specs/20260909-deployment_host_requirements.md), [Recurring Triggers](../../specs/20260711-scheduler_recurring_event_triggers.md), and their existing linked storage, Policy, runtime, portability and verification owners.

The deployment writer owns the new deployment requirement specification plus existing deployment, NanoHost-distribution, and container-packaging documentation assigned by the primary. The scheduler writer owns the recurring trigger specification, durable scheduler and runtime scheduling specifications, and Runtime Model Core if a stable conceptual clarification is needed. Neither may edit shared storage, audit, portability, Web, index, Roadmap, or this plan without a coordinated ownership transfer. The primary owns those shared projections and this record. Reviewer, verifier, and auditor contexts are read-only; one writer per path remains mandatory.

## Closeout Summary

Closed as documentation work. [Deployment Host Requirements](../../specs/20260909-deployment_host_requirements.md) and [Scheduler Recurring Triggers](../../specs/20260711-scheduler_recurring_event_triggers.md) are Accepted / Not Started. B1/B2 design blockers are cleared in Roadmap without reordering the pathway or completing R109, R110 or R092. Two disjoint writers produced the drafts; the primary integrated shared owners and the final bounded checker-mode corrections after stopping the deployment writer and taking its paths. Product Vision and production code remain unchanged; no commit, deployment or runtime qualification occurred.

The accepted host contract distinguishes support intent from observed qualification, includes both Linux architectures, separates source/image/runtime dependencies, preserves the empirical resource recommendation, and gives the existing installer a checksum-bound bundled profile and one internal evaluator shared by `--check-host`, `--check` and installation. The accepted recurring contract retains exact history and atomic queue acceptance, one waiting occurrence per schedule, current authority, bounded retries and deadline, exact restart reconciliation, and inert portable history without deployment-local admission paths.

After compaction the primary re-read the plan, current diff and active reviewer/auditor findings. No fresh direction check ran because work continued within the already scrutinized B1/B2 route. The final simplifications reused existing installer, scheduler, AuditEvent, Workspace fence, import and verification owners rather than adding runners or registries.

## Verification Evidence

Each slice received an independent normal reviewer, Claude Code adversarial verifier through Herdr, and intent auditor. Final normal review and audit found no remaining material defect. Claude's final B1 and B2 verdicts found no surviving falsifier within their stated design scope. Their retained outputs are `temp/changes/202609091207510001-deployment_recurring_design/claude-b1-final-confirmation.txt` and `claude-b2-final-confirmed.txt`; late bundled-profile/checker-mode producer-consumer corrections were separately inspected by the B1 reviewer and auditor. These reviews and checks do not prove the future implementation runs.

Material corrections included target architecture versus test host, full-bundle libc requirements, static prerequisites versus runtime proof, exact bundled-profile consumption, occurrence/queue/audit atomicity, complete old-definition snapshots, clock and unknown-commit boundaries, immutable resolved admission payloads, queue backlog, and non-authorizing import IDs and audit selectors. Claude objections that conflicted with explicit three-attempt/pre-admission timing intent, treated a storage cap as a reservation, or requested new prose-pinning tests outside the finite repository exemption were rejected with reasons and withdrawn after reassessment.

R002 retains its historical initial-arm64 distribution closure. The engineer's correction establishes both supported architectures; existing R109/R110 deployment and qualification work must complete the currently missing amd64 artifact path. This change does not reopen R002 or claim its older result proves amd64 or the new prerequisite profile.

Observed checks:

- `node --test tests/verification-instruments-contract.test.mjs tests/agents-root-contract.test.mjs`: 22/22 passed. The existing governance projection was corrected only after independent reviewer approval; raw-byte digest, exact identity binding, one-JSON-object framing and strict real-use invariants remain covered. Raw output is retained in the plan's temporary evidence directory.
- `pnpm exec biome check tests/verification-instruments-contract.test.mjs`: passed, one file checked, no fixes.
- `node scripts/validate-spec-lifecycle.mjs`: passed.
- `node scripts/generate-doc-index.mjs --check`: passed after final regeneration.
- `git diff --check`: passed.
- `git diff --exit-code -- docs/product-vision.md apps packages containers scripts`: passed; these paths remain unchanged.
- `node scripts/validate-doc-model.mjs`: the sole failure is the pre-existing `docs/changes/202609081255000001-agent_plugin_skill_mcp_catalog/plan.md` status `in-review`, which is outside the canonical lifecycle vocabulary. That unrelated file was preserved; this is a remaining corpus-validation issue, not a B1/B2 design blocker.

The initially incompatible Herdr client was bypassed with the official temporary 0.8.2 client verified against its published SHA-256. The existing Herdr server and user sessions were not restarted. Claude received the named internal documents only after the engineer's explicit authorization recorded in Epoch 3. Research remains uncommitted under `temp/research/20260909-deployment-requirements/`; raw reviews remain under the matching temporary change directory. The two review sessions are left idle for possible continuation, and the temporary client remains outside the repository.

## Intent Epoch 2

Source: the engineer's explicit reply to the scheduling clarification in this turn: adopt three total admission attempts (initial plus two retries), retry on the next five-second scan, never resubmit accepted work solely because execution failed, and expire unadmitted work ten minutes after its original scheduled time. This resolves the retry ambiguity in Epoch 1 without authorizing worker-effect replay.

## Intent Epoch 3

Source: after automatic review rejected the initial Claude dispatch for sharing internal document paths and design context, the engineer explicitly authorized providing the B1/B2 design documents, change plan, and necessary related repository context to the two Claude Code verifiers for read-only adversarial review. Dispatch succeeded after that authorization. This does not authorize credentials, deployment, publication, or unrelated data access.

## Intent Epoch 4

Source: the engineer explicitly corrected the B1 architecture inference: NanoHost supports x86_64 as well as ARM64; ARM64 identifies the current test host, not the supported architecture boundary. The target documents must preserve both architectures and classify architecture-specific packaging or test coverage as implementation gaps rather than narrowing product intent.
