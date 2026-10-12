---
type: change-plan
status: planned
date: "2026-10-12"
started: "2026-10-12"
---
# L6 Story Reorganization

This plan records the 2026-10-12 reorganization of L6 stories and the release gate. It adds no design authority. [Foundation](../../core/foundation.md), [L6 Story Acceptance](../../specs/20260529-l6_story_acceptance.md), [Release Management](../../specs/20260829-release_management.md), [Persistent Deployment Acceptance](../../specs/20260909-persistent_deployment_acceptance.md), and [Test Strategy](../../specs/20260529-test_strategy.md) govern the work. [L6 story reorganization](../../decisions/20261012-l6_story_reorganization.md) records the accepted ruling. The [Release Cookbook](../../cookbooks/release.md) and [Persistent Live Acceptance](../../cookbooks/persistent-live-acceptance.md) project those owners.

## Intent Revision 1 — 2026-10-12

**Source and outcome.** Put the engineer's 2026-10-12 rulings into the owning specifications. A story states an outcome: one persona, one ask, a starting world, outcome predicates, perturbations, and named integrity invariants. The actor's public abilities stay available. Privileged channels do not. Suggestions sit beside friction and never enter the verdict. A defect reduces to the product cause. The release gate is the deterministic CI that Test Strategy assigns to the candidate and tag gates, then the ten catalog stories on the published prerelease. Worker qualification stays on the updated deployment before stable promotion. Stable publication promotes a passing prerelease's bytes and does not rebuild them. This entry is append-only under [Change Execution](../../change-execution.md).

The engineer's words are the quotations in the decision record, with their faithful English translations. They are not repeated here as a second authority. On telemetry, the engineer agreed to three data classes. Product facts never depend on OpenTelemetry. Operational telemetry uses OpenTelemetry. One evidence bundle per story run may contain a telemetry file, and that file never decides the verdict. The L6 owner states the bundle and one run-scoped Collector. This change writes no product code. Issues #219, #220, and #221 stay deferred until after RC4.

This change supersedes `docs/decisions/20261010-release_acceleration.md` whole. Exact-commit candidate CI reuse, publication-path proof for a changed publication job, the compact release record, the public parameterized runner, and sequential Worker groups carry forward. The exact-source image build and the container replacement over the existing Data Root leave the release gate. The helper's release-only contract stays. `scripts/release-product-inputs.mjs` loses its release obligation.

**Non-negotiables and exclusions.** Preserve publication integrity, tag and asset rules, digest and attestation rules, authorization gates, data continuity, evidence safety, and L6 role separation and falsifiers. Do not define the product integrity-check operation. Do not edit story files, the story validator, the release-round runner, `docs/product-vision.md`, or the untracked chat-task proposal. Do not edit the operational telemetry specification. The runner still contains the exact-source deploy path until a later package removes it. The tag workflow still builds on every tag, so stable promotion without a rebuild is not implemented and must be implemented before any stable release.

**Acceptance.** The named owners state the rulings, each rule has one owner, and the decision record holds the reason. Current Implementation stays truthful about the validator, the runner, the product-input script, the tag workflow, repository visibility, and the published prereleases. Focused document checks pass. The writer of this rewrite does not accept it. Story files and the runner are unchanged.

**Effect boundary.** Documentation only. No tag, publication, deployment, or GitHub write.

**Completion truth.** Opening this record proves no owner amendment is accepted by this plan alone. Status stays `planned` until an independent acceptor judges the diff.

## Checkpoint

The owner text and this plan are written. The story schema check still requires `User-visible Steps`. The release-round runner still deploys by exact source and still runs the old scenario rows. Stable promotion without a rebuild is specified and not implemented. Unknown: whether the later story package will fill the extraction gaps for stories 1, 2, 4, 7, 8, 9, and 10 without adding steps the actor must follow. Method: amend the owners in this change and leave code, validators, and story files to later packages. Frontier: document checks for this rewrite. Next action: an independent acceptor reads the diff. This writer does not accept it.

The catalog now carries the surviving criteria of Chat-Mode Exchange, Task-Mode Issue To Open Pull Request, Goal At The Shipped Scope, and External Agent Through Remote MCP. The story package expresses those criteria in story form. Base commit `32d3b950` of `docs/cookbooks/release.md` is only the source of that extraction.
