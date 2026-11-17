---
status: Accepted
implementation: Implemented
kind: topology
aspect: sandbox
---
# Worker Execution Environment Images

This specification owns the common Worker execution-environment baseline, the published common base, and the shared image build.

## Scope

Owns:

- The common execution-environment baseline for supported Worker Agent images.
- The published `worker-common` base and what an extension does and does not confer.
- The shared multi-target Docker build, declared-runtime-set conformance, and image verification.
- The empty image-private package-config root and the fixed helper destination.
- The separation between installed image capabilities and runtime authorization, and the pre-activation boundary for the internal dogfood image.

Does not own:

- Worker Agent behavior, adapter translation, scheduler placement, Runtime Epoch lifecycle, provider routing, and credential resolution — their runtime and adapter owners. AgentManifest and AEP schema, including copy-on-init development grants — [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md).
- OpenShell implementation internals — [OpenShell Mechanism Internalization](20260703-openshell_mechanism_internalization.md). The internal `test-env` image — [Toolchain](../toolchain.md).
- Attempt-image content and lifecycle — [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) and [Agent Environment Package](20260616-agent_environment_package.md). This specification states only the published-catalog boundary.
- A workload that requires a container runtime. mise does not provide one, and no specification in this baseline owns that workload.
- Product release composition — [Release Management](20260829-release_management.md). Catalog publishing rules — [Container Image Packaging](20260708-container_image_packaging.md).

Core:

- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Sandbox](../core/sandbox.md)
- [Agent Supply](../core/agent-supply.md)

## Inherited Volume Layout

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns generic retained-volume admission and replacement. The common base declares `/workspace`, `/sandbox` and `/openkit/threads` through OCI `Config.Volumes`, pins numeric sandbox UID/GID `1000:1000`, sets OCI `WorkingDir` to `/tmp/openkit-bootstrap` so the mount does not mask that directory, and makes `/openkit` a real directory outside retained home whose `/openkit/threads` child is retained under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md) while its other children stay ephemeral. Derived images inherit these declarations and may add validated volume targets; no file-type manifest is required. An image layout label is descriptive evidence, never permission to select another storageRef or broaden mounts/credentials.

The Dockerfile must declare persistent `/workspace`, `/sandbox` and `/openkit/threads` targets and create `/openkit` as an independent directory; `containers/workers/Dockerfile` implements those declarations. Image-level declarations and Docker preservation checks do not prove the complete NanoHost attachment/restart path; that acceptance remains with the volume owner. Fixed immutable executables, non-root containment, current AEP authority, declared runtimes, image verification and build egress rules continue unchanged. Initial volume content is seeded only from the exact selected image; later images must not overwrite existing home data to refresh software.

## Thesis

OpenKit publishes one deployment worker image, `worker-runtimes`, containing Codex, OpenCode, Pi, and DeepSeek together with the worker shim and four adapters, and it builds that image from one common stage because the runtimes need the same complete Node.js and Python development environment, Unix tooling, non-root filesystem contract, and OpenKit worker shim. It publishes that common stage as `worker-common`, an empty declared-runtime-set artifact, because extension is the answer to every workload the baseline does not carry, and an extension point nobody can name is not an extension point. The costs of one image, a coupled release cadence, a larger supply surface, and a failure of any runtime failing the deployment image, are accepted.

Every published worker image contains exactly its declared runtime set, whose cardinality may be zero, one, or many. `worker-common` is the empty set. The current repository deployment set contains the four runtimes. The deployment image's declared set is `codex`, `pi`, `opencode`, and `deepseek`. `worker-codex`, `worker-opencode`, and `worker-pi` are removed and are not aliases. Catalog field `runtimes` is a non-empty JSON array on the deployment image and is omitted on the empty base. CI, preflight, and OCI-label consumers change together in the same reviewed change. This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)). `AgentManifest` and AEP `control.adapter.targetRuntime` select exactly one adapter per session. Image contents confer no authority.

The image answers which binaries and writable locations exist. The authored AgentManifest answers which of those binaries may reach which external endpoint. NanoCore resolves that declaration into the immutable AEP, and the NanoHost materializes it through stock OpenShell and Sandbox Integration as the exact launch policy. No Docker layer, image label, backend default, process environment variable, or bundled policy file may add network or credential authority.

## Principles

- Publish the current catalog set `worker-common` and `worker-runtimes`. The set may grow through a reviewed specification and catalog change. There is no no-fifth-image or universal-image prohibition.
- Publish `worker-common` because users and secondary developers select it directly as the public end-user extension base. The repository `test-env` image is an internal sibling that pins the same upstream Node digest and is not a consumer of the published base.
- Use one repository-owned multi-target Dockerfile with one published common stage and one deployment target, `worker-runtimes`.
- Install exactly the catalog-declared runtime set in each image and fail smoke verification when an undeclared first-party Agent CLI is present. The deployment image's declared set is the four runtimes. The common stage contains none of them. Mutual absence of an undeclared CLI remains declared-set conformance.
- Keep the common stage free of Codex, OpenCode, Pi, DeepSeek, `pi-mcp-adapter`, provider credentials, OpenShell policy YAML, and product-state logic.
- Pin direct binary and image inputs to exact versions and digests while allowing Debian security package revisions to refresh during an explicit image rebuild.
- Run the worker and its native runtime as the non-root `sandbox` user.
- Give the worker broad access to installed local tools while keeping filesystem and network authority default-deny outside the AEP.
- Treat diagnostic tool installation as local capability, not permission to probe arbitrary public or private networks.
- Install mise in the common stage as the workspace-local toolchain provisioner, so a task repository declaring its own toolchain is served without a new image, and treat it as local capability under the rule above: it provisions tools, it confers no network authority, and every host it would fetch from is denied until an authored AgentManifest grant names it.
- Keep the common environment small enough to explain and smoke in one place; additional ecosystems enter only for a current supported workload, and a workload-specific toolchain belongs in a derived image or a workspace-local mise provision rather than in this baseline.

## Image Topology

The repository stores the shared worker Dockerfile and common launcher under `containers/workers/`. The deployment image's smoke script and operator notes live under `containers/worker-runtimes/`. The former `containers/worker-codex/`, `containers/worker-opencode/`, and `containers/worker-pi/` leaves are removed.

```text
containers/workers/Dockerfile
  worker-shim-builder
        |
        v
  worker-common  (published base artifact)
        |
        +-------------------------------+
        |                               |
        v                               v
  worker-runtimes                 external derivation
  (sole deployment image)         (user or
                                   secondary-developer image)
```

The deployment target is a derivation inside this Dockerfile. An external derivation is any image built `FROM` the published base in a Dockerfile this specification does not own. The repository `test-env` image is not that derivation: it is an internal sibling that pins the same upstream Node digest independently, owned by `docs/toolchain.md`, and it is not a base consumer. The throwaway derived-image proof in `scripts/docker/smoke-image.sh` exercises the external `USER root` then `USER sandbox` extension path.

`containers/images.json` records the same Dockerfile for the worker entries and a unique required build target for each entry. Repository build scripts and release CI must consume that target; a manifest target that is missing, duplicated, or inconsistent with the image id is invalid. The deployment entry is id `worker-runtimes`, repository `openkit-worker-runtimes`, Dockerfile target `worker-runtimes`, local tag `openkit/worker-runtimes:dev`, smoke `containers/worker-runtimes/smoke.sh`, and smoke command `openkit-worker-runtimes-smoke`. An example release reference is `ghcr.io/<github-owner>/openkit-worker-runtimes:v0.0.1`. Catalog `runtimes` is a non-empty JSON array for the deployment image, ordered `codex`, `pi`, `opencode`, `deepseek`, and is omitted for the empty declared set. OCI label `org.openkit.worker.runtimes` carries those identifiers joined by commas in that order with no spaces, because an OCI label value is one string. `org.openkit.worker.contract` stays. `workerContract` stays `openkit-worker-v1`. Whether the control-protocol owner bumps that string is that owner's question, and this specification does not invent a bump. CI, preflight, and OCI-label consumers, including `apps/nanocore/src/docker/container-images-manifest.test.ts`, change together in the same reviewed change. The repository catalog file no longer lists `worker-codex`, `worker-opencode`, or `worker-pi`. They are not aliases.

The common stage is a published artifact and a build boundary. It is tagged, published, digest-addressable, and extensible by a derived Dockerfile, and that extension path is the supported way to add a toolchain this baseline does not carry. Publishing it does not make it a complete worker environment: its declared runtime set is empty, so it cannot host a governed Worker Agent, and an AgentManifest that selects it directly fails the launch precondition closed under `docs/specs/20260616-agent_environment_package.md` and `docs/specs/20260802-nanohost_runtime_and_transport.md` rather than launching a worker with no selected adapter. What extending it confers is the tool and filesystem baseline below and nothing else; a derived image receives no network, credential, or filesystem authority from its base, because authority comes only from the authored AgentManifest resolved into the immutable AEP. A derived Dockerfile must regain `USER root` to install additions and then return to `USER sandbox`.

A user-derived image may supply ordinary native runtime configuration, instructions, resource roots and default trees for each runtime it actually provides. The selected adapter owns and documents the qualified native source selection and precedence; an image author need not know internal Thread directory hashes. Prefer native separate-source layering; where unavailable, the adapter initializes only a fresh private home from the image-designated native tree under Persistent Worker Volumes. No OpenKit-specific profile schema or mandatory package set is introduced.

Default resources intended to remain image-owned reside outside retained mounts; native mutable state and authored configuration remain in the admitted private retained home. Existing homes are never synchronized or reseeded to apply a later image's defaults. A missing designated source or unsafe/unrepresentable native mechanism fails qualification visibly. An image carrying files at a native-looking path is not proof that the adapter loads them.

A derived image preserves the fixed launcher/shim contract, admitted non-root identity, storage/control separation and supported adapter closure. It cannot use ENTRYPOINT, CMD, a default tree or a configuration file to select another bootstrap, current conversation, credential or external authority. Native sources and startup flags are documented only after the selected pin proves them; this specification does not guess a universal template path or environment selector.

The decision and its reason are recorded in [a decision record](../decisions/20260930-adapters_honor_native_configuration.md).

## Common Development Environment

The current image baseline is below. Version pins in this table are current defaults.

| Capability | Pinned baseline | Installation authority |
| --- | --- | --- |
| OS and Node.js | `node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68` | Official multi-architecture Node.js image |
| npm | Version bundled with the pinned Node.js image | Official Node.js image |
| Corepack | `0.36.0` (current default) | Independent install of the pinned Corepack. The Node image does not supply it. |
| pnpm | `10.33.3` | Corepack, aligned with the repository `packageManager` field |
| Python | CPython `3.14.6` | Installed by pinned uv into an immutable image path |
| uv and uvx | `0.11.30`, source image `ghcr.io/astral-sh/uv:0.11.30@sha256:93b61e21202b1dab861092748e46bbd6e0e41dd84f59b9174efd2353186e1b47` | Official uv multi-architecture image |
| GitHub CLI | `2.96.0` | Official release archive with architecture-specific SHA-256 verification |
| mise | `2026.8.14` | Official release binary with architecture-specific SHA-256 verification |
| Codex | Established by the Codex adapter slice, not guessed here | Deployment image only |
| Pi | Established by the Pi adapter slice, not guessed here | Deployment image only |
| OpenCode | Established by the OpenCode adapter slice, not guessed here | Deployment image only |
| DeepSeek | Established by the DeepSeek adapter slice, not guessed here | Deployment image only |
| Pi SDK host and native MCP/tool-search closure | Workspace-patched SDK and exact versions owned by Pi Worker Adapter; no community MCP adapter | Deployment image only |

Current default runtime pins are the version manifest under `containers/worker-runtimes/`. Versions examined before those pins are historical inputs, not missing deployment pins. The repository deployment image does not install `pi-mcp-adapter`. The accepted Pi slice uses its own specification's workspace-patched native SDK closure.

The common OS tool set is `bash`, `build-essential`, `ca-certificates`, `curl`, `dnsutils`, `fd-find`, `file`, `git`, `iproute2`, `iputils-ping`, `jq`, `lsof`, `nano`, `net-tools`, `netcat-openbsd`, `openssh-client`, `pkg-config`, `procps`, `ripgrep`, `tar`, `tini`, `traceroute`, `unzip`, `vim`, and `xz-utils`. The image must expose the Debian `fdfind` binary through the conventional `fd` command.

The common language surface must expose `node`, `npm`, `npx`, `corepack`, `pnpm`, `python`, `python3`, `pip`, `pip3`, `uv`, and `uvx` on `PATH`. The base Python environment lives under immutable `/opt` under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md); Python package writes go to a user-created environment inside a declared data target such as `/sandbox`, and Node package caches and user configuration remain under `/sandbox` through the non-root home.

The common stage also exposes `mise` on `PATH` as the workspace-local toolchain provisioner. It is installed at an exact pinned version from an integrity-verified upstream release, as a root-owned immutable binary under the same rule as every other image-level supply, and its exact pin is the mise row in the baseline table above. Everything it provisions is written under the writable non-root home, so a provision is a workspace-local effect that leaves the image-level supply unmutated: the pinned Node.js, Python, uv, and package managers above remain what the image guarantees, and a task repository declaring a different Node in its own `.mise.toml` receives it beside them rather than in place of them. This exists so a task repository whose toolchain the baseline does not carry can be served without a derived image and without a rebuilt sandbox.

Installing mise grants no network authority, exactly as installing `curl` or `git` grants none. mise does not provide a container runtime. A workload that needs a container runtime is outside this specification. Every host a provision would fetch from — a language distribution server, a release archive host, a registry mirror — is denied until an authored AgentManifest names it as an exact grant, and the copy-on-init built-in development grants owned by `docs/specs/20260703-agent_manifest_aep_resolution.md` do not name any of them. A provision against an ungranted host therefore fails as a denied network operation rather than silently succeeding, and the correct response is an authored grant for a real workload, never a hidden backend default. mise consequently does not make an arbitrary task repository buildable inside a sandbox; it makes a declared toolchain provisionable once its supply hosts are granted.

The image must create writable `/sandbox`, `/workspace`, an empty `/openkit/sessions`, an empty `/openkit/threads`, `/openkit/artifacts`, and normal user cache/config directories before switching to `sandbox`. `/openkit/sessions` holds disposable AgentSession inputs; `/openkit/threads` holds retained Thread/runtime native data and exact Turn captures under [Worker Runtime Sub-Agent Provenance](20260711-worker_runtime_subagent_provenance.md#2-runtime-provenance-capture). No attempt package is baked into `/openkit/sessions`. System runtime directories, the shared shim deployment, the immutable Python installation, and native Agent runtime installations remain owned by root and are not writable by the worker.

`npm` audit, funding, update-notifier, and Agent auto-update behavior are disabled in the image because they create undeclared network effects and version drift. A worker may install task dependencies into writable workspace or user locations, but it may not mutate the image-level runtime supply.

## Deployment Image

The deployment image inherits the common environment and adds the four pinned native Agent runtimes, the shim, the four adapters, and Pi's dedicated SDK host with the workspace-patched production dependency closure required by Pi Worker Adapter. Pi uses that pin's native MCP and native tool search; the repository deployment image does not install pi-mcp-adapter. worker-common contains none of the four native runtimes, the Pi SDK host or the community MCP adapter. The image installs the fixed absolute `/usr/local/bin/openkit-worker-shim` bootstrap target and shared sanitized launcher. The OpenShell driver replaces image `ENTRYPOINT` and `CMD` with its inert sandbox command, so NanoHost starts the governed worker only through the runtime owner's fixed timeout-zero unary `ExecSandbox` request for `/usr/local/bin/openkit-worker-shim` with no arguments and ignored stdin in `/workspace`; image metadata, package content, configuration, and caller input cannot select that command or carry a Turn credential. A zero bootstrap request timeout is not a zero overall control or liveness deadline.

Pi discovery behavior belongs to Pi Worker Adapter: the host loads native tool search with additive activation, retains native MCP ownership and direct managed-server exposure, and does not load native codemode script composition at the current pin. Packaging must preserve the built host's patched dependency closure and private loader/transport imports. A plain global Pi CLI installation, a community adapter, or a successful CLI version command is not equivalent to the SDK host. Search-only operation requires no codemode worker execution; do not strip transitive package assets from the supported production closure merely because that feature is not active.

The decision and its reason are recorded in [a decision record](../decisions/20260930-pi_native_mcp_discovery.md).

Worker image builds embed the same immutable release identity as the App and label the OCI revision/version from those build arguments. The envelope lives in a root-owned file outside writable/retained volumes, with no runtime environment override. Release candidate construction supplies exact `OPENKIT_SOURCE_COMMIT` and `OPENKIT_RELEASE_TAG` to both App and Worker builds. An untagged local build supplies its exact source commit and omits the tag; an unknown build is not compatible. NanoHost’s existing immutable `image.inspect` returns that label provenance, and Core checks it against its known boot identity before Worker storage attachment/material delivery, including resident reuse. The bound private poll must independently carry the matching image-file identity before Core returns readiness or any command. These are release-coupled compatibility checks under [Worker Control Protocol](20260703-worker_control_protocol.md), not new authority, a retained AEP field, or an SDK/schema-version compatibility fallback.

Public image preparation and activation report a trusted release incompatibility as `worker_release_incompatible` with status 409 and a fixed safe message. A primary incompatibility before material delivery retains that code in the governed Turn’s existing terminal error field. Cancellation and unknown cleanup retain their existing precedence; an arbitrary peer-supplied error code is not a trusted incompatibility.

The fixed image helper preserves the ten existing sandbox file-import identities and adds one separate AgentSession-private input. It also has constrained `worker-supply` and `runtime-credential` namespaces. Those ten slots plus package-config are not the whole helper namespace set. Executable imports and replace behavior stay purpose-restricted. Exact credential and supply semantics stay with their runtime and supply owners. The package-config rule is: only `reference.import` with literal identity `package-config` and the closed relative path `<agent-session-id>/config/package.json` may create `/openkit/sessions/<agent-session-id>/config/package.json`. It uses the existing no-follow, no-overwrite, mode-`0600`, fsync, atomic-placement, clean-zero-exit, and fixed value-free failure boundary. Adjacent identity or path, export, another config destination, caller or image-metadata selection, a baked package, and a generic configuration-file surface are prohibited.

The fixed zero-argument bootstrap Start environment contains only the bounded trusted bootstrap environment and no AgentSession, Turn, package, or raw route credential; its unary stdin is empty and reaches EOF before execution. The launcher starts only the shared Sandbox Integration supervisor. Upstream inference and capability tokens stay inside Integration. The native child receives two session-local loopback credentials minted at `session.open`, one for inference and one for capability, and never holds `OPENKIT_WORKER_INFERENCE_TOKEN` or `OPENKIT_WORKER_CAPABILITY_TOKEN`. Worker control remains inside the Worker Shim control client. Private `turn.start` route-token delivery remains runtime-owned rather than image-owned ([resident request attribution](../decisions/20260930-resident_request_attribution.md)). The sanitized launcher retains its bounded bootstrap environment and `env -i`; arbitrary image or user native settings cannot alter its fixed executable/interpreter or control bindings. Verified Config.Env supplies only digest-bound read-only defaults to NanoCore's native environment resolution. The native child receives the admitted public map through `session.open`, not by package-specific launcher allowlists, host-environment inheritance or an editable OpenShell environment store. Installing or setting a variable grants no endpoint, credential, filesystem, model or external-tool authority. The image has no `/usr/local/lib/openkit/allow-anthropic-api-key` carrier. Runtime-env credentials follow [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape); the bootstrap launcher does not inherit `ANTHROPIC_API_KEY`.

The decision and its reason are recorded in [a decision record](../decisions/20260930-native_environment_managed_outside_the_sandbox.md).

Codex retains its writable home and governed Node proxy behavior required by the optional runtime-provenance extension. Those remain Codex-specific and are not a property every runtime imitates. OpenCode retains the invariant that `/etc/opencode` is absent until a V2 proof shows explicit private configuration cannot be overridden. Direct Anthropic provider projection is historical and is not current image guidance.

## Authority Layers

The complete launch contract has three non-overlapping layers:

| Layer | Owns | Must not own |
| --- | --- | --- |
| Worker image | Installed binaries including the declared set of four runtimes, immutable versions, fixed shim path, local filesystem layout, non-root identity, fixed zero-argument Harness launcher, smoke command | Endpoint permission, credential generation or persistence, provider selection, Start-field selection, product state |
| AgentManifest and resolved AEP | Exact filesystem grants, exact network endpoint and binary grants, credential declarations, backend requirements, selected image | Backend-private policy syntax or hidden defaults |
| NanoHost-owned stock OpenShell and Sandbox Integration | Enforced filesystem, process, network, and distinct worker-control, inference, and capability route bindings for that immutable AEP | New authority, merged route credentials, undeclared endpoints, canonical OpenKit state |

An image must not copy `/etc/openshell/policy.yaml` or another default network policy. NanoCore must always pass the generated policy explicitly to OpenShell, and the generated policy must contain exactly the immutable authority represented by the AEP, including its fixed resolved worker-control declaration; `docs/specs/20260703-worker_control_protocol.md` owns the worker-control mechanics.

Trusted NanoCore inference is a provider-route constraint, not a claim that the package has no other network rules. A trusted-relay package must retain the exact worker-control and worker-inference rules, must remain free of direct provider credentials and direct provider endpoints, and may also carry unrelated manifest-authored development grants that do not alter the LLM route.

## Built-In Development Grants

This specification does not own the out-of-box development grant table. `docs/specs/20260703-agent_manifest_aep_resolution.md` owns the copy-on-init built-in AgentManifest development grants. Installed tools confer no authority. No mise supply host is granted. Existing manifests are unchanged by later template edits, and a missing grant fails denied.

The installed Node package tools must support scoped and unscoped npm metadata and archive downloads when the selected manifest declares the npm grant, including its encoded-slash authorization, from the grant owner. The setting is supplied by the immutable package and enforced by the backend; it is not baked into the image or inferred from an installed package manager. Updating an image or template does not opt an existing authored manifest in.

The decision and its reason are recorded in [a decision record](../decisions/20261008-encoded_slash_authority_and_release_hold.md).

## Non-Published Attempt Images

The execution runtime may run a sandbox from an image that is not one of the currently published catalog artifacts: content retrieved from a declared public registry, or an image built from an Agent Environment Package build definition or an administrator-authorized immutable environment-preparation candidate using the same definition and bounds. Preparation may precede a Worker attempt; it confers no activation, publication or workload authority. That path is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md` and `docs/specs/20260616-agent_environment_package.md`. This section exists so that its relationship to the published baseline is stated rather than assumed.

What this specification continues to guarantee applies only to its published artifacts. The supported deployment image is `worker-runtimes`. `worker-common` joins it as a published empty-set artifact subject to the acceptance predicates, smoke verification, release matrix, and environment-refresh lifecycle here, without becoming a deployment image. An attempt image is none of these. The published set may grow through a reviewed specification and catalog change.

What this specification does **not** guarantee about an attempt image:

- It is not published, not tagged as a repository image, and not selectable as a deployment image. It never becomes a published artifact, and it never enters `containers/images.json`, the release build matrix, the two-architecture release evidence, or the vulnerability-scanning unit. An attempt image built `FROM` the published base is still an attempt image; inheriting from a published artifact confers none of that artifact's release identity.
- Its OS tool baseline, language ecosystems, pinned versions, writable layout, and virtual-environment seeding are not covered by the common development environment defined here. A worker running in an attempt image may lack any part of that baseline.
- No acceptance predicate, verification step, or environment-refresh obligation in this specification applies to it, and release evidence here proves nothing about it.

What holds for every image class, published or not:

- Authority comes only from the authored `AgentManifest` resolved into the immutable AEP and materialized as the exact launch policy. Installed binaries, image labels, layers, and bundled files confer no network, credential, or filesystem authority in an attempt image any more than they do in a published one.
- Hosting a governed Worker Agent requires the worker runtime contract that the deployment image here satisfies — the shared shim at its declared path, the non-root `sandbox` user, and the writable locations the shim and worker require. That contract is a launch precondition owned by `docs/specs/20260616-agent_environment_package.md` and `docs/specs/20260802-nanohost_runtime_and_transport.md`, which fail a launch closed when it cannot be satisfied. This specification neither imposes it on an attempt image nor verifies it, and states it here only so nobody reads the exclusions above as permission to launch a governed worker from an image that cannot host one.

An attempt image is not published. That does not freeze the published catalog at its current entries. Growth still requires a reviewed specification and catalog change.

## Internal Dogfood Image

One internal `release: false` `kind: test` dogfood image may derive the published `worker-common` digest, share the exact CI development-toolchain standard, and bundle Codex plus Pi but not OpenCode. The image is not activated. It has no Dockerfile, no catalog entry, and no shared installer. It is not a published product image, it is not `test-env`, and it is not the deployment image `worker-runtimes`. Publication of `worker-common` does not activate this image and does not qualify changed image bytes.

Before activation there is no dogfood image lifecycle, durable state, retry, recovery, or dependency-failure behavior because no artifact exists. The future activating change must first accept an owner that settles all five decision classes required by root `AGENTS.md`: exact definition and exclusions; unique authority and projection boundary; creation, update, termination, retry, and recovery lifecycle; conflict, missing, stale, restart, and dependency-failure semantics; and externally observable acceptance predicates.

Future activation gates must prove declared-set conformance, two AEP-selected dry runs, and that a Codex-selected session receives no unintended provider credential, including no Anthropic key merely because Pi is installed. Shared-image selection does not confer credential authority. The image must not include NanoCore, NanoHost, Docker CLI or socket, nested containers, built-in image policy, or test-executor markers. Sandbox scope is compile and build, unit tests, and headless-browser tests. Full integration stays on external project-owned systems. There is no SSH product contract.

## Version And Maintenance Lifecycle

Direct release inputs use exact versions and integrity verification. The Node and uv multi-architecture source images are digest-pinned, GitHub CLI archives and the mise binary are verified with the upstream per-architecture SHA-256 values, and the four Agent runtime versions are explicit pins in the runtime version manifest. This specification does not guess a pin the manifest does not record. The pins match `containers/images.json`, the built-in manifests, and static tests.

An environment refresh is one reviewed maintenance change that updates source versions or digests, updates this baseline table and the image catalog, adds or adjusts version assertions first, builds both supported architectures through release CI, smokes the base image and the deployment image, and repeats stock OpenShell create, AEP upload, shim dry-run, and delete verification. A changed apt package set is accepted only through a rebuilt final image digest and the same verification; no running sandbox updates its image-level supply in place.

If any of the four runtimes cannot build on a supported architecture, the deployment image is unavailable and `worker-common` can still be valid. If the base image fails, the deployment image fails with it.

Publishing the base makes every refresh of the common stage a change to a released artifact that external derivations inherit, which is the cost this specification previously declined to pay and now accepts for the consumers named in Principles. The release identity, tag, digest, and label rules that cost brings are not restated here: `worker-common` is an ordinary `release: true` entry in `containers/images.json` and takes them unchanged from `docs/specs/20260708-container_image_packaging.md`. What is owned here is narrower: a refresh MUST NOT reduce the baseline a derivation already relies on without the same reviewed maintenance change, because a derived Dockerfile states what it adds and cannot state what its base removed. A stale local tag may remain cached according to AgentManifest pull policy, but a release or deployment that requires exact supply must select an immutable final image digest. `test-env` does not inherit that digest by derivation; a Node digest change is a sibling mirror update owned by `docs/toolchain.md`.

Replacing a sandbox, or recovering through a fresh Runtime Epoch after invalidation, recreates the environment from the selected final image and immutable AEP. The admitted inherited volume layout preserves complete writable volumes, including user-installed dependencies and unknown files, under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md). Image replacement changes immutable software; it does not reset those volumes and does not promise native-format rollback or that a live process survives. A later AgentSession may resume the exact retained conversation when the runtime and version allow. A version that cannot read the retained native data this version wrote fails resume explicitly under [AgentSession](../core/agent-session.md). This version starts from a new data root and does not read earlier-version data ([earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)).

## Native Context Configuration Supply

OpenKit may supply qualified native context settings and bounded file capabilities through the existing adapter and retained-home owners. Preserve user-supplied packages, Extensions, instructions, and MCP configuration within admitted Sandbox policy. User-installed context-mode remains user supply; OpenKit does not bundle, import, or depend on its code. [The accepted decision](../decisions/20261015-large_files_and_model_context.md) supplies the reason.

Each adapter qualifies supported loading and precedence against its selected pin. Image defaults apply to fresh homes only where native setup is copy-on-init. Preserve authored existing homes and record effective configuration rather than silently reseeding them. Native truncation or spill is a second layer; OpenKit-supplied results must already meet [bounded projection rules](20260703-worker_context_package.md#bounded-model-projection).

### Build Supply Integrity

Every image-time install, including runtime CLI supply, MUST use a committed lock file or integrity hash. Installs MUST be frozen, with scripts disabled except for independently reviewed allowlisted packages. Downloads MUST verify against committed checksums. Worker image-platform SBOMs MUST accompany releases under `SHA256SUMS`; the App sibling embeds its own SBOM for offline inventory. [Development Security](20261109-development_security.md) owns the shared controls and release provenance.

## Verification

L0/L1 static and contract checks must prove:

- all current worker catalog entries select one shared Dockerfile and unique targets, and a release worker base is identified by absent `runtimes` rather than by a reserved id;
- the shared common stage contains the complete tool and filesystem baseline, exact pinned direct inputs including the mise pin, the generic shim, and an empty declared runtime set with no baked OpenShell policy;
- no built-in AgentManifest grant names a language distribution server, release archive host, or registry mirror that exists only to serve a mise provision;
- the shared launcher accepts no arguments or stdin credentials and starts only the Sandbox Integration supervisor; private `turn.start` remains runtime-owned, upstream inference and capability tokens stay inside Integration, and the native child receives the two session loopback credentials rather than `OPENKIT_WORKER_INFERENCE_TOKEN` or `OPENKIT_WORKER_CAPABILITY_TOKEN`;
- the fixed helper accepts exactly one image-private package import at `package-config/<agent-session-id>/config/package.json`, creates only `/openkit/sessions/<agent-session-id>/config/package.json` with the accepted atomic file boundary, rejects adjacent identity, path, destination, export, existing target, and baked package content, and leaves all ten workspace identities unchanged;
- The deployment image contains exactly the four selected runtimes, the shim and four adapters, plus Pi's built SDK host with the exact patched native MCP/tool-search production closure; pi-mcp-adapter is absent from that repository artifact, and the empty-set base contains none of the native runtime or Pi-host supply.
- repository build helpers and release CI pass the manifest target to Docker;
- Every built-in AgentManifest declares the common tool binary paths and the development grants owned by [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#built-in-development-grant-templates), including explicit encoded-slash authorization on the npm grant only.
- trusted-relay AEP validation accepts unrelated manifest-authored grants while still rejecting direct Provider credentials, concrete Provider routes, and malformed relay rules;
- OpenShell policy rendering preserves Git Smart HTTP wildcard paths and `GET`/`POST` methods without adding `git-receive-pack` or any undeclared endpoint.

Image smoke checks must run as `sandbox` and prove the exact Node.js, Python, uv, mise, GitHub CLI, pnpm, and the four native Agent versions; every required command; writable workspace, session, artifact, cache, and worker-created virtual-environment paths; non-writable immutable runtime paths; absence of a baked OpenShell policy; absence of `/etc/opencode` or the proved equivalent; generic shim dry-run; Pi SDK host and patched native MCP/tool-search closure present and loadable, with pi-mcp-adapter absent; the zero-argument launcher; and declared-set conformance, including mutual absence of undeclared first-party Agent CLIs. The empty-set base runs the same smoke minus native-Agent assertions, and additionally proves that none of the Codex, OpenCode, Pi, or DeepSeek CLIs is present. The deployment smoke proves the declared set of four. The three old mutual-absence leaf smokes are not a second contract. Pi image smoke validates the actual deployed package/patch identity and host dependency resolution, including the required connection-state hook and native search factory. It does not infer the search/call or resume behavior from those imports; the adapter's real-host fixture owns that proof. Image-content smoke remains distinct from a live inference Turn and deployed Sandbox acceptance.

One check must build a throwaway derived image that starts `FROM` the local base, regains `USER root`, adds one tool, returns to `USER sandbox`, and proves that the added tool and the complete inherited baseline are both present. That check lives in `scripts/docker/smoke-image.sh`. It is not `test-env`.

Release evidence for each supported architecture must build and smoke the base image and the deployment image. A stock OpenShell image-compatibility check must create one disposable sandbox from the deployment image, upload a representative AEP containing the common grants, complete the generic shim dry run, and delete the sandbox. That isolated packaging check does not make direct CLI sandbox creation the product execution path and does not prove NanoHost lifecycle, RelayStream, nested HTTP/2, real-provider turns, route credentials, worker-control behavior, or arbitrary task success. Image smoke does not establish deployed upstream-token containment. A local or static pass is not current-release stock qualification. The combined-image acceptance row is exact pins once recorded, four adapter selections, and these probe commands. Live deployed checks stay with their owning change.

## Acceptance Predicates

The exact deployment image can run the Pi adapter's search-only SDK fixture with one native connection owner, unchanged direct managed exposure and hidden-tool exclusion, without pi-mcp-adapter or a native codemode execution path. Image smoke and adapter behavior evidence are named separately; packaging acceptance does not claim a real provider Task or deployed routing acceptance.

- An operator can build the current published artifacts from one shared Dockerfile, and the empty-set base carries no native Agent CLI.
- A derived Dockerfile that starts `FROM` the published base, regains `USER root`, adds one toolchain, and returns to `USER sandbox` produces a runnable sandbox image without editing this repository. That path is proved by the throwaway check in `scripts/docker/smoke-image.sh`, not by `test-env`.
- An AgentManifest selecting the empty-set base directly fails the launch precondition closed rather than starting a worker with no selected adapter.
- A derived image inherits the tool and filesystem baseline and inherits no network, credential, or filesystem authority from its base.
- A worker can provision a toolchain declared by its task repository through mise into its writable home, and the image-level Node.js, Python, uv, and package-manager supply is unchanged afterward.
- A mise provision whose supply host is not an authored grant fails as a denied network operation, and no built-in development grant names such a host.
- A non-root worker in the deployment image can use the complete declared Node.js, Python, Unix, source-control, build, editor, and diagnostic command baseline locally.
- A worker-created Python virtual environment under `/sandbox` accepts package installation when the exact PyPI grants are present.
- npm and pnpm can retrieve scoped and unscoped package metadata and archives with the selected manifest's explicit npm grant. npm, pnpm, Git clone/fetch, and read-only GitHub CLI operations retain exactly the selected manifest's endpoint, executable, method, path, and encoded-slash authority. Image smoke proves tool supply; deployed download and denial observations prove the network behavior under [Worker Sandbox Freedom Policy](20260709-worker_sandbox_freedom_policy.md#built-in-development-baseline).
- Git push, arbitrary curl, private-network access, undeclared package hosts, and undeclared provider endpoints remain denied under the built-in baseline.
- Removing an AgentManifest grant removes the corresponding generated OpenShell network policy without rebuilding the image.
- Adding an executable to an image does not authorize that executable for any external endpoint.
- The deployment image releases as one artifact. `worker-common` can still be published as the base. The four runtimes do not release as independent leaf images.
- Two independent implementers can derive the same Docker targets, tool inventory, writable paths, authority layering, failure behavior, and required checks from this specification, and they obtain the development grants from `docs/specs/20260703-agent_manifest_aep_resolution.md`.
- Every image exposes the same fixed absolute zero-argument Harness target without using `ENTRYPOINT`, `CMD`, an environment variable, image label, or package field as a bootstrap selector.
- Every image begins with an empty `/openkit/sessions`, accepts exactly one canonical package import per admitted Turn after exact AgentSession admission and before Context imports and native `turn.start`, and exposes no generic config root, package selector, alternate destination, or export path.

## Implementation

- `containers/workers/` — shared worker Dockerfile, launcher, and common-stage smoke
- `containers/worker-runtimes/` — deployment smoke and runtime version manifest
- `containers/` — image catalog
- `scripts/docker/` — catalog-driven build and derived-image smoke

## Implementation Gaps

None.

## Decisions

- [Earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)
- [Adapters honor native configuration](../decisions/20260930-adapters_honor_native_configuration.md)
- [Pi native MCP discovery](../decisions/20260930-pi_native_mcp_discovery.md)
- [Resident request attribution](../decisions/20260930-resident_request_attribution.md)
- [Native environment managed outside the sandbox](../decisions/20260930-native_environment_managed_outside_the_sandbox.md)
- [Encoded-slash authority](../decisions/20261008-encoded_slash_authority_and_release_hold.md)
- [Large files and model context](../decisions/20261015-large_files_and_model_context.md)
