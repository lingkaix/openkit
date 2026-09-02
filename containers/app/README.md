# App Image

This image packages NanoCore, Web UI assets, Caddy, migrations, and data templates behind one public HTTP port.

Both build stages use the exact digest-pinned Node base declared for `app` in `containers/images.json`.

The entrypoint probes NanoCore's loopback App HTTP/1.1 health endpoint before starting Caddy. Caddy uses that listener for public app routes and does not publish or connect to the separate private NanoHost HTTP/2 listener.

The runtime image exposes the compiled stopped-server administrator recovery command as `/usr/local/bin/openkit-operator`. It acquires the ordinary NanoCore data-root lock and refuses a live deployment; the image entrypoint does not invoke it.

It does not own worker agent runtimes. Worker execution belongs in `containers/worker-*` images.
