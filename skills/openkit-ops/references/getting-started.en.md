---
status: Accepted
---
# Getting Started With OpenKit

This procedure requires an authorized host, a supported container runtime for App-image deployment, persistent storage and a selected release or source revision. NanoHost additionally needs the supported OpenShell runtime. Confirm OS, architecture, available disk and current service bindings before installation. The empirical small-team starting shape is 2 CPU cores, 8 GiB memory and 30 GiB available storage; image builds and caches can need more.

## Choose The Installation

For an existing deployment, inspect it and use the operations reference. For maintenance, we recommend an external Agent with this `openkit-ops` Skill and your authorized host tools; name the deployment, exact target release and permitted interruption. Ask it to follow [installed NanoHost release replacement](nanocore-operations.en.md#replace-an-installed-nanohost-release) when upgrading the execution host, separately from App updates. Do not replay first-run setup, replace its Vault key or create a second process on its writable Data Root.

For a release installation, follow [Install From Published Assets](#install-from-published-assets) below. Retain the exact App digest, source identity and matching asset checksums. A package or image download alone is not a working installation.

## Install From Published Assets

This path uses a published App image, matching NanoHost archive and operations package. It uses no source checkout, repository build command or fixture teardown. The example places NanoCore's App container and the installed NanoHost on one supported Linux host. Existing installations use the maintenance procedure instead; stop if the selected data, container, service or credential destinations already belong to another installation.

### Select And Verify One Release

1. Select one exact published tag. Read its public release page and retain its source commit, App digest, Worker image digest and platform. Do not use `latest`, a local image, a source archive or an unpublished candidate as the installation artifact.
2. Map `x86_64` to `amd64`, or `aarch64` to `arm64`. Acquire `openkit-ops-skill-<tag>.tar.gz`, `openkit-nanohost-<tag>-linux-<arch>.tar.gz`, and `SHA256SUMS` from that same release. Use the browser download links or, from a new private working directory, these GitHub CLI commands after replacing the placeholders:

```bash
OPENKIT_RELEASE_TAG='<exact-published-tag>'
OPENKIT_RELEASE_ARCH='<amd64-or-arm64>'
gh release download "$OPENKIT_RELEASE_TAG" --repo lingkaix/openkit \
  --pattern "openkit-ops-skill-$OPENKIT_RELEASE_TAG.tar.gz" \
  --pattern "openkit-nanohost-$OPENKIT_RELEASE_TAG-linux-$OPENKIT_RELEASE_ARCH.tar.gz" \
  --pattern SHA256SUMS
test -f "openkit-ops-skill-$OPENKIT_RELEASE_TAG.tar.gz"
test -f "openkit-nanohost-$OPENKIT_RELEASE_TAG-linux-$OPENKIT_RELEASE_ARCH.tar.gz"
sha256sum --check --ignore-missing SHA256SUMS
```

3. Verify `SHA256SUMS` itself against the digest in the selected release's publication evidence. Extract the two verified archives into that private directory. Keep their top-level directories and archive checksums. The NanoHost `MANIFEST.json` must match the selected tag, source commit and architecture; its own checksum file verifies the extracted payload. A mismatch stops installation.
4. Load `skills/openkit-ops/SKILL.md` from inside the extracted operations archive. Its administrator executable is `skills/openkit-ops/scripts/openkit` relative to the archive root. Provide Node.js 24, then run local `ops search diagnostics`, `ops describe bootstrap.consume`, and `ops describe nanohost.enroll`. These commands need no running deployment. Stop on a loader, dependency or schema failure before dependent setup effects. Use only discovery forms supported by that exact package; local help availability depends on its release.

### Check The Host And Reserve Persistent Inputs

Use the NanoHost archive's bundled host profile and installer. From its extracted directory, run `./install.sh --check-host` with the privileges its static checks require. Accept only a fresh `requirements-met` result bound to this archive, profile, machine and observation. `requirements-unmet`, `cannot-check` or stale evidence stops installation. Provision missing prerequisites only under separate operator authorization and rerun the complete check. [Deployment Host Requirements](https://github.com/lingkaix/openkit/blob/main/docs/specs/20260909-deployment_host_requirements.md) distinguishes this result from installation and runtime readiness.

Reserve one fresh persistent Data Root, one protected App-secret directory, one protected NanoHost credential directory, and unused App/private-transport ports. Confirm the selected host has no conflicting NanoHost service or installation. Preserve existing bytes; do not clear directories to make a first-install check pass. NanoHost additionally needs the profile's Docker, systemd, namespace, network and OpenShell prerequisites. The archive supplies its target-matched Gateway; an arbitrary separately installed OpenShell CLI does not replace it.

Through protected operator input, create the server authentication secret and an exact 32-byte `0600` Vault key outside the Data Root. Create only absent files and keep the Vault key for this deployment. Prepare a certificate and private key for the exact NanoHost rendezvous name or address, plus the matching trusted public CA when platform roots do not trust it. Never print secret bytes, place them in command arguments or use TLS verification overrides.

### Configure And Start The Published App

Write the fresh Data Root's `config/server.jsonc` using [configuration](nanocore-data-root-config.en.md). Select server mode, the exact public origin, matching CORS origins and disabled ordinary sign-up. The App process stays on container loopback; Caddy serves Web and public APIs. Configure the separate native HTTP/2 listener, not a route through Caddy.

For a co-located Docker bridge deployment, use this non-secret connection layout. Replace identity placeholders with values admitted by the selected release. The port numbers are examples and must be checked for conflicts.

| Input | Example and required relationship |
| --- | --- |
| App bind | Container `127.0.0.1:4317`; published Caddy `127.0.0.1:18080` maps to container `8080`. |
| Public origin | `http://127.0.0.1:18080` for this host-local example. Remote access requires the separately configured exact HTTPS origin and normal certificate validation. |
| `nanohost.bind` | `{ "host": "0.0.0.0", "port": 18443 }` inside the container; Docker publishes it on host loopback only. |
| `nanohost.rendezvousUrl` | `https://127.0.0.1:18443`; the certificate must be valid for that address. A non-loopback container bind requires TLS even with a host-loopback port mapping. |
| `nanohost.identityId`, `deploymentId`, `credentialRef` | One explicit deployment pair and its non-secret credential reference. Preserve these exact values across both processes. |
| `nanohost.credentialSlots.A` and `.B` | Four distinct absolute `secretPath`/`companionPath` entries under the container's dedicated credential-directory mount. All four files start absent. The host directory is root/service-owned and not group/other writable; secret files are created as `0600`. |
| Vault and TLS files | Container paths under a read-only App-secret mount; set `vault.encryptedFile.keyFilePath`, `OPENKIT_TLS_CERT_FILE`, and `OPENKIT_TLS_KEY_FILE` to their exact files. |

The protected App environment file contains `BETTER_AUTH_SECRET` and the non-secret TLS file references. It contains no NanoHost transport Token. Mount only the declared persistent and protected inputs; do not mount the host Docker socket into NanoCore. Use the published `app` repository and digest from the selected release in this command:

```bash
OPENKIT_APP_REFERENCE='<published-app-repository>@sha256:<published-index-digest>'
OPENKIT_INSTALL_CONTAINER='<explicit-new-container-name>'
docker pull "$OPENKIT_APP_REFERENCE"
docker run --detach --name "$OPENKIT_INSTALL_CONTAINER" --restart unless-stopped \
  --publish 127.0.0.1:18080:8080 \
  --publish 127.0.0.1:18443:18443 \
  --env OPENKIT_CORE_MODE=server \
  --env OPENKIT_BIND_HOST=127.0.0.1 \
  --env-file /absolute/protected/app.env \
  --mount type=bind,src=/absolute/fresh-data-root,dst=/data/openkit \
  --mount type=bind,src=/absolute/protected/app-secrets,dst=/run/openkit-secrets,readonly \
  --mount type=bind,src=/absolute/protected/nanohost-slots,dst=/run/openkit-enrollment \
  "$OPENKIT_APP_REFERENCE"
```

Replace every path before execution. The App configuration's slot paths must resolve through the last mount to the exact host credential files selected below. That mount is writable only for the existing exclusive enrollment/rotation sink; it is not Worker storage. Keep the App and native HTTP/2 ports distinct. Observe public health and fresh Web navigation, but do not report Worker readiness yet.

### Establish Administrator Access And Enroll NanoHost

Set `OPENKIT_NANOCORE_URL` to the exact selected public origin before any networked CLI operation; this example uses `http://127.0.0.1:18080`. Establish the package's supported endpoint credential store, using a working OS secret-store writer or its explicitly permitted encrypted fallback. Credential-store preflight must pass before consuming bootstrap; unavailable storage stops this step.

Use the released CLI's secret-safe `bootstrap.consume` operation to create the first owner. Supply the owner identity and password through protected user input, and consume the one-time bootstrap credential without showing it to the Agent. The CLI stores the resulting administrator credential for that exact endpoint. This release's Web has no bootstrap-token flow: after owner creation, sign in through Web with that owner's email and password while ordinary sign-up remains disabled. Verify administrator access through a public read; never replay bootstrap after the first owner exists. [Deployment modes](nanocore-deployment-modes.en.md#administrator-cli-and-remote-mcp-access) owns connection and credential use.

From the verified NanoHost archive directory, run the installer's no-write `./install.sh --check`. Stop on destination conflict. With installation authorized and its current host check passed, run `sudo ./install.sh`. Require its complete installation result; a partial result retains its existing bounded inspection/retry rules. Installation places the binary, stock Gateway and service unit. It does not configure, enroll or start NanoHost and does not establish readiness.

Create the root-owned `/etc/openkit/nanohost.env` with only the accepted non-secret session inputs:

- `OPENKIT_NANOHOST_IDENTITY_ID` and `OPENKIT_NANOHOST_DEPLOYMENT_ID`: the exact configured pair.
- `OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL`: the exact native HTTP/2 HTTPS origin above.
- `OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE`, and `OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE`: the four host paths corresponding to the App's configured sink mount.
- `OPENKIT_NANOHOST_NANOCORE_CA_FILE`: the trusted public CA file only when required; omission uses platform roots.

Through the authenticated administrator CLI, describe and call `nanohost.enroll` with first `targetSlot: "A"` and the explicitly chosen future expiry. NanoCore must prove exclusive creation of the absent secret and companion files and return only redacted delivery metadata. Do not copy a raw Token into environment, shell, output or a document. An ambiguous or failed sink remains a refusal; inspect it without overwriting another attempt's files.

Only after enrollment succeeds, run `sudo systemctl daemon-reload` and `sudo systemctl start openkit-nanohost.service`. Read `nanohost.runtime-target` for the exact identity/deployment and require current ready, predecessor-fenced and fresh-empty observations. Missing Worker images do not block substrate readiness; stock Supervisor registry/bootstrap dependencies still apply. A service process, installed binary or earlier static host check is insufficient.

### Prepare A Worker And Verify Useful Work

Configure a supported Provider, one sourced positive logical-model context limit and the selected Agent through the existing public configuration and credential owners. Bind its runtime image to the selected release's published `worker-runtimes` digest. The extension base `worker-common` has no Worker runtime; a Docker image pulled into the host daemon is not proof that NanoHost's Image Store has it.

Follow [Prepare And Reuse A Worker Environment](nanocore-operations.en.md#prepare-and-reuse-a-worker-environment) for the exact registered Agent source/revision, immutable preparation candidate and separately authorized activation. Use the existing `worker-environment.prepare`, status and activation operations; retain their exact results. Registry acquisition, logical-model dispatchability and runtime readiness remain separate checks. Do not seed a fixture, stage files into the private epoch or replace a failed readiness result with image presence.

Observe authenticated diagnostics, current NanoHost readiness and public retained records. Ask for one bounded real Worker task through Web or remote MCP, then inspect its terminal outcome and meaningful output. A normal bounded stop does not prove the requested objective. Keep Provider, NanoHost, Worker preparation and real-work results separate. Installation can be complete while runtime qualification remains blocked or incomplete.

### Optional App-Update Helper

The operations archive may include `scripts/docker/app-update-helper.py` outside its Skill subtree. Verify its release/checksum binding before the separately authorized [helper installation and restricted transport setup](nanocore-operations.en.md#restricted-host-helper). Configure only this exact deployment, protected host trust and the fixed command. If the payload is missing, unsupported or unverified, report App update unavailable and finish the basic installation without enabling it. Do not fetch an arbitrary helper, use a source build or invent host-update authority.

Retain the installation and deciding non-secret evidence. A failed stage stops its dependent stage; unavailable observations remain unknown. Preserve the Data Root, Vault key, credentials, installed services and retained work. Neither this guide nor an unsuccessful first attempt grants teardown or reset authority.

## Install From Source

For a source installation, explicitly acquire the source checkout and pinned toolchain before using repository commands:

```bash
git clone --filter=blob:none https://github.com/lingkaix/openkit.git openkit-source
cd openkit-source
git checkout --detach <full-commit>
bash scripts/repo-init.sh
```

The placeholder must be replaced with the selected full commit. Record `git rev-parse HEAD`; do not build an unreviewed moving branch by accident. From that acquired checkout, read `docs/toolchain.md` and `docs/cookbooks/docker-app.md`, then use their current App build/run commands. These source-build procedures intentionally require a checkout; installed-Skill host-only recovery does not.

For source-based initial NanoHost setup, separately establish the exact required Worker images, configured identity/deployment pair, safe credential delivery and readiness. Use the explicitly acquired source's `docs/cookbooks/nanohost-real-use-host.md` with the operator's actual target. Do not copy a repository test-host alias, invoke teardown on a persistent instance, or treat a NanoCore container as proof that Worker execution is ready.

## Establish Access And Configuration

Choose local mode only for an intended implicit local-user deployment. For shared or remote use, configure server mode, its exact public origin and protected authentication secret, then use the normal first-login/bootstrap flow. Browser sign-in or protected credential storage supplies access; never paste raw tokens into Agent context.

Use [configuration](nanocore-data-root-config.en.md) for separate Server, Workspace and User settings. Supply a Provider through its supported credential mechanism, one logical model and an Agent default. Every model needs a sourced or explicitly authored positive context limit; prices and other optional metadata need not be invented. Use the public Skill's discovery and configuration operations when the service is running.

## Verify Useful Work

Observe public health and authorized diagnostics, then verify Provider inference and NanoHost readiness independently. Create or select a Workspace, attach the requested source/data through supported product operations, and ask for one bounded real Worker task in Web or through the public Skill. Inspect the terminal task and meaningful output; a successful Assistant reply or HTTP request does not prove Worker execution.

If a prerequisite is unavailable, report that exact boundary and follow [operations](nanocore-operations.en.md). Preserve the running deployment and unrelated state. [Product use](using-openkit.en.md) explains ordinary work after installation.
