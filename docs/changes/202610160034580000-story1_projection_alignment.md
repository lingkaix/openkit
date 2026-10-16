---
type: standalone-change
status: implemented
date: "2026-10-16"
branch: rc8/p14-story1-projection
---
# Story 1 Projection Alignment

## Intent And Boundary

The coordinator requested P14-STORY1 on 2026-10-16: align the first-install story with its accepted dedicated-development-machine scene and retained installation. This change edits that story, its local catalog summary, and this admission record. It changes no owner, other story, product code, or Actor solution. It performs no story run, account operation, host operation, reset, or deployment.

## Accepted Owners

- [L6 Story Acceptance, Catalog and Admission](../specs/20260529-l6_story_acceptance.md) requires story 1 on the dedicated development machine using the public repository and release assets, without a source checkout in use or a disposable VM, and retains the installation.
- [Persistent Deployment Acceptance, Release Update And Qualification Projection](../specs/20260909-persistent_deployment_acceptance.md) projects the same scene.
- [Release Management, Catalog Stories](../specs/20260829-release_management.md#catalog-stories) owns the release deployment scope.

## Entry Gate And Acceptance Observations

Admission is re-decided for this revision. A competent Actor who receives only the operator persona and the ask to install the published release and show readiness can satisfy all three existing predicates: serving through health and Web, ready diagnostics with no blockers, and a ready runtime target when configured. These are product outcomes with named public observations. No predicate fixes a call sequence, count, order, retry policy, or implementation. The optional runtime predicate remains optional. Stage-manager preparation and evidence collection do not enter the Actor task payload. This preserves the distinct L6 risk: whether an unconstrained operator can complete a first install from public release material. Image smoke and host-requirement checks remain lower-layer mechanical proofs; they do not establish that user outcome.

Before editing, the story contradicted its catalog by requiring a disposable host and its destruction. The revised story prepares an empty selected installation scope, fences an earlier installation without deleting it or unrelated state, and retains the new deployment, its data, credentials, and evidence. The Actor ask and all outcome predicates are unchanged. Environment failures refer to the actual development-machine scene and cannot replace product adjudication after the ask and evidence collection complete.

## Verification And Review Boundary

The required check is `pnpm run check:repo` on the committed head through the coordinator's single-slot runner. Its output and an independent read-only exact-head reviewer report are retained externally under the P14-STORY1 evidence label. This record does not claim an unobserved check or review result. The final coordinator report supplies the exact head, check result, review verdict, and branch range. No L6 execution occurred, so no Actor or Judge product verdict is claimed; the independent reviewer rechecks artifact admission and owner alignment.

Three repository files change; no owning document changes, no product owner is added, and no closed set or registry is added. The two existing specification projections and the release owner remain authoritative. There are no known unresolved design choices in this projection correction. Implementation is complete; check and independent review remain pending at this recorded snapshot.
