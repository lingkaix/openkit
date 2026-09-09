---
type: change-plan
status: in-progress
date: "2026-09-09"
---
# Persistent Live Acceptance

## Intent Epoch 1

The engineer requests architecture, technical design, canonical documentation, implementation and actual deployment of two complementary real-use paths: tasks and Agent benchmark work running in OpenKit with its product records and diagnostics; and a desktop Agent operating the same deployed product through a refreshed, capable OpenKit Skill plus separately authorized SSH/tools. A co-deployed Codex/Pi Agent and customer autonomous maintenance are excluded. The primary personally authors documentation, consults an independent Claude Code Agent, and obtains independent reviewer/auditor scrutiny. Commit documentation before implementation. Delegate all concrete implementation and testing work to Cursor CLI Agents using Grok 4.6. Deploy to the expressly authorized SSH alias `a2`, using existing `~/.openkit` test data and Codex subscription configuration; the engineer explicitly permits test-data loss, while credential confidentiality remains strict. Continue until both modes actually run. The purpose is to reduce repeated environment construction and enable pending feature plans to obtain their own real acceptance, not to declare all roadmap plans complete in this change.

## Intent Epoch 2

During canonical writing the engineer asks to state whether these modes primarily cover L6 Stories and real-user Agent task/benchmark suites, or whether all L6 must execute internally. The working interpretation is explicit scope plus default placement: these two modes are the default for ordinary L6; the Actor may be external, and cold-start/installation/destructive/isolation stories retain a justified dedicated environment. L1-L5 retain their existing owners. This clarifies placement without broadening test-platform scope.

## Owners

- [Architecture](../../core/architecture.md) owns observation versus execution authority.
- [Persistent deployment acceptance](../../specs/20260909-persistent_deployment_acceptance.md) owns the two-mode composition and initial acceptance.
- [L6](../../specs/20260529-l6_story_acceptance.md) owns open-ended Actor and independent verdict semantics.
- [Skill interface](../../specs/20260713-openkit_agent_skill_interface.md) owns discovery and public operation projection.
- [Operational telemetry](../../specs/20260731-operational_telemetry_standardization.md) and [boot diagnostics](../../specs/20260704-nanocore_bootstrap_readiness.md) retain optional signals and process observations.
- [Verification instruments](../../verification-instruments.md) retains strict fixture qualification while admitting ordinary persistent product use.

## Method And Decisions

Reuse existing Task/Goal, public work reads, Audit, Usage, Evidence, Skill packaging and deployment tooling. Do not add an evidence aggregation service, evaluation database, runner or automatic repair daemon. Restore useful existing public read projections in the CLI, refresh guidance and story admission, and add bounded process/request diagnostics only within the explicit initial slice. External host operations stay outside the Skill. Cold and destructive qualification do not operate implicitly on the shared instance.

Claude consultation is through Herdr `live-consultant`; canonical writing is primary-only. Independent registered reviewer/auditor contexts inspect actual bytes. Cursor `live-deployment` first inspects a2 read-only and later receives exclusive deployment/test ownership when documents are committed. No other agent may mutate that deployment concurrently. Primary owns this plan and all documentation; implementation ownership is dispatched by explicit paths after the documentation commit.

## Checkpoint

Baseline `a592b199`, initially clean. Canonical owners now define persistent ordinary acceptance without cold-start or credential replacement. The existing 209-operation catalog retains its mappings-plus-exclusions oracle. The initial new read is NanoHost runtime-target; search/dashboard additions are deferred for their accepted private-visibility dependency. Product Vision is untouched. The read-only a2 observation below establishes the actual Worker readiness/image blockers.

Next action: commit the independently reviewed documentation, then dispatch the bounded API/Skill/telemetry implementation to Cursor Grok 4.6. The expected observable is a focused red-to-green contract regression and built Skill; changed runtime behavior is not claimed before those checks. Deployment follows reviewed implementation and an exact committed artifact. A fresh Claude direction context examines the current intent, diff and host evidence before that external effect. If actual NanoHost qualification becomes necessary and its host assertion fails materially, obtain fresh independent direction scrutiny before investing in R109/R110 rather than absorbing that project.

## Acceptance And Evidence

Both real modes must complete on one persistent authorized deployment with exact build attribution, meaningful output and public terminal-state evidence. The external Skill L6 retains its required independent judgment and repeated-run admission, with current host context isolated from hidden answers. A repeated attempt must not recreate the product or Provider account. Record focused check results and real observations here before closure. Other plans close only against evidence that satisfies their own conditions.

Temporary source/inspection/consultation evidence stays under `temp/live-*` and `temp/reviews/20260909-persistent-deployment-consultant/`. No implementation or deployment completion is claimed at this checkpoint.

## Story Admission Argument

The revised Skill story asks for one new named project Workspace and its identity. A competent Actor with only that goal and the installed product interface can satisfy every required product assertion; no exact CLI sequence, reference count or hidden answer is required. A unique attempt-owned name replaces empty-deployment isolation for this subject. Scope/tool and confidentiality assertions preserve ordinary permitted use; discovery friction remains non-blocking. The story requires two consecutive real-provider runs under the L6 owner before its revised admission is evidenced. Internal real Task completion is the mode-one seam proof and does not claim a benchmark comparison or the separate Worker MCP story's full acceptance.

## Design Review Evidence

Claude Consultant returned Continue with no consequential unresolved objection after inspecting actual owners and source. It withdrew an unnecessary repeat-permission request because the engineer already authorized persistent reuse and a2 deployment. Direct code inspection corrected two proposed detours: operation coverage already exists, and NanoHost qualification teardown must not run as ordinary product preflight. The amended verification owner is 4591 words, within its 4600-word ceiling. Optional HTTP telemetry remains requested scope, separate from acceptance authority. No new build identity is invented; deployed artifacts remain the attribution source.

Observed document checks: documentation model passed (248 documents), spec lifecycle passed, story schema passed (2 stories), `git diff --check` passed, and skill-creator validation passed using an isolated uv PyYAML environment after system Python lacked that optional dependency. Independent reviewer final reinspection found no actionable documentation findings; Auditor found no blocking intent, authority-consistency or protected-path finding. Their corrected-byte reports are retained at `temp/live-design-review.md` and `temp/live-acceptance-auditor.md`. Production checks remain Cursor-owned implementation work.

## Deployment Observation

Cursor read-only inspection found the persistent a2 NanoCore container healthy at its existing HTTPS endpoint, using the existing test Data Root. Its configured NanoHost is running but the observed target is not ready/fresh-empty, and the configured Codex Worker image is absent. These are real implementation/deployment blockers to mode one; liveness does not discharge them. The existing host deploy script only accepts origin/main, so deployment must either use an authorized publication or transport the exact committed snapshot and reuse the existing build/service procedure with truthful identity. No Git push is implied merely by the script's preference. A separate prior test container exists and is outside this change's owned deployment.

## Review Corrections

Independent review separated Actor admission from product assertions, restored required Skill discovery triggers, clarified telemetry configuration truth conditions, corrected local indexes and Markdown, and preserved the desktop Agent operator phase. Search and dashboard mappings are deferred: their existing handlers check Workspace access but do not yet implement the accepted private-thread visibility contract. Only the admin NanoHost runtime-target read is added now; the three existing exclusions receive accurate dependency reasons. This avoids expanding a known content-visibility gap while leaving both requested execution modes achievable through attempt-owned public records.
