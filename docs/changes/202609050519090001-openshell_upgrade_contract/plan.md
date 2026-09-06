---
type: change-plan
status: verified
started: 2026-09-05
completed: 2026-09-05
branch: codex/openshell-upgrade-contract
---
# OpenShell Upgrade Contract

## Intent Epochs

### Intent Epoch 1 — 2026-09-05 — Replace pin certification with dependency and integration maintenance

- **Outcome:** In an isolated worktree, first amend the owning specifications and add an OpenShell upgrade cookbook, then remove redundant pin evidence and add executable compatibility, backpressure, failure, and diagnostic checks; verify and merge the coherent change into the original `codex/r058-worker-mcp` branch.
- **Accepted decisions:** Trust matching official SDK, Gateway, and Supervisor releases for their own compatibility. Cargo owns the SDK source dependency; ordinary release metadata retains exact external artifact identity. Verify OpenKit's integration behavior, distinguish immutable correctness requirements from calibratable parameters, and diagnose candidate failures before changing configuration. Finite load tests do not prove an absolute memory bound; retain the smallest still-required source proof until an equally strong boundary exists.
- **Non-negotiables:** Preserve official stock components, current release version, existing runtime and security boundaries, English repository text, exact artifact checksums, unrelated work, and meaningful failing oracles. No backward compatibility matrix, automatic updater, threshold relaxation, new public configuration surface, or generic verification platform.
- **Acceptance:** Active specifications and cookbook agree; no active consumer depends on deleted evidence; focused tests exercise actual byte behavior, backpressure, cancellation, and failure diagnostics rather than only source strings; supported upgrade commands have truthful observed validation and distinguish real-stock execution from harness self-checks; release packaging still verifies exact artifact identity; an independent reviewer inspects the diff before commit and merge.
- **Effect boundary:** Local worktree files, ordinary local checks, disposable local test resources, read-only upstream inspection, Git commits, and merge into the original branch are authorized. This change does not authorize publication, an actual upstream version upgrade, or starting/stopping shared A1 services; any real-host qualification must name an admitted disposable subject and preserve the separate host noninterference gate.

## Owners

- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260829-release_management.md`
- `docs/verification-instruments.md`
- `docs/toolchain.md`
- `docs/documentation-model.md`

## Checkpoint

- **Base:** Worktree created at `009a4d90218bdeaab34f2403e23279835eeb0d49`; original branch is `codex/r058-worker-mcp`, now at `edc9e31f` with a concurrent integration-scoped readiness-poll fix.
- **Protected unrelated work:** The original checkout has modified `docs/changes/202609031230162442-r058_worker_mcp/plan.md` and untracked `docs/changes/202609050619490001-delegated_engineering_governance/plan.md`. Preserve both files and the concurrent readiness-poll commit during integration. Their observed SHA-256 values are retained in `temp/changes/202609050519090001-openshell_upgrade_contract/original-unrelated-before.json`; refresh immediately before fast-forward because their owner remains active.
- **Current facts:** All independent documentation, release, policy/bridge/evidence, and diagnostic reviews accepted the final artifact. The 40 old pin artifacts, historical certification test, and unused policy snapshot package are removed. Eleven immutable Git objects retain exactly three source files; the three bound groups include queue multiplicity (256 forward frames and 16 frames at each relay endpoint). Cancellation discards buffered bytes. The shared policy fixture checks the actual NanoCore producer and NanoHost SDK parser, including fail-closed trust-boundary validation. Release packaging and readiness consume ordinary release metadata.
- **Ownership:** All builders released their paths. The primary owns final integration and closeout; independent reviewers have no remaining actionable findings.
- **Method correction:** Independent probe review found that normalized-fact self-checks do not admit the concrete SDK/peer/cleanup stack as a deciding qualification instrument. The implemented opt-in probe is therefore retained only as an unadmitted diagnostic under `docs/verification-instruments.md` Oracle Classification; neither a successful run nor its self-check can release a candidate. Complete qualification still requires the real-stock observations and harness admission specified by the owner. No actual dependency upgrade is part of this change.
- **Unknowns:** No integration conflict or failing check remains. No live stock subject has been run or qualified.
- **Next action:** None within the accepted implementation scope. The reviewed foundation and concurrent fix reached the original branch, the merged checks passed, and the immediate pre/post-merge inventory proves unrelated bytes were preserved.

## Verification

- The pre-commit fresh-context check detected a newly created unrelated governance plan and returned `Reframe` solely to correct the protected-state inventory. The checkpoint and pre-merge byte inventory now include it; no reviewed implementation defect was found. The following fresh direction check returned `Continue` after verifying both hashes and the original branch head.
- Fresh-context direction checks returned `Continue` for the original implementation direction and the subsequent non-deciding diagnostic classification. Independent document, release, policy/bridge/evidence, and diagnostic reviews inspected the final artifacts and accepted them with no remaining actionable findings.
- Full `cargo test --locked`: 94 binary tests and two integration tests passed, zero failed, one opt-in live diagnostic ignored. Output: `temp/changes/202609050519090001-openshell_upgrade_contract/cargo-test.log`. `cargo clippy --locked --all-targets --all-features -- -D warnings`, Cargo format checks, and Cargo check passed.
- The eight bridge tests cover byte segmentation, genuine bounded-channel backpressure, cancellation, EOF/error, and local control admission under inference load. The intended cancellation red precedes the repair in `temp/changes/202609050519090001-openshell_upgrade_contract/bridge-tests/result.md`. Shared-policy parser rejection tests exposed relative-path and blank-host gaps before their correction.
- NanoCore policy and caller tests passed 32 tests; the final policy-only rerun passed nine. NanoCore typecheck, lint, build, and dependent builds passed. Source-assumption integrity and negative mutation cases passed.
- The final seven-file release suite in `openkit/test-env:env-c315cef6228d` passed 44 tests, including the verifier's Cargo mismatch rejection. The image build-input label is `c315cef6228dec0889f9e6075e51b3b5c4fede7dd1f91f17fc6708a523376dc8`. Output: `temp/changes/202609050519090001-openshell_upgrade_contract/release-linux.log`. Direct macOS packaging setup fails because BSD tar lacks the required GNU options; it is not a product PASS.
- Full `pnpm run check:repo` passed in the same repository image with the worktree and common Git directory mounted, validating 216 documents, the generated index, terminology, test governance, 968 Biome files, and the models catalog. Output: `temp/changes/202609050519090001-openshell_upgrade_contract/check-repo-linux.log`. Native Biome skips the worktree under the ignored `temp/` ancestor, and the ordinary image mount cannot resolve its external common Git directory; these setup limits were corrected by the explicit image mounts, without skipping checks.
- The diagnostic's four self-checks passed; its live entry remains ignored and unadmitted. No live-stock, saturation, global-memory, recovery, or A1 noninterference PASS is claimed.
- Implementation commit: `39fb54d1`. The worktree merged original commit `edc9e31f` without conflict; its readiness-poll code and R058 records remain byte-identical to that commit. Full merged Cargo checks passed 96 tests with one live diagnostic ignored, and merged `check:repo` passed (217 documents). Outputs: `temp/changes/202609050519090001-openshell_upgrade_contract/cargo-test-merged.log` and `temp/changes/202609050519090001-openshell_upgrade_contract/check-repo-merged-linux.log`.
- `git diff --check` and commit hooks passed. The original branch fast-forwarded from `edc9e31f` to integration commit `2e8cc8b2`; both unrelated files retained their exact immediate pre-merge SHA-256 values. Evidence: `temp/changes/202609050519090001-openshell_upgrade_contract/merge-back.json`.

## Remaining Work

No work remains for the accepted foundation and cleanup scope. A future OpenShell candidate adoption must independently admit the diagnostic harness and complete the owning specification's real-stock qualification; this change does not claim that adoption or qualification occurred.

## Closeout

The accepted owner amendments, upgrade cookbook, dependency cleanup, release-consistency checks, shared policy conformance, transport regressions, and explicitly unadmitted stock diagnostic are implemented in `39fb54d1` and integrated with the original branch in `2e8cc8b2`. The reviewed change removes redundant upstream certification while retaining exact release identity and the smallest source slice still needed for the opaque-buffer argument. The current OpenShell version remains `0.0.99`. No unresolved finding remains within this scope; the unperformed real-stock qualification and harness admission remain explicit future-candidate requirements in the owning specification and cookbook. No shared host service, publication, deployment, or upstream upgrade occurred.
