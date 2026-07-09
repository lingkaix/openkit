# NanoCore Deployment Modes

This guide explains how to deploy, configure, start, and verify NanoCore across supported product modes and governed container worker placements.

NanoCore has two independent deployment axes:

- Core mode: `local` or `server`.
- Worker container placement: `local` or `remote`.

Real Worker Agent execution is container-only. Host execution is not a supported product runtime.

The supported product matrix has four combinations:

| Core mode | Worker runtime | Container placement | Primary use |
| --- | --- | --- | --- |
| `local` | `container` | `local` | Single-user local work with local OpenShell container isolation. |
| `local` | `container` | `remote` | Single-user local product state with worker containers on another machine. |
| `server` | `container` | `local` | Authenticated shared NanoCore with local OpenShell container isolation. |
| `server` | `container` | `remote` | Authenticated shared NanoCore with workers in a remote OpenShell gateway. |

`OPENKIT_CORE_MODE` selects the NanoCore product mode. `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=local|remote`, and `OPENKIT_CONTAINER_BACKEND=openshell` select the real Worker Agent runtime. Keep Core mode separate from worker runtime placement.

## Release Images And Container Catalog

OpenKit-owned container images are cataloged in `containers/images.json`.

The normal release images are:

- `app`: the product app image with NanoCore, the public HTTP entrypoint, Web assets, migrations, and data-root templates.
- `worker-codex`: the governed Codex worker image with the OpenKit worker shim or sidecar.

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

Install repository dependencies before running from source:

```bash
bash scripts/repo-init.sh
pnpm install
pnpm --filter @openkit/nanocore build
```

Choose a persistent data root:

```bash
export OPENKIT_DATA_ROOT="$HOME/nano-data"
mkdir -p "$OPENKIT_DATA_ROOT"
```

Use `OPENKIT_DATA_ROOT/config/server.jsonc` for durable server, provider, and agent configuration. See [NanoCore DATA_ROOT Config Guide](./nanocore-data-root-config.en.md).

Use `PORT` to select the NanoCore HTTP port. If unset, the development server defaults to the package default.

Use `OPENKIT_BIND_HOST` only when you intentionally expose NanoCore beyond loopback. Local mode defaults to loopback. Server mode defaults to a network-facing bind host unless overridden.

When running from a release app image, mount the persistent data root at `/data/openkit` and keep worker images separate. The app image is not the normal worker runtime bundle.

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

Server mode enables authenticated HTTP operation through Better Auth. Use it for shared deployments, remote MCP access, and any deployment where users should authenticate before using product APIs.

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

### Local Container Runtime

Local container runtime is selected with:

```bash
OPENKIT_WORKER_RUNTIME=container
OPENKIT_CONTAINER_PLACEMENT=local
OPENKIT_CONTAINER_BACKEND=openshell
OPENKIT_OPENSHELL_GATEWAY=openshell
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:3000/api/worker-control
```

Use local container runtime when NanoCore and the OpenShell gateway are reachable from the same machine or local gateway context.

For a release deployment, replace `OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev` with the published version or digest reference.

If the OpenShell worker uses Codex subscription credentials, bootstrap `auth.json` into the NanoCore vault through `POST /api/app/vault/bootstrap/codex-auth-json` and pass only the Codex config file explicitly:

```bash
OPENKIT_OPENSHELL_CODEX_CONFIG_TOML="$HOME/.codex/config.toml"
```

If OpenShell network policy is enforced, add allowed endpoints:

```bash
OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS='[
  {"name":"openai_api","host":"api.openai.com","port":443,"protocol":"rest","access":"read-write"},
  {"name":"chatgpt","host":"chatgpt.com","port":443,"protocol":"rest","access":"read-write"}
]'
```

### Remote Container Runtime

Remote container runtime is selected with:

```bash
OPENKIT_WORKER_RUNTIME=container
OPENKIT_CONTAINER_PLACEMENT=remote
OPENKIT_CONTAINER_BACKEND=openshell
OPENKIT_OPENSHELL_GATEWAY=a1-openkit
OPENKIT_OPENSHELL_GATEWAY_URL=https://127.0.0.1:54003
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:54002/api/worker-control
```

Remote container mode requires both `OPENKIT_OPENSHELL_GATEWAY_URL` and `OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM`.

For a release deployment, replace `OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev` with the published version or digest reference.

`OPENKIT_OPENSHELL_GATEWAY_URL` is the OpenShell gateway endpoint as seen by the NanoCore process.

`OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM` is the NanoCore worker-control route as seen by the remote worker sandbox.

For the current `a1` development topology, expose the remote gateway locally and expose the local worker-control route back to the remote sandbox:

```bash
ssh -N -L 127.0.0.1:54003:127.0.0.1:17670 a1
ssh -N -R 127.0.0.1:54002:127.0.0.1:3000 a1
```

Do not set `OPENKIT_OPENSHELL_GATEWAY_INSECURE=1` for an mTLS OpenShell profile such as `a1-openkit`. The profile authentication must be used instead.

Use remote container runtime when NanoCore should keep product state locally or on a server while worker execution happens on a separate machine with its own OpenShell gateway and container capacity.

## Startup Profiles

### Local Core + Local Container Runtime

```bash
OPENKIT_CORE_MODE=local \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=local \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_GATEWAY=openshell \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:3000/api/worker-control \
OPENKIT_DATA_ROOT="$HOME/nano-data/local-container" \
pnpm --filter @openkit/nanocore dev
```

### Local Core + Remote Container Runtime

```bash
OPENKIT_CORE_MODE=local \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=remote \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_GATEWAY=a1-openkit \
OPENKIT_OPENSHELL_GATEWAY_URL=https://127.0.0.1:54003 \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:54002/api/worker-control \
OPENKIT_DATA_ROOT="$HOME/nano-data/local-remote-container" \
pnpm --filter @openkit/nanocore dev
```

### Server Core + Local Container Runtime

```bash
OPENKIT_CORE_MODE=server \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=local \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_GATEWAY=openshell \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:3000/api/worker-control \
OPENKIT_BIND_HOST=0.0.0.0 \
PORT=3000 \
OPENKIT_DATA_ROOT="$HOME/nano-data/server-local-container" \
pnpm --filter @openkit/nanocore start
```

### Server Core + Remote Container Runtime

```bash
OPENKIT_CORE_MODE=server \
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=remote \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_GATEWAY=a1-openkit \
OPENKIT_OPENSHELL_GATEWAY_URL=https://127.0.0.1:54003 \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:54002/api/worker-control \
OPENKIT_BIND_HOST=0.0.0.0 \
PORT=3000 \
OPENKIT_DATA_ROOT="$HOME/nano-data/server-remote-container" \
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

For remote server-mode deployments, use the path visible to the NanoCore server, not the path visible only on the desktop client.

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

This verifies one bounded Goal Mode step for every Core mode and container placement combination without provider quota.

Run the reusable opt-in real remote OpenShell backend verification only after the `a1-openkit` gateway profile, local gateway tunnel, reverse worker-control tunnel, and worker image are ready:

```bash
OPENKIT_E2E_REMOTE_OPENSHELL=1 \
OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY=a1-openkit \
OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL=https://127.0.0.1:54003 \
OPENKIT_E2E_REMOTE_OPENSHELL_LOCAL_RELAY_PORT=54101 \
OPENKIT_E2E_REMOTE_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:54002/api/worker-control \
pnpm --filter @openkit/nanocore exec vitest run src/runtime/openshell-cli.e2e.test.ts
```

The remote e2e probe starts a local worker-control relay, creates a remote OpenShell sandbox, uploads a temporary Git workspace, runs a no-quota `node -e` worker command, downloads transcript and patch evidence, asserts a pending staged review, and tears down the sandbox.

## MCP And Desktop Agent Access

The OpenKit MCP server is a stdio interface over public NanoCore APIs. It does not start NanoCore, manage OpenShell, or bypass auth.

For local deployments:

```bash
OPENKIT_NANOCORE_URL=http://127.0.0.1:3000 pnpm --filter @openkit/mcp dev
```

For server-mode deployments, add the deployment-provided scoped NanoCore token only through environment variables:

```bash
OPENKIT_NANOCORE_URL=https://nanocore.example.com \
OPENKIT_NANOCORE_TOKEN='server-issued-okt-token' \
pnpm --filter @openkit/mcp dev
```

Use [mcp/README.md](../mcp/README.md) and [skills/README.md](../skills/README.md) for desktop agent setup and loop operation.

## Operational Notes

- Keep NanoCore as the source of truth for Goal Mode, Action Center, artifacts, workspace change sets, and review decisions.
- Keep OpenShell as a backend runtime for sandbox lifecycle, file transport, policy, and teardown.
- Do not expose generic shell execution through MCP, App API, or Web UI.
- Do not allow remote workers to push directly to protected branches in the first implementation.
- Treat Codex auth JSON bootstrap content, `OPENKIT_OPENSHELL_CODEX_CONFIG_TOML`, NanoCore tokens, and provider keys as secrets. Do not write them into repository files.
- Use fresh `OPENKIT_DATA_ROOT` directories when switching between incompatible internal pre-release layouts.
- Stop SSH tunnels and remote sandboxes after verification unless the deployment explicitly owns them as services.
