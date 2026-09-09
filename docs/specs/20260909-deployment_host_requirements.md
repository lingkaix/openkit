---
status: Accepted
implementation: Not Started
date: 2026-09-09
---
# Deployment Host Requirements

## Owns

- The supported host profiles for running NanoCore from source, running the NanoCore application image, running the packaged NanoHost, and co-locating the application image with NanoHost.
- The boundary between source-build dependencies, installed runtime dependencies, conditional capabilities, and non-binding resource recommendations for those profiles.
- The side-effect-free packaged-NanoHost requirement check, its machine-readable profile source, exact archive-and-machine binding, verdict vocabulary, and bounded failure semantics.

## Does Not Own

- Repository bootstrap commands, exact developer-tool versions, dependency installation, or generated-file maintenance, which are owned by `docs/toolchain.md`.
- NanoCore configuration, boot readiness, authentication, storage layout, listener configuration, or deployment-mode procedure.
- NanoHost archive contents, installer destinations and retry behavior, enrollment, Runtime Epoch lifecycle, readiness, containment, or real-host qualification.
- Container image contents, image-platform publication, release composition, scheduling capacity, or an operator provisioning recipe.
- A package manager, deployment runner, fleet inventory, host-certification database, or durable installation record.

## Core References

- `docs/core/foundation.md`
- `docs/core/architecture.md`
- `docs/core/runtime-model.md`
- `docs/core/sandbox.md`

## Related Specifications

- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260708-container_image_packaging.md`
- `docs/specs/20260829-release_management.md`

## Summary

NanoCore and NanoHost are separate deployment roles and may run on different machines. NanoCore may run from the repository on Linux or macOS, or as the repository application image through the Docker path qualified by OpenKit. NanoHost runs on `linux/amd64` or `linux/arm64`, uses OpenKit's Docker-specific private Runtime Epoch, and must run the exact target-matched OpenShell Gateway, SDK integration, and Supervisor release selected by the NanoHost owner. Upstream OpenShell support for macOS, Podman, MicroVMs, or other platforms does not admit those paths for NanoHost.

The packaged-NanoHost requirement check answers whether the profile's named static prerequisites for one exact NanoHost archive are observed on one Linux machine. NanoCore source and application-image dependencies remain guidance resolved through their existing machine-readable owners rather than inputs to this checker. The check is distinct from operator provisioning, installation outcome, NanoCore or NanoHost runtime readiness, and real-product qualification. `requirements-met` makes no startability, readiness, containment, capacity, support, qualification, or release-readiness claim.

## Decision

### Supported Profiles

| Profile | Supported host | Installed host dependencies | Source or image-build dependencies | Support boundary |
| --- | --- | --- | --- | --- |
| NanoCore source | Linux or macOS on x86_64 or arm64 | The exact Node and pnpm versions projected by the root machine-readable toolchain sources, installed workspace dependencies, writable configured data storage, and the configured listener and network reachability | Repository bootstrap and native build tools are the source path owned by `docs/toolchain.md`; they are not requirements for a separately built image | Starts NanoCore and Web from a checkout. Current direct observation covers Apple Silicon macOS; another admitted source-host target still needs its own exact check result. It does not supply Worker Agent execution without a reachable qualified NanoHost. |
| NanoCore application image | Linux on `linux/amd64` or `linux/arm64` | A functioning Docker Engine capable of running the selected Linux image, persistent writable storage for the configured data root, and the configured listener and network reachability | The Node, pnpm, compiler, Python, SQLite headers, Caddy, and init components declared by the application Dockerfile are image-build or image-contained dependencies; they are not host packages | OpenKit qualifies this profile through Docker. A compatible OCI format alone does not make Podman, Docker Desktop on macOS, or another engine supported without a repository qualification result. |
| Packaged NanoHost | `linux/amd64` or `linux/arm64` | systemd, unified cgroup v2, Linux mount and network namespace facilities, seccomp, the fixed executable Docker components and `slirp4netns` paths consumed by NanoHost, Docker Engine `28.0` or later, libc compatibility with both exact target-matched GNU/Linux executables, fixed runtime and persistent roots, and the privileges required later to create and fence the private Runtime Epoch | Rust, Node, pnpm, Cargo source dependencies, and packaging tools belong only to source build and release packaging. The installed host does not require Rust, Node, pnpm, or an independently installed OpenShell CLI. | The intended distribution set contains one target-matched archive per admitted architecture. The exact Cargo-pinned SDK and architecture-matched digest-pinned Supervisor are part of the same OpenShell `v0.0.99` integration. The current packager and live installer implement only arm64; that is an implementation gap, not the support boundary. |
| Combined small deployment | One `linux/amd64` or `linux/arm64` machine satisfying both the application-image and packaged-NanoHost profiles | The union of those two profiles, with distinct configured listeners and persistent roots and with the system Docker installation kept separate from NanoHost's private epoch runtime | Image construction and repository source build remain optional preparation paths, not installed runtime requirements | Runs NanoCore/Web and NanoHost on one machine. Runtime acceptance still has to prove the NanoHost noninterference, fresh-empty, transport, and readiness predicates owned by the NanoHost specification. |

The packaged NanoHost profile has one Docker realization. `/usr/bin/containerd`, `/usr/bin/dockerd`, `/usr/bin/docker`, and `/usr/bin/slirp4netns` are fixed because the current service invokes those paths directly. The checker observes compatible static prerequisites at those paths; exact Docker output or a `slirp4netns` package digest is evidence about one tested machine, not the portable support boundary. Podman is unsupported for NanoHost until a later accepted design supplies an implementation and real qualification. Native macOS NanoHost is likewise unsupported; a macOS NanoCore host reaches a separate qualified Linux NanoHost.

The `image.build` effect has an additional conditional requirement: Buildx `0.35.0` or later, BuildKit `0.31.0` or later, and the `exec.proxy` capability must pass the existing pre-effect check. A host may start the base runtime without proving this conditional capability, but it must reject `image.build` before a build effect when the check fails. Required deployment images are acquired and verified before NanoHost runtime readiness under the NanoHost owner; registry access is therefore not a host-start requirement.

OpenShell's upstream support matrix is an input, not OpenKit's product support owner. OpenKit consumes the upstream Docker `28.0` floor and the Gateway's glibc `2.28` floor for its pinned `v0.0.99` integration, then narrows the supported set to its Docker-specific Linux amd64 and arm64 targets. The Gateway floor alone is insufficient because each separately built NanoHost executable may require newer libc symbols. Packaging derives the maximum required symbol versions from both exact target-matched executables, and the host check observes loader compatibility with that derived requirement rather than hard-coding the Gateway floor as the complete package requirement. Upstream Podman, macOS, MicroVM, and Windows possibilities remain outside the OpenKit NanoHost profile.

### Resource Recommendation

For the initial combined small-deployment profile, begin with at least 2 available logical CPU cores, 8 GiB of available memory, and 30 GiB of available persistent storage before loading deployment images and Workspace data. This is an empirical operating recommendation, not a hard minimum, admission rule, capacity promise, per-process allocation, or storage reservation. Actual deployment images, build cache, retained Workspace data, and operating-system use may require more. The NanoHost Image Store's separately owned 200-GiB content bound is an eviction ceiling, not reserved capacity and not a replacement for measuring available storage.

A machine below the recommendation has recommendation observation `unmet`; that observation does not change a static hard-requirement verdict or real-product qualification. If a concrete required allocation, filesystem write, image import, process start, or owned runtime capacity proof fails, that owning operation fails truthfully and NanoCore or NanoHost remains non-ready as its existing owner requires. A split deployment does not divide or duplicate the combined recommendation: no independent per-role resource recommendation is qualified yet.

### Machine-Readable Requirement Sources

| Concern | Authoritative machine-readable projection |
| --- | --- |
| NanoCore source tool identities | Root `.mise.toml`, `package.json`, and the lockfile, interpreted only through `docs/toolchain.md` |
| Application image platform and content | `containers/images.json` and the selected Dockerfile, interpreted only through the container-image specification |
| NanoHost platform and host prerequisites | `apps/nanohost/deploy/host-manifest.json`, interpreted through this specification for requirement checking and through the NanoHost specification for archive projection |
| Pinned OpenShell integration | `apps/nanohost/openshell/release.json`, `apps/nanohost/Cargo.toml`, and `apps/nanohost/Cargo.lock`, interpreted through the NanoHost specification |

The target NanoHost host manifest uses `schemaVersion: 2` and contains `profileId`, the closed Linux architecture set `amd64` and `arm64`, ordered requirement entries with stable id, class, probe name, predicate, and positive timeout, plus the scoped resource recommendation. Requirement class is exactly one of `platform`, `service-manager`, `kernel`, `executable`, `version`, `libc`, or `filesystem`; probe names select repository-owned checker operations and never contain shell text. `profileDigest` is lowercase SHA-256 over the exact raw `apps/nanohost/deploy/host-manifest.json` bytes. The single profile admits both target architectures and must not encode one qualified machine's kernel release, full command inventory, exact Docker output, or `slirp4netns` digest as portable requirements. The exact profile bytes ship inside every NanoHost archive as `host-manifest.json`, covered by inner checksums. Each release `MANIFEST.json` carries the exact target architecture, profile id, and profile digest without copying the requirement fields.

The packaged-NanoHost static prerequisite set is closed for this profile:

| Capability | Required observation |
| --- | --- |
| Platform and service manager | Linux kernel on the selected `amd64` or `arm64` target; systemd is active; the archive unit parses successfully and uses unit and slice settings supported by that systemd. The unit and slice need not already be installed. Actual installation, group creation, and termination are later acceptance steps. |
| Process containment | Unified cgroup v2 is mounted; Linux mount and network namespace facilities are exposed; the configured service principal declares the privileges consumed by the fixed unit and binary. Actual namespace creation and complete cgroup fencing are runtime acceptance. |
| Kernel sandbox support | The kernel reports seccomp support. Landlock remains upstream-recommended and is not an OpenKit hard prerequisite without a selected hard-requirement policy mode. Actual OpenShell policy enforcement is runtime acceptance. |
| Container backend | Executable regular non-symlink `/usr/bin/containerd`, `/usr/bin/dockerd`, and `/usr/bin/docker`; Docker reports version `28.0` or later. That floor is an upstream prerequisite, while a fresh real-product run qualifies the selected observed Docker version and private cgroup-parent behavior. |
| Private networking | Executable regular non-symlink `/usr/bin/slirp4netns`; `/run/systemd/resolve/resolv.conf` is a readable regular non-symlink file with a syntactically usable resolver entry. Actual namespace attachment and tap networking are runtime acceptance. No exact package version or digest is the portable predicate. |
| Bundled executables | The exact target-matched NanoHost and Gateway pass archive integrity and ELF machine checks, and the host loader and libc satisfy the maximum symbol-version requirements derived from both exact binaries. |
| Filesystem | Every existing ancestor of the fixed live destinations is a real non-symlink directory with the required ownership and mode predicate; an installer-owned absent descendant is allowed. Actual destination creation, configured-root creation, and writes remain installer or runtime acceptance. Thirty GiB is evaluated only as the separate recommendation. |

The `image.build` requirements remain conditional and are checked only when that effect is selected. Actual namespace, cgroup, private-network, filesystem-write, image, NanoCore-reachability, noninterference, and readiness behavior is proved only by the NanoHost runtime acceptance owner. The static checker creates no runtime and claims none of those facts.

The current schema-version-1 host manifest and its installer, package verifier, host harness, and tests still enforce exact Docker and `slirp4netns` identities from one promoted machine. That is current implementation and retained historical evidence, not the target prerequisite contract. Replacing those projections is required before a schema-version-2 requirement verdict may be claimed. No previous `host-prerequisites=pass`, A1 result, or release candidate is retroactively a pass for the new profile.

### Requirement Check And Installation Boundary

The packaged-NanoHost requirement check is the bundled `install.sh --check-host` mode and is side-effect free. It reads only the archive's checksum-verified bundled `host-manifest.json`, rejects profile bytes whose SHA-256 differs from the profile digest in release `MANIFEST.json`, observes only the named Linux machine, places a time bound on every executable or filesystem probe, and emits one terminal hard-requirement verdict plus a separate recommendation observation. It never falls back to a repository or network profile and does not install or upgrade a package, create a destination, start or stop a service, load an image, enroll a NanoHost, write configuration, or claim runtime readiness.

The complete hard-requirement verdict vocabulary and precedence are:

- `requirements-met`: every mandatory static probe ran to completion and satisfied the exact profile.
- `requirements-unmet`: at least one completed probe proved that a mandatory platform, required executable, version predicate, path, or static prerequisite is absent or incompatible. A proved mismatch takes precedence when another probe also cannot be completed, while the result retains both per-requirement outcomes.
- `cannot-check`: no probe proved a mismatch, but at least one mandatory probe could not produce a bounded trustworthy observation because the inspection tool was unavailable, observation permission was denied, it timed out, its output was malformed, or observations were internally inconsistent. This fails closed and is never converted to `requirements-met`.

A required executable that is absent, not a regular non-symlink file, or not executable is `requirements-unmet`. Failure of an otherwise independent inspection tool or permission needed only to observe the predicate is `cannot-check`; it is not evidence that the runtime dependency is absent.

The separate recommendation observation is `met`, `unmet`, or `cannot-check`. It never changes the hard-requirement verdict. Unknown available memory or storage is not reported as zero, and total installed capacity is not substituted for available capacity.

The `--check-host` mode writes exactly one structured JSON object followed by one newline and no other stdout. The existing `--check` installation-disposition mode and default live installation reuse the same internal probe result but retain their separately owned installation output; neither prints a second host-check JSON object or implements another comparator. That object contains exactly `{schemaVersion, profileId, profileDigest, productCommit, archiveSha256, machineIdentityDigest, machineObservationDigest, checkedAt, hardVerdict, recommendationObservation, requirements}`. Each ordered `requirements` member contains exactly `id`, outcome `met`, `unmet`, or `cannot-check`, and bounded normalized `observed` facts or `null` when no trustworthy observation exists. Each member serializes keys in that order and the array follows manifest order. `machineObservationDigest` is lowercase SHA-256 over the exact compact UTF-8 JSON serialization of the complete ordered `requirements` array with no newline. `archiveSha256` is lowercase SHA-256 over the complete NanoHost archive. `productCommit` is required and verified against the archive's generated provenance.

`machineIdentityDigest` contains only lowercase SHA-256 over the exact bytes of `/etc/machine-id`; the raw platform installation identifier and hostname are forbidden. A missing or unreadable identifier is `cannot-check`.

The ordered requirement members retain the bounded non-secret facts needed to inspect and reproduce the verdict; their digest supplements and never replaces `machineIdentityDigest`. Changing the profile, product commit, archive bytes, selected platform installation, or any required observation makes the result stale. This result is verification evidence only; it is neither a product record nor a durable deployment authority.

Provisioning is a separate operator-authorized cookbook action that may try to make a requirements-unmet machine satisfy a profile. After provisioning, the complete requirement check runs again as a new result; it does not patch or resume the previous result.

The NanoHost installer then applies only the archive contract owned by the NanoHost specification. Its `installable`, `already-installed`, `resumable`, and `destination-conflict` dispositions and `installation=complete` or `installation=incomplete` outcomes remain installation facts. A partial install preserves the existing exact-byte, exact-mode, no-overwrite, invocation-owned cleanup, and safe retry behavior. It does not revise the earlier host verdict and never implies service start.

Runtime acceptance begins only after configuration, enrollment, required-image preparation, and service start. NanoCore readiness belongs to its bootstrap-readiness owner; NanoHost fresh-empty, containment, connection, capacity, and real-stock acceptance belong to the NanoHost owner. A passed requirement check and complete installation satisfy neither acceptance boundary.

## Lifecycle And Failure Semantics

1. Select one profile and immutable artifact. A missing, unknown, or contradictory profile is `cannot-check`.
2. Run the side-effect-free static probes and recommendation observation. Requirements-unmet and cannot-check outcomes stop automatic installation.
3. Perform any separately authorized provisioning, then create a new complete check result.
4. Run the archive installation path. A failed or partial install reports its own exact outcome and follows its existing bounded retry contract.
5. Configure and start the selected services, then run the separately owned runtime acceptance checks. Failure remains non-ready; the host-requirement result is not rewritten.

A host loses its prior requirement evidence when a bound input becomes stale. Ordinary runtime failure does not automatically prove static requirements unmet; it is classified by the runtime owner unless a repeated check proves a missing prerequisite. Unmet combinations have no fallback to an unqualified engine, architecture, service manager, or native NanoHost path.

### Requirement-Set Evolution

A requirement is added only by changing this owning specification and the affected machine-readable profile in the same accepted change, incrementing its schema version or profile id as appropriate, and producing a new profile digest. The change states which consumed implementation fact makes the predicate necessary and supplies a bounded probe and failure classification.

A requirement is relaxed only after implementation and qualification show the wider predicate is sufficient. Relaxation also creates a new profile digest. A host excluded by the old profile reaches `requirements-met` only after a fresh complete check against the new product commit, archive digest, and machine identity; the change does not rewrite its prior result or establish qualification.

A requirement or profile is retired only when no selected qualified product path consumes it or an accepted replacement owns the path. Retirement makes it unselectable for new installation, upgrade, or qualification claims. It does not stop a running service merely because documentation changed, but an already deployed host remains bound to its prior product commit and profile digest and cannot claim qualification for a product selecting the new or retired profile until it migrates, passes a fresh check, and passes its runtime qualification. Migration or decommission follows the existing runtime and operator owners; there is no silent fallback or automatic host mutation.

## Current Implementation Projection

NanoCore source startup, Docker application-image packaging for both Linux architectures, and the `linux/arm64` NanoHost archive exist. The repository machine-readable tool pins, image catalog, Dockerfiles, OpenShell release pin, and NanoHost schema-version-1 arm64 host manifest also exist. The pinned OpenShell metadata and NanoHost source contain target selection for amd64, but the NanoHost packager, live installer, archive-bundled schema-version-2 profile, manifest, CI job, and retained real-host evidence are incomplete or arm64-only; `linux/amd64` packaging and qualification are not implemented.

The target NanoHost prerequisite profile, `--check-host` mode, and result object are not started. Existing source tool projections, image catalog, archive verifier, installed-path checks, and schema-version-1 arm64 host manifest are current facts owned elsewhere and do not partially implement this new contract. Current installation and host assertion still require arm64 plus the promoted machine's exact Docker version string and exact `slirp4netns` version and digest. Acceptance of this design does not weaken those checks, implement amd64 packaging, or qualify another host; implementation must update all producers and consumers together and obtain fresh exact-product qualification per target.

## Acceptance Criteria

1. Documentation and machine-readable projections identify NanoCore source, application-image, packaged-NanoHost, and combined profiles without treating them as interchangeable.
2. Linux and macOS on x86_64 or arm64 are admitted for NanoCore source execution, the qualified application-image host remains Linux with Docker, and NanoHost targets Linux amd64 and arm64 and may be reached remotely from either NanoCore host platform.
3. NanoHost runs the exact OpenKit-pinned OpenShell Gateway, SDK integration, and Supervisor; an arbitrary installed OpenShell CLI or an upstream-compatible component set does not satisfy the profile.
4. Podman and native macOS NanoHost are not advertised as qualified, and current arm64-only packaging or A1 evidence is not advertised as the architecture support boundary or proof of `linux/amd64` qualification.
5. The combined 2-core, 8-GiB, 30-GiB recommendation cannot cause hard rejection, cannot be inferred per role, and remains separate from runtime capacity proof.
6. A requirement result is side-effect free, bounded, fail-closed, one-JSON-object framed, and bound to one exact profile, product commit, archive digest, platform-installation identity digest, machine observation, and time; changed inputs make it stale.
7. Requirement verdict, provisioning, installation disposition and result, runtime readiness, and real-product qualification remain separately named and separately proved.
8. Replacing exact promoted-machine identities with prerequisite predicates cannot reuse an earlier host pass as acceptance evidence.
9. Adding, relaxing, or retiring a requirement creates a new profile digest, never rewrites prior results, and gives already deployed hosts an explicit migration or support consequence.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Broad upstream OpenShell support is mistaken for OpenKit support. | Bind NanoHost qualification to the pinned OpenKit integration and the single profile's exact Linux amd64 and arm64 target set using the Docker realization. |
| Resource advice becomes a hidden minimum. | Emit a separate recommendation observation and forbid it from changing the hard verdict. |
| A package check or successful copy is treated as readiness. | Keep host verdict, installation outcome, and runtime acceptance as distinct gates owned by distinct documents. |
| A prerequisite-profile migration launders old exact-host evidence. | Bind each result to profile and archive digests and require fresh qualification after any projection change. |
| Host requirements duplicate toolchain, image, or runtime owners. | Keep exact source pins, image contents, archive contents, and readiness predicates in their existing owners and reference their machine-readable projections. |

## Alternatives Considered

### One Universal Host List

Rejected. It would incorrectly require source-build tools on installed systems, imply macOS NanoHost support, and erase the separate-machine topology.

### Treat Upstream Docker And Podman As Equivalent

Rejected. The OpenKit NanoHost invokes Docker-specific binaries, sockets, Buildx behavior, private daemon topology, and cleanup paths. Upstream support does not implement or qualify a Podman path in OpenKit.

### Keep Exact Qualified-Machine Package Identities As The Support Contract

Rejected as the target. Exact identities remain useful evidence for one machine, but they exclude otherwise compatible machines without testing the capability NanoHost actually consumes. The migration remains incomplete until the executable projection and fresh qualification exist.
