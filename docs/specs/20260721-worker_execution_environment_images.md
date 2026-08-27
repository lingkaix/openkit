---
status: Accepted
implementation: Partial
updated: 2026-08-12
---
# Worker Execution Environment Images

## Owns

This specification owns the common execution-environment baseline for the supported Worker Agent images, the published common base artifact and what extending it does and does not confer, the shared multi-target Docker build shape, the empty image-private package-config root and fixed helper destination, the exact separation between installed image capabilities and runtime authorization, the built-in development network grants projected through AgentManifest and AEP, and the image-level verification required before Codex, OpenCode, or Pi is treated as a complete supported worker environment.

## Does Not Own

This specification does not own Worker Agent behavior, native adapter command or result translation, scheduler placement, Runtime Epoch lifecycle or transport, provider routing, credential resolution, generic AgentManifest or AEP schema semantics, OpenShell implementation internals, arbitrary internet access, deployment credentials, browser automation, additional language ecosystems, or a universal worker runtime.

It does not own the content, tool baseline, verification, or release lifecycle of a non-published attempt image. It owns only the boundary statement below: that such images exist outside its four published artifacts, and exactly what it does and does not guarantee about them.

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

OpenKit publishes three deployment worker images because Codex, OpenCode, and Pi are three independently versioned runtime supplies, and it builds them from one common stage because they need the same complete Node.js and Python development environment, Unix tooling, non-root filesystem contract, and OpenKit worker shim. It publishes that common stage as a fourth artifact because extension is the answer to every workload the baseline does not carry, and an extension point nobody can name is not an extension point.

The image answers which binaries and writable locations exist. The authored AgentManifest answers which of those binaries may reach which external endpoint. NanoCore resolves that declaration into the immutable AEP, and the NanoHost materializes it through stock OpenShell and Sandbox Integration as the exact launch policy. No Docker layer, image label, backend default, process environment variable, or bundled policy file may add network or credential authority.

## Principles

- Publish exactly `worker-common`, `worker-codex`, `worker-opencode`, and `worker-pi`; `worker-common` is the base artifact that the other three and every external derivation extend, and no fifth image is published.
- Publish `worker-common` because it now has consumers that select it directly: the repository's own derived development environment, owned by `docs/toolchain.md`, and any user or secondary developer building a customized Worker Agent sandbox image. Extension through a derived Dockerfile is the supported path for a toolchain the baseline does not carry.
- Use one repository-owned multi-target Dockerfile with one published common runtime stage and one final target per supported runtime.
- Install one native Agent runtime in each final image and fail smoke verification when another supported native runtime is present.
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
                                                        (repository development
                                                         image; user or
                                                         secondary-developer image)
```

The three final targets are derivations inside this Dockerfile. An external derivation is any image built `FROM` the published base in a Dockerfile this specification does not own, including the repository's own development image. The repository deliberately builds its development image that way rather than as a fifth target here, so that the extension path a user depends on is the same path the repository itself walks, and a defect in it is discovered here rather than by the first external consumer.

`containers/images.json` records the same Dockerfile for all four worker entries and a unique required build target for each entry. Repository build scripts and release CI must consume that target; a manifest target that is missing, duplicated, or inconsistent with the image id is invalid.

The common stage is a published artifact and a build boundary. It is tagged, published, digest-addressable, and extensible by a derived Dockerfile, and that extension path is the supported way to add a toolchain this baseline does not carry. Publishing it does not make it a complete worker environment: it installs no native Agent runtime, so it cannot host a governed Worker Agent, and an AgentManifest that selects it directly fails the launch precondition closed under `docs/specs/20260616-agent_environment_package.md` and `docs/specs/20260802-nanohost_runtime_and_transport.md` rather than launching a worker with no runtime. What extending it confers is the tool and filesystem baseline below and nothing else; a derived image receives no network, credential, or filesystem authority from its base, because authority comes only from the authored AgentManifest resolved into the immutable AEP.

## Common Development Environment

The accepted baseline as of 2026-07-21 is:

| Capability | Pinned baseline | Installation authority |
| --- | --- | --- |
| OS and Node.js | `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` | Official multi-architecture Node.js image |
| npm | Version bundled with the pinned Node.js image | Official Node.js image |
| pnpm | `10.33.3` | Corepack, aligned with the repository `packageManager` field |
| Python | CPython `3.14.6` | Installed by pinned uv into an immutable image path |
| uv and uvx | `0.11.30`, source image `ghcr.io/astral-sh/uv:0.11.30@sha256:93b61e21202b1dab861092748e46bbd6e0e41dd84f59b9174efd2353186e1b47` | Official uv multi-architecture image |
| GitHub CLI | `2.96.0` | Official release archive with architecture-specific SHA-256 verification |
| Codex | `0.144.1`, Codex image only | Pinned native package |
| OpenCode | `1.18.1`, OpenCode image only | Pinned native package |
| Pi | `0.80.7`, Pi image only | Pinned native package |

The common OS tool set is `bash`, `build-essential`, `ca-certificates`, `curl`, `dnsutils`, `fd-find`, `file`, `git`, `iproute2`, `iputils-ping`, `jq`, `lsof`, `nano`, `net-tools`, `netcat-openbsd`, `openssh-client`, `pkg-config`, `procps`, `ripgrep`, `tar`, `tini`, `traceroute`, `unzip`, `vim`, and `xz-utils`. The image must expose the Debian `fdfind` binary through the conventional `fd` command.

The common language surface must expose `node`, `npm`, `npx`, `corepack`, `pnpm`, `python`, `python3`, `pip`, `pip3`, `uv`, and `uvx` on `PATH`. Python package writes go to the seeded `/sandbox/.venv`, and Node package caches and user configuration remain under `/sandbox` through the non-root home.

The common stage also exposes `mise` on `PATH` as the workspace-local toolchain provisioner. It is installed at an exact pinned version from an integrity-verified upstream release, as a root-owned immutable binary under the same rule as every other image-level supply, and its exact pin joins the baseline table above in the change that installs it. Everything it provisions is written under the writable non-root home, so a provision is a workspace-local effect that leaves the image-level supply unmutated: the pinned Node.js, Python, uv, and package managers above remain what the image guarantees, and a task repository declaring a different Node in its own `.mise.toml` receives it beside them rather than in place of them. This exists so a task repository whose toolchain the baseline does not carry can be served without a derived image and without a rebuilt sandbox.

Installing mise grants no network authority, exactly as installing `curl` or `git` grants none. Every host a provision would fetch from — a language distribution server, a release archive host, a registry mirror — is denied until an authored AgentManifest names it as an exact grant, and the built-in development grants below do not name any of them. A provision against an ungranted host therefore fails as a denied network operation rather than silently succeeding, and the correct response is an authored grant for a real workload, never a hidden backend default. mise consequently does not make an arbitrary task repository buildable inside a sandbox; it makes a declared toolchain provisionable once its supply hosts are granted.

The image must create writable `/sandbox`, `/workspace`, an empty `/openkit/config`, `/openkit/session`, `/openkit/artifacts`, the Python virtual environment, and normal user cache/config directories before switching to `sandbox`. No attempt package is baked into `/openkit/config`. System runtime directories, the shared shim deployment, the immutable Python installation, and native Agent runtime installations remain owned by root and are not writable by the worker.

`npm` audit, funding, update-notifier, and Agent auto-update behavior are disabled in the image because they create undeclared network effects and version drift. A worker may install task dependencies into writable workspace or user locations, but it may not mutate the image-level runtime supply.

## Runtime-Specific Final Images

Every final image inherits the common environment and adds only its pinned native Agent runtime, runtime-specific immutable files, labels, and smoke command. Each image installs the fixed absolute `/usr/local/bin/openkit-worker-shim` bootstrap target and shared sanitized launcher. The OpenShell driver replaces image `ENTRYPOINT` and `CMD` with its inert sandbox command, so NanoHost starts the governed worker only through the runtime owner's fixed timeout-zero unary `ExecSandbox` request for `/usr/local/bin/openkit-worker-shim --package /openkit/config/package.json` in `/workspace`; image metadata, package content, configuration, and caller input cannot select that command.

The fixed image helper preserves the ten existing workspace import identities and adds one separate image-private prerequisite: only `reference.import` with literal identity `package-config` and literal relative path `package.json` may create `/openkit/config/package.json`. It uses the existing no-follow, no-overwrite, mode-`0600`, fsync, atomic-placement, clean-zero-exit, and fixed value-free failure boundary. Adjacent identity or path, export, another config destination, caller or image-metadata selection, a baked package, and a generic configuration-file surface are prohibited.

The bootstrap Start environment contains only the six existing non-secret lineage entries and no raw route credential. The unary request's stdin is exactly 88 bytes: two distinct 43-character tokens, each followed by one newline, then request EOF before execution. This remains within the pinned whole-message 1,048,576-byte server cap. The launcher rejects absent, malformed, oversized, duplicate, equal, extra, or trailing input with fixed value-free errors, projects the worker-control token only on descriptor 3, and preserves the independently generated inference token only through the already-authorized sanitized `OPENKIT_WORKER_INFERENCE_TOKEN` native-Agent binding. It otherwise preserves only the existing bounded OpenKit route bindings, proxy variables supplied by OpenShell, locale and terminal variables, the common development `PATH`, Python virtual-environment variables, TLS variables, and user identity variables. Worker-control and capability tokens MUST NOT enter the native Agent environment; capability remains disabled. Only the historical Pi adapter passed `ANTHROPIC_API_KEY`, and that permission was selected by an immutable Pi image marker rather than a caller-controlled environment switch.

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

The three repository-owned AgentManifest templates author the same common development grants. Repetition across the three manifests is intentional because each manifest is the complete authority for its selected image; the backend must not infer or merge a shared hidden allowlist.

| Grant | Endpoint | Exact access | Authorized binaries |
| --- | --- | --- | --- |
| GitHub Smart HTTP read | `github.com:443` | `GET /**/info/refs*` and `POST /**/git-upload-pack` | `/usr/bin/git` |
| GitHub REST read | `api.github.com:443` | OpenShell `read-only` REST access | `/usr/local/bin/gh` |
| npm package read | `registry.npmjs.org:443` | OpenShell `read-only` REST access | Node, npm, npx, pnpm, and pnpx paths declared by the manifest |
| PyPI index read | `pypi.org:443` | OpenShell `read-only` REST access | uv and the writable virtual-environment Python and pip paths declared by the manifest |
| PyPI artifact read | `files.pythonhosted.org:443` | OpenShell `read-only` REST access | The same Python tool paths |

The Git grant deliberately omits `POST /**/git-receive-pack`, so clone, fetch, and pull are available while push is denied. The common baseline does not authorize `curl`, `ping`, `dig`, `nslookup`, `nc`, `traceroute`, a browser, or an Agent runtime against arbitrary internet hosts. It does not authorize Git SSH, Git LFS, release assets, deployment APIs, package registries other than npm and PyPI, private network addresses, or direct LLM endpoints other than the separately declared Pi provider route.

An authored AgentManifest may add a narrower present-use grant when the generic sandbox policy permits it. Missing endpoints fail as a denied network operation, unsupported exact-rule shapes fail before sandbox creation, missing declared binaries fail manifest validation, and backend inability to enforce a grant blocks launch rather than widening access.

## Non-Published Attempt Images

The execution runtime may run a sandbox from an image that is not one of the four artifacts published here: content retrieved from a declared public registry, or an image built for one attempt from an Agent Environment Package build definition. That path is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md` and `docs/specs/20260616-agent_environment_package.md`. This section exists so that its relationship to the published baseline is stated rather than assumed.

What this specification continues to guarantee applies only to its published artifacts. `worker-codex`, `worker-opencode`, and `worker-pi` remain the only supported deployment images, because they are the only ones carrying a native Agent runtime; `worker-common` joins them as a published artifact subject to the acceptance predicates, smoke verification, release matrix, and environment-refresh lifecycle here, without becoming a deployment image. An attempt image is none of these.

What this specification does **not** guarantee about an attempt image:

- It is not published, not tagged as a repository image, and not selectable as a deployment image. It never becomes a published artifact, and it never enters `containers/images.json`, the release build matrix, the two-architecture release evidence, or the vulnerability-scanning unit. An attempt image built `FROM` the published base is still an attempt image; inheriting from a published artifact confers none of that artifact's release identity.
- Its OS tool baseline, language ecosystems, pinned versions, writable layout, and virtual-environment seeding are not covered by the common development environment defined here. A worker running in an attempt image may lack any part of that baseline.
- No acceptance predicate, verification step, or environment-refresh obligation in this specification applies to it, and release evidence here proves nothing about it.

What holds for every image class, published or not:

- Authority comes only from the authored `AgentManifest` resolved into the immutable AEP and materialized as the exact launch policy. Installed binaries, image labels, layers, and bundled files confer no network, credential, or filesystem authority in an attempt image any more than they do in a published one.
- Hosting a governed Worker Agent requires the worker runtime contract that the final images here satisfy — the shared shim at its declared path, the non-root `sandbox` user, and the writable locations the shim and worker require. That contract is a launch precondition owned by `docs/specs/20260616-agent_environment_package.md` and `docs/specs/20260802-nanohost_runtime_and_transport.md`, which fail a launch closed when it cannot be satisfied. This specification neither imposes it on an attempt image nor verifies it, and states it here only so nobody reads the exclusions above as permission to launch a governed worker from an image that cannot host one.

The closed publishing rule is unaffected: an attempt image is not published, so it creates no exception to `Publish exactly worker-common, worker-codex, worker-opencode, and worker-pi`. What it is an exception to is the narrower assumption that every sandbox image is one of the three deployment images.

## Version And Maintenance Lifecycle

Direct release inputs use exact versions and integrity verification. The Node and uv multi-architecture source images are digest-pinned, GitHub CLI archives are verified with the upstream per-architecture SHA-256 values, and all three Agent runtime versions remain explicit build arguments whose defaults match `containers/images.json`, the built-in manifests, and static tests.

An environment refresh is one reviewed maintenance change that updates source versions or digests, updates this baseline table and the image catalog, adds or adjusts version assertions first, builds both supported architectures through release CI, smokes the base image and all three final images, and repeats stock OpenShell create, AEP upload, shim dry-run, and delete verification. A changed apt package set is accepted only through a rebuilt final image digest and the same verification; no running sandbox updates its image-level supply in place.

If one native runtime cannot build on a supported architecture, only that final image is unavailable; the base image and other two runtime artifacts remain valid. If the base image fails, all four builds fail.

Publishing the base makes every refresh of the common stage a change to a released artifact that external derivations inherit, which is the cost this specification previously declined to pay and now accepts for the consumers named in Principles. The release identity, tag, digest, and label rules that cost brings are not restated here: `worker-common` is an ordinary `release: true` entry in `containers/images.json` and takes them unchanged from `docs/specs/20260708-container_image_packaging.md`. What is owned here is narrower: a refresh MUST NOT reduce the baseline a derivation already relies on without the same reviewed maintenance change, because a derived Dockerfile states what it adds and cannot state what its base removed. A stale local tag may remain cached according to AgentManifest pull policy, but a release or deployment that requires exact supply must select an immutable final image digest.

Replacing a sandbox, or recovering through a fresh Runtime Epoch after invalidation, recreates the environment from the selected final image and immutable AEP. Writable virtual-environment or user-cache changes are disposable unless an independently declared workspace/output contract captures them; this specification creates no package-cache persistence or sandbox-resume guarantee.

## Current Implementation Projection

The strict version 3 AEP currently selects exactly one reference or bounded build image form. A reference may select one of the three published deployment images through the authored reference and pull policy owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`, including the mutable development tags used by built-in templates; selecting the published base instead fails the launch precondition closed, because it carries no native runtime. A build produces one non-published attempt image: NanoHost validates and executes the bounded build, admits the verified OCI result to its Image Store, imports the exact digest into the current Runtime Epoch, and returns digest evidence without creating a published artifact. The exclusions above remain current for that attempt image.

The repository now builds `worker-codex`, `worker-opencode`, and `worker-pi` from `containers/workers/Dockerfile`, passes the required manifest target through the local build helper and both release-CI build steps, and retains only runtime-specific smoke ownership under each leaf directory. The common stage installs the accepted tool baseline, deploys one shared worker shim and sanitized launcher, creates the writable non-root layout and empty `/openkit/config`, seeds the Python virtual environment, and leaves no root-owned build state beneath `/sandbox` or `/workspace`. The helper preserves the ten workspace import identities and accepts only the exact import-only `package-config/package.json` specialization at `/openkit/config/package.json`. The NanoHost fixed unary bootstrap/response monitor, authenticated `starting` latch, exact two-slot parser, and mandatory process-group-absence barrier are implemented but remain runtime-owned rather than image-owned.

The three built-in AgentManifest templates now declare the complete common binary paths and five development grants. Config-schema accepts bounded exact `GET` or `POST` REST rules, NanoCore preserves those authored rules through resolved setup and AEP creation, trusted worker inference permits unrelated authored development grants while still rejecting direct provider credentials, and OpenShell materialization renders the exact Git wildcard rules without a hidden endpoint or `git-receive-pack`. Worker inference authority is limited to the selected adapter and its native runtime binary; unrelated runtime binaries retain only their separately authored grants.

On 2026-07-21, the current arm64 development host built and smoked all three final targets natively, then cross-built and smoked the same targets as `linux/amd64`. Every smoke ran as the non-root `sandbox` user and covered exact versions, command inventory, exact-one-runtime isolation, writable and immutable path checks, absence of baked policy, absence of root-owned writable state, and generic shim dry-run.

On 2026-08-01, historical A1 verification used stock OpenShell and Gateway `0.0.80` to create one disposable sandbox from each refreshed Codex, OpenCode, and Pi image, upload a representative AEP with exactly the five common development grants and no additional host, complete the generic shim dry run, and return zero residual containers and sandboxes through legacy whole-Cell cleanup after every case. This completes image-content acceptance only; it does not prove the target NanoHost lifecycle, stock RelayStream, nested standard HTTP/2 behavior, or route-token separation.

The current strict-version-3, NanoHost, config-schema, worker-shim, App API, Core Client, migration, build, lint, OpenAPI, and Rust package-exit checks pass. This projection records that package state only and does not claim completion of a new A1 gate.

The base-publication and mise decisions accepted on 2026-08-12 are not implemented. The common stage remains an untagged internal stage, `containers/images.json` carries three worker entries rather than four, no mise pin exists anywhere in the repository, no base-image smoke or derived-image check exists, and release CI builds three targets. Until that implementation lands, every rule above about the published base and about mise states an accepted decision rather than an observable property of this repository. This specification owns those decisions; the directory guides under `containers/` deliberately describe the repository as it stands rather than announcing the decisions, so a reader who arrives there first sees what is true today and reaches the decisions through this specification.

## Verification

L0/L1 static and contract checks must prove:

- all four worker catalog entries select one shared Dockerfile and four unique targets, and the base entry is `release: true` and carries no `runtime` selection;
- the shared common stage contains the complete tool and filesystem baseline, exact pinned direct inputs including the mise pin, the generic shim, and no native Agent runtime or baked OpenShell policy;
- no built-in AgentManifest grant names a language distribution server, release archive host, or registry mirror that exists only to serve a mise provision;
- the shared launcher accepts exactly two ordered private token lines and EOF, exposes worker control only through descriptor 3 and inference only through the sanitized inference binding, and emits only fixed value-free failures for every invalid slot shape;
- the fixed helper accepts exactly one image-private package import at `package-config/package.json`, creates only `/openkit/config/package.json` with the accepted atomic file boundary, rejects adjacent identity, path, destination, export, existing target, and baked package content, and leaves all ten workspace identities unchanged;
- each final target contains exactly its selected native runtime, expected immutable binary paths, labels, and runtime-specific smoke command;
- repository build helpers and release CI pass the manifest target to Docker;
- every built-in AgentManifest declares the common tool binary paths and the five exact development grants;
- trusted-relay AEP validation accepts unrelated manifest-authored grants while still rejecting direct provider credentials, provider attachments, direct provider routes, and malformed relay rules;
- OpenShell policy rendering preserves Git Smart HTTP wildcard paths and `GET`/`POST` methods without adding `git-receive-pack` or any undeclared endpoint.

Image smoke checks must run as `sandbox` and prove the exact Node.js, Python, uv, mise, GitHub CLI, pnpm, and native Agent versions; every required command; writable workspace, session, artifact, cache, and virtual-environment paths; non-writable immutable runtime paths; absence of a baked OpenShell policy; generic shim dry-run; and exact-one-Agent-runtime isolation. The base image runs the same smoke minus the native-Agent assertions, and additionally proves that no native Agent runtime is present.

One check must build a throwaway derived image whose only instruction is `FROM` the published base plus one added tool, and prove that the added tool and the complete inherited baseline are both present. It exists to keep the external extension path exercised by the repository rather than only by its users.

Release evidence for each supported architecture must build and smoke the base image and every final target. A stock OpenShell image-compatibility check must create one disposable sandbox from every final image, upload a representative AEP containing the common grants, complete the generic shim dry run, and delete the sandbox. That isolated packaging check does not make direct CLI sandbox creation the product execution path and does not prove NanoHost lifecycle, RelayStream, nested HTTP/2, real-provider turns, route credentials, worker-control behavior, or arbitrary task success.

## Acceptance Predicates

- An operator can build all four published artifacts from one shared Dockerfile, and the base artifact carries no native Agent runtime.
- A derived Dockerfile whose only instruction is `FROM` the published base, plus one added toolchain, produces a runnable sandbox image without editing this repository, and the repository's own development image is built by exactly that path.
- An AgentManifest selecting the base directly fails the launch precondition closed rather than starting a worker with no native runtime.
- A derived image inherits the tool and filesystem baseline and inherits no network, credential, or filesystem authority from its base.
- A worker can provision a toolchain declared by its task repository through mise into its writable home, and the image-level Node.js, Python, uv, and package-manager supply is unchanged afterward.
- A mise provision whose supply host is not an authored grant fails as a denied network operation, and no built-in development grant names such a host.
- A non-root worker in any of the three images can use the complete declared Node.js, Python, Unix, source-control, build, editor, and diagnostic command baseline locally.
- The writable Python virtual environment accepts package installation when the exact PyPI grants are present.
- npm, pnpm, Git clone/fetch, and read-only GitHub CLI operations have only the endpoint and binary authority declared by the selected AgentManifest.
- Git push, arbitrary curl, private-network access, undeclared package hosts, and undeclared provider endpoints remain denied under the built-in baseline.
- Removing an AgentManifest grant removes the corresponding generated OpenShell network policy without rebuilding the image.
- Adding an executable to an image does not authorize that executable for any external endpoint.
- The three final images may release independently even though they share the common build stage.
- Two independent implementers can derive the same Docker targets, tool inventory, writable paths, authority layering, built-in grants, failure behavior, and required checks from this specification.
- Every image exposes the same fixed absolute shim target and two-slot launcher contract without using `ENTRYPOINT`, `CMD`, an environment variable, image label, or package field as a bootstrap selector.
- Every image begins with an empty `/openkit/config`, accepts exactly one canonical package import before Context materialization and bootstrap, and exposes no generic config root, package selector, alternate destination, or export path.

## Alternatives Considered

### Three Fully Duplicated Dockerfiles

Rejected because the current images already repeat the shim build, user layout, launcher, base packages, and runtime contract, while the requested complete development environment would multiply the same maintenance and verification work three times.

### Fourth Published OpenKit Worker Base Image — Superseded 2026-08-12

Originally rejected because no deployment or AgentManifest selected such an artifact, so an internal multi-stage build boundary removed repetition without adding a release artifact, compatibility promise, vulnerability-scanning unit, or user choice.

That rejection is superseded because its single stated premise is now false rather than merely outweighed. Two consumers select the artifact directly: the repository's own development environment, which `docs/toolchain.md` derives from it, and any user or secondary developer customizing a Worker Agent sandbox image. The costs named in the original rejection were correctly identified and are now accepted rather than disputed — the release artifact, the compatibility surface, the vulnerability-scanning unit, and the user-visible choice all become real, and Version And Maintenance Lifecycle above states what that obliges. The alternative that remains rejected is the one this entry was actually protecting against: publishing a base with no consumer.

### Repository Development Image As A Fifth Target Here

Rejected because it would give the repository a build path no external consumer has. The development image needs exactly what a user needs — a derived Dockerfile over the published base — and building it as a privileged internal target would leave the external extension path unexercised, which is the specific failure that publishing the base exists to prevent. It also mixes a repository-operation artifact into a product specification's release matrix; `docs/toolchain.md` owns that image and this specification owns only the base it extends.

### Bake mise Toolchain Supply Hosts Into The Built-In Development Grants

Rejected because it would make the baseline authorize language distribution servers, release archive hosts, and registry mirrors for every worker, whether or not that worker provisions anything. That is the hidden shared allowlist this specification already forbids, and it would restore exactly the inference the Built-In Development Grants section removes by repeating each manifest in full. A workload that provisions a toolchain declares its supply hosts as exact grants in its own authored manifest.

### One Universal Image Containing All Agents

Rejected because it couples runtime releases, enlarges the attack and supply surface, weakens exact-one-runtime verification, and makes image selection less truthful.

### Bake The Upstream OpenShell Policy Into Every Image

Rejected because that policy contains wider agent and endpoint authority than OpenKit declares, and image-owned authorization would conflict with the immutable AgentManifest-to-AEP boundary.

### Allow Arbitrary Internet Access For Development Convenience

Rejected because installed diagnostic and package tools do not justify an unbounded exfiltration and supply-chain channel. Exact present-use grants preserve a useful default while keeping network authority inspectable and removable.

## Consequences

The three images become larger than their previous runtime-only forms, but every supported Worker Agent receives the same predictable development environment and maintenance becomes one common-stage update plus three small runtime leaves. Some dependency installers will still fail when their packages fetch undeclared secondary hosts; the correct response is an explicit narrow manifest grant for a real workload, not a hidden backend default or unrestricted curl policy.

Publishing the base adds one release artifact, one vulnerability-scanning unit, one more two-architecture build, and a user-visible choice that did not exist before. In exchange the extension path stops being theoretical: the repository's own development image walks it, so it is exercised on every change rather than first exercised by a user. The narrower consequence to expect is a support question this specification now invites and previously did not, namely what a derived image may assume about its base; Version And Maintenance Lifecycle answers it in one direction only, that a refresh may not silently reduce the baseline.

mise makes a declared toolchain provisionable without a new image, and it does not make an arbitrary repository buildable. A task whose toolchain supply hosts are not granted fails at the network boundary, which is the designed outcome rather than a gap, and a task requiring a container runtime is not served by mise at all. That second case remains unowned by any specification.
