# App Image

This image packages NanoCore, Web UI assets, Caddy, migrations, and data templates behind one public HTTP port.

It does not own worker agent runtimes. Worker execution belongs in `containers/worker-*` images.
