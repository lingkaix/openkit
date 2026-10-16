# App Image

This image packages NanoCore, Web UI assets, Caddy, migrations, and data templates behind one public HTTP port.

All build and runtime stages use the exact digest-pinned Node base declared for `app` in `containers/images.json`.

A release build passes `OPENKIT_RELEASE_TAG` and `OPENKIT_SOURCE_COMMIT` and the runtime stage writes `/usr/local/lib/openkit/release-identity.json`. A build without those arguments, including local and non-release CI builds, omits the file. The identity is not an image `ENV`: the App-update helper replays the previous container's `Config.Env`, which would otherwise keep the old identity after an update. NanoCore reads the file at startup. See [Container Image Packaging](../../docs/specs/20260708-container_image_packaging.md).

The local `scripts/docker/run-app.sh` seed helper authors an explicit 8,000-token compaction threshold for its default logical model. This is a context-management policy, not model capacity metadata; normal provider model/context admission still applies, and existing configuration files are preserved.

After readiness and Caddy startup, the entrypoint waits for either NanoCore or Caddy to exit, then exits nonzero and stops the surviving process through its EXIT trap. Tini therefore exits and the container restart policy can restart the App. Deployment health requires both the Web page and NanoCore `/api/health` through Caddy, using the image's curl and grep.

The entrypoint probes NanoCore's loopback App HTTP/1.1 health endpoint before starting Caddy. Caddy uses that listener for public app routes, including exact `/mcp` before the Web catch-all, and does not publish or connect to the separate private NanoHost HTTP/2 listener.

The public proxy rejects `/v1` and `/v1/*`, bare `/api` and `/internal`, and unsupported `/mcp/*` children with HTTP 404 JSON. Existing App API and exact MCP routes keep their upstream routing. The accepted #209 reachability ruling keeps the Gateway outside the public App origin. The Web fallback serves only GET and HEAD. Other methods receive HTTP 405 JSON with `Allow: GET, HEAD`. The App image smoke checks these responses, query strings, and the Web fallback through packaged Caddy.

The root `Caddyfile` owns one shared `nanocore_transport` snippet for all NanoCore proxies, including SSE and remote MCP. Its upstream idle keep-alive is 4 seconds. NanoCore's shared App HTTP/HTTPS server options advertise 300 seconds and add a 60-second socket buffer, closing idle sockets after 360 seconds on pinned Node 24.18.0. The 356-second margin lets Caddy reuse a socket even when a main-thread stall delays NanoCore reading the request; a stall exceeding the margin can still cause a reset. The five-minute advertised window also covers Chromium's direct Web socket reuse, while the buffer preserves at least one minute beyond clients following that hint. These idle settings do not limit active requests or SSE streams; header receipt remains 60 seconds and full request receipt remains 300 seconds. The separate private HTTP/2 listener has no idle-close timer. Run `node --test tests/app-image-entrypoint.test.mjs` for the configured timeout-ordering and routing regressions; the entrypoint lifecycle cases require Bash with `wait -n` support.

`scripts/docker/smoke-image.sh app` checks the target-native Retrieval Kernel CLI, MCP and local service, embedded Chinese/Japanese dictionaries, byte-range isolation, source-free scope revocation and Linux process limits. It also checks packaged tools and recovery commands, then starts the ordinary entrypoint with a disposable Data Root. It requires public `/api/health` within 60 seconds and checks the SPA root before stopping the server and removing its temporary data. This exercises schema conversion using the production dependency layout created by `pnpm deploy`.

Workspace Zod 4 dependencies pin 4.6.5 exactly so legacy deploy cannot resolve a newer shared schema implementation than NanoCore's locked JSON Schema converter. The separate root A2UI overrides retain Zod 3.25.76 for those packages.

The runtime image exposes the compiled stopped-server administrator recovery command as `/usr/local/bin/openkit-operator` and the stopped-server data-root restore command as `/usr/local/bin/openkit-restore`. Recovery acquires the ordinary NanoCore data-root lock and refuses a live deployment. Restore reuses the existing restore helper, refuses when `server/runtime/nanocore.lock` is present, and does not start NanoCore. The image entrypoint does not invoke either command.

Live `backup.create` writes `/data/openkit.backups/<backupId>`, a sibling of the Data Root, not a directory inside the `/data/openkit` mount. Persist that sibling on the host (`<data-root>.backups`) with the running App.

Restore replaces the target Data Root with `rename`, so the target must be a **child** of a writable directory on one filesystem. Do not bind the host Data Root itself at `/data/openkit`: that path is a mountpoint and rename fails with `EBUSY`. Mount a dedicated host parent at `/restore` and restore its child. Mount the retained backup subtree read-only at `/backup`. Staging defaults to `<data-root>.restore-staging` beside that child, so the parent must be writable.

```bash
docker run --rm --entrypoint openkit-restore \
  --mount type=bind,src=/absolute/path/to/restore-parent,dst=/restore \
  --mount type=bind,src=/absolute/path/to/openkit.backups/<backupId>,dst=/backup,readonly \
  openkit/app:<exact-version> \
  --backup-root /backup \
  --data-root /restore/data
```

The optional App-update transport uses the image's OpenSSH client to invoke a separately installed host helper. `scripts/docker/app-update-helper.py` runs on the selected Linux/systemd/Docker host, outside the App being replaced; its protected configuration defaults to `/etc/openkit/app-update/helper.json`. Its stdin admits only prepare/start/status, while its supervised job preserves the deployment bindings and records observed replacement or recovery. The image carries neither the helper's host privileges nor its private SSH identity. Installation and real-host acceptance are separate from image build and unit checks; see `docs/specs/20260910-app_update_delivery.md` and the `openkit-ops` operations reference. The helper supports only published-release digest pulls. It retains `sourceRepository` for release-tag attribution and requires the current default of 3 GiB free on Docker's data-root filesystem and the receipt filesystem before pulling.

For a deployment with an existing read/write repository bind at `/srv/repos`, the protected host helper configuration sets `repositoryDirectory` to that exact host directory. The helper preserves this configured bind during replacement; it rejects an undeclared, missing or different repository bind. Without that setting, the existing deployment shape is unchanged. Public update requests cannot supply mount paths.

Run `python3 scripts/docker/app-update-helper.test.py -v` from the repository root for the deterministic helper checks, including real Git tag resolution and validation against the public receipt schema. These checks do not establish live deployment success.

NanoCore uses Node's detached process groups and a private supervisor IPC channel to terminate MCP stdio servers and credential-bearing descendants, including when NanoCore exits unexpectedly.

The manual CI `smoke` gate builds this image and runs the operator against disposable data and credential bind mounts without starting NanoCore or Caddy. After a local image build, the same opt-in host check is `OPENKIT_TEST_APP_IMAGE_RECOVERY=1 pnpm run test:app-image-admin-recovery`; never point it at an active or persistent deployment.

It does not own worker agent runtimes. Worker execution belongs in `containers/worker-*` images.

The retrieval build stage supplies the target-native Rust executable for Linux amd64 or arm64. It verifies the vendored mecab-ipadic 2.7.0-20250920 archive before compiling embedded tokenizers, then copies the executable to `/usr/local/bin/retrieval-kernel` and the complete available dependency notices, exact SPDX metadata, and upstream notice provenance to `/usr/local/share/licenses/retrieval-kernel/`. Runtime performs no dictionary download. The app's `notices/GAPS.json` lists unresolved upstream notice supply; packaging does not claim those gaps are settled. No CLI or MCP face is installed in a Sandbox image.

The runtime packages Poppler (`pdfinfo` and `pdftotext`), ImageMagick (`identify` and `convert`), Bubblewrap and `prlimit` for source-owned PDF text-layer and explicit bounded image processing. Packaging does not grant namespace privileges or qualify the processor under the default container restrictions. NanoCore probes the actual fixed isolation boundary for each processing operation and returns a truthful unavailable representation when it cannot run. Media processing does not change App startup or readiness and does not request host or container privilege changes. See [Work Resource Interaction](../../docs/specs/20260713-work_resource_interaction_model.md#bounded-media-processors).
