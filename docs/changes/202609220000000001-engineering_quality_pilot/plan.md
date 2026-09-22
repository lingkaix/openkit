---
type: change-plan
status: verified
date: "2026-09-22"
branch: codex/engineering-quality-pilot
---
# Engineering Quality Pilot

## Intent Epoch 1 — 2026-09-22

The engineer requested explicit SOLID, KISS, DRY, YAGNI, high-cohesion/low-coupling guidance for agents and Code Smell consideration in review, a governance-file revision proposal with measurable observations developed with a Claude Code Consultant, and ten behavior-preserving cleanup rounds on a new branch. An independent Claude Code Auditor evaluates and scores each completed pair before further implementation continues when improvement is supported. PI collaborators must use GPT-6 astra. Consolidate this conversation's temporary proposals, plans, discussion, and evidence for later retention. Source: the engineer's current task messages and model clarification. The previously corrected Turn-status issue is historical context, not a new cleanup target.

The authorization covers local investigation, governance edits, tests, and cleanup under existing accepted product contracts. It does not cover deployment, publication, production data changes, new product semantics, or accepting unresolved governing trade-offs. Do not manufacture changes to reach ten rounds. Preserve functionality, legitimate semantic differences, and strict effect boundaries. Round 0 is governance preparation and does not count as code cleanup.

## Owners

- [Agent execution contract](../../../AGENTS.md), [change execution](../../change-execution.md), [documentation model](../../documentation-model.md), and [verification instruments](../../verification-instruments.md).
- [Foundation](../../core/foundation.md), [architecture](../../core/architecture.md), and [protocol](../../core/protocol.md).
- [Test strategy](../../specs/20260529-test_strategy.md) and [Core Client boundary](../../specs/20260528-core_client_boundary.md); additional slice owners are recorded when selected.

## Scheme And Evidence

The temporary Chinese work bundle is [temp/quality-governance/README.md](../../../temp/quality-governance/README.md). It links the earlier architecture proposal and plan, the new governance proposal, source intent, actual consultation, slice evidence, and independent evaluations. Curated conclusions are retained here so no lasting decision depends on temporary evidence. This record supplies no design authority.

Select one cohesive existing responsibility per round, record the observable improvement hypothesis before implementation, reuse its behavioral contract and lowest-sufficient tests, and migrate real consumers without compatibility scaffolding. Investigate deletion through consumer closure and proportionate ablation evidence. An unavailable oracle blocks dependent changes. Two disjoint workers may implement one pair with exclusive path ownership; freeze those artifacts for the Auditor before the next pair. Scores describe evidence and uncertainty; they cannot offset a regression or override an owner.

## Working Checkpoint

The bounded pilot is complete and frozen. Pairs 1-5 and the final governance rationale passed independent assessment with no blockers. The outcome is eight code cleanups, one no-change evaluation, and one read-only validation, not ten code improvements. All workers are frozen. All PI collaborators used openai-codex/gpt-6-astra with high reasoning. Verified status applies only to this bounded evidence and does not imply release readiness or engineer acceptance of a new architecture.

## Closeout

The outcome is eight code cleanup slices, one explicit no-change evaluation, and one discovery validation round. These are not ten code improvements. The engineer requested ten rounds; after Consultant scrutiny rejected an unjustified computation-only refactor and bounded discovery found no worthwhile substitute, we reported the narrower result rather than manufacturing a change. No product architecture, domain/service hierarchy, public schema, durable lifecycle, or Turn-status contract was changed.

| Round | Result | Independent D1 / D2 / D3 |
| --- | --- | --- |
| 1 | Removed unconsumed Settings hooks and projections while retaining live connection/Workspace owners. | +1 / 0 / N/A |
| 2 | Shared JSON transport policy and reused request identity at five command sites; regenerated CLI. | +2 / +1 / N/A |
| 3 | Shared Composer file import in the existing Artifact owner; screen refresh remains local. | +2 / +1 / N/A |
| 4 | Resolved document links once and removed audit rereads, preserving ordered diagnostics. | +1 / +1 / N/A; D1 corrected from +2 |
| 5 | Shared three conversation activity destinations while retaining each Workspace source and separate active matching. | +2 / +1 / N/A |
| 6 | Removed an unreachable release-lineage guard already guaranteed by the parser. | +1 / 0 / N/A |
| 7 | Kept the already single-owner test discovery rule; no code change. | 0 / 0 / N/A |
| 8 | Shared an identical stateless secret pattern in a private config-schema module; browser projection stays separate. | +1 / 0 / N/A |
| 9 | Selected the newest dashboard Artifact directly, retaining first ties and existing fallbacks. | 0 / +1 / N/A |
| 10 | Compared two fresh PI discovery tasks over frozen snapshots; both found correct entrypoints. | N/A / N/A / 0; validation only |

D1 describes duplicate decisions, D2 caller burden, and D3 discoverability. These are explanatory judgments with no aggregate or calibrated quality scale. G1/G2 preservation and strict risk were assessed separately from scores; R10 is not applicable because it changes no code. Its D3 score is 0 because both conditions found an entrypoint, not N/A or a claim that no effect exists. The R4 score correction is retained alongside the original because repeated computation is not automatically duplicated knowledge. The R8 Auditor had previously advised its scope boundary and disclosed that limitation; implementation review was independent, not an arms-length review of its own earlier advice.

Governance changes explicitly name SOLID alongside existing KISS, DRY, YAGNI, cohesion, and coupling; introduce evidence-based Code Smell consideration to root review and the reviewer role; and add bounded non-authoritative rationale to Engineering Doctrine. Existing change-execution, verification, and test-strategy owners already supply the required execution rules and were not duplicated or expanded. No standing score gate, Gherkin framework, metrics platform, compatibility layer, or new Service hierarchy was added. Local guides now identify the actual reuse seams.

The source-only discovery comparison used two fresh GPT-6 astra/high sessions with identical read/grep/find/ls tools and normalized prompts, randomized opaque assignment, and 640-path snapshots differing only in five Round 3 files. Complete tool paths stayed within the assigned snapshots. Both found valid reuse paths; the candidate example required fewer import steps. Tool-call counts of 33/29 do not establish efficiency or improved discovery success. One sample per condition, no CodeGraph, prompt-only scope restriction, missing copied role-registration files, and unexecuted partial code examples limit the claim. Native sessions received the same registered builder instructions separately. The comparison supports a local caller-burden observation, not an agent success-rate claim or a second code improvement.

The formal findings retain three pre-existing or adjacent follow-ups: Composer import-error visibility, failing operations Skill archive references, and an attention-route encoding candidate that still needs admitted-identifier verification. R6's eight baseline failures remain unresolved; no archive-byte equivalence, full-repository correctness, deployment, or release readiness is claimed. R8 does not unify the separate browser-safe pattern. No observed runtime divergence at R2's previously repeated request-ID sites is claimed.

Baseline and current HEAD remain bd582d6a53a20dce1c241896e6ff2224b955ed71 on codex/engineering-quality-pilot. No repository commit, index change, push, deployment, publication, or production data operation was performed. Fixture tests create their own disposable stores and Git repositories. Deliberate fault source copies were removed; patches, hashes, visible tool traces, and named outputs remain in the same-name temp/changes directory. Temporary probes do not become permanent test infrastructure. The Chinese work-package README links all proposals, plan history, measurements, raw opinions, and recommendations; lasting conclusions are curated in this record.

The final independent Auditor accepted R9/R10 and closeout with no blockers or overclaims. It independently reran 19 dashboard tests, 101 governance checks, document/lifecycle/index validation, and CLI regeneration and byte comparison. It checked A/B snapshot and prompt integrity and the load-bearing answer claims against source, but did not read every trace entry. It did not repeat the 46 CLI tests or every package typecheck/lint/build during closeout; those claims retain their producer output. Its prior overstatements about observed R2 semantic drift and private constants preventing public-schema behavior checks were explicitly retracted.

## Verification

Runtime: Node 24.18.0 and pnpm 10.33.3. Counts below overlap across rounds and must not be summed into a coverage claim. Original failed attempts are retained, including a fixture typing error and a test callback lint error corrected without dropping assertions.

| Surface | Exact check or bounded observation | Observed result |
| --- | --- | --- |
| Root governance | node --test tests/agents-root-contract.test.mjs tests/change-execution-contract.test.mjs tests/verification-instruments-contract.test.mjs tests/doc-model.test.mjs | 101 passed; exit 0 |
| Documents | node scripts/validate-doc-model.mjs; node scripts/validate-spec-lifecycle.mjs; node scripts/generate-doc-index.mjs --check | 284 documents valid; lifecycle valid; index current |
| Settings | pnpm --filter @openkit/web exec vitest run --no-cache --configLoader runner src/screens/settings/settings.test.tsx | 42 passed before/after |
| Core Client / CLI | pnpm --filter @openkit/core-client test; node --test tests/openkit-skill-interface.test.mjs tests/openkit-public-redaction.test.mjs | 88 client and 46 CLI tests passed; typecheck/lint/build also exit 0 |
| Composer | pnpm --filter @openkit/web exec vitest run --no-cache --configLoader runner src/screens/chat/chat.test.tsx src/screens/artifacts/artifacts.test.tsx src/primitives/primitives.test.tsx | 260 passed; one isolated baseline media-type fault detected |
| Document validator | node --test tests/doc-model.test.mjs; temporary differential fixture probe | 70 passed; 91 identical ordered diagnostic arrays; whole-document resolutions 1899 to 1164 and reads 1262 to 1164 in that probe only |
| Conversation routes | pnpm --filter @openkit/web exec vitest run --no-cache --configLoader runner src/app/Sidebar.test.tsx src/screens/chat/chat.test.tsx src/screens/workspace/workspace.test.tsx | 305 passed; two affected examples passed after fixture typing correction |
| Release parser | node --test tests/release-preflight.test.mjs | 28 passed; five isolated clause-removal faults each detected by its matching assertion |
| Release packaging | node --test --test-reporter=tap tests/release-preflight.test.mjs tests/package-release-assets.test.mjs | Before/after 33 passed, 8 failed, exit 1; failure identities and normalized messages identical. Six GNU-tar environment failures, two existing operations Skill reference failures. No archive equality observed. |
| Config schema | pnpm --filter @openkit/config-schema test --no-cache --configLoader native src/agent.test.ts src/agent-environment.test.ts | 62 passed; one isolated shared-pattern fault caused exactly two named failures and 60 passes; public export/schema projection hashes unchanged |
| Dashboard | pnpm --filter @openkit/nanocore exec vitest run --no-cache --configLoader runner src/thread-dashboard.test.ts src/workspace-dashboard.test.ts | 19 passed before/after; affected case passed after callback lint correction |
| Package checks | pnpm --filter @openkit/web, @openkit/core-client, @openkit/config-schema, and @openkit/nanocore with each package's typecheck, lint, and build scripts in its round | Final named checks exit 0; existing Web/config lint information and NanoCore warning remain |
| Integration CLI | pnpm build:openkit; cmp against accepted pair-01-after CLI bytes | Rebuilt after R8; byte-identical |
| Containment | git diff --check; per-pair before/after SHA manifests and source diffs | Passed; named scopes frozen for independent assessment |

Raw command lines, versions, outputs, failure details, and independent reruns are retained under temp/changes/202609220000000001-engineering_quality_pilot. The score correction and limited discovery result are evidence about the method itself: use case-specific observations and proportionate independent scrutiny; do not adopt this pilot's fixed round count, role schedule, or scores as a universal workflow.
