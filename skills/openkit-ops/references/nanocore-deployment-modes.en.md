---
status: Accepted
---
# NanoCore Deployment Modes

This manual explains the two supported NanoCore product modes and their shared NanoHost worker-runtime boundary.

NanoCore has one product-mode axis:

- `local` uses one implicit local user for personal operation and development.
- `server` protects product APIs with configured authentication for shared or remote operation.

Real Worker Agent execution uses one configured NanoHost RuntimeTarget in both modes. NanoHost owns the stock OpenShell Gateway, private container backend, Runtime Epoch, shared Harness and Sandbox, and private Harness operations. NanoCore owns product admission, execution attempts, AgentSession continuity, durable runtime projections, and public APIs. NanoCore has no worker-runtime, placement, SSH lifecycle, Gateway-forward, direct Gateway, or sandbox-direct endpoint selector.

## Release Images And Container Catalog

OpenKit-owned container images are cataloged in `containers/images.json`.

Current artifact selection uses the shipped catalog. That catalog lists `app`, the extension base `worker-common`, and the repository deployment image `worker-runtimes`.

- `app` contains NanoCore, the public HTTP entrypoint, Web assets, migrations, and data-root templates.
- `worker-common` is the extension base with an empty runtime set.
- `worker-runtimes` is the current repository deployment image and contains Codex, Pi, OpenCode, and DeepSeek.

`test-env` is the repository test image and is not a deployment artifact.

Local development uses the local tags of the shipped catalog entries:

```text
openkit/app:dev
openkit/worker-common:dev
openkit/worker-runtimes:dev
```

A local build does not publish these images. GHCR publication is a separate, later version-tag release step. Production-style deployments should use an exact published version tag or digest-pinned image reference and should not use `latest`.

Use [Release Cookbook](https://github.com/lingkaix/openkit/blob/main/docs/cookbooks/release.md) for release tags and [Docker App Image](https://github.com/lingkaix/openkit/blob/main/docs/cookbooks/docker-app.md) for local app-image build, run, persistence smoke, and packaged UI checks.

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

Use `OPENKIT_DATA_ROOT/config/server.jsonc` for durable server and NanoHost transport configuration; Providers and Agents have their own files under `config/providers/` and `config/agents/`. See [NanoCore DATA_ROOT Config](nanocore-data-root-config.en.md).

Use `PORT` to select the NanoCore HTTP port. Use `OPENKIT_BIND_HOST` only when the selected Core mode and deployment intentionally expose NanoCore beyond loopback.

When running the release app image, mount the persistent data root at `/data/openkit` and keep Worker images separate.

For stopped-server administrator recovery from the release image, first stop the deployment through its normal operator workflow and confirm that no NanoCore process uses the mounted data root. Then run a one-shot container with the app entrypoint replaced by `openkit-operator`, the same data root mounted read-write at `/data/openkit`, and a private host output directory mounted at `/recovery`:

```bash
docker run --rm --entrypoint openkit-operator \
  --mount type=bind,src=/absolute/path/to/openkit-data,dst=/data/openkit \
  openkit/app:<exact-version> \
  admin recovery-users --data-root /data/openkit

docker run --rm --entrypoint openkit-operator \
  --mount type=bind,src=/absolute/path/to/openkit-data,dst=/data/openkit \
  --mount type=bind,src=/absolute/private/recovery,dst=/recovery \
  openkit/app:<exact-version> \
  admin recover-access --data-root /data/openkit \
  --owner-user-id user_example \
  --expires-at <future-expiry-ISO8601> \
  --output /recovery/admin-recovery.json \
  --confirm issue-server-admin-token:user_example:<future-expiry-ISO8601>
```

Use the deployment's named volume instead of the first bind mount when it owns `/data/openkit`. The command refuses a held data-root lock and never stops NanoCore. Do not run it against a live mount, print or inspect the recovery envelope, or reuse an output path for a different owner or expiry. Pass the complete `0600` envelope directly through stdin to the bundled Skill's `credential.store`; only its Token enters endpoint credential storage.

## Vault Startup

Local and server modes use the encrypted-file Vault under `DATA_ROOT/server/vault/`. The raw 32-byte master key remains in an exact-`0600` file outside the Data Root and is configured through `vault.encryptedFile.keyFilePath`.

A missing, invalid, or wrong key leaves Vault locked and readiness degraded without exposing key or filesystem details. See [NanoCore DATA_ROOT Config](nanocore-data-root-config.en.md) for key creation, backup warnings, and the complete config shape.

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

Use the public Web sign-in/bootstrap flow for the configured server origin. Keep passwords, session cookies and one-time bootstrap material in the browser or protected credential mechanism rather than shell arguments or printed HTTP headers.

## NanoHost Runtime

NanoHost can start with an empty Worker Image Store and establish its authenticated NanoCore connection before Worker images are available. The current pinned stock OpenShell Gateway may still access GHCR to obtain its Supervisor image during startup, before Gateway health and NanoCore readiness. This is accepted upstream behavior: empty Worker-image storage does not mean completely offline startup. If bootstrap cannot reach the required registry, inspect the NanoHost/Gateway logs and host DNS, HTTPS and proxy access to GHCR; do not bypass TLS, change the pinned release or erase retained Worker data to repair it. Worker images are checked and imported at point of use; that path does not remove this stock Supervisor dependency. The private Docker daemon and Gateway must resolve names through the epoch projection of `/run/systemd/resolve/resolv.conf`; container `--dns` settings alone do not prove that daemon registry lookups work. A private-daemon error naming the host stub `127.0.0.53` indicates a resolver-projection defect. Preserve its startup evidence and correct that projection rather than replacing the host resolver or repeatedly restarting the failed epoch.

NanoCore accepts Worker Agent work only through the configured NanoHost identity and NanoHost-initiated authenticated HTTP/2 session. The App API remains on its HTTP/1.1 listener; `nanohost.bind` selects a separate native HTTP/2 listener on a different local port, while `nanohost.rendezvousUrl` is the endpoint advertised to NanoHost after any deployment mapping. The RuntimeTarget must be ready, predecessor-fenced, and fresh-empty before admission.

Use [NanoHost Real-Use Host](https://github.com/lingkaix/openkit/blob/main/docs/cookbooks/nanohost-real-use-host.md) for the current reviewed-host workflow:

Supply the operator-selected host alias explicitly when following that source-checkout procedure. Its test-host examples are not a default target, and fixture teardown must not run against an existing persistent installation.

The cookbook owns authenticated NanoHost bring-up and idempotent teardown. It does not authorize manual Sandbox repair, direct database mutation, credential retention, or a second runtime path.

The selected authored AgentManifest supplies the exact Worker image, pull policy, native runtime binaries, adapter id, provider requirements, sandbox policy, and required capabilities. NanoCore has no deployment environment override for those fields.

A real remote worker input uses one credential-free HTTPS Git source and exact accepted commit. Private-repository credential injection requires a separately owned Vault-backed contract and is not implied by NanoHost setup.

For an existing enrolled host, use [installed NanoHost release replacement](nanocore-operations.en.md#replace-an-installed-nanohost-release) through an external Agent with this Skill and authorized host tools. Preserve its configuration and enrollment; the fixture workflow above is not persistent-host upgrade or recovery.

## Verification

Read deployment diagnostics through the authenticated deployment surface:

```bash
curl -s http://127.0.0.1:3000/api/diagnostics
```

Run deterministic local verification with the package and repository gates documented in [NanoCore](https://github.com/lingkaix/openkit/blob/main/apps/nanocore/README.md).

Run the explicit real Task Mode gate only after accepting provider quota and supplying its required current artifact identities:

```bash
pnpm -w test:e2e:real-task-mode
```

NanoCore restart continuity, NanoHost fail-stop behavior, execution-server restart recovery, and Gateway failure recovery are stage acceptance scenarios owned by [NanoHost Runtime And Transport](https://github.com/lingkaix/openkit/blob/main/docs/specs/20260802-nanohost_runtime_and_transport.md), not a separate Cell runner.

## Administrator CLI And Remote MCP Access

Ordinary product work uses Web or remote MCP at the configured public origin plus `/mcp`. Use a client that supports Streamable HTTP and a protected per-user static `Authorization: Bearer` header. An administrator issues the user's appropriately scoped Token through the supported Web procedure or this administrator CLI's named secret-safe sink. Transfer it into the client's protected credential configuration without prompts, argv, logs or evidence. Non-loopback endpoints require HTTPS. Query, body, cookies and implicit local authority do not authenticate MCP; browser OAuth and refresh tokens are unavailable in this release. A client without static-header support has an unmet prerequisite. Read the remote guide and discover contracts through search, describe and call; connection does not grant operation permission.

The bundled administrator CLI uses public NanoCore contracts and is not a separate package. It does not start NanoCore, manage host services or expose private deployment state. A currently usable administrator bearer remains subject to read-only, expiry, revocation, per-effect approvals and model-delivery restrictions. Keep its endpoint store separate from issued named credentials. Replace the complete operations package on version mismatch; there is no compatibility alias.

## Establish the connection

1. Confirm that the host can load this operations Skill, execute its bundled script, provide Node.js 24, and protect local credentials and environment state.
2. Resolve `scripts/openkit` relative to the installed Skill directory.
3. Set `OPENKIT_NANOCORE_URL` only when the process must use an explicit local or remote NanoCore endpoint.
4. Run `scripts/openkit doctor` before invoking product operations.
5. Report endpoint reachability, authentication availability, NanoCore readiness, and contract compatibility without exposing sensitive values.

Use the same public interface for local and remote NanoCore endpoints. Do not assume that a local endpoint authorizes unauthenticated access; follow the result returned by `doctor`.

## Handle credentials safely

Store persistent bearer credentials through the endpoint-keyed credential operation and supported local credential store. Use `OPENKIT_NANOCORE_TOKEN` only as an explicit ephemeral automation override.

Pass bootstrap codes, tokens, and other secret inputs through stdin or a platform credential mechanism. Never pass them as arguments, print them, quote them in conversation, or persist them in artifacts, evidence, knowledge, or logs.

Use `ops search` with terms such as `credential`, `bootstrap`, or `connection`, then use `ops describe` before calling the selected operation. Use `token.create` or `token.rotate` only with an explicit non-reserved local `destination` name such as `automation`, described by the operation. These operations require a server-admin bearer token in server mode, store the issued secret into the named slot, and return redacted token records and storage metadata. They never replace or select the endpoint administration credential.

First-owner bootstrap requires a display name, email, and password as well as the one-time bootstrap code. Submit these through the discovered bootstrap operation using stdin. Successful consumption creates the same owner's Browser login credential and stores the returned administrator Token securely; use that email and password to sign in to the Web UI. Never repeat bootstrap on an initialized deployment.

Treat a secure-storage preflight failure as a setup blocker. If bootstrap consumption reports that credential storage failed, do not ask the CLI to reveal the consumed token; report the typed failure and require a new explicit setup decision.

## Diagnose failures

Interpret CLI exit statuses consistently:

- Treat `0` as a successful command envelope.
- Treat `2` as a local usage, input, or schema error and correct the request locally.
- Treat `3` as a connection or authentication failure and rerun `doctor` after correcting endpoint or credential state.
- Treat `4` as a typed NanoCore rejection and follow its redacted error code and details.
- Treat `1` as an unexpected CLI failure and preserve only redacted diagnostics.

When `doctor` reports a capability or contract incompatibility, update the complete operations Skill artifact or connect to a matching NanoCore deployment. Do not add a compatibility alias or bypass the check.

Named slots are distinct per endpoint and name. Names contain 1–64 lowercase letters, digits, underscores or hyphens, start with a letter, and cannot be `admin`, `endpoint`, `default`, `current` or start with the token prefix. Reusing a name replaces only that named credential. Named writes prefer a safe keychain writer and otherwise use the warned encrypted fallback. Reads honor the persisted backend selection; they never revive older credentials when a backend returns. Local slot deletion prevents rediscovery even if unavailable keychain cleanup leaves an orphan, and does not revoke the server token. Named storage does not change subsequent CLI authentication. A preflight storage failure prevents issuance. A storage failure after issuance requires token inventory inspection and a new explicit recovery decision; never ask to print the one-time secret or blindly retry.

Use `workspace.dashboard` for eligible work and counts, `thread.dashboard` for one eligible Thread, and `app.search` with `query` for product content search. These differ from `ops search`, which discovers operation metadata. An ordinary caller needs current Workspace membership. A currently usable administrator credential is eligible for another user's private Threads under the administrator eligibility rule in [Core Permissions](https://github.com/lingkaix/openkit/blob/main/docs/core/permissions.md#administrator-eligibility). `thread.create` defaults to private; create formal Task/Goal work with explicit `visibility: workspace` and admitted inputs. These reads do not implement conversation sharing or private-to-shared handoff.

## Operational Notes

- Keep NanoCore as the source of truth for Goal Mode, Action Center, Artifacts, Workspace changes, reviews, and durable evidence.
- Keep stock OpenShell private to the NanoHost Runtime Epoch.
- Do not expose generic shell execution through remote MCP or the administrator CLI, App API, or Web UI.
- Treat Vault bootstrap material, NanoCore tokens, NanoHost transport credentials, and provider keys as secrets.
- Use the product App API and retained redacted RuntimeEvidence for diagnosis rather than direct table scans.
