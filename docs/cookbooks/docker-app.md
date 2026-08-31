# Docker App Image

The `containers/app/Dockerfile` image is the app deployment contract for single-container server trials and dogfooding.

It builds `@openkit/protocol`, `@openkit/core-client`, `nanocore`, and `web`, then ships built NanoCore files, production NanoCore dependencies, Drizzle migrations, data templates, web SPA assets, Caddy, and `tini`.

The image exposes only the public Caddy HTTP port.

NanoCore's App HTTP/1.1 listener stays loopback-only and is exposed through Caddy. A configured private NanoHost HTTP/2 listener uses a different local port and is never published or proxied by the app image.

## Build

```bash
scripts/docker/build-image.sh app
```

The image is built from `node:24-bookworm-slim` to match `.node-version`.

The builder enables pnpm 10 through Corepack, installs native build tooling for `better-sqlite3`, builds the workspace packages in dependency order, and uses `pnpm deploy --prod --legacy` to create the production NanoCore tree.

Worker runtimes are packaged separately under `containers/worker-*`.

## Run

For the standard local dogfooding setup, use the repo-level helper:

```bash
pnpm run app:run
```

The helper creates `~/nano-data` when it does not exist, loads `~/nano-data/secrets/openkit.env` when that file exists, seeds deployment defaults in `config/server.jsonc`, an OpenRouter profile in `config/providers/openrouter.provider.jsonc`, a logical route in `config/gateway.jsonc`, and `config/internal-role-profiles.jsonc`, mounts that data root into the app container, and serves the web UI at `http://127.0.0.1:7080`.

Rebuild the app image before starting it with:

```bash
pnpm run app:run --rebuild
```

Before using real provider-backed turns, put `OPENROUTER_API_KEY='...'` in `~/nano-data/secrets/openkit.env`, or export it in the host shell that runs `pnpm run app:run`.

If you use several Provider accounts, give each Provider file its own `secretRef`, add the desired private Provider routes to `gateway.jsonc`, and put referenced `env:NAME` assignments in `~/nano-data/secrets/openkit.env` or export them before starting the app.

Existing app provider entries that still contain inline credential fields such as `apiKey` fail clearly and must be changed to `secretRef`.

```bash
docker run --rm -it -p 8080:8080 -v /tmp/openkit-data:/data/openkit openkit/app:dev
```

Caddy serves the SPA from `/srv/web`, proxies ordinary `/api/*` and `/internal/*` requests to the NanoCore App HTTP/1.1 listener on loopback without stripping route prefixes, returns `404` for `/api/nanohost/transport/*`, and disables gzip plus enables immediate flushing for turn SSE routes.

## Smoke

```bash
scripts/docker/smoke-image.sh app
```

The smoke command reports Node, pnpm, and Caddy versions as required app tools.

## Persistence Smoke

Run the host-side persistence smoke after building the app image:

```bash
scripts/docker/app-persistence-smoke.sh
```

The script starts `openkit-app` with a temporary host directory mounted at `/data/openkit`, seeds a minimal `config/server.jsonc` when no server config exists, verifies `/api/health` and the SPA root through the public Caddy route, creates a Workspace through `/api/workspaces`, writes smoke-owned runtime and log markers, restarts the container with the same mount, and verifies the Workspace plus the canonical data-root layout survived.

The PASS summary covers `server/db/core.sqlite`, `config/server.jsonc`, `server/files`, `server/runtime`, `server/vendor`, the personal `users/user_local` subtree, the canonical `workspaces/<workspaceId>` subtree, an agent resolved-snapshot marker, and server and Workspace log markers.

Override the image, host port, or data root when needed:

```bash
OPENKIT_APP_IMAGE=openkit/app:dev \
OPENKIT_APP_SMOKE_PORT=18080 \
OPENKIT_APP_SMOKE_DATA_ROOT=/tmp/openkit-data \
scripts/docker/app-persistence-smoke.sh
```

## Packaged UI E2E

Run the host-side packaged UI e2e after building the app image:

```bash
scripts/docker/e2e-app.sh
```

The script starts `openkit/app:dev` with a temporary data root, seeds a redaction-safe provider profile that uses `secretRef: "env:OPENKIT_APP_E2E_SECRET"`, enables the simulator executor, publishes only the public Caddy route, and runs `pnpm --filter @openkit/web e2e:staging` against that route.

Override the image, host port, data root, provider id, or fixture secret when needed:

```bash
OPENKIT_APP_IMAGE=openkit/app:dev \
OPENKIT_APP_UI_E2E_PORT=18081 \
OPENKIT_APP_UI_E2E_DATA_ROOT=/tmp/openkit-app-data \
OPENKIT_APP_E2E_PROVIDER_ID=provider_app_redaction \
OPENKIT_APP_E2E_SECRET=sk-openkit-app-e2e-secret \
scripts/docker/e2e-app.sh
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CADDY_HTTP_PORT` | `8080` | Public HTTP port served by Caddy. |
| `OPENKIT_HTTP_PORT` | `4317` | App-image alias for the internal NanoCore HTTP port; the entrypoint exports it to NanoCore's `PORT`. |
| `OPENKIT_CORE_MODE` | `local` | NanoCore mode for app. |
| `OPENKIT_BIND_HOST` | `127.0.0.1` | NanoCore bind host, kept on loopback unless explicitly overridden. |
| `OPENKIT_DATA_ROOT` | `/data/openkit` | Mounted persistent data root for SQLite, config, server runtime, personal user state, and canonical Workspace state. |

NanoCore's actual HTTP port environment variable is `PORT`.

The app entrypoint accepts either `OPENKIT_HTTP_PORT` or `PORT`, requires them to match if both are set, and then exports `PORT` before starting NanoCore.

## Image Boundary

Caddy is locked to the current app image because the app image needs one public HTTP port for the SPA and NanoCore APIs.

Caddy is not part of the future formal release image contract unless a later release-image decision adds it explicitly.
