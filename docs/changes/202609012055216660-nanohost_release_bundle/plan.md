---
type: change-plan
status: in-progress
started: 2026-09-01
branch: codex/phase1-release-baseline
---
# NanoHost Release Bundle

## Intent Epochs

### Intent Epoch 1 — 2026-09-01 — Phase 1 release artifact delivery

- **Outcome:** Make NanoHost an installable and verifiable `linux/amd64` release asset and include that asset in the existing immutable OpenKit tag workflow beside the App, Worker, and end-user `openkit` Skill.
- **Non-negotiables:** Keep one NanoHost Rust binary and the existing stock OpenShell `v0.0.99` Gateway; reuse the current tag identity, GitHub Release, checksum, retry, and post-publication owners; add no backward compatibility, cross-build framework, release service, deployment state, or package registry; do not reboot A1, restart the Codex App Server, or start, stop, or restart the current OpenKit deployment during development or verification.
- **Acceptance:** A deterministic bundle named `openkit-nanohost-<tag>-linux-amd64.tar.gz` contains the NanoHost binary, checksum-verified pinned Gateway, current systemd unit, installer, manifest, and repository license; the installer verifies bytes before writing its fixed destinations; release preflight and workflow tests reject missing or inconsistent NanoHost inputs; the tag workflow builds and verifies the bundle, includes it in `SHA256SUMS` and GitHub Release creation, and downloads and verifies it after publication.
- **Effect boundary:** Repository files, temporary local packaging directories, and read-only upstream release inspection only. No tag creation or push, GitHub Release publication, package-visibility mutation, host provisioning, service lifecycle effect, or A1 runtime effect is authorized by this plan.
- **Completion truth:** R002 may close after the installable artifact and its focused gate are accepted. R004 remains open until an engineer authorizes one exact tag after merge and the real tag workflow publishes and verifies the complete release.

### Intent Epoch 2 — 2026-09-01 — Correct the target and distribution authority

- **Reframe trigger:** Independent verification found that A1, the current NanoHost binary, the host manifest, and the accepted OpenShell pin evidence are all `aarch64`; the proposed `linux/amd64` target had no present consumer or accepted owner, and a second release-input manifest would duplicate the existing pin authority.
- **Outcome:** Deliver the first NanoHost distribution for the real `linux/arm64` consumer, amend the NanoHost specification to own the artifact and minimal installer contract, retain the existing OpenShell pin manifest as the only external checksum owner, and reuse one executable release-asset verifier before and after publication.
- **Non-negotiables:** Preserve the original tag/publication owners; use an official native arm64 GitHub-hosted runner; add no cross-build framework, self-hosted A1 runner, second pin manifest, service manager, deployment state, or compatibility path; do not reboot A1, restart the Codex App Server, start or stop the current OpenKit deployment, or execute any current-host service lifecycle command.
- **Acceptance:** A reproducible `openkit-nanohost-<tag>-linux-arm64.tar.gz` contains an AArch64 NanoHost binary that passed a side-effect-free `--version` observation, the checksum-verified pinned Gateway, the unit, installer, OpenKit license, upstream OpenShell license and third-party notices, a generated projection manifest, and inner checksums; the installer rejects corruption, wrong ELF architecture, and missing fixed binary prerequisites before its first write; the same verifier accepts the intact asset and rejects deliberate corruption in focused tests, CI packaging, and post-publication verification.
- **Completion truth:** R002 closes only after the built binary, real bundle, staging-root installer, readiness output, and focused gate are accepted. R004 remains open until an engineer authorizes one exact tag after merge and the real tag workflow publishes and verifies the complete release; R001 remains open until its separate fresh no-host-reboot gate succeeds.

### Intent Epoch 3 — 2026-09-01 — Separate live readiness from staging evidence

- **Reframe trigger:** Second-round review accepted the arm64 direction but found that the plan still inverted specification versus pin-projection authority, conflated live-host prerequisites with amd64 `DESTDIR` verification, left license filenames ambiguous, lacked a pre-publication real-artifact A1 path, and did not bind upstream license bytes to retained identity.
- **Outcome:** Keep version and supported-target authority in the NanoHost specification, extend the existing pin evidence projection with the OpenShell source commit and license digests, give every bundled license a unique fixed path, and define live-root and staging installer semantics that cannot be confused.
- **Installer boundary:** Default live-root installation and `--check` both require an `aarch64` host and fixed runtime prerequisites before any write; `--check` performs no writes. Staging is enabled only by an explicit absolute `DESTDIR` other than `/`, writes only below it, skips host-only readiness checks, and must report that it proves filesystem projection rather than live readiness.
- **Real-artifact acceptance:** Before R002 closes, build the actual NanoHost binary natively on A1, run its side-effect-free `--version`, package it with the real checksum-pinned Gateway and commit-bound license bytes, run live `install.sh --check`, stage-install under a temporary `DESTDIR`, and compare installed bytes. This path must not call `systemctl`, start or stop a service, restart the host, restart the App Server, or affect the current deployment.
- **Completion truth:** Fixture checks decide implementation logic but cannot alone close R002. The retained A1 real-artifact result plus focused checks and independent acceptance close R002; R001 and R004 keep their separate runtime and publication gates.

### Intent Epoch 4 — 2026-09-01 — Close staging escape and evidence applicability

- **Reframe trigger:** Third-round review found that an absolute textual `DESTDIR` can still canonicalize to `/` or traverse symlinked ancestors into live paths, and that an A1 artifact result without an exact final-candidate commit requirement could become stale after a later artifact-affecting edit.
- **Staging containment:** Staging accepts only an absolute path whose canonical form is non-root and textually identical to the supplied normalized path, does not yet exist, and has no symlink in any existing ancestor. The installer creates the private staging root and every destination directory itself before writing; traversal forms, repeated-root forms, existing roots, symlink roots, and symlink ancestors fail before writes.
- **Evidence applicability:** The A1 real-artifact gate runs against the exact final candidate Git commit after all artifact-affecting changes, records that commit and input identities, and must be rerun after any change to the binary source or lock/toolchain, pin projection, service unit, installer, packager, verifier, workflow, or bundled license bytes.
- **Completion truth:** No fixture or stale A1 artifact can close R002. Only focused containment checks plus an applicable exact-final-commit A1 result and independent acceptance may close it.

### Intent Epoch 5 — 2026-09-01 — Make live preflight truthful on occupied A1

- **Reframe trigger:** Review of the actual authority diff found that A1 already has files at all three fixed live destinations and the required `--version` edit changes NanoHost bytes, so a zero-write A1 `--check` cannot truthfully report installable; the same review found missing `/usr/bin/docker`, live symlink containment, and observable temporary-file retry semantics.
- **Live preflight:** Add the execution-host-manifest-owned `/usr/bin/docker` identity to fixed prerequisites. `--check` separately reports host/package readiness and one closed destination disposition: `installable`, `already-installed`, `resumable`, or nonzero `destination-conflict`. Existing live destinations and their existing ancestors must be regular non-symlink paths.
- **Retry and residue:** Missing live files stage through one fixed adjacent reserved temporary path per destination. Caught failure cleans only temporary files created by that invocation; an exact regular temporary file left by interruption may be reused when its bytes and mode match the current payload, while a mismatched, non-regular, or symlink temporary path fails closed. Retry is decided only by the current three payload bytes/modes and the observed destination/temp bytes/modes, not by an unobservable bundle identity.
- **A1 acceptance:** The exact-final-commit A1 gate requires package and host prerequisites to pass, accepts the expected nonzero `destination-conflict` caused by the installed earlier NanoHost bytes as truthful evidence, proves no live destination changed, and then proves the real bundle through a new contained `DESTDIR`. It never overwrites the current installation or claims that A1 is ready to install the candidate live.

## Accepted Owners

- `docs/specs/20260802-nanohost_runtime_and_transport.md` owns the fixed OpenShell version and supported runtime target but currently excludes operator installation; this change must amend it before implementation so that it also owns distribution artifact contents, fixed prerequisites, and the minimal installer effect boundary.
- `docs/specs/20260829-release_management.md` owns product tag identity, release composition, publication authorization, retry, and post-publication verification.
- `apps/nanohost/README.md` owns NanoHost build and operator installation procedure; `docs/cookbooks/release.md` owns the maintainer release procedure.
- `apps/nanohost/openshell-pin/manifest.md` remains the unique evidence/input projection of the specification-owned OpenShell version and target, consumed archive and executable checksums, source commit, and redistributed license-file checksums; packaging and preflight mechanically consume its single JSON block instead of creating a parallel manifest.
- `scripts/package-release-assets.mjs`, a single extracted release-asset verifier, `scripts/release-preflight.mjs`, root `package.json`, and `.github/workflows/ci.yml` realize the release gate without owning design.
- `docs/roadmap.md` records outcome status but does not redefine any behavior above.

## Current Facts And Gaps

- The existing release workflow already prepares, promotes, retries, records, and verifies release images and the portable Skill archive.
- Release Management currently excludes NanoHost and forces prerelease-only tags because no NanoHost distribution artifact exists.
- NanoHost already builds as one Rust binary and has one systemd unit, but the repository has no release bundle, installer, generated bundle metadata, packaging command, or tag-workflow job for it.
- A1 and the current NanoHost binary are AArch64, and the current pin manifest already records the accepted `v0.0.99` AArch64 Gateway archive and extracted executable checksums.
- NanoHost currently has no harmless identity mode; its normal entry path immediately begins runtime initialization, so R002 needs a small side-effect-free `nanohost --version` path and regression.
- The OpenShell `v0.0.99` tag resolves to commit `8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032`; its Apache-2.0 `LICENSE` has SHA-256 `b967d1c87b93b7d61ebcf4f8737e6ad79e5433e743e49dff395a36fb3c327047`, and its `THIRD-PARTY-NOTICES` has SHA-256 `8c35aead093cbdfb3e11345d88cf2cb179f86391e859e4a7bc11539a0cc601f8`.
- GitHub provides the native `ubuntu-24.04-arm` hosted runner, while the repository test-environment image is amd64-only; the smallest native build is therefore a dedicated tag-only arm job that hands its binary to the existing portable-assets job.
- Release Management currently overstates R001 evidence and the stable blocker. This change must reconcile it with Roadmap and the open R001 gate rather than reusing the stale claim or removing the prerelease-only guard.

## Design

### One Specification Owner, One Pin Projection, And One Generated Projection

Keep the OpenShell version and supported target in the NanoHost specification. Extend the existing JSON evidence block in `apps/nanohost/openshell-pin/manifest.md` with the observed source commit and both redistributed license-file digests, then consume that single block as the only external evidence/input projection. Preflight and packaging reject a missing, duplicate, malformed, specification-mismatched, or checksum-invalid block; no second durable release manifest is added.

The first and only admitted distribution is `linux/arm64`, built for the real A1 class on a native arm64 hosted runner. The bundle's `MANIFEST.json` is a generated projection of the exact tag, target, included files, prerequisite names, and pin facts; it is not an independent authority.

### Side-Effect-Free Binary Identity

Add the smallest early `nanohost --version` branch before configuration, enrollment, networking, storage, or process startup. A focused Rust regression proves that it prints the Cargo-owned version and exits successfully without requiring runtime environment.

### Deterministic Bundle

Add one NanoHost-owned packaging path that accepts an exact release tag, built NanoHost binary, downloaded Gateway archive, repository root, and output directory. It parses the existing pin evidence, validates both Gateway checksums, rejects unexpected archive shape or non-AArch64 ELF inputs, creates one fixed tree, writes the generated manifest and inner checksum file, and produces a byte-reproducible tarball using fixed order, modes, mtime, owner, group, and gzip metadata.

The bundle contains exactly `nanohost`, `openshell-gateway`, `openkit-nanohost.service`, `install.sh`, `MANIFEST.json`, `SHA256SUMS`, `licenses/openkit-LICENSE`, `licenses/openshell-LICENSE`, and `licenses/openshell-THIRD-PARTY-NOTICES` beneath one tag-and-target-prefixed root. No config secret, environment file, OpenShell CLI, Supervisor image, Image Store content, runtime evidence, or source tree is included.

The installer uses standard host tools and always validates every inner checksum and both AArch64 ELF identities before its first target write. Default live-root installation also validates `uname -m` as `aarch64`, fixed `/usr/bin/containerd` and `/usr/bin/dockerd`, exact execution-host-manifest-owned `/usr/bin/docker` and `/usr/bin/slirp4netns` identities, and the systemd host prerequisite before writing to fixed live paths. Every existing live destination and ancestor must be a regular non-symlink file or real non-symlink directory as applicable.

`--check` runs the same package and host prerequisite checks without writing or invoking `systemctl`, then reports host readiness separately from one closed mutually exclusive destination disposition: `installable` when all destinations and temporary paths are absent; `already-installed` when all destinations match and all temporary paths are absent; `resumable` when every destination and temporary path is absent or exact but the state is neither of those first two cases; or nonzero `destination-conflict` otherwise. A conflict does not erase the successful prerequisite observation or claim installability.

Staging accepts only an absolute `DESTDIR` whose canonical normalized form is textually identical and not `/`, which does not yet exist, and whose existing ancestors are all real directories rather than symbolic links. The installer creates that root with private permissions and creates every descendant destination itself before writing; `/tmp/..`, `//`, lexical traversal, existing roots, symlink roots, and symlink ancestors fail closed before the first write. Staging skips host-only architecture and runtime readiness checks that are irrelevant on the amd64 verifier and reports `staged-only` rather than installed-ready.

Each missing live destination uses one fixed adjacent reserved temporary path. A caught failure removes only a regular temporary file created by the current invocation; an exact regular temporary file left by an uncatchable interruption may be reused when its bytes and mode match the current payload, while any mismatched, non-regular, or symlink temporary path fails before destination mutation. Existing exact destination bytes/modes and exact temporary bytes/modes are the complete retry oracle; no bundle-level retry identity or durable installer state exists.

No mode enrolls NanoHost, writes credentials, creates deployment identity, pulls deployment images, calls `systemctl`, or starts a service. Live completion output distinguishes installed artifacts from unresolved configuration, enrollment, image, and service-start steps; staging output makes no live readiness claim.

### Existing Release Workflow Extension

Add one tag-only build job on the official `ubuntu-24.04-arm` runner. It reads the exact Rust version from `apps/nanohost/mise.toml`, installs that toolchain with rustup, builds the locked release binary natively, runs `nanohost --version`, and uploads only the raw NanoHost binary for the existing portable-assets job; it does not use A1, a self-hosted runner, the amd64 test image, or a cross-build framework.

Keep the Skill packager unchanged except for combining final portable checksums when necessary. The existing portable-assets job downloads the native binary artifact, downloads the Gateway and license inputs from their exact pinned identities, verifies every retained digest, invokes the NanoHost packager, and runs the shared verifier in explicit `DESTDIR` mode without executing the foreign-architecture binary.

GitHub Release creation uploads both portable archives plus their one `SHA256SUMS`. Release notes name the NanoHost target and checksum and replace the obsolete statement that NanoHost is absent with the truthful R001 runtime limitation. The amd64 post-publication job downloads the complete attachment set, verifies the checksum file, runs only the explicit `DESTDIR` path, and compares the installed bytes with the verified bundle; it does not claim live readiness or start a service.

Extract one executable release-asset verifier used by focused tests, the packaging job, and the post-publication job. It verifies outer checksum membership, exact archive tree, generated-manifest consistency, inner checksums, AArch64 ELF identity, explicit newly created staging installation, installed bytes, and `staged-only` output; its focused test also corrupts one bundled byte and proves rejection before any destination is created or changed. Separate focused installer checks drive the live-root branch with a fake command environment; prove architecture, `/usr/bin/docker`, other prerequisite, destination, ancestor, and reserved-temp failures occur before writes; prove caught cleanup and exact interrupted-temp resume; and prove traversal and symlinked staging roots or ancestors cannot write outside `DESTDIR`.

Preflight keeps stable tags blocked until R001 closes. It additionally rejects missing or inconsistent NanoHost distribution inputs and requires the installer, unit, distinct license paths, and the single accepted pin evidence block used by packaging.

## Lowest-Sufficient Regression

Before implementation, add or extend focused Node tests with these expected failures:

- Release preflight currently accepts fixtures with missing or invalid NanoHost distribution inputs and OpenShell pin evidence; the new check must reject them without introducing a NanoHost release manifest.
- NanoHost currently cannot return its version without runtime initialization; the new focused regression must fail until `--version` exits before side effects.
- The current packager cannot produce the required bundle twice with identical bytes, reject non-AArch64 inputs, or prove intact, host/prerequisite failure, live destination/temp containment, cleanup/resume, canonical newly created staging, traversal/symlink rejection, and deliberately corrupted installer paths.
- The current workflow test proves only the Skill archive is uploaded and verified; it must fail until the NanoHost tarball and combined checksum are wired through packaging, GitHub Release creation, and post-publication verification.

## Verification

- Run the focused NanoHost version, release preflight, packaging, verifier, and workflow tests and record exact counts.
- Run the packager twice against fixed AArch64 fixture executables and assert byte-identical tarballs; verify both checksum layers, the exact tree, distinct license paths, canonical newly created `DESTDIR` bytes, staged-only output, a disposition table proving exactly one result for all-absent, all-installed, partial-or-temp-residue, and conflicting states, live-host architecture/prerequisite rejection including `/usr/bin/docker`, live destination/ancestor/temp symlink rejection, caught cleanup, interrupted-temp resume, traversal escape rejection, and deliberate corruption-before-write.
- Before accepting the pin-projection edit, re-confirm the lightweight `v0.0.99` tag's commit and the two license-file bytes from a complete non-shallow upstream clone as required by the existing realization gate, then compare their retained SHA-256 values with the commit-bound downloads.
- After every artifact-affecting repository change is committed, on A1 build the actual NanoHost binary from the exact final candidate `HEAD` with the pinned toolchain, run `--version`, package it with the real pinned Gateway and commit-bound license bytes, run the real bundle's live `install.sh --check`, retain successful package/host prerequisite observations plus the expected nonzero `destination-conflict`, prove the three live destinations unchanged, let the installer create a new canonical temporary `DESTDIR`, and compare installed bytes; retain the exact Git commit, clean relevant-path predicate, commands, input identities, checksums, output, and no-lifecycle predicate as R002 evidence, and rerun it if any artifact-affecting path changes.
- Run `pnpm release:preflight -- --tag v0.1.0-rc.1` against the repository.
- Run focused documentation and repository checks for changed specs, cookbook, workflow, package scripts, and generated index.
- Run the existing release gate only if the touched release boundary requires it after focused checks pass; record unrelated baseline failures without absorbing their repair.
- Do not run `host:nanohost:bring-up`, the R001 A1 host runner, `systemctl`, host reboot, service start, stop, or restart, current App Server lifecycle command, container lifecycle command against the current deployment, or real tag publication. The R002 A1 real-artifact command may only compile, inspect, package, run installer `--check`, and write beneath a newly created temporary `DESTDIR`.

## Independent Acceptance

- The first independent Verifier returned `Reframe`; the first Reviewer and Auditor returned `BLOCK` because the amd64 target, duplicate manifest owner, installation authority, R001 truth, architecture checks, redistribution notices, deterministic claim, and deciding verifier were not yet sound.
- After Intent Epoch 2, the same external Fable consultant returned `AGREE` and the registered Verifier returned `ACCEPT`; the Reviewer and Auditor returned `BLOCK` on staging semantics, license paths, authority wording, a stale regression, real-artifact acceptance, and pinned license bytes, producing Intent Epoch 3.
- After Intent Epoch 3, the same external Fable consultant and Auditor returned `AGREE` and `ACCEPT`; the Reviewer and Verifier found the staging traversal/symlink escape and stale A1 evidence applicability gaps, producing Intent Epoch 4.
- After Intent Epoch 4, the same external Fable consultant returned `AGREE`, and the registered Verifier, Reviewer, and Auditor each returned `ACCEPT`; the plan-stage authority, containment, evidence-applicability, and no-lifecycle gates are accepted.
- The required post-compaction fresh-context direction check returned `Reframe` only because this plan still described those completed acceptances as pending; this checkpoint correction changes the next action to the accepted three-file authority slice before implementation.
- After the NanoHost and Release Management specification edits, independent Reviewer, Verifier, and Auditor acceptance is required again before implementation because those files own the public artifact and stable-release truth.
- The first actual authority-diff review returned `BLOCK`/`REFRAME` on occupied-A1 `--check`, missing `/usr/bin/docker`, live symlink containment, bundle-level retry identity, and temporary-file cleanup/recovery, producing Intent Epoch 5.
- After Intent Epoch 5 and the mutually exclusive disposition correction, the same Fable consultant returned `AGREE`, and the registered Reviewer, Verifier, and Auditor each returned `ACCEPT` on the actual NanoHost spec, Release Management spec, pin projection, and generated index diff.
- After implementation, a producer does not accept its own output. Independent review inspects the actual diff and named focused evidence; a fresh verifier is used if implementation changes the accepted design or leaves a material uncertainty.

## Commit And PR Boundary

- Keep authority-bearing specification and change-plan edits in a coherent design commit before production workflow implementation, while preserving the append-only Intent Epoch history.
- Keep the lowest-sufficient failing tests before or with the implementation commit according to the repository hook and review constraints; no failing commit is pushed as a finished branch state.
- Push only `codex/phase1-release-baseline` and create one PR for the R002 artifact plus R004 release-workflow support.
- Do not create or push a release tag. After merge, exact-tag authorization and real publication are a separate external-effect decision and evidence cycle.

## Rewritable Checkpoint

- **Facts:** The complete authority slice is accepted by Fable and the registered Reviewer, Verifier, and Auditor; pin JSON parsing, the 209-document model, generated index, and diff checks pass; complete upstream checkout evidence confirms the source commit and license digests; R001 remains in a separate Draft PR; no service lifecycle command has run in this phase.
- **Unknowns:** The smallest existing test helpers that can construct valid AArch64 fixture bytes and reproducible archives without a new dependency, and whether workflow composition can reuse the current portable-assets job without coupling its amd64 test image to native execution.
- **Method:** Perform the required fresh direction check, commit the accepted authority slice, assign one test writer to the lowest-sufficient regressions, then implement the smallest NanoHost version, installer, packager, shared verifier, preflight, and workflow changes under non-overlapping ownership.
- **Frontier:** Authority is accepted and ready for its coherent design commit; production implementation remains unopened.
- **Predicted Next Action:** A fresh Verifier will decide whether the accepted authority commit and test-first implementation still advance the current Intent; on `Continue`, the authority commit and focused failing regressions are next, with no runtime or external effect.
