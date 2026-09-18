# App Image

This image packages NanoCore, Web UI assets, Caddy, migrations, and data templates behind one public HTTP port.

Both build stages use the exact digest-pinned Node base declared for `app` in `containers/images.json`.

The local `scripts/docker/run-app.sh` seed helper authors an explicit 8,000-token compaction threshold for its default logical model. This is a context-management policy, not model capacity metadata; normal provider model/context admission still applies, and existing configuration files are preserved.

The entrypoint probes NanoCore's loopback App HTTP/1.1 health endpoint before starting Caddy. Caddy uses that listener for public app routes and does not publish or connect to the separate private NanoHost HTTP/2 listener.

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

The optional App-update transport uses the image's OpenSSH client to invoke a separately installed host helper. `scripts/docker/app-update-helper.py` runs on the selected Linux/systemd/Docker host, outside the App being replaced; its protected configuration defaults to `/etc/openkit/app-update/helper.json`. Its stdin admits only prepare/start/status, while its supervised job preserves the deployment bindings and records observed replacement or recovery. The image carries neither the helper's host privileges nor its private SSH identity. Installation and real-host acceptance are separate from image build and unit checks; see `docs/specs/20260910-app_update_delivery.md` and the `openkit-ops` operations reference. On the first remote-commit update, the helper initializes the configured `sourceWorkDir` Git cache when that path is missing or empty. It refuses a symbolic link, a non-directory, Git metadata that is a symbolic link, or existing non-Git data before any git effects, and it does not change those files. Operator-staged archives remain the separate unpushed-commit path.

For a deployment with an existing read/write repository bind at `/srv/repos`, the protected host helper configuration sets `repositoryDirectory` to that exact host directory. The helper preserves this configured bind during replacement; it rejects an undeclared, missing or different repository bind. Without that setting, the existing deployment shape is unchanged. Public update requests cannot supply mount paths.

Run `python3 scripts/docker/app-update-helper.test.py -v` from the repository root for the deterministic helper checks, including real Git tag resolution and validation against the public receipt schema. These checks do not establish live deployment success.

NanoCore uses Node's detached process groups and a private supervisor IPC channel to terminate MCP stdio servers and credential-bearing descendants, including when NanoCore exits unexpectedly.

The manual CI `smoke` gate builds this image and runs the operator against disposable data and credential bind mounts without starting NanoCore or Caddy. After a local image build, the same opt-in host check is `OPENKIT_TEST_APP_IMAGE_RECOVERY=1 pnpm run test:app-image-admin-recovery`; never point it at an active or persistent deployment.

It does not own worker agent runtimes. Worker execution belongs in `containers/worker-*` images.
