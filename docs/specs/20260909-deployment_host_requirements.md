---
status: Accepted
implementation: Implemented
kind: topology
aspect: architecture
---
# Deployment Host Requirements

This specification owns which machines may run NanoCore and the packaged NanoHost, and how a side-effect-free check reports that fact.

## Scope

This specification owns the supported host profiles for NanoCore source, the NanoCore application image, the packaged NanoHost, and the combined small deployment. It owns the boundary between source-build dependencies, installed runtime dependencies, conditional capabilities, and non-binding resource recommendations. It owns the side-effect-free packaged-NanoHost requirement check, its profile source, archive-and-machine binding, verdict vocabulary, and bounded failure semantics.

Does not own:

- Repository bootstrap, exact developer-tool versions, dependency installation, and generated-file maintenance. `docs/toolchain.md` owns them.
- NanoCore configuration, boot readiness, authentication, storage layout, listener configuration, and deployment-mode procedure. Those specifications own them.
- NanoHost archive contents, installer destinations and retry, enrollment, Runtime Epoch lifecycle, readiness, containment, and real-host qualification. The NanoHost specification owns them.
- Container image contents, image-platform publication, release composition, scheduling capacity, and an operator provisioning recipe. Those owners keep them.
- A package manager, deployment runner, fleet inventory, host-certification database, or durable installation record.

Core: [`docs/core/doctrine.md`](../core/doctrine.md), [`docs/core/architecture.md`](../core/architecture.md), [`docs/core/runtime-model.md`](../core/runtime-model.md), [`docs/core/sandbox.md`](../core/sandbox.md).

## Decision
### Supported Profiles

| Profile | Supported host | Installed host dependencies | Source or image-build dependencies | Support boundary |
| --- | --- | --- | --- | --- |
| NanoCore source | Linux or macOS on x86_64 or arm64 | The exact Node and pnpm versions projected by the root machine-readable toolchain sources, installed workspace dependencies, writable configured data storage, and the configured listener and network reachability | Repository bootstrap and native build tools are the source path owned by `docs/toolchain.md`; they are not requirements for a separately built image | Starts NanoCore and Web from a checkout. Current direct observation covers Apple Silicon macOS; another admitted source-host target still needs its own exact check result. It does not supply Worker Agent execution without a reachable qualified NanoHost. |
| NanoCore application image | Linux on `linux/amd64` or `linux/arm64` | A functioning Docker Engine capable of running the selected Linux image, persistent writable storage for the configured data root, and the configured listener and network reachability | The Node, pnpm, compiler, Python, SQLite headers, Caddy, and init components declared by the application Dockerfile are image-build or image-contained dependencies; they are not host packages | OpenKit qualifies this profile through Docker. A compatible OCI format alone does not make Podman, Docker Desktop on macOS, or another engine supported without a repository qualification result. |
| Packaged NanoHost | `linux/amd64` or `linux/arm64` | The checker and installer Python prerequisite defined below; systemd, unified cgroup v2, Linux mount and network namespace facilities, seccomp, the fixed executable Git, Docker components, and `slirp4netns` paths consumed by NanoHost, Docker Engine `28.0` or later, libc compatibility with both exact target-matched GNU/Linux executables, fixed runtime and persistent roots, and the privileges required later to create and fence the private Runtime Epoch | Rust, Node, pnpm, Cargo source dependencies, and packaging tools belong only to source build and release packaging. The installed host does not require Rust, Node, pnpm, or an independently installed OpenShell CLI. | The distribution set contains one target-matched archive per admitted architecture. The exact Cargo-pinned SDK and architecture-matched digest-pinned Supervisor are part of the same OpenShell `v0.0.99` integration. The current packager and installer handle both architectures. |
| Combined small deployment | One `linux/amd64` or `linux/arm64` machine satisfying both the application-image and packaged-NanoHost profiles | The union of those two profiles, with distinct configured listeners and persistent roots and with the system Docker installation kept separate from NanoHost's private epoch runtime | Image construction and repository source build remain optional preparation paths, not installed runtime requirements | Runs NanoCore/Web and NanoHost on one machine. Runtime acceptance still has to prove the NanoHost noninterference, fresh-empty, transport, and readiness predicates owned by the NanoHost specification. |

The packaged NanoHost profile has one Docker realization. `/usr/bin/git`, `/usr/bin/containerd`, `/usr/bin/dockerd`, `/usr/bin/docker`, and `/usr/bin/slirp4netns` are fixed because the current service invokes those paths directly. The checker observes compatible static prerequisites at those paths; exact Docker output or a `slirp4netns` package digest is evidence about one tested machine, not the portable support boundary. Podman is unsupported for NanoHost until a later accepted design supplies an implementation and real qualification. Native macOS NanoHost is likewise unsupported; a macOS NanoCore host reaches a separate qualified Linux NanoHost.

The `image.build` effect has an additional conditional requirement: Buildx `0.35.0` or later, BuildKit `0.31.0` or later, and the `exec.proxy` capability must pass the existing pre-effect check. A host may start the base runtime without proving this conditional capability, but it must reject `image.build` before a build effect when the check fails. Worker images are acquired and verified at point of use under the NanoHost owner and are not readiness prerequisites. Stock OpenShell Supervisor bootstrap may still retrieve its pinned image from GHCR before Gateway health; deployment must provide that supported upstream access when needed.

OpenShell's upstream support matrix is an input, not OpenKit's product support owner. OpenKit consumes the upstream Docker `28.0` floor and the Gateway's glibc `2.28` input for its current OpenShell pin `v0.0.99`, then narrows the supported set to its Docker-specific Linux amd64 and arm64 targets. The Gateway floor alone is insufficient because each separately built NanoHost executable may require newer libc symbols. Packaging derives the maximum required symbol versions from both exact target-matched executables, and the host check observes loader compatibility with that derived requirement rather than hard-coding the Gateway floor as the complete package requirement. Upstream Podman, macOS, MicroVM, and Windows possibilities remain outside the OpenKit NanoHost profile.

The systemd parse probe judges the archive's OpenKit service, its slice and the required `openkit.slice` parent, including exact-name, dash-prefix and type-wide drop-ins that apply to them, rather than the configuration of unrelated units loaded by `systemd-analyze verify`. Diagnostics attributed to another unit do not fail the OpenKit predicate unless they also concern an OpenKit unit. OpenKit diagnostics and unattributed inspector failures remain blocking even when verification exits zero. A nonzero status remains blocking, except for the exact expected diagnostic that the not-yet-installed NanoHost executable is absent; that exception must be the only remaining diagnostic and have status one. The parser also removes the exact older-manager unknown-key warnings for `RestartSteps` and `RestartMaxDelaySec` before it judges the OpenKit unit. It does not ignore any other OpenKit diagnostic. The fixed restart floor stays distinct from measured stepped backoff. Unavailable inspection remains `cannot-check`. This read-only check does not correct or certify unrelated services.

### Resource Recommendation

For the initial combined small-deployment profile, the current recommendation is at least 2 available logical CPU cores, 8 GiB of available memory, and 30 GiB of available persistent storage before loading deployment images and Workspace data. This is an empirical operating recommendation, not a hard minimum, admission rule, capacity promise, per-process allocation, or storage reservation. Actual deployment images, build cache, retained Workspace data, and operating-system use may require more. The NanoHost Image Store's administrator-configurable content limit has a current default of 200 GiB; it is an admission ceiling, not reserved capacity or automatic eviction. Full-store admission preserves retained images and refuses growth, and the limit does not replace measuring available storage.

A machine below the recommendation has recommendation observation `unmet`; that observation does not change a static hard-requirement verdict or real-product qualification. If a concrete required allocation, filesystem write, image import, process start, or owned runtime capacity proof fails, that owning operation fails truthfully and NanoCore or NanoHost remains non-ready as its existing owner requires. A split deployment does not divide or duplicate the combined recommendation: no independent per-role resource recommendation is qualified yet.

### Retrieval Service Supply

NanoCore requires a target-matched supervised Retrieval Kernel executable with its embedded tokenizer dictionaries and license notices on Linux amd64 and arm64, and compatible source-build supply on supported macOS targets. Runtime queries download no dictionaries and perform no inference. Missing executable or required dictionary fails the dependent retrieval operation explicitly. Child resource exhaustion must not terminate NanoCore. Service qualification measures bounded UTF-8 indexing, RPC wall time, process memory and CPU, and derived-store growth separately for each supported target. These measurements do not convert the combined deployment recommendation into a hard minimum. No format extractor or Sandbox CLI/MCP installation is added.

### Machine-Readable Requirement Sources

| Concern | Authoritative machine-readable projection |
| --- | --- |
| NanoCore source tool identities | Root `.mise.toml`, `package.json`, and the lockfile, interpreted only through `docs/toolchain.md` |
| Application image platform and content | `containers/images.json` and the selected Dockerfile, interpreted only through the container-image specification |
| NanoHost platform and host prerequisites | `apps/nanohost/deploy/host-manifest.json`, interpreted through this specification for requirement checking and through the NanoHost specification for archive projection |
| Pinned OpenShell integration | `apps/nanohost/openshell/release.json`, `apps/nanohost/Cargo.toml`, and `apps/nanohost/Cargo.lock`, interpreted through the NanoHost specification |

NanoCore source and application-image dependencies remain guidance. Their machine-readable owners resolve them. They are not inputs to this checker. The target NanoHost host manifest is `apps/nanohost/deploy/host-manifest.json`. Probe names select repository-owned checker operations and never contain shell text. `profileDigest` is lowercase SHA-256 over the exact raw bytes of that manifest. The single profile admits both target architectures and must not encode one qualified machine's kernel release, full command inventory, exact Docker output, or `slirp4netns` digest as portable requirements. The exact profile bytes ship inside every NanoHost archive as `host-manifest.json`, covered by inner checksums. Each release `MANIFEST.json` carries the exact target architecture, profile id, and profile digest without copying the requirement fields.

The packaged-NanoHost static prerequisite set is closed for this profile:

| Capability | Required observation |
| --- | --- |
| Checker and installer | Usable Python 3.8 or later at `/usr/bin/python3`, with its standard library. This is an inspection and bundle-verification prerequisite, including staging; the NanoHost service does not depend on Python. A distribution-owned interpreter symlink is permitted. |
| Platform and service manager | Linux kernel on the selected `amd64` or `arm64` target; systemd is active; the archive unit parses successfully and uses unit and slice settings supported by that systemd. The unit and slice need not already be installed. Actual installation, group creation, and termination are later acceptance steps. |
| Process containment | Unified cgroup v2 is mounted; Linux mount and network namespace facilities are exposed; the configured service principal declares the privileges consumed by the fixed unit and binary. Actual namespace creation and complete cgroup fencing are runtime acceptance. |
| Kernel sandbox support | The kernel reports seccomp support. Landlock remains upstream-recommended and is not an OpenKit hard prerequisite without a selected hard-requirement policy mode. Actual OpenShell policy enforcement is runtime acceptance. |
| Container backend | Executable regular non-symlink `/usr/bin/containerd`, `/usr/bin/dockerd`, and `/usr/bin/docker`; Docker reports version `28.0` or later. That floor is an upstream prerequisite, while a fresh real-product run qualifies the selected observed Docker version and private cgroup-parent behavior. |
| Workspace collection | Executable regular non-symlink `/usr/bin/git`; a bounded `--version` probe completes successfully and reports a well-formed Git version. No exact package version string is the portable predicate. Actual private-repository isolation, byte-exact hashing, and candidate production are runtime acceptance owned by the workspace data boundary and NanoHost runtime specifications. |
| Private networking | Executable regular non-symlink `/usr/bin/slirp4netns`; `/run/systemd/resolve/resolv.conf` is a readable regular non-symlink file with a syntactically usable resolver entry. Actual namespace attachment and tap networking are runtime acceptance. No exact package version or digest is the portable predicate. |
| Bundled executables | The exact target-matched NanoHost and Gateway pass archive integrity and ELF machine checks, and the host loader and libc satisfy the maximum symbol-version requirements derived from both exact binaries. |
| Filesystem | Every existing ancestor of the fixed live destinations is a real non-symlink directory with the required ownership and mode predicate; an installer-owned absent descendant is allowed. Actual destination creation, configured-root creation, and writes remain installer or runtime acceptance. Thirty GiB is evaluated only as the separate recommendation. |

The [engineer decision](../decisions/20261005-nanohost_check_requires_python.md) admits Python as the checker's bootstrap prerequisite. It is checked before any profile can be verified or interpreted, so it adds no runtime requirement entry or probe name. The fixed path and minimum version apply to every invocation, independently of ambient `PATH`; the checker never provisions the interpreter. The specification owns this prerequisite, while the checksum-bound installer projects its enforcement and the profile id and digest identify the changed prerequisite set.

A missing, unsupported, unusable, or stalled interpreter produces exactly one bounded terminal `cannot-check` JSON result in `--check-host` mode, with unknown bindings and no claimed requirement observations. Live installation and installation-disposition checking stop before destination effects; staging also stops before writes because bundle verification requires the same interpreter. These modes retain their existing installation output. After operator correction, retry the complete check or installation as a new invocation; there is no resume of an incomplete observation, interpreter fallback, automatic repair, or persisted checker lifecycle. An earlier result is stale when its interpreter prerequisite, profile, product, archive, or machine inputs change; restarting the service does not create or renew checker evidence.

The `image.build` requirements remain conditional and are checked only when that effect is selected. Actual namespace, cgroup, private-network, filesystem-write, image, NanoCore-reachability, noninterference, and readiness behavior is proved only by the NanoHost runtime acceptance owner. The static checker creates no runtime and claims none of those facts.

The former schema-version-1 host manifest and its installer, package verifier, host harness, and tests enforced exact Docker and `slirp4netns` identities from one promoted machine, and pinned Git to one promoted machine's exact version line. Their results are retained historical evidence, not the target prerequisite contract. No previous host-prerequisites pass or earlier release candidate is retroactively a pass for the new profile. The schema-version-2 profile and its executable projection are the current contract. A fresh check is a separate observation. Staged installation retains its host-check exemption under the NanoHost installer owner. The read-only private-store scan invokes only the Git admitted by the selected profile. In schema version 2, Git uses the Workspace collection prerequisite above instead of the promoted machine's exact version line; installation and pre-epoch startup use that same owned prerequisite, and a failed mandatory observation blocks them without claiming runtime proof.

### Requirement Check And Installation Boundary

The packaged-NanoHost requirement check is the bundled `install.sh --check-host` mode and is side-effect free. It reads only the archive's checksum-verified bundled `host-manifest.json`, rejects profile bytes whose SHA-256 differs from the profile digest in release `MANIFEST.json`, observes only the named Linux machine, places a time bound on every executable or filesystem probe, and emits one terminal hard-requirement verdict plus a separate recommendation observation. It never falls back to a repository or network profile and does not install or upgrade a package, create a destination, start or stop a service, load an image, enroll a NanoHost, write configuration, or claim runtime readiness.

The complete hard-requirement verdict vocabulary and precedence are:

- `requirements-met`: every mandatory static probe ran to completion and satisfied the exact profile.
- `requirements-unmet`: at least one completed probe proved that a mandatory platform, required executable, version predicate, path, or static prerequisite is absent or incompatible. A proved mismatch takes precedence when another probe also cannot be completed, while the result retains both per-requirement outcomes.
- `cannot-check`: no probe proved a mismatch, but at least one mandatory probe could not produce a bounded trustworthy observation because the inspection tool was unavailable, observation permission was denied, it timed out, its output was malformed, or observations were internally inconsistent. This fails closed and is never converted to `requirements-met`.

A required executable that is absent, not a regular non-symlink file, or not executable is `requirements-unmet`. Failure of an otherwise independent inspection tool or permission needed only to observe the predicate is `cannot-check`; it is not evidence that the runtime dependency is absent.

The separate recommendation observation is `met`, `unmet`, or `cannot-check`. It never changes the hard-requirement verdict. Unknown available memory or storage is not reported as zero, and total installed capacity is not substituted for available capacity.

The `--check-host` mode writes exactly one structured JSON object followed by one newline and no other stdout. The existing `--check` installation-disposition mode and default live installation reuse the same internal probe result but retain their separately owned installation output; neither prints a second host-check JSON object or implements another comparator. The checker result contract is implemented by `apps/nanohost/deploy/install.sh`. Each requirement member serializes `id`, `outcome`, and `observed` in that order. `observed` contains bounded normalized non-secret facts, or null when no trustworthy observation exists. Each requirement outcome is `met`, `unmet`, or `cannot-check`. The requirements array follows manifest order. `machineObservationDigest` is lowercase SHA-256 over the exact compact UTF-8 JSON serialization of the complete ordered `requirements` array with no newline. `archiveSha256` is lowercase SHA-256 over the complete NanoHost archive. `productCommit` is required and verified against the archive's generated provenance.

`machineIdentityDigest` contains only lowercase SHA-256 over the exact bytes of `/etc/machine-id`; the raw platform installation identifier and hostname are forbidden. A missing or unreadable identifier is `cannot-check`.

The ordered requirement members retain the bounded non-secret facts needed to inspect and reproduce the verdict; their digest supplements and never replaces `machineIdentityDigest`. Changing the profile, product commit, archive bytes, selected platform installation, or any required observation makes the result stale. This result is verification evidence only; it is neither a product record nor a durable deployment authority.

Provisioning is a separate operator-authorized cookbook action that may try to make a requirements-unmet machine satisfy a profile. After provisioning, the complete requirement check runs again as a new result; it does not patch or resume the previous result.

The NanoHost installer then applies only the archive contract owned by the NanoHost specification. Its `installable`, `already-installed`, `resumable`, and `destination-conflict` dispositions and `installation=complete` or `installation=incomplete` outcomes remain installation facts. A partial install preserves the existing exact-byte, exact-mode, no-overwrite, invocation-owned cleanup, and safe retry behavior. It does not revise the earlier host verdict and never implies service start. Installed-host replacement follows [NanoHost Installed Release Replacement](20260802-nanohost_runtime_and_transport.md#installed-release-replacement) and requires a fresh target archive host check without weakening these installation dispositions.

Runtime acceptance begins after configuration, enrollment and service start. First installation establishes configuration and enrollment; installed release replacement preserves valid retained configuration and enrollment and verifies them before start. Worker-image availability is proved separately for each admitted workload; missing Worker images do not block substrate readiness, while stock OpenShell bootstrap dependencies remain applicable. NanoCore readiness belongs to its bootstrap-readiness owner; NanoHost fresh-empty, containment, connection, capacity, and real-stock acceptance belong to the NanoHost owner. `requirements-met` makes no startability, readiness, containment, capacity, support, qualification, or release-readiness claim. A passed requirement check and complete installation satisfy neither acceptance boundary.

## Lifecycle And Failure Semantics
1. Satisfy the checker bootstrap prerequisite, then select one profile and immutable artifact. A missing, unknown, or contradictory profile is `cannot-check`.
2. Run the side-effect-free static probes and recommendation observation. Requirements-unmet and cannot-check outcomes stop automatic installation.
3. Perform any separately authorized provisioning, then create a new complete check result.
4. Run the archive installation path. A failed or partial install reports its own exact outcome and follows its existing bounded retry contract.
5. Establish configuration and enrollment for first installation, or verify their retained validity under the NanoHost replacement owner, then start the selected services and run the separately owned runtime acceptance checks. Failure remains non-ready; the host-requirement result is not rewritten.

A host loses its prior requirement evidence when a bound input becomes stale. Ordinary runtime failure does not automatically prove static requirements unmet; it is classified by the runtime owner unless a repeated check proves a missing prerequisite. Unmet combinations have no fallback to an unqualified engine, architecture, service manager, or native NanoHost path.

### Requirement-Set Evolution

A requirement is added only by changing this owning specification and the affected machine-readable profile in the same accepted change, incrementing its schema version or profile id as appropriate, and producing a new profile digest. The change states which consumed implementation fact makes the predicate necessary and supplies a bounded probe and failure classification.

A requirement is relaxed only after implementation and qualification show the wider predicate is sufficient. Relaxation also creates a new profile digest. A host excluded by the old profile reaches `requirements-met` only after a fresh complete check against the new product commit, archive digest, and machine identity; the change does not rewrite its prior result or establish qualification.

A requirement or profile is retired only when no selected qualified product path consumes it or an accepted replacement owns the path. Retirement makes it unselectable for new installation, upgrade, or qualification claims. It does not stop a running service merely because documentation changed, but an already deployed host remains bound to its prior product commit and profile digest and cannot claim qualification for a product selecting the new or retired profile until it migrates, passes a fresh check, and passes its runtime qualification. Migration or decommission follows the existing runtime and operator owners; there is no silent fallback or automatic host mutation. Installed-distribution replacement follows [NanoHost Installed Release Replacement](20260802-nanohost_runtime_and_transport.md#installed-release-replacement); requirement checking never performs that transition.

## Implementation

<a id="current-implementation-projection"></a>

- `apps/nanohost/deploy/`
- `apps/nanohost/openshell/`
- `apps/nanohost/src/`
- `containers/`
- `scripts/`

## Implementation Gaps

None.

## Decisions

- [Python is the checker prerequisite](../decisions/20261005-nanohost_check_requires_python.md)
