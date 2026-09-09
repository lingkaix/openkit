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

## Intent Epoch 3

The engineer now explicitly authorizes that if any current token, login information, or Credential is unavailable, it may be rebuilt or reinjected. During the single planned a2 deployment this uses existing administrator recovery, provider subscription renewal or injection, and NanoHost transport credential reissue as necessary, without a repeated permission request. Confidentiality and existing authorities remain: no secret output or argv, no direct database authentication-flag mutation, and no invented authorization path. Source: user steering on 2026-09-09 during implementation.

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

Baseline `a592b199`, initially clean. Canonical owners define persistent ordinary acceptance without cold-start of a new instance. Intent Epoch 3 now authorizes rebuilding or reinjecting unavailable credentials during the one planned deployment through existing recovery, subscription, and NanoHost transport procedures. The existing catalog retains its mappings-plus-exclusions oracle. The initial new read is NanoHost runtime-target; search/dashboard additions remain deferred. Product Vision is untouched.

Local implementation now passes focused NanoCore, schema, Core Client and catalog checks. Web typecheck and build pass after the existing frozen workspace install restored absent package links; no dependency change was needed for Web. Independent review identified optional exporter shutdown gating listener closure; the correction now starts best-effort flush concurrently. An independent controlled probe of the actual entrypoint function observes both listeners and the canonical close callback completing with telemetry still pending. The durable regression executes that same extracted function. The two Web diagnostics fixtures are aligned and their 49 focused tests pass.

Next action: finalize and independently inspect these bounded corrections, commit the coherent implementation, then `live-deployment` performs one a2 deployment (restore staging NanoHost, optional Collector start after review, Epoch 3 credential recovery as needed). Do not recover tokens or start Collector before that build. Do not mutate readiness flags in SQLite. A fresh Claude direction context still examines intent, diff and host evidence before that external effect.

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

## Implementation Dispatch

Documentation committed as `cbab8ace` after independent review and audit. Cursor `live-builder` owns the bounded runtime/schema/client/catalog code and focused tests; primary retains all Markdown. Cursor `live-tester` independently derives the real-use evidence procedure read-only; Cursor `live-deployment` checks the actual NanoHost backend and image-import readiness before any remote mutation. Expected observations are contract regressions and the real readiness cause, not success inferred from process liveness. The release-tree and fixture-wording test projections intentionally require reconciliation with the newly committed owners during implementation.

Fresh independent Claude `live-direction` (session `35cd8033-7ea2-4fea-a228-4bab64596c24`) inspected source intent, current diff and host evidence after primary compaction and returned Continue. It confirmed ordinary Task admission requires the actual NanoHost handshake and warned that host Docker image inventory does not prove the private backend image is absent. Directly changing readiness database flags is forbidden; fix image supply or the actual runtime owner and observe a fresh handshake. If readiness requires a NanoHost code fix, handle the demonstrated defect under its accepted owner, not qualification teardown. Preserve the exact successful snapshot transport/build/restart procedure in the cookbook after observation; a local commit plus deployed digest is attributable without claiming origin publication.

## Corrected Host Observation

The private NanoHost image store contains the staging images; the earlier host-Docker absence inference was false. Actual cause: the single live NanoHost unit still connects to the retained R058 fixture on rendezvous 4328, not staging on 8081. The fixture has zero live leases, all 24 backend sessions cleaned, stale September 6 activity, and verified/completed owning plans. There is no active concurrent work to preserve in that session. Restore the existing staging configuration during the single planned deployment, retaining the unrelated fixture container and data. Read-only evidence: `temp/live-deployment/nanohost-readiness-probe.md` and `temp/live-deployment/r058-occupancy.md`.

## Ownership Split

After confirming its release, `live-builder` retains NanoCore process/telemetry, App API schemas and dependency lock ownership. Cursor `live-tester` now owns Core Client, Skill operation catalog and the existing Skill/verification contract tests, preserving peer-written fixtures. This independent seam can progress in parallel; a later independent reviewer will inspect both final slices. Primary still owns all Markdown and no agent may alter a2 until the committed build is ready.

## External Interface Preparation

Cursor `live-deployment` stored the existing a2 file grant in the local Skill encrypted store for `https://ai.simonxu.net`. That grant is invalid: the same in-memory token returned HTTP 401 from both `127.0.0.1:7080` and public HTTPS `GET /api/app/diagnostics`. Doctor store presence is not auth proof. Intent Epoch 3 now authorizes existing stopped-server administrator recovery, provider subscription renewal or injection, and NanoHost transport credential reissue during the single deployment, without repeat permission. Pipe recovery envelopes through stdin only. Do not print secrets, guess tokens, or write authentication flags in SQLite. Remote service mutation still waits for the final committed build. Evidence: `temp/live-deployment/auth-store-outcome.md`.

## Telemetry Configuration Correction

Claude inspected the installed stock exporter merge implementation and confirmed there is no documented override that removes inherited environment header names. Rejecting unsupported header configuration is independent of SDK evaluation timing and replaces the proposed temporary process-environment mutation. The telemetry owner now defines this explicit disabled case and safe variable-name diagnostic; endpoint validity remains separately observable. Stock TLS transport remains operator configuration. This adds no exporter wrapper or alternative transport.

Optional same-deployment Collector prep is ready and not started: pin RepoDigest `otel/opentelemetry-collector-contrib@sha256:799dc6cf12c96192af37b5bdba804da8c10b3bc563b43cb90c3f3c58d9572ad6` (manifest-list; image Id recorded separately), loopback OTLP/HTTP on free `127.0.0.1:14318`, rotated file export under `/home/ubuntu/openkit/otelcol` outside Data Root, `--restart unless-stopped`, config already installed, YAML `validate` exited 0 in a disposable `--network none` run. Start and product `OTEL_EXPORTER_OTLP_ENDPOINT` wait for the one deployment. Evidence: `temp/live-deployment/collector-slice.md`.

## Local Implementation Evidence

Observed App API schema suite: 116 tests passed; Core Client: 78 tests passed; Skill and verification contracts: 34 tests passed; initial NanoCore telemetry/process/diagnostics/boot checks: 26 passed; OpenAPI projection: 24 passed. Relevant lint, typecheck, schema/client/NanoCore builds and Skill bundle build passed. Web typecheck and build also passed after `pnpm install --frozen-lockfile` supplied the missing workspace package links. Independent Cursor review reproduced the Core Client/catalog results and inspected generated bytes. Sources: `temp/live-builder-checks.md`, `temp/live-tester/implementation-checks.md`, `temp/live-tester/build-env/report.md`, and `temp/live-review/skill-seam-review.md`. These are local evidence, not live acceptance.

Final correction checks: shutdown/phase/telemetry suite 18 passed; the behavior-based phase-order file 7 passed after replacing the source-shape assertion; both touched Web suites 49 passed; focused lint and NanoCore build passed. Independent documentation reinspection withdrew an inferred completed-flush requirement: normal exit may cut off best-effort export, while the existing shutdown owner retains exit authority. No actionable documentation finding remains. `temp/live-review/close-listeners-telemetry-probe.txt` records the independent hanging-exporter observation. Documentation model (248), lifecycle, generated index and diff-whitespace checks pass.
