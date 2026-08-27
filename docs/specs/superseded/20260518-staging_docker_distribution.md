---
status: Superseded
implementation: N/A
status-changed: 2026-07-08
current-guidance: "`docs/specs/20260708-container_image_packaging.md`"
decision-evidence: "`docs/specs/20260708-container_image_packaging.md`"
---
# Staging Docker Distribution

## Lifecycle Reason

Container Image Packaging And Release Publishing absorbed image taxonomy, Dockerfile ownership, smoke validation, metadata, and release publication into the active packaging contract. The staging-only distribution lost authority because its bundled host-mode runtime assumptions conflict with the current governed worker architecture.

## Retention Reason

This document preserves the original staging image goals, single-container deployment constraints, provider seeding, and platform assumptions so packaging history remains auditable without allowing the obsolete host-mode bundle to shape current releases.

Updated 2026-05-29: Staging provider seed config uses `secretRef: "env:OPENROUTER_API_KEY"` and rejects inline credential fields such as `apiKey`. `defaultProviderId` remains current where it names the gateway or internal facade default. See [Remove Historical Compatibility Layers](./20260529-remove_legacy_compatibility.md).

## Summary

OpenKit v0.0.3 defines three Docker image classes and implements the staging image first.

The staging image packages NanoCore, the web UI, Codex, and OpenCode into one container for real server trials on single-container platforms such as Fly.io, Railway, and Dokploy, but it is not the final production distribution.

The durable decisions are:

- OpenKit owns three image classes: `dev-e2e`, `staging`, and `release`.
- The `dev-e2e` image is for debug, browser e2e, black-box NanoCore e2e, and CI-style diagnostics.
- The `staging` image is the v0.0.3 target and runs NanoCore in `local` mode without an auth wall.
- The `staging` image bundles Codex and OpenCode with the UI and NanoCore, and NanoCore connects to those runtimes through loopback host-mode adapters.
- The future `release` image packs only UI and NanoCore, runs NanoCore in `server` mode, and expects agents to run in separate local or remote containers.
- The container uses one persistent data root, defaulting to `/data/openkit`.
- NanoCore remains the only public API owner.
- The web UI and NanoCore are served from one HTTP port through Caddy.
- Agent runtimes run behind NanoCore and are never exposed directly.
- Codex uses the existing `codex app-server` adapter path.
- OpenCode uses `opencode serve` as the runtime boundary; the SDK may be used only as a client helper.
- LLM provider configuration stays file-backed under the data root, is seeded with OpenAI, OpenRouter, xAI/Grok, Google Gemini, and custom OpenAI-compatible templates, and selects the default provider from the server config file.
- models.dev metadata is vendored as a version-tagged snapshot so the provider list is stable until the project intentionally refreshes it.

## Goals / Non-goals

Goals:

- Define the three-image distribution taxonomy and keep Dockerfile names aligned with it.
- Build the `staging` OCI image that includes `apps/nanocore`, `apps/web`, Caddy, Codex CLI, and OpenCode CLI.
- Keep staging NanoCore in `local` mode by default with no auth wall.
- Serve the SPA and API from one external port.
- Make `OPENKIT_DATA_ROOT` explicit and volume-friendly for server deployment.
- Keep all operator-editable config and durable records inside the data root.
- Add `data/config/server.jsonc` as the server config file and use it to select the default providers.
- Add staging provider templates for OpenAI, OpenRouter, xAI/Grok, Google Gemini, and custom OpenAI-compatible endpoints.
- Vendor a version-tagged models.dev snapshot and treat refreshes as explicit maintenance work.
- Add an OpenCode agent manifest and adapter plan that matches OpenKit's `Core -> Agent` boundary.
- Verify the image with black-box Docker smoke tests, including boot, health, UI load, provider diagnostics, storage persistence, and agent runtime availability.
- Audit the web UI against v0.0.1 and v0.0.2 capabilities so the staging image exposes the actual current product surface.

Non-goals:

- Hardened production image, horizontal scaling, HA SQLite, managed object storage, or production orchestration.
- Complete implementation of the future formal `release` image beyond defining its contract.
- In-container TLS termination as a release gate. Staging platforms can terminate TLS before the container.
- Full Secret Vault implementation.
- Remote agent pools or bridge sidecars.
- Automatic migration from v0.0.1 data roots.
- Live models.dev fetches during container boot.

## Background

v0.0.2 established local/server mode, `OPENKIT_DATA_ROOT`, `core.sqlite`, file-backed provider profiles, agent manifests, server-mode auth, diagnostics, and e2e release gates.

v0.0.3 moves from local dogfooding to a deployable staging artifact while preserving the small `App + Core + Agent` boundary.

The staging image should prove that OpenKit can run as a real server with persistent data and configured LLM providers before the project commits to the formal release image and remote-agent architecture.

## Decision

### Runtime boundary

NanoCore is the public server.

Agent servers are private child processes controlled by NanoCore.

Codex continues to use `codex app-server`.

OpenCode should use `opencode serve` as the agent runtime boundary.

US-011 resolves the client strategy: NanoCore starts and supervises `opencode serve` itself, uses raw HTTP only for early readiness probes such as `/global/health` or `/doc`, and then uses `@opencode-ai/sdk` in client-only mode for typed session, prompt, abort, and event APIs.

This follows the same logic as the Codex decision: Core owns lifecycle, readiness, credentials, event projection, and termination; native SDKs should not hide those responsibilities.

### Container boundary

OpenKit has three image classes:

| Image class | Purpose | NanoCore mode | Bundled agents | Agent location |
| --- | --- | --- | --- | --- |
| `dev-e2e` | Debug, local test, browser e2e, and process e2e diagnostics. | `local` unless a test overrides it. | Codex, OpenCode, simulator, and test helpers. | Same container or test-controlled loopback processes. |
| `staging` | v0.0.3 server trials and dogfooding. | `local`, with no auth wall by default. | Codex and OpenCode. | Same container, reached by NanoCore through loopback host-mode adapters. |
| `release` | Future formal product image. | `server`. | None by default. | Separate local or remote agent containers managed by future orchestration. |

The v0.0.3 implementation target is `staging`.

The staging image exposes one HTTP port.

Caddy serves `apps/web/dist` at `/` and reverse-proxies `/api/*` and `/internal/*` to NanoCore on loopback.

The image starts NanoCore first, waits for `/api/health`, then starts Caddy.

If NanoCore exits, the container exits.

The staging entrypoint sets `OPENKIT_CORE_MODE=local` unless the operator explicitly overrides it.

The future release image must not bundle Codex or OpenCode in the same runtime layer by default.

### Data root boundary

The container default data root is `/data/openkit`.

Operators can override it with `OPENKIT_DATA_ROOT`, but platform examples should mount persistent storage at `/data/openkit`.

All durable state must live under the data root:

- `core.sqlite`
- `config/server.jsonc`
- `config/providers/*.provider.jsonc`
- `config/agents/*.agent.jsonc`
- `config/agents/*.agent.jsonc`
- user and workspace files under `users/<userId>/workspaces/<workspaceId>/`
- future conversation records, artifact metadata, usage summaries, and diagnostics projections

Runtime cache, temporary sockets, generated Caddy config, pid files, and logs can live outside the data root if they are rebuildable.

### Server config boundary

The server config file lives at `data/config/server.jsonc`.

v0.0.3 keeps JSONC as the runtime config format because NanoCore already has a JSONC loader and template-copy path.

The server config owns deployment-level defaults:

```jsonc
{
  "mode": "local",
  "defaults": {
    "coreProviderId": "openai",
    "coreModel": "gpt-5.1",
    "gatewayProviderId": "openai",
    "gatewayModel": "gpt-5.1",
    "agentId": "agent_codex_host"
  },
  "internal": {
    "openaiCompatFacade": {
      "enabled": true,
      "defaultProviderId": "openai",
      "defaultModel": "gpt-5.1"
    }
  }
}
```

`defaults.coreProviderId` and `defaults.gatewayProviderId` are separate defaults.

`internal.openaiCompatFacade.defaultProviderId` can mirror it for the OpenAI-compatible internal facade.

If both are present and conflict, NanoCore must either document the precedence clearly or reject the config with a typed diagnostic.

### Provider config boundary

Provider config remains file-backed JSONC and must use `secretRef` for credential material. Inline credential fields such as `apiKey`, `token`, `secret`, and `clientSecret` are invalid.

The staging template set includes:

- `openai.provider.jsonc`
- `openrouter.provider.jsonc`
- `xai-grok.provider.jsonc`
- `gemini.provider.jsonc`
- `custom-openai-compatible.provider.jsonc`

The templates should use provider ids that align with models.dev where practical:

- `openai`
- `openrouter`
- `xai`
- `google`
- `custom-openai-compatible`

The first release seeds static templates and vendors a models.dev snapshot with an explicit version tag.

The v0.0.3 snapshot lives under `packages/models-dev-catalog/snapshots/2026-05-18/` with `api.json`, `metadata.json`, and a refresh guide in `packages/models-dev-catalog/README.md`.

The v0.0.3 `api.json` checksum is `cbcd32171e574e4ff1ff7c7720b708da25539b9ee664459bdc15617ea7375e00`.

Runtime boot reads the vendored snapshot or static templates only; it never fetches models.dev over the network.

Refreshing the vendored snapshot is explicit maintenance work and should update the tag, source URL, checksum, and a short changelog entry.

## Proposed Design

### Image shape

Use a multi-stage build:

1. `deps` stage installs workspace dependencies with pnpm.
2. `build` stage builds `@openkit/protocol`, `@openkit/core-client`, `nanocore`, and `web`.
3. `runtime` stage contains Node 24, Caddy, built NanoCore files, built web assets, runtime production dependencies, data templates, Drizzle migrations, Codex CLI, and OpenCode CLI.

The first Dockerfile can be named `Dockerfile.staging` to keep the production Dockerfile name available for the future release image.

The dev/debug/e2e image can be named `Dockerfile.dev-e2e` or use a `dev-e2e` target in the same Dockerfile if that keeps build caching simpler.

Use build args for agent runtime versions:

- `CODEX_CLI_VERSION`, defaulting to `0.130.0`
- `OPENCODE_CLI_VERSION`, defaulting to `1.15.4`

The image build must not silently use floating agent runtime versions in CI.
The runtime image installs Codex from the platform-native Linux payload for the Docker target architecture and exposes the native binary directly at `/opt/codex/bin/codex`.
The npm Codex wrapper is not part of the runtime execution path.

### Entrypoint shape

The entrypoint should:

1. Resolve `OPENKIT_DATA_ROOT`, defaulting to `/data/openkit`.
2. Create the data root when missing.
3. Start NanoCore on loopback with `OPENKIT_CORE_MODE=local` and `OPENKIT_BIND_HOST=127.0.0.1` unless explicitly overridden.
4. Wait for NanoCore health.
5. Start Caddy on `0.0.0.0:${PORT:-8080}`.
6. Stop both processes when either one exits.

### Caddy routes

Caddy should:

- serve static SPA files from `/srv/openkit/web`
- use SPA fallback to `index.html`
- proxy `/api/*` to `http://127.0.0.1:${OPENKIT_CORE_PORT:-3000}`
- proxy `/internal/*` to the same NanoCore origin
- avoid proxying OpenCode or Codex agent servers directly

### Agent runtime packaging

Codex acceptance checks:

- `codex --version` works in the runtime image.
- `codex app-server --help` works in the runtime image.
- existing skip-aware Codex smoke e2e can run from the image when credentials are supplied.

OpenCode acceptance checks:

- `opencode --version` works in the runtime image.
- `opencode serve --help` works in the runtime image.
- NanoCore can report OpenCode runtime readiness from the agent manifest.
- NanoCore can start a supervised `opencode serve` process on loopback, protect it with generated Basic Auth credentials, probe `/global/health` or `/doc`, and project prompt output through existing agent-session events.

### UI sync audit

The web UI must visibly cover the current v0.0.1 and v0.0.2 capabilities before the Docker image is considered complete:

- workspace selection and creation
- thread list and thread workbench
- streaming assistant items
- command output deltas
- approvals
- user-input questions
- artifacts
- agent session visibility and refresh
- workspace configuration
- workspace memory editing
- per-turn feedback
- diagnostics refresh
- provider summaries and redaction
- agent readiness
- server-mode sign-up, sign-in, and sign-out
- protected API rejection after logout

This is a product audit, not only a test audit. Missing visible UI should become explicit v0.0.3 tasks.

## Alternatives Considered

Use the OpenCode SDK as the primary runtime boundary:

- Rejected for staging because the SDK is a client for the server and can hide the agent process lifecycle that NanoCore must own.
- Allowed as an internal HTTP client after NanoCore starts and supervises `opencode serve`.

Expose NanoCore and web UI on separate ports:

- Rejected for staging because platforms are easier to trial with one HTTP service and one public port.

Serve static assets from NanoCore directly:

- Deferred. Caddy gives a small, explicit staging boundary and can later grow into compression, cache headers, and reverse-proxy policy without putting static serving into NanoCore.

Use Nginx instead of Caddy:

- Viable fallback. Caddy is preferred for the first staging image because the config is smaller and SPA fallback is straightforward.

Fetch models.dev on every boot:

- Rejected for v0.0.3. Boot should not require external network access beyond configured LLM providers.

Use live models.dev without vendoring:

- Rejected because the provider list would change outside OpenKit release control.
- A version-tagged vendored snapshot gives stable reviewable diffs and predictable staging behavior.

## Consequences

The staging image is operationally simple but intentionally not horizontally scalable.

SQLite and file-backed workspace state assume one writer process per data root.

Agents share the container filesystem and process namespace in staging, so this does not prove the later remote-agent sandbox boundary.

Provider template quality becomes user-visible in server deployments, so diagnostics and redaction must remain strict.

## Rollout / Migration Plan

1. Add this spec and the v0.0.3 release plan.
2. Add Docker smoke tests before adding the Dockerfile.
3. Add `Dockerfile.staging`, Caddy config, and entrypoint.
4. Add server config template with `defaults.coreProviderId` and `defaults.gatewayProviderId`.
5. Add provider templates, vendored models.dev snapshot, and diagnostics tests.
6. Add OpenCode agent manifest and readiness tests.
7. Implement the OpenCode server adapter as a separate `apps/nanocore` session beside the command-backed path.
8. Add web UI sync audit tests and fill visible gaps.
9. Add image-level e2e that boots the container against a temporary persistent data root and verifies restart persistence.
10. Document deployment examples only after the local image smoke passes.

## Testing Strategy

Required test layers:

- Unit tests for provider template loading and redaction.
- Unit tests for server config default-provider resolution.
- Unit tests for vendored models.dev snapshot loading and version metadata.
- Unit tests for OpenCode agent manifest loading and readiness.
- Dockerfile static tests for required copied files and entrypoint references.
- Image smoke test that builds the staging image and checks `codex`, `opencode`, `node`, and `caddy` availability.
- Container black-box test for `/api/health`, SPA root load, diagnostics, and restart persistence.
- Existing `pnpm -w verify:full`.
- Web Playwright e2e against the single-container route, not only the Vite dev proxy.
- `scripts/docker/staging-ui-e2e.sh` starts the staging image through Caddy, seeds a redaction-safe provider, enables internal self-check local turns, and runs `pnpm --filter @openkit/web e2e:staging`.

## Risks & Mitigations

Risk: agent CLI installs drift or break image builds.

Mitigation: pin versions with build args and record them in the image label or diagnostics endpoint.

Risk: Caddy hides NanoCore errors during boot.

Mitigation: entrypoint waits for NanoCore health and exits if NanoCore fails.

Risk: provider credentials leak through diagnostics or bundled templates.

Mitigation: reject inline credential fields, redact secret references and URL auth components in diagnostics, and add image-level redaction checks.

Risk: OpenCode server behavior differs from the SDK abstraction.

Mitigation: define the adapter against the server's OpenAPI surface first and use the SDK only when it does not obscure errors or lifecycle.

Risk: data written outside `/data/openkit` is lost on platform restart.

Mitigation: add a container restart e2e that creates a workspace and verifies the workspace after restart with only `/data/openkit` persisted.

Risk: staging accidentally drifts into the formal release image.

Mitigation: keep image taxonomy in docs and tests, and assert that `Dockerfile.staging` bundles agents while the future `release` image contract does not.

## Open Questions

- Should Caddy be included in the same image or should NanoCore eventually serve static assets directly for a smaller image?
- Resolved by US-011: use `@opencode-ai/sdk` client-only mode after NanoCore starts and authenticates `opencode serve`; keep raw HTTP for readiness probes and fallback diagnostics only.

## Links

- Historical v0.0.2 release record (no longer retained in the repository)
- [OpenCode documentation](https://opencode.ai/docs/)
- [OpenCode SDK package](https://www.npmjs.com/package/@opencode-ai/sdk)
- [OpenAI-Compatible Internal Facade](./20260517-openai_compat_facade.md)
- [Agent Manifest Loader](./agent-setup-runtime-supply/20260517-agent_manifest_loader.md)
- [NanoCore Black-Box E2E Harness](./test-strategy/20260517-nano_core_e2e_harness.md)
