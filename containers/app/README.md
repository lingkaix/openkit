# App Image

This image packages NanoCore, Web UI assets, Caddy, migrations, and data templates behind one public HTTP port.

Both build stages use the exact digest-pinned Node base declared for `app` in `containers/images.json`.

The entrypoint probes NanoCore's loopback App HTTP/1.1 health endpoint before starting Caddy. Caddy uses that listener for public app routes and does not publish or connect to the separate private NanoHost HTTP/2 listener.

The runtime image exposes the compiled stopped-server administrator recovery command as `/usr/local/bin/openkit-operator`. It acquires the ordinary NanoCore data-root lock and refuses a live deployment; the image entrypoint does not invoke it.

The optional App-update transport uses the image's OpenSSH client to invoke a separately installed host helper. `scripts/docker/app-update-helper.py` runs on the selected Linux/systemd/Docker host, outside the App being replaced; its protected configuration defaults to `/etc/openkit/app-update/helper.json`. Its stdin admits only prepare/start/status, while its supervised job preserves the deployment bindings and records observed replacement or recovery. The image carries neither the helper's host privileges nor its private SSH identity. Installation and real-host acceptance are separate from image build and unit checks; see `docs/specs/20260910-app_update_delivery.md` and the `openkit-ops` operations reference.

Run `python3 scripts/docker/app-update-helper.test.py -v` from the repository root for the deterministic helper checks, including real Git tag resolution and validation against the public receipt schema. These checks do not establish live deployment success.

NanoCore uses Node's detached process groups and a private supervisor IPC channel to terminate MCP stdio servers and credential-bearing descendants, including when NanoCore exits unexpectedly.

The manual CI `smoke` gate builds this image and runs the operator against disposable data and credential bind mounts without starting NanoCore or Caddy. After a local image build, the same opt-in host check is `OPENKIT_TEST_APP_IMAGE_RECOVERY=1 pnpm run test:app-image-admin-recovery`; never point it at an active or persistent deployment.

It does not own worker agent runtimes. Worker execution belongs in `containers/worker-*` images.
