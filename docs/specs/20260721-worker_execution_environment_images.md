---
status: Accepted
implementation: Partial
updated: 2026-08-28
---
# Worker Execution Environment Images

## Owns

This specification owns the common execution-environment baseline for the supported Worker Agent images, the published common base artifact and what extending it does and does not confer, the shared multi-target Docker build shape, the empty image-private package-config root and fixed helper destination, the exact separation between installed image capabilities and runtime authorization, declared-runtime-set conformance for published worker images, the image-level verification required before a catalog leaf is treated as a complete supported worker environment, and the pre-activation backlog boundary for the internal dogfood image.

## Does Not Own

This specification does not own Worker Agent behavior, native adapter command or result translation, scheduler placement, Runtime Epoch lifecycle or transport, provider routing, credential resolution, generic AgentManifest or AEP schema semantics, the copy-on-init built-in development grant table owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`, OpenShell implementation internals, arbitrary internet access, deployment credentials, browser automation, additional language ecosystems, or the internal `test-env` sibling owned by `docs/toolchain.md`.

It does not own the content, tool baseline, verification, or release lifecycle of a non-published attempt image. It owns only the boundary statement below: that such images exist outside the current published catalog, and exactly what it does and does not guarantee about them. It does not prohibit a later reviewed catalog growth or a multi-runtime published artifact; those are packaging and supply-surface costs, not a ban.

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/sandbox.md`
- `docs/core/agent-supply.md`

## Related Docs

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260708-container_image_packaging.md`
- `docs/specs/20260709-worker_sandbox_freedom_policy.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/toolchain.md`

## Thesis

OpenKit publishes three current deployment worker images because Codex, OpenCode, and Pi are three independently versioned runtime supplies with no present need to merge them, and it builds them from one common stage because they need the same complete Node.js and Python development environment, Unix tooling, non-root filesystem contract, and OpenKit worker shim. It publishes that common stage as an empty declared-runtime-set artifact because extension is the answer to every workload the baseline does not carry, and an extension point nobody can name is not an extension point.

Every published worker image contains exactly its declared runtime set, whose cardinality may be zero, one, or many. `worker-common` is the empty set. Current `worker-codex`, `worker-opencode`, and `worker-pi` leaves remain singular facts. Catalog `runtime` stays singular descriptive metadata for those leaves; the first published multi-runtime artifact must migrate that metadata and its CI, preflight, and OCI-label consumers in the same reviewed change. `AgentManifest` and AEP `control.adapter.targetRuntime` select exactly one adapter per session. Image contents confer no authority.

The image answers which binaries and writable locations exist. The authored AgentManifest answers which of those binaries may reach which external endpoint. NanoCore resolves that declaration into the immutable AEP, and the NanoHost materializes it through stock OpenShell and Sandbox Integration as the exact launch policy. No Docker layer, image label, backend default, process environment variable, or bundled policy file may add network or credential authority.

## Principles

- Publish the current catalog set `worker-common`, `worker-codex`, `worker-opencode`, and `worker-pi`. The set may grow through a reviewed specification and catalog change. There is no no-fifth-image or universal-image prohibition.
- Publish `worker-common` because users and secondary developers select it directly as the public end-user extension base. The repository `test-env` image is an internal sibling that pins the same upstream Node digest and is not a consumer of the published base.
- Use one repository-owned multi-target Dockerfile with one published common stage and one final target per current leaf.
- Install exactly the catalog-declared runtime set in each image and fail smoke verification when an undeclared first-party Agent CLI is present. Mutual-absence smokes are declared-set conformance, not a platform rule that an image contain exactly one runtime.
- Keep the common stage free of Codex, OpenCode, Pi, provider credentials, OpenShell policy YAML, and product-state logic.
- Pin direct binary and image inputs to exact versions and digests while allowing Debian security package revisions to refresh during an explicit image rebuild.
- Run the worker and its native runtime as the non-root `sandbox` user.
- Give the worker broad access to installed local tools while keeping filesystem and network authority default-deny outside the AEP.
- Treat diagnostic tool installation as local capability, not permission to probe arbitrary public or private networks.
- Install mise in the common stage as the workspace-local toolchain provisioner, so a task repository declaring its own toolchain is served without a new image, and treat it as local capability under the rule above: it provisions tools, it confers no network authority, and every host it would fetch from is denied until an authored AgentManifest grant names it.
- Keep the common environment small enough to explain and smoke in one place; additional ecosystems enter only for a current supported workload, and a workload-specific toolchain belongs in a derived image or a workspace-local mise provision rather than in this baseline.

## Image Topology

The repository stores the shared worker Dockerfile and common launcher under `containers/workers/`. Runtime-specific smoke scripts and operator notes remain under `containers/worker-codex/`, `containers/worker-opencode/`, and `containers/worker-pi/` so each published artifact retains a discoverable owner.

```text
containers/workers/Dockerfile
  worker-shim-builder
        |
        v
  worker-common  (published base artifact)
        |
    +---+----------------+----------------+- - - - - - - - - -+
    |                    |                |                   :
    v                    v                v                   v
worker-codex      worker-opencode     worker-pi         external derivation
                                                        (user or
                                                         secondary-developer image)
```

The three final targets are derivations inside this Dockerfile. An external derivation is any image built `FROM` the published base in a Dockerfile this specification does not own. The repository `test-env` image is not that derivation: it is an internal sibling that pins the same upstream Node digest independently, owned by `docs/toolchain.md`, and it is not a base consumer. The throwaway derived-image proof in `scripts/docker/smoke-image.sh` exercises the external `USER root` then `USER sandbox` extension path.

`containers/images.json` records the same Dockerfile for all current worker entries and a unique required build target for each entry. Repository build scripts and release CI must consume that target; a manifest target that is missing, duplicated, or inconsistent with the image id is invalid. Catalog `runtime` is singular descriptive metadata for a current leaf and is omitted for the empty declared set; do not add a `runtimes` array until the first published multi-runtime artifact migrates that metadata together with CI, preflight, and OCI-label consumers.

The common stage is a published artifact and a build boundary. It is tagged, published, digest-addressable, and extensible by a derived Dockerfile, and that extension path is the supported way to add a toolchain this baseline does not carry. Publishing it does not make it a complete worker environment: its declared runtime set is empty, so it cannot host a governed Worker Agent, and an AgentManifest that selects it directly fails the launch precondition closed under `docs/specs/20260616-agent_environment_package.md` and `docs/specs/20260802-nanohost_runtime_and_transport.md` rather than launching a worker with no selected adapter. What extending it confers is the tool and filesystem baseline below and nothing else; a derived image receives no network, credential, or filesystem authority from its base, because authority comes only from the authored AgentManifest resolved into the immutable AEP. A derived Dockerfile must regain `USER root` to install additions and then return to `USER sandbox`.

## Common Development Environment

The accepted baseline as of 2026-08-28 is:

| Capability | Pinned baseline | Installation authority |
| --- | --- | --- |
| OS and Node.js | `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` | Official multi-architecture Node.js image |
| npm | Version bundled with the pinned Node.js image | Official Node.js image |
| pnpm | `10.33.3` | Corepack, aligned with the repository `packageManager` field |
| Python | CPython `3.14.6` | Installed by pinned uv into an immutable image path |
| uv and uvx | `0.11.30`, source image `ghcr.io/astral-sh/uv:0.11.30@sha256:93b61e21202b1dab861092748e46bbd6e0e41dd84f59b9174efd2353186e1b47` | Official uv multi-architecture image |
| GitHub CLI | `2.96.0` | Official release archive with architecture-specific SHA-256 verification |
| mise | `2026.8.14` | Official release binary with architecture-specific SHA-256 verification |
| Codex | `0.144.1`, Codex image only | Pinned native package |
| OpenCode | `1.18.1`, OpenCode image only | Pinned native package |
| Pi | `0.80.7`, Pi image only | Pinned native package |

The common OS tool set is `bash`, `build-essential`, `ca-certificates`, `curl`, `dnsutils`, `fd-find`, `file`, `git`, `iproute2`, `iputils-ping`, `jq`, `lsof`, `nano`, `net-tools`, `netcat-openbsd`, `openssh-client`, `pkg-config`, `procps`, `ripgrep`, `tar`, `tini`, `traceroute`, `unzip`, `vim`, and `xz-utils`. The image must expose the Debian `fdfind` binary through the conventional `fd` command.

The common language surface must expose `node`, `npm`, `npx`, `corepack`, `pnpm`, `python`, `python3`, `pip`, `pip3`, `uv`, and `uvx` on `PATH`. Python package writes go to the seeded `/sandbox/.venv`, and Node package caches and user configuration remain under `/sandbox` through the non-root home.

The common stage also exposes `mise` on `PATH` as the workspace-local toolchain provisioner. It is installed at an exact pinned version from an integrity-verified upstream release, as a root-owned immutable binary under the same rule as every other image-level supply, and its exact pin is the mise row in the baseline table above. Everything it provisions is written under the writable non-root home, so a provision is a workspace-local effect that leaves the image-level supply unmutated: the pinned Node.js, Python, uv, and package managers above remain what the image guarantees, and a task repository declaring a different Node in its own `.mise.toml` receives it beside them rather than in place of them. This exists so a task repository whose toolchain the baseline does not carry can be served without a derived image and without a rebuilt sandbox.

Installing mise grants no network authority, exactly as installing `curl` or `git` grants none. Every host a provision would fetch from — a language distribution server, a release archive host, a registry mirror — is denied until an authored AgentManifest names it as an exact grant, and the copy-on-init built-in development grants owned by `docs/specs/20260703-agent_manifest_aep_resolution.md` do not name any of them. A provision against an ungranted host therefore fails as a denied network operation rather than silently succeeding, and the correct response is an authored grant for a real workload, never a hidden backend default. mise consequently does not make an arbitrary task repository buildable inside a sandbox; it makes a declared toolchain provisionable once its supply hosts are granted.

The image must create writable `/sandbox`, `/workspace`, an empty `/openkit/config`, `/openkit/session`, `/openkit/artifacts`, the Python virtual environment, and normal user cache/config directories before switching to `sandbox`. No attempt package is baked into `/openkit/config`. System runtime directories, the shared shim deployment, the immutable Python installation, and native Agent runtime installations remain owned by root and are not writable by the worker.

`npm` audit, funding, update-notifier, and Agent auto-update behavior are disabled in the image because they create undeclared network effects and version drift. A worker may install task dependencies into writable workspace or user locations, but it may not mutate the image-level runtime supply.

## Runtime-Specific Final Images

Every current leaf inherits the common environment and adds only its pinned native Agent runtime, runtime-specific immutable files, labels, and smoke command. Each image installs the fixed absolute `/usr/local/bin/openkit-worker-shim` bootstrap target and shared sanitized launcher. The OpenShell driver replaces image `ENTRYPOINT` and `CMD` with its inert sandbox command, so NanoHost starts the governed worker only through the runtime owner's fixed timeout-zero unary `ExecSandbox` request for `/usr/local/bin/openkit-worker-shim --package /openkit/config/package.json` in `/workspace`; image metadata, package content, configuration, and caller input cannot select that command.

The fixed image helper preserves the ten existing workspace import identities and adds one separate image-private prerequisite: only `reference.import` with literal identity `package-config` and literal relative path `package.json` may create `/openkit/config/package.json`. It uses the existing no-follow, no-overwrite, mode-`0600`, fsync, atomic-placement, clean-zero-exit, and fixed value-free failure boundary. Adjacent identity or path, export, another config destination, caller or image-metadata selection, a baked package, and a generic configuration-file surface are prohibited.

The bootstrap Start environment contains only the six existing non-secret lineage entries and no raw route credential. The unary request's stdin is exactly 88 bytes: two distinct 43-character tokens, each followed by one newline, then request EOF before execution. This remains within the pinned whole-message 1,048,576-byte server cap. The launcher rejects absent, malformed, oversized, duplicate, equal, extra, or trailing input with fixed value-free errors, projects the worker-control token only on descriptor 3, and preserves the independently generated inference token only through the already-authorized sanitized `OPENKIT_WORKER_INFERENCE_TOKEN` native-Agent binding. It otherwise preserves only the existing bounded OpenKit route bindings, proxy variables supplied by OpenShell, locale and terminal variables, the common development `PATH`, Python virtual-environment variables, TLS variables, and user identity variables. Worker-control and capability tokens MUST NOT enter the native Agent environment; capability remains disabled. The Pi image may carry `/usr/local/lib/openkit/allow-anthropic-api-key` as carrier capability only. `docs/specs/20260703-agent_manifest_aep_resolution.md` `credentials.declarations` is the authority for whether `ANTHROPIC_API_KEY` is declared for the selected session.

Codex retains its writable home and governed Node proxy behavior required by the optional runtime-provenance extension. OpenCode retains the invariant that `/etc/opencode` is absent. Pi retains its direct Anthropic provider projection and no other provider credential.

## Authority Layers

The complete launch contract has three non-overlapping layers:

| Layer | Owns | Must not own |
| --- | --- | --- |
| Worker image | Installed binaries, immutable versions, fixed shim path, local filesystem layout, non-root identity, shared two-slot launcher, smoke command | Endpoint permission, credential generation or persistence, provider selection, Start-field selection, product state |
| AgentManifest and resolved AEP | Exact filesystem grants, exact network endpoint and binary grants, credential declarations, backend requirements, selected image | Backend-private policy syntax or hidden defaults |
| NanoHost-owned stock OpenShell and Sandbox Integration | Enforced filesystem, process, network, and distinct worker-control, inference, and capability route bindings for that immutable AEP | New authority, merged route credentials, undeclared endpoints, canonical OpenKit state |

An image must not copy `/etc/openshell/policy.yaml` or another default network policy. NanoCore must always pass the generated policy explicitly to OpenShell, and the generated policy must contain exactly the immutable authority represented by the AEP, including its fixed resolved worker-control declaration; `docs/specs/20260703-worker_control_protocol.md` owns the worker-control mechanics.

Trusted NanoCore inference is a provider-route constraint, not a claim that the package has no other network rules. A trusted-relay package must retain the exact worker-control and worker-inference rules, must remain free of direct provider credentials and direct provider endpoints, and may also carry unrelated manifest-authored development grants that do not alter the LLM route.

## Built-In Development Grants

This specification does not own the out-of-box development grant table. `docs/specs/20260703-agent_manifest_aep_resolution.md` owns those five grants as copy-on-init built-in AgentManifest template content. Installed tools confer no authority. No mise supply host is granted. Existing manifests are unchanged by later template edits, and a missing grant fails denied.

## Non-Published Attempt Images

The execution runtime may run a sandbox from an image that is not one of the currently published catalog artifacts: content retrieved from a declared public registry, or an image built for one attempt from an Agent Environment Package build definition. That path is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md` and `docs/specs/20260616-agent_environment_package.md`. This section exists so that its relationship to the published baseline is stated rather than assumed.

What this specification continues to guarantee applies only to its published artifacts. Current `worker-codex`, `worker-opencode`, and `worker-pi` remain the supported singular deployment leaves because each currently declares one native Agent runtime; `worker-common` joins them as a published empty-set artifact subject to the acceptance predicates, smoke verification, release matrix, and environment-refresh lifecycle here, without becoming a deployment image. An attempt image is none of these. The published set may grow through a reviewed specification and catalog change.

What this specification does **not** guarantee about an attempt image:

- It is not published, not tagged as a repository image, and not selectable as a deployment image. It never becomes a published artifact, and it never enters `containers/images.json`, the release build matrix, the two-architecture release evidence, or the vulnerability-scanning unit. An attempt image built `FROM` the published base is still an attempt image; inheriting from a published artifact confers none of that artifact's release identity.
- Its OS tool baseline, language ecosystems, pinned versions, writable layout, and virtual-environment seeding are not covered by the common development environment defined here. A worker running in an attempt image may lack any part of that baseline.
- No acceptance predicate, verification step, or environment-refresh obligation in this specification applies to it, and release evidence here proves nothing about it.

What holds for every image class, published or not:

- Authority comes only from the authored `AgentManifest` resolved into the immutable AEP and materialized as the exact launch policy. Installed binaries, image labels, layers, and bundled files confer no network, credential, or filesystem authority in an attempt image any more than they do in a published one.
- Hosting a governed Worker Agent requires the worker runtime contract that the current leaves here satisfy — the shared shim at its declared path, the non-root `sandbox` user, and the writable locations the shim and worker require. That contract is a launch precondition owned by `docs/specs/20260616-agent_environment_package.md` and `docs/specs/20260802-nanohost_runtime_and_transport.md`, which fail a launch closed when it cannot be satisfied. This specification neither imposes it on an attempt image nor verifies it, and states it here only so nobody reads the exclusions above as permission to launch a governed worker from an image that cannot host one.

An attempt image is not published. That does not freeze the published catalog at four entries.

## Internal Dogfood Image

After the first GHCR publication of `worker-common`, one internal `release: false` `kind: test` dogfood image may derive that published digest, share the exact CI development-toolchain standard, and bundle Codex plus Pi but not OpenCode. That image is design and backlog only in this change: no Dockerfile, no catalog entry, and no shared installer. It is not a published product image and it is not `test-env`.

Before activation there is no dogfood image lifecycle, durable state, retry, recovery, or dependency-failure behavior because no artifact exists. The future activating change must first accept an owner that settles all five decision classes required by root `AGENTS.md`: exact definition and exclusions; unique authority and projection boundary; creation, update, termination, retry, and recovery lifecycle; conflict, missing, stale, restart, and dependency-failure semantics; and externally observable acceptance predicates.

Future activation gates must prove declared-set conformance, two AEP-selected dry runs, and that a Codex-selected session receives no `ANTHROPIC_API_KEY` even though the Pi carrier marker exists. The image must not include NanoCore, NanoHost, Docker CLI or socket, nested containers, built-in image policy, or test-executor markers. Sandbox scope is compile and build, unit tests, and headless-browser tests. Full integration stays on external project-owned systems. There is no SSH product contract.

## Version And Maintenance Lifecycle

Direct release inputs use exact versions and integrity verification. The Node and uv multi-architecture source images are digest-pinned, GitHub CLI archives and the mise binary are verified with the upstream per-architecture SHA-256 values, and all three Agent runtime versions remain explicit build arguments whose defaults match `containers/images.json`, the built-in manifests, and static tests.

An environment refresh is one reviewed maintenance change that updates source versions or digests, updates this baseline table and the image catalog, adds or adjusts version assertions first, builds both supported architectures through release CI, smokes the base image and all three final images, and repeats stock OpenShell create, AEP upload, shim dry-run, and delete verification. A changed apt package set is accepted only through a rebuilt final image digest and the same verification; no running sandbox updates its image-level supply in place.

If one native runtime cannot build on a supported architecture, only that final image is unavailable; the base image and other two runtime artifacts remain valid. If the base image fails, all four builds fail.

Publishing the base makes every refresh of the common stage a change to a released artifact that external derivations inherit, which is the cost this specification previously declined to pay and now accepts for the consumers named in Principles. The release identity, tag, digest, and label rules that cost brings are not restated here: `worker-common` is an ordinary `release: true` entry in `containers/images.json` and takes them unchanged from `docs/specs/20260708-container_image_packaging.md`. What is owned here is narrower: a refresh MUST NOT reduce the baseline a derivation already relies on without the same reviewed maintenance change, because a derived Dockerfile states what it adds and cannot state what its base removed. A stale local tag may remain cached according to AgentManifest pull policy, but a release or deployment that requires exact supply must select an immutable final image digest. `test-env` does not inherit that digest by derivation; a Node digest change is a sibling mirror update owned by `docs/toolchain.md`.

Replacing a sandbox, or recovering through a fresh Runtime Epoch after invalidation, recreates the environment from the selected final image and immutable AEP. Writable virtual-environment or user-cache changes are disposable unless an independently declared workspace/output contract captures them; this specification creates no package-cache persistence or sandbox-resume guarantee.

## Current Implementation Projection

The current strict version 3 AEP selects exactly one reference or bounded build image form; the accepted target is the strict version 4 package owned by `docs/specs/20260616-agent_environment_package.md`. A reference may select one of the current published deployment leaves through the authored reference and pull policy owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`, including the mutable development tags used by built-in templates; selecting the published empty-set base instead fails the launch precondition closed, because it declares no runtime. A build produces one non-published attempt image: NanoHost validates and executes the bounded build, admits the verified OCI result to its Image Store, imports the exact digest into the current Runtime Epoch, and returns digest evidence without creating a published artifact. The exclusions above remain current for that attempt image.

The repository now builds `worker-common`, `worker-codex`, `worker-opencode`, and `worker-pi` from `containers/workers/Dockerfile`, passes the required manifest target through the local build helper and both release-CI build steps, and retains only runtime-specific smoke ownership under each leaf directory. The published common stage installs the accepted tool baseline including pinned mise `2026.8.14` at root-owned `/usr/local/bin/mise`, deploys one shared worker shim and sanitized launcher, creates the writable non-root layout and empty `/openkit/config`, seeds the Python virtual environment, labels and smokes itself as `worker-common`, finishes as `USER sandbox`, and leaves no root-owned build state beneath `/sandbox` or `/workspace`. Each current leaf regains `USER root` only to install its declared runtime and smoke command, then returns to `sandbox`. The helper preserves the ten workspace import identities and accepts only the exact import-only `package-config/package.json` specialization at `/openkit/config/package.json`. The NanoHost fixed unary bootstrap/response monitor, authenticated `starting` latch, exact two-slot parser, and mandatory process-group-absence barrier are implemented but remain runtime-owned rather than image-owned.

The three built-in AgentManifest templates now declare the complete common binary paths and five development grants owned as copy-on-init templates by `docs/specs/20260703-agent_manifest_aep_resolution.md`. Config-schema accepts bounded exact `GET` or `POST` REST rules, NanoCore preserves those authored rules through resolved setup and AEP creation, trusted worker inference permits unrelated authored development grants while still rejecting direct provider credentials, and OpenShell materialization renders the exact Git wildcard rules without a hidden endpoint or `git-receive-pack`. Worker inference authority is limited to the AEP-selected adapter; image contents confer no adapter or credential authority.

On 2026-07-21, the current arm64 development host built and smoked all three final targets natively, then cross-built and smoked the same targets as `linux/amd64`. Every smoke ran as the non-root `sandbox` user and covered exact versions, command inventory, declared-set conformance, writable and immutable path checks, absence of baked policy, absence of root-owned writable state, and generic shim dry-run.

On 2026-08-01, historical A1 verification used stock OpenShell and Gateway `0.0.80` to create one disposable sandbox from each refreshed Codex, OpenCode, and Pi image, upload a representative AEP with exactly the five common development grants and no additional host, complete the generic shim dry run, and return zero residual containers and sandboxes through legacy whole-Cell cleanup after every case. This completes image-content acceptance only; it does not prove the target NanoHost lifecycle, stock RelayStream, nested standard HTTP/2 behavior, or route-token separation.

The current strict-version-3, NanoHost, config-schema, worker-shim, App API, Core Client, migration, build, lint, OpenAPI, and Rust package-exit checks pass. This projection records that package state only; it does not claim the accepted strict-version-4 contract or a new A1 gate is implemented.

`containers/images.json` now carries four worker entries on one Dockerfile. `worker-common` is `release: true` with `baseImage` and `target` and without `runtime` or `workerContract`, which is the empty declared runtime set identified structurally by absent runtime metadata. Local smoke of that base is `containers/workers/openkit-worker-common-base-smoke.sh`, which reuses `smoke-common.sh` for baseline, mise version, and ownership, then proves no first-party Agent CLI is present. `scripts/docker/smoke-image.sh` additionally builds one network-free throwaway image `FROM` the local base, regains `USER root`, adds one tiny executable, returns to `USER sandbox`, proves the inherited common baseline plus that executable, and deletes the temporary image. `test-env` is not that derived proof. First GHCR publication of `worker-common` remains a later version-tag release event; this repository change does not publish. The internal Codex-plus-Pi dogfood image remains design and backlog only.

## Verification

L0/L1 static and contract checks must prove:

- all current worker catalog entries select one shared Dockerfile and unique targets, and a release worker base is identified by absent `runtime` rather than by a reserved id;
- the shared common stage contains the complete tool and filesystem baseline, exact pinned direct inputs including the mise pin, the generic shim, and an empty declared runtime set with no baked OpenShell policy;
- no built-in AgentManifest grant names a language distribution server, release archive host, or registry mirror that exists only to serve a mise provision;
- the shared launcher accepts exactly two ordered private token lines and EOF, exposes worker control only through descriptor 3 and inference only through the sanitized inference binding, and emits only fixed value-free failures for every invalid slot shape;
- the fixed helper accepts exactly one image-private package import at `package-config/package.json`, creates only `/openkit/config/package.json` with the accepted atomic file boundary, rejects adjacent identity, path, destination, export, existing target, and baked package content, and leaves all ten workspace identities unchanged;
- each current leaf contains exactly its catalog-declared runtime set, expected immutable binary paths, labels, and runtime-specific smoke command;
- repository build helpers and release CI pass the manifest target to Docker;
- every built-in AgentManifest declares the common tool binary paths and the five exact development grants owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`;
- trusted-relay AEP validation accepts unrelated manifest-authored grants while still rejecting direct Provider credentials, concrete Provider routes, and malformed relay rules;
- OpenShell policy rendering preserves Git Smart HTTP wildcard paths and `GET`/`POST` methods without adding `git-receive-pack` or any undeclared endpoint.

Image smoke checks must run as `sandbox` and prove the exact Node.js, Python, uv, mise, GitHub CLI, pnpm, and native Agent versions; every required command; writable workspace, session, artifact, cache, and virtual-environment paths; non-writable immutable runtime paths; absence of a baked OpenShell policy; generic shim dry-run; and declared-set conformance, including mutual absence of undeclared first-party Agent CLIs. The empty-set base runs the same smoke minus native-Agent assertions, and additionally proves that no first-party Agent CLI is present.

One check must build a throwaway derived image that starts `FROM` the local base, regains `USER root`, adds one tool, returns to `USER sandbox`, and proves that the added tool and the complete inherited baseline are both present. That check lives in `scripts/docker/smoke-image.sh`. It is not `test-env`.

Release evidence for each supported architecture must build and smoke the base image and every final target. A stock OpenShell image-compatibility check must create one disposable sandbox from every final image, upload a representative AEP containing the common grants, complete the generic shim dry run, and delete the sandbox. That isolated packaging check does not make direct CLI sandbox creation the product execution path and does not prove NanoHost lifecycle, RelayStream, nested HTTP/2, real-provider turns, route credentials, worker-control behavior, or arbitrary task success.

## Acceptance Predicates

- An operator can build the current published artifacts from one shared Dockerfile, and the empty-set base carries no native Agent CLI.
- A derived Dockerfile that starts `FROM` the published base, regains `USER root`, adds one toolchain, and returns to `USER sandbox` produces a runnable sandbox image without editing this repository. That path is proved by the throwaway check in `scripts/docker/smoke-image.sh`, not by `test-env`.
- An AgentManifest selecting the empty-set base directly fails the launch precondition closed rather than starting a worker with no selected adapter.
- A derived image inherits the tool and filesystem baseline and inherits no network, credential, or filesystem authority from its base.
- A worker can provision a toolchain declared by its task repository through mise into its writable home, and the image-level Node.js, Python, uv, and package-manager supply is unchanged afterward.
- A mise provision whose supply host is not an authored grant fails as a denied network operation, and no built-in development grant names such a host.
- A non-root worker in any current leaf can use the complete declared Node.js, Python, Unix, source-control, build, editor, and diagnostic command baseline locally.
- The writable Python virtual environment accepts package installation when the exact PyPI grants are present.
- npm, pnpm, Git clone/fetch, and read-only GitHub CLI operations have only the endpoint and binary authority declared by the selected AgentManifest.
- Git push, arbitrary curl, private-network access, undeclared package hosts, and undeclared provider endpoints remain denied under the built-in baseline.
- Removing an AgentManifest grant removes the corresponding generated OpenShell network policy without rebuilding the image.
- Adding an executable to an image does not authorize that executable for any external endpoint.
- Current leaves may release independently even though they share the common build stage.
- Two independent implementers can derive the same Docker targets, tool inventory, writable paths, authority layering, failure behavior, and required checks from this specification, and they obtain the five development grants from `docs/specs/20260703-agent_manifest_aep_resolution.md`.
- Every image exposes the same fixed absolute shim target and two-slot launcher contract without using `ENTRYPOINT`, `CMD`, an environment variable, image label, or package field as a bootstrap selector.
- Every image begins with an empty `/openkit/config`, accepts exactly one canonical package import before Context materialization and bootstrap, and exposes no generic config root, package selector, alternate destination, or export path.

## Alternatives Considered

### Three Fully Duplicated Dockerfiles

Rejected because the current images already repeat the shim build, user layout, launcher, base packages, and runtime contract, while the requested complete development environment would multiply the same maintenance and verification work three times.

### Fourth Published OpenKit Worker Base Image — Superseded 2026-08-12

Originally rejected because no deployment or AgentManifest selected such an artifact, so an internal multi-stage build boundary removed repetition without adding a release artifact, compatibility promise, vulnerability-scanning unit, or user choice.

That rejection is superseded because its single stated premise is now false rather than merely outweighed. Users and secondary developers select the artifact directly as the public extension base. The costs named in the original rejection were correctly identified and are now accepted rather than disputed — the release artifact, the compatibility surface, the vulnerability-scanning unit, and the user-visible choice all become real, and Version And Maintenance Lifecycle above states what that obliges. The repository `test-env` image is not that consumer. The alternative that remains rejected is the one this entry was actually protecting against: publishing a base with no consumer.

### Repository Development Image As A Fifth Target Here

Not selected. `test-env` is an internal sibling with its own Dockerfile and is not a target in this product Dockerfile. Mixing a repository-operation artifact into this specification's release matrix would still be a coupling cost. The published catalog may grow through a reviewed specification and catalog change; there is no no-fifth-image prohibition. The later internal dogfood image is a `kind: test` non-published class, not a fifth published product image.

### Bake mise Toolchain Supply Hosts Into The Built-In Development Grants

Rejected because it would make the baseline authorize language distribution servers, release archive hosts, and registry mirrors for every worker, whether or not that worker provisions anything. That is the hidden shared allowlist `docs/specs/20260703-agent_manifest_aep_resolution.md` already forbids. A workload that provisions a toolchain declares its supply hosts as exact grants in its own authored manifest.

### One Universal Image Containing All Agents

Not a ban. Combining Codex, OpenCode, and Pi into one published artifact would couple their release cadences and enlarge the supply surface every consumer inherits. Those costs are why the current leaves remain separate singular facts, not a platform rule that an image contain exactly one runtime. A later reviewed multi-runtime artifact remains possible and must migrate singular `runtime` catalog metadata together with CI, preflight, and OCI-label consumers in the same change.

### Bake The Upstream OpenShell Policy Into Every Image

Rejected because that policy contains wider agent and endpoint authority than OpenKit declares, and image-owned authorization would conflict with the immutable AgentManifest-to-AEP boundary.

### Allow Arbitrary Internet Access For Development Convenience

Rejected because installed diagnostic and package tools do not justify an unbounded exfiltration and supply-chain channel. Exact present-use grants preserve a useful default while keeping network authority inspectable and removable.

## Consequences

The three current leaves become larger than their previous runtime-only forms, but every supported Worker Agent receives the same predictable development environment and maintenance becomes one common-stage update plus small runtime leaves. Some dependency installers will still fail when their packages fetch undeclared secondary hosts; the correct response is an explicit narrow manifest grant for a real workload, not a hidden backend default or unrestricted curl policy.

Publishing the base adds one release artifact, one vulnerability-scanning unit, one more two-architecture build, and a user-visible choice that did not exist before. In exchange the external extension path is named and smoked by the throwaway derived-image check. The narrower consequence to expect is a support question this specification now invites and previously did not, namely what a derived image may assume about its base; Version And Maintenance Lifecycle answers it in one direction only, that a refresh may not silently reduce the baseline.

mise makes a declared toolchain provisionable without a new image, and it does not make an arbitrary repository buildable. A task whose toolchain supply hosts are not granted fails at the network boundary, which is the designed outcome rather than a gap, and a task requiring a container runtime is not served by mise at all. That second case remains unowned by any specification.
