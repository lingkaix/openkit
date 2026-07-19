# L6 Execution Role Separation And Adjudication Contract

Type: change-plan

Status: verified

Started: 2026-07-19

Completed: 2026-07-19

Branch: `codex/self-improvement-loop-foundations`

## Intent

Make L6 story acceptance a measurable instrument rather than a self-graded ritual: separate the execution roles so verdicts are independent of run knowledge, make every product verdict reproducible from a durable evidence package, give non-blocking findings a lifecycle, require baseline stability before a story counts as evidence, and make the story artifact contract mechanically checkable.

## Motivating Findings

- The story artifact contract's body section list was enforced nowhere: three of six committed stories matched it, `openkit-agent-skill-progressive-discovery` used `User-Visible Flow` and `Acceptance Assertions`, `nanocore-restart-reconnection` had contracted to five ad hoc sections, and `Evidence To Collect` was a de facto standard section absent from the contract. Drift accumulated inside the layer whose purpose is catching drift.
- Agent-first semantics let the story-reading agent act as the user, so an executor that knows Expected Outcomes in advance cannot detect discoverability failures; the progressive-discovery story avoided this only accidentally, because its entrypoint is itself an agent surface.
- The run orchestrator adjudicated its own run: setup knowledge contaminated verdicts, verdicts were not reproducible from retained evidence, and evidence was deleted after being recorded, which forecloses re-adjudication and review calibration.
- The prior contract carried a verdict-shaped assertion ("the run executes and passes") and no baseline repeat-stability requirement, so per-story noise was invisible.

## Decisions

1. Agent-first execution separates orchestrator, actor, and judge. The actor receives only the persona and the user ask; the verbatim actor prompt enters the evidence package. The judge adjudicates in a clean context from the story text and the evidence package only, with no tool or environment access.
2. Verdict authority is split along the existing typed classifications: the judge owns `passed`, `failed`, and `inconclusive`; the orchestrator owns `skipped`, `environment_failure`, and `tool_failure` and records the judge's verdict without arbitration. Once the actor completes the user-visible flow and evidence collection succeeds, non-product classifications are no longer available.
3. The evidence package must let an independent judge with no run memory reproduce the product verdict. A judge that cannot decide a required assertion returns `inconclusive` naming the missing evidence, which is a story defect that tightens `Evidence To Collect`.
4. `failed` and `inconclusive` runs retain the full redacted transcript and evidence package for one release cycle; `passed` runs retain the summary plus a small sampled fraction of full packages for re-adjudication and review calibration.
5. Each agent-first run records four non-blocking friction scalars trended per story revision: actor tool calls, error-recovery retries, guidance loaded beyond the declared minimum, and elapsed time. Every recorded subjective finding is linked to a change record or product issue, or explicitly waived with a reason.
6. A new or materially revised story becomes acceptance evidence only after consecutive consistent typed classifications: three runs without real-provider requirements, two for opt-in real-provider or real-Codex stories.
7. Story front matter gains a required `contracts` field naming the owning Core and specification documents, encoded as one comma-separated scalar line so the existing no-YAML-dependency metadata parser keeps working without a code change; a change to a listed document marks the story for review, and a missing document fails validation. The body section list is now normative for repository validation, split into required and allowed-optional sections including `Required Opt-in Environment Variables` and `Evidence To Collect`.
8. Every deterministic assertion must be an oracle over collected evidence or readable product records and name what decides it; verdict-shaped assertions are banned. For stories on strict surfaces the judge SHOULD come from a different model family than the actor.
9. Failure Triage Notes remain orchestrator work: diagnosis benefits from run context while judgment is harmed by it. Deterministic adapters evaluate assertions in code and are exempt from role separation.
10. The scalar front matter grammar is retained deliberately as a scope fence, hardened three ways: `parseStoryContracts` in `story-metadata.mjs` is the single owner of the comma-separated contracts convention; metadata validation rejects unknown front matter fields against the closed nine-field set; and `scripts/validate-story-schema.mjs` enforces the full artifact schema in `check:repo`. The switch trigger is normative in the L6 specification: if a second field ever needs structure, adopt a real YAML parser with a closed schema in one step instead of growing partial YAML syntax onto the scalar parser.

## Scope

Two slices under one record. Slice one revises the owning L6 specification and normalizes the six committed story artifacts to the revised contract without changing any story's product meaning: section renames, Expected Outcomes/Deterministic Assertions splits with evidence anchoring, `contracts` front matter, removal of two verdict-shaped or metadata-shaped assertions, checkpoint capture folded into `Evidence To Collect` for the pi-ai gateway story, and evidence-retention alignment in cleanup sections. Slice two implements the story schema validation authorized by the revised specification, test-first, inside the existing metadata owner and repository check chain.

## Non-Goals

- No new runner framework, evidence platform, or general agentic executor; role separation is an execution-semantics rule over existing runner ownership.
- No change to L6's opt-in, manually invoked gate posture or to the L1-L5 reduction rule.
- No product behavior change and no `docs/core/*` change; [Architecture](../core/architecture.md), [Work Model](../core/work-model.md), and [Foundation](../core/foundation.md) remain unchanged.
- Seeded-defect review calibration schedules and a spec-statement traceability index remain separate future proposals and are not authorized by this record.

## Design Ownership

- [L6 Story Acceptance Testing](../specs/20260529-l6_story_acceptance.md) owns all revised semantics: roles, adjudication authority, evidence package bar, retention, friction scalars, findings lifecycle, admission stability, and the normative artifact schema.
- [Test Strategy](../specs/20260529-test_strategy.md) is unchanged; it already delegates L6 detail to the owning specification.
- [Self-Improvement Evaluation Loop](../specs/20260710-self_improvement_evaluation_loop.md) is unchanged and cited as precedent: the work/judge separation invariant now governs both the product's evaluation loop and the repository's acceptance layer.
- [Change Tracking](../change-tracking.md) rules were followed for this record.

## Documentation Changes

- `docs/specs/20260529-l6_story_acceptance.md`: revised Owns, Summary, Story Selection, Story Artifact Contract, Agent-first Execution, Deterministic Execution, Lifecycle, Pass And Failure Semantics, Evidence And Security, Test And Release Policy, Current Implementation, Acceptance Predicates, Alternatives Considered (added rejected "Orchestrating Agent As Judge"), Deferred Questions, and Related Docs.
- `tests/stories/openkit-agent-skill-progressive-discovery.story.md`: contract sections, split outcomes/assertions with evidence anchors, `contracts` front matter, actor-prompt evidence, retention-aligned cleanup, removed the verdict-shaped assertion.
- `tests/stories/nanocore-restart-reconnection.story.md`: full normalization from five ad hoc sections to the contract, record-anchored assertions, added `Evidence To Collect` and `Cleanup`, `contracts` front matter.
- `tests/stories/openkit-local-self-check.story.md`, `tests/stories/worker-mcp-governed-tool-use.story.md`: `contracts` front matter.
- `tests/stories/pi-ai-gateway-real-provider.story.md`: `contracts` front matter; `Checkpoints` folded into `Evidence To Collect`.
- `tests/stories/task-mode-real-worker-release.story.md`: `contracts` front matter; removed the metadata-shaped assertion already owned by front matter.
- `tests/stories/README.md`: normative section list, `contracts` field documentation, checkpoint capture folded into `Evidence To Collect`, evidence-anchored assertion and no-verdict-assertion authoring rules, non-YAML grammar note, and the `check:repo` schema validation pointer.
- `tests/stories/AGENTS.md`: `contracts` added to required metadata fields, scalar-only rule retained, normative section list reference.
- `tests/story-runner/README.md`: updated file inventory for the hardened metadata owner and its repository-check consumer.

## Code Changes

- `tests/story-runner/story-metadata.mjs`: `contracts` added to required fields; unknown front matter fields rejected against the closed nine-field set; exported `parseStoryContracts` as the single owner of the comma-separated contracts convention; exported `REQUIRED_STORY_SECTIONS`, `OPTIONAL_STORY_SECTIONS`, and `validateStoryBodySections` with fenced-code-block awareness.
- `tests/story-runner/story-metadata.test.mjs`: tests added first for contracts requirement, unknown-field rejection, contracts helper behavior including empty-entry rejection, body section presence, membership, duplication, fenced-block handling, and full-corpus validation of every committed story.
- `scripts/validate-story-schema.mjs`: thin repository walker importing the metadata owner's rules; adds contract-reference existence and repository-unique story id checks; follows the `validate-spec-lifecycle.mjs` pure-function-plus-CLI pattern.
- `package.json`: `check:repo` runs `validate-story-schema.mjs` after spec lifecycle validation.

## Checkpoints

- 2026-07-19: Documentation slice landed: L6 specification revision, six story normalizations, local guide updates, and this record.
- 2026-07-19: A review of the `contracts` encoding against `tests/story-runner/story-metadata.mjs` found that a YAML list would break the deliberate no-YAML scalar parser and the deterministic story command; the field was re-encoded as one comma-separated scalar line and the one-step YAML switch trigger was made normative in the specification.
- 2026-07-19: Hardening slice landed test-first: contracts helper ownership, closed field set, body section validator, and the `check:repo` story schema validation.

## Verification

- All six story bodies contain only contract sections, checked by header extraction and by `validateStoryBodySections` over the committed corpus.
- All fifteen `contracts` references resolve to existing repository documents, enforced by `scripts/validate-story-schema.mjs`.
- `node --test tests/story-runner/*.test.mjs` passes with 49 tests, including 15 story-metadata tests; the new tests were confirmed failing before implementation.
- `node scripts/validate-story-schema.mjs` passes over the six committed stories; a negative fixture run confirmed detection of unknown sections, missing contract documents, and duplicate story ids.
- `node scripts/validate-spec-lifecycle.mjs` passes after the specification revision.
- Changed source lines respect the Biome 100-column format; the Biome binary for the verification sandbox platform was unavailable, so `biome check` should be rerun in a permitted environment before commit.
- The revised specification was reviewed as a full diff for internal consistency with the retained skip, gate, redaction, and anti-platform clauses.

## Remaining Follow-Ups

- Add orchestrator/actor/judge support to agent-first runner practice, including verbatim actor-prompt capture and judge invocation from the story plus evidence package only.
- Implement friction scalar extraction from existing run evidence and the retention sampling for passed runs.
- Record baseline stability runs for each committed story before its next use as acceptance evidence.
- Rerun `pnpm run check:repo` in an environment with the platform Biome binary before committing.
