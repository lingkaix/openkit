---
status: Accepted
---
# NanoCore Deployment Modes

This manual explains the two supported NanoCore product modes and their shared NanoHost worker-runtime boundary.

NanoCore has one product-mode axis:

- `local` uses one implicit local user for personal operation and development.
- `server` protects product APIs with configured authentication for shared or remote operation.

Real Worker Agent execution uses one configured NanoHost RuntimeTarget in both modes. NanoHost owns the stock OpenShell Gateway, private container backend, Runtime Epoch, shared Harness and Sandbox, and private Harness operations. NanoCore owns product admission, Turn leases, AgentSession continuity, durable runtime projections, and public APIs. NanoCore has no worker-runtime, placement, SSH lifecycle, Gateway-forward, direct Gateway, or sandbox-direct endpoint selector.

## Release Images And Container Catalog

OpenKit-owned container images are cataloged in `containers/images.json`.

The normal release images are:

- `app` contains NanoCore, the public HTTP entrypoint, Web assets, migrations, and data-root templates.
- Runtime-specific `worker-*` images contain the generic `openkit-worker-shim`, one static adapter, and one pinned native runtime.

`test-env` is the repository test image and is not a deployment artifact.

Local development uses local tags:

```text
openkit/app:dev
openkit/worker-codex:dev
```

Production-style deployments should use an exact version tag or digest-pinned image reference and should not use `latest`.

Use [Release Cookbook](../cookbooks/release.md) for release tags and [Docker App Image](../cookbooks/docker-app.md) for local app-image build, run, persistence smoke, and packaged UI checks.

## Shared Prerequisites

Install repository dependencies before running from source:

```bash
bash scripts/repo-init.sh
pnpm install
pnpm --filter @openkit/nanocore build
```

Create a persistent data root:

```bash
export OPENKIT_DATA_ROOT="$HOME/nano-data/openkit"
mkdir -p "$OPENKIT_DATA_ROOT"
```

Use `OPENKIT_DATA_ROOT/config/server.jsonc` for durable server, provider, agent, NanoHost identity, dedicated NanoHost listener bind, and NanoHost rendezvous configuration. See [NanoCore DATA_ROOT Config](./nanocore-data-root-config.en.md).

Use `PORT` to select the NanoCore HTTP port. Use `OPENKIT_BIND_HOST` only when the selected Core mode and deployment intentionally expose NanoCore beyond loopback.

When running the release app image, mount the persistent data root at `/data/openkit` and keep Worker images separate.

## Vault Startup

Local and server modes use the encrypted-file Vault under `DATA_ROOT/server/vault/`. The raw 32-byte master key remains in an exact-`0600` file outside the Data Root and is configured through `vault.encryptedFile.keyFilePath`.

A missing, invalid, or wrong key leaves Vault locked and readiness degraded without exposing key or filesystem details. See [NanoCore DATA_ROOT Config](./nanocore-data-root-config.en.md) for key creation, backup warnings, and the complete config shape.

## Core Modes

### Local Mode

Local mode uses the implicit local user `user_local` and does not require server-mode session cookies for product APIs.

```bash
OPENKIT_CORE_MODE=local \
OPENKIT_DATA_ROOT="$HOME/nano-data/openkit-local" \
pnpm --filter @openkit/nanocore dev
```

Use local mode for development, personal desktop operation, and test deployments that do not need multi-user authentication.

### Server Mode

Server mode enables authenticated HTTP operation through Better Auth.

```bash
OPENKIT_CORE_MODE=server \
OPENKIT_DATA_ROOT="$HOME/nano-data/openkit-server" \
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

Sign in and retain the returned session cookie only in the calling client:

```bash
curl -i http://127.0.0.1:3000/api/auth/sign-in/email \
  -H 'content-type: application/json' \
  --data '{"email":"user@example.com","password":"password123456"}'
```

## NanoHost Runtime

NanoCore accepts Worker Agent work only through the configured NanoHost identity and NanoHost-initiated authenticated HTTP/2 session. The App API remains on its HTTP/1.1 listener; `nanohost.bind` selects a separate native HTTP/2 listener on a different local port, while `nanohost.rendezvousUrl` is the endpoint advertised to NanoHost after any deployment mapping. The RuntimeTarget must be ready, predecessor-fenced, and fresh-empty before admission.

Use [NanoHost Real-Use Host](../cookbooks/nanohost-real-use-host.md) for the current reviewed-host workflow:

```bash
pnpm host:provision a1
pnpm host:assert a1
```

The cookbook owns authenticated NanoHost bring-up and idempotent teardown. It does not authorize manual Sandbox repair, direct database mutation, credential retention, or a second runtime path.

The selected authored AgentManifest supplies the exact Worker image, pull policy, native runtime binaries, adapter id, provider requirements, sandbox policy, and required capabilities. NanoCore has no deployment environment override for those fields.

A real remote worker input uses one credential-free HTTPS Git source and exact accepted commit. Private-repository credential injection requires a separately owned Vault-backed contract and is not implied by NanoHost setup.

## Verification

Read deployment diagnostics through the authenticated deployment surface:

```bash
curl -s http://127.0.0.1:3000/api/diagnostics
```

Run deterministic local verification with the package and repository gates documented in [NanoCore](../../apps/nanocore/README.md).

Run the explicit real Task Mode gate only after accepting provider quota and supplying its required current artifact identities:

```bash
pnpm -w test:e2e:real-task-mode
```

NanoCore restart continuity, NanoHost fail-stop behavior, execution-server restart recovery, and Gateway failure recovery are stage acceptance scenarios owned by [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md), not a separate Cell runner.

## Agent Skill Access

The accepted AI-native access path is the unified `openkit` Skill with its bundled CLI over public NanoCore APIs. The CLI does not start NanoCore, manage NanoHost, bypass authentication, or expose private deployment state.

The bundled CLI uses `OPENKIT_NANOCORE_URL` as explicit endpoint configuration. Server-mode access resolves a scoped token from supported credential storage or the explicit ephemeral `OPENKIT_NANOCORE_TOKEN` override without printing credential material.

Use [Skills](../../skills/README.md) and [Agent Skill Interface](../specs/20260713-openkit_agent_skill_interface.md) for the accepted setup and operation catalog.

## Operational Notes

- Keep NanoCore as the source of truth for Goal Mode, Action Center, Artifacts, Workspace changes, reviews, and durable evidence.
- Keep stock OpenShell private to the NanoHost Runtime Epoch.
- Do not expose generic shell execution through the Agent Skill Interface, App API, or Web UI.
- Treat Vault bootstrap material, NanoCore tokens, NanoHost transport credentials, and provider keys as secrets.
- Use the product App API and retained redacted RuntimeEvidence for diagnosis rather than direct table scans.
