# NanoCore Deployment Modes

This guide explains how to deploy, configure, start, and verify NanoCore across the supported product modes and the governed container worker runtime.

NanoCore has two independent deployment axes:

- Core mode: `local` or `server`.
- Disposable OpenShell Cell placement: `local` or `remote`.

Real Worker Agent execution is container-only. Host execution is not a supported product runtime.

The supported worker runtime is one single-slot disposable OpenShell Cell. Local placement runs the Cell on the NanoCore host; remote placement controls the complete Cell on another host through a fixed SSH helper command and reaches that Cell's loopback Gateway through an operator-managed SSH local-forward exposed as a loopback HTTP origin.

The supported product matrix has four combinations:

| Core mode | Worker runtime | Container placement | Primary use |
| --- | --- | --- | --- |
| `local` | `container` | `local` | Single-user operation with a co-located disposable OpenShell Cell. |
| `local` | `container` | `remote` | Single-user product state with a disposable OpenShell Cell on another host. |
| `server` | `container` | `local` | Authenticated HTTP operation with a co-located disposable OpenShell Cell. |
| `server` | `container` | `remote` | Authenticated HTTP operation with a disposable OpenShell Cell on another host. |

`OPENKIT_CORE_MODE` selects the NanoCore product mode. `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell` select the real Worker Agent runtime. Core mode and Cell placement remain independent.

## Release Images And Container Catalog

OpenKit-owned container images are cataloged in `containers/images.json`.

The normal release images are:

- `app`: the product app image with NanoCore, the public HTTP entrypoint, Web assets, migrations, and data-root templates.
- `worker-codex`: the governed Codex worker image with the OpenKit Codex shim.

`dev-e2e` is a local and CI diagnostic image. It is not published as a normal release artifact.

Local development uses local tags:

```text
openkit/app:dev
openkit/worker-codex:dev
```

Versioned release deployments should use exact version tags or digest-pinned image references:

```text
ghcr.io/<owner>/openkit-app:v0.0.1
ghcr.io/<owner>/openkit-worker-codex:v0.0.1
ghcr.io/<owner>/openkit-app@sha256:<digest>
ghcr.io/<owner>/openkit-worker-codex@sha256:<digest>
```

Do not use `latest` as the deployment reference for production-style setups.

The release workflow publishes only manifest entries where `release` is `true`, after the release preflight, L0-L3, L5, image build, and image smoke pass.

Release worker images must use digest-pinned base images before a stable tag can publish them.

Use [Release Cookbook](./cookbooks/release.md) for the version tag workflow.

Use [Docker App Image](./cookbooks/docker-app.md) for local app image build, run, persistence smoke, and packaged UI e2e commands.

Use [Container Image Packaging And Release Publishing](./specs/20260708-container_image_packaging.md) for the image taxonomy and publishing contract.

## Shared Prerequisites

Every Cell host must run Linux with systemd, util-linux `flock`, containerd, Docker Engine and CLI, and `curl`. Install the official, unmodified `/usr/bin/openshell` and `/usr/bin/openshell-gateway` binaries at exactly `0.0.80` on that host; a fork, patched binary, replacement Gateway, private protocol, or custom binary path is not supported.

The NanoCore host must also have the official OpenShell CLI `0.0.80` at its platform path: `/usr/bin/openshell` on Linux or `/opt/homebrew/bin/openshell` on macOS. Remote placement additionally requires `/usr/bin/ssh`, a non-interactive SSH target for the Cell host, and separate operator-managed connectivity to the Gateway and worker-control endpoints.

Verify both stock component versions on each Cell host:

```bash
/usr/bin/openshell --version
/usr/bin/openshell-gateway --version
```

Both commands must report `0.0.80`. The Cell helper repeats this check before starting an epoch, enables Providers v2 through the stock CLI, and verifies the setting before readiness.

Install repository dependencies before running from source:

```bash
bash scripts/repo-init.sh
pnpm install
pnpm --filter @openkit/nanocore build
```

Create a new empty persistent data root for this deployment:

```bash
export OPENKIT_DATA_ROOT="$HOME/nano-data/disposable-cell"
mkdir -p "$OPENKIT_DATA_ROOT"
```

Do not reuse or migrate a data root from an earlier worker lifecycle. NanoCore does not provide a migration path for the previous shared-Gateway topology.

Use `OPENKIT_DATA_ROOT/config/server.jsonc` for durable server, provider, and agent configuration. See [NanoCore DATA_ROOT Config Guide](./nanocore-data-root-config.en.md).

Use `PORT` to select the NanoCore HTTP port. If unset, the development server defaults to the package default.

Use `OPENKIT_BIND_HOST` only when you intentionally expose NanoCore beyond loopback. Local mode defaults to loopback. Server mode defaults to a network-facing bind host unless overridden.

When running from a release app image, mount the persistent data root at `/data/openkit` and keep worker images separate. The app image is not the normal worker runtime bundle.

## Disposable OpenShell Cell Host Setup

The Cell is a single-slot runtime boundary owned by NanoCore. Each epoch contains one stock OpenShell Gateway, one dedicated containerd, one dedicated dockerd, one dedicated Docker network, and fresh mutable runtime roots. Cleanup destroys the entire epoch, removes the epoch network, and starts a verified empty replacement before scheduler capacity becomes available again.

The owning lifecycle and failure contract is [OpenShell Disposable Cell Lifecycle](./specs/20260715-openshell_disposable_cell_lifecycle.md).

On A1, build and smoke the worker image directly from the synchronized repository checkout, then save it into the Cell image cache. Building on A1 avoids transferring a large image archive to the runtime host:

```bash
docker build --network host \
  --file containers/worker-codex/Dockerfile \
  --tag openkit/worker-codex:dev \
  .
docker run --rm --network none \
  openkit/worker-codex:dev \
  openkit-worker-codex-smoke
docker pull \
  ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898
test "$(docker image inspect --format '{{.Id}}' \
  ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898)" = \
  'sha256:7c37c367f63d2d160673c41d58363be8a4beb543b82a3de8547d09c0b5be1a2f'
docker save \
  --output /tmp/openkit-worker-codex-dev-aarch64.tar \
  openkit/worker-codex:dev
docker save \
  --output /tmp/openshell-supervisor-709aa0fe-aarch64.tar \
  ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898
sudo install -d -o root -g root -m 0755 /var/lib/openkit/openshell-cell/image-cache
sudo install -o root -g root -m 0600 \
  /tmp/openkit-worker-codex-dev-aarch64.tar \
  /var/lib/openkit/openshell-cell/image-cache/openkit-worker-codex-dev-aarch64.tar
sudo install -o root -g root -m 0600 \
  /tmp/openshell-supervisor-709aa0fe-aarch64.tar \
  /var/lib/openkit/openshell-cell/image-cache/openshell-supervisor-709aa0fe-aarch64.tar
rm /tmp/openkit-worker-codex-dev-aarch64.tar \
  /tmp/openshell-supervisor-709aa0fe-aarch64.tar
```

The supervisor tag and source image id above are the exact Linux arm64 identity baked into the official OpenShell `0.0.80` Gateway on A1. Docker `29.6.1` normalizes the saved archive to image id `sha256:d87e54175490a7dc5e75daef1c4aaf43955cf3fc3945827e4f03698ea99faadb` in each fresh Cell, which the helper verifies before starting the Gateway. Other architectures are rejected until their official identity is separately verified.

Install the repository-owned privileged helper at its fixed path:

```bash
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0700 \
  apps/nanocore/scripts/openshell-cell.sh \
  /usr/local/libexec/openkit-openshell-cell
```

On A1, grant only the two helper actions to the `ubuntu` account that runs NanoCore. Create `/etc/sudoers.d/openkit-openshell-cell` with mode `0440` and this content:

```sudoers
Cmnd_Alias OPENKIT_OPENSHELL_CELL = /usr/local/libexec/openkit-openshell-cell prepare *, /usr/local/libexec/openkit-openshell-cell recycle *
ubuntu ALL=(root) NOPASSWD: OPENKIT_OPENSHELL_CELL
```

Validate the rule before starting NanoCore:

```bash
sudo chmod 0440 /etc/sudoers.d/openkit-openshell-cell
sudo visudo -cf /etc/sudoers.d/openkit-openshell-cell
```

Do not grant NanoCore passwordless access to a shell, `systemctl`, Docker, containerd, or an arbitrary helper path. The installed helper accepts exactly `prepare <owner-id>` and `recycle <owner-id>`, requires the owner id to match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`, derives every privileged resource from fixed roots, serializes lifecycle changes with a host-wide lock, and recovers a stale idle epoch after a host reboot.

## Vault Startup

Local mode defaults to the operating-system keychain. Server mode defaults to the encrypted-file Vault; local mode can select the same backend with `vault.localDefaultBackend: "encrypted-file"` in `config/server.jsonc`.

The only configured encrypted-file key source in V1 is `vault.encryptedFile.keyFilePath`. It must name an absolute regular file owned by the NanoCore process user, with exact `0600` permissions and exactly 32 raw bytes. Production's DATA_ROOT portability gate requires the configured path to be external to the current data root. See [NanoCore DATA_ROOT Config Guide](./nanocore-data-root-config.en.md) for key generation, backup warnings, and the config shape.

When the key is valid, NanoCore authenticates it against `server/vault/header.json` before exposing the backend as available. Missing, invalid, or wrong keys leave Vault locked and readiness degraded, but do not stop NanoCore or expose filesystem and key details. The process clears temporary key buffers after every unlock attempt and clears its owned key during lock, orderly shutdown, and process-exit cleanup.

## Core Modes

### Local Mode

Local mode is single-user mode. It uses the implicit local user `user_local` and does not require server-mode session cookies for product APIs.

```bash
OPENKIT_CORE_MODE=local \
OPENKIT_DATA_ROOT="$HOME/nano-data/local-container" \
pnpm --filter @openkit/nanocore dev
```

Use local mode for development, personal desktop operation, and test deployments that do not need multi-user auth.

### Server Mode

Server mode enables authenticated HTTP operation through Better Auth. Use it for shared deployments, remote public API or Agent Skill CLI access, and any deployment where users should authenticate before using product APIs.

```bash
OPENKIT_CORE_MODE=server \
OPENKIT_DATA_ROOT="$HOME/nano-data/server-container" \
OPENKIT_BIND_HOST=0.0.0.0 \
PORT=3000 \
pnpm --filter @openkit/nanocore start
```

Create a user:

```bash
curl -i http://127.0.0.1:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  --data '{"email":"user@example.com","password":"password123456","name":"User"}'
```

Sign in and keep the returned session cookie for protected product APIs:

```bash
curl -i http://127.0.0.1:3000/api/auth/sign-in/email \
  -H 'content-type: application/json' \
  --data '{"email":"user@example.com","password":"password123456"}'
```

## Worker Runtime Configuration

### Disposable Local Cell

Select a co-located Cell with:

```bash
OPENKIT_WORKER_RUNTIME=container
OPENKIT_CONTAINER_PLACEMENT=local
OPENKIT_CONTAINER_BACKEND=openshell
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=http://host.openshell.internal:3000/api/worker-control
```

NanoCore invokes the installed Cell helper with non-interactive `sudo`, and the stock Gateway binds to the fixed loopback endpoint `http://127.0.0.1:17670` with health at `http://127.0.0.1:17671/readyz`. Do not start a shared Gateway separately and do not configure an external Gateway URL.

For a release deployment, replace `OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev` with the published version or digest reference.

If the OpenShell worker uses Codex subscription credentials, bootstrap `auth.json` into the NanoCore vault through `POST /api/app/vault/bootstrap/codex-auth-json` and pass only the Codex config file explicitly:

```bash
OPENKIT_OPENSHELL_CODEX_CONFIG_TOML="$HOME/.codex/config.toml"
```

The immutable AEP is the complete network authority. NanoCore has no environment variable or backend default that can append endpoints; direct provider endpoints must be authorized by the selected authored manifest and recorded in that launch's AEP.

### Disposable Remote Cell

Select a remote disposable Cell with:

```bash
OPENKIT_WORKER_RUNTIME=container
OPENKIT_CONTAINER_PLACEMENT=remote
OPENKIT_CONTAINER_BACKEND=openshell
OPENKIT_OPENSHELL_CELL_SSH_TARGET=ubuntu@a1
OPENKIT_OPENSHELL_GATEWAY=openshell
OPENKIT_OPENSHELL_GATEWAY_URL=http://127.0.0.1:27670
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=https://nanocore.example.com/api/worker-control
```

`OPENKIT_OPENSHELL_CELL_SSH_TARGET` identifies the Cell host and must work non-interactively. NanoCore runs only this fixed command shape through it:

```text
/usr/bin/ssh -T -o BatchMode=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 <target> /usr/bin/sudo -n /usr/local/libexec/openkit-openshell-cell <prepare|recycle> <owner-id>
```

`OPENKIT_OPENSHELL_GATEWAY_URL` is the loopback HTTP origin that the NanoCore process uses to reach the stock Gateway through the SSH local-forward. It must use `127.0.0.1` or `localhost` and must not contain credentials, a path, query, or fragment.

`OPENKIT_OPENSHELL_GATEWAY` is optional and defaults to `openshell`. When set, it must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}` so it cannot be interpreted as another OpenShell option.

The Gateway continues to bind only to `127.0.0.1:17670` on the Cell host. For the current single-Cell helper, dockerd allocates the first OpenShell network from `10.231.0.0/24`, so the sandbox reaches the Cell host at the exact bridge address `10.231.0.1`. One acceptable test transport carries the loopback Gateway forward and exposes the NanoCore worker-control port only on that bridge address:

```bash
ssh -N -T \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ForwardAgent=no \
  -o ForwardX11=no \
  -o PermitLocalCommand=no \
  -o StrictHostKeyChecking=yes \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=2 \
  -L 127.0.0.1:27670:127.0.0.1:17670 \
  -R 10.231.0.1:23001:127.0.0.1:3000 \
  a1
```

This test shape requires `GatewayPorts clientspecified` on the Cell host SSH server and sets `OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=http://10.231.0.1:23001/api/worker-control`; replace `3000` with the actual loopback NanoCore port. Never bind the reverse listener to `0.0.0.0`. The exact bridge bind keeps worker-control reachable from Cell sandboxes without exposing it on every A1 interface. The lifecycle helper still runs through its separate fixed SSH command with all forwarding disabled.

`OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL` is the exact credential-free HTTP(S) NanoCore worker-control route as seen from the remote sandbox. It is mandatory for remote placement, must end at `/api/worker-control`, and must be exposed through a separately authenticated network or tunnel path; loopback and unspecified addresses are rejected, and the local `host.openshell.internal` default is not sufficient. A production deployment may use separate authenticated transports for the two directions; the combined tunnel above is the proven disposable A1 test shape.

The SSH target, Gateway origin, and worker-control URL must refer to one coherent placement. NanoCore persists a non-secret digest of the exact Cell controller target and rejects restart cleanup when that digest or the configured Gateway target changes. A remote Gateway without the matching disposable Cell lifecycle target is unsupported, even if the Gateway is reachable.

## Startup Profiles

### Local Core + Disposable Cell

```bash
OPENKIT_CORE_MODE=local \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=local \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=http://host.openshell.internal:3000/api/worker-control \
OPENKIT_DATA_ROOT="$HOME/nano-data/local-container" \
pnpm --filter @openkit/nanocore dev
```

### Local Core + Remote Disposable Cell

```bash
OPENKIT_CORE_MODE=local \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=remote \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_CELL_SSH_TARGET=ubuntu@a1 \
OPENKIT_OPENSHELL_GATEWAY_URL=http://127.0.0.1:27670 \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=https://nanocore.example.com/api/worker-control \
OPENKIT_DATA_ROOT="$HOME/nano-data/local-remote-cell" \
pnpm --filter @openkit/nanocore dev
```

### Server Core + Disposable Cell

```bash
OPENKIT_CORE_MODE=server \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=local \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=http://host.openshell.internal:3000/api/worker-control \
OPENKIT_BIND_HOST=0.0.0.0 \
PORT=3000 \
OPENKIT_DATA_ROOT="$HOME/nano-data/server-local-container" \
pnpm --filter @openkit/nanocore start
```

### Server Core + Remote Disposable Cell

```bash
OPENKIT_CORE_MODE=server \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=remote \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_CELL_SSH_TARGET=ubuntu@a1 \
OPENKIT_OPENSHELL_GATEWAY_URL=http://127.0.0.1:27670 \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=https://nanocore.example.com/api/worker-control \
OPENKIT_BIND_HOST=0.0.0.0 \
PORT=3000 \
OPENKIT_DATA_ROOT="$HOME/nano-data/server-remote-cell" \
pnpm --filter @openkit/nanocore start
```

## Workspace Setup

Goal Mode worker steps need a repository resource when the task writes to a repository.

Link the default repository resource:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/repositories/default \
  -H 'content-type: application/json' \
  --data '{"displayName":"OpenKit","localPath":"/absolute/path/to/git/repository"}'
```

In server mode, use the path visible to the NanoCore host, not a path visible only on a desktop client.

Read repository diagnostics:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/repositories/diagnostics
```

## Loop Verification

Read diagnostics:

```bash
curl -s http://127.0.0.1:3000/api/diagnostics
```

Run the deterministic four-case loop matrix from source:

```bash
pnpm --filter @openkit/nanocore exec vitest run src/deployment-mode-matrix.test.ts
```

This verifies one bounded Goal Mode step for every Core mode and Cell placement combination without provider quota.

Run real local OpenShell and Goal Mode acceptance on A1 itself. NanoCore, the privileged helper, the stock Gateway, containerd, dockerd, the worker image cache, and the disposable test repository must all be on A1. NanoCore prepares the Cell before materialization and recycles it after success or failure; do not manually delete only the sandbox or provider and treat that as cleanup proof.

For remote acceptance, run NanoCore on the selected NanoCore host, keep the fixed SSH lifecycle target and the operator-managed Gateway transport active, and provide a worker-control URL reachable from the A1 sandbox. The remote backend E2E proves stock CLI preflight, Cell prepare, sandbox materialization, and whole-Cell cleanup, and the separate real Codex `0.144.1` provenance acceptance has passed on A1 against stock OpenShell `0.0.80`.

Either acceptance result is valid only when the worker completes, NanoCore cleanup succeeds, the old Cell processes, network, and mutable roots are gone, and the replacement Cell reports its exact Gateway service active plus zero Docker containers and zero OpenShell sandboxes in both stable-empty checks.

## Agent Skill Access

The accepted AI-native access path is one end-user `openkit` Skill with a bundled CLI over public NanoCore APIs. The CLI does not start NanoCore, manage OpenShell, bypass authentication, or expose private deployment state.

The unified Skill lives at `skills/openkit/` and includes its standalone executable at `scripts/openkit`. User-facing MCP and split setup/loop Skill variants have been removed and must not be restored.

The bundled CLI uses `OPENKIT_NANOCORE_URL` as explicit endpoint configuration. Server-mode access resolves a scoped token from supported credential storage or the explicit ephemeral `OPENKIT_NANOCORE_TOKEN` override without printing credential material.

Use [skills/README.md](../skills/README.md), [the Agent Skill Interface spec](./specs/20260713-openkit_agent_skill_interface.md), and [the implementation plan](./changes/202607131935040001-openkit_agent_skill_interface.md) for the accepted setup and loop direction.

## Operational Notes

- Keep NanoCore as the source of truth for Goal Mode, Action Center, artifacts, workspace change sets, and review decisions.
- Keep stock OpenShell as a backend runtime for sandbox lifecycle, file transport, and policy inside the disposable Cell.
- Keep the first OpenShell scheduler pool and target at one slot; capacity returns only after whole-Cell recycle and replacement readiness succeed.
- Bind every remote Gateway origin to the same fixed SSH lifecycle target; never use a naked shared Gateway.
- Do not expose generic shell execution through the Agent Skill Interface, App API, or Web UI.
- Treat Codex auth JSON bootstrap content, `OPENKIT_OPENSHELL_CODEX_CONFIG_TOML`, NanoCore tokens, and provider keys as secrets. Do not write them into repository files.
- Use a fresh `OPENKIT_DATA_ROOT` for every deployment of the disposable Cell lifecycle.
