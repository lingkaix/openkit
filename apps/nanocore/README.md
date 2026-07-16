# nanocore

`nanocore` is the tiny real demo core server for the UI-first protocol slice.

## Scope

- local-mode single-user operation
- server-mode HTTP-only session auth
- optional file-backed state through `OPENKIT_DATA_ROOT`
- implicit local actor `user_local`
- governed container Worker Agent sessions
- Codex-managed ChatGPT subscription login state
- agent-facing LLM Gateway endpoints for Chat Completions and Responses
- workspace repository resources for governed worker materialization
- Goal Mode planning, task supervision, actionable human review, stored verification evidence, and terminal summaries
- real HTTP + SSE protocol surface
- thread-bound agent reuse

## Runtime

- `nanocore` starts governed worker sessions through the configured container worker runtime.
- one nanocore thread binds to one Codex agent session
- follow-up turns on the same thread reuse the same agent session when it stays healthy
- current capabilities: turn execution, streaming assistant text, approval bridging, user-input questions, interruption, artifact inventory/content and review decisions, workspace configuration, workspace knowledge editing, repository linking, Goal Mode start and plan approval, actionable Goal Review, stored verification evidence, terminal summaries, unified Human Attention Action Center projection, Codex/ChatGPT login coordination, and dual-entry LLM Gateway routing
- current non-goals: remote agents, full Sustained Mode automation, Task Evaluator loops, and an independent final-verifier completion gate

## Prerequisites

- real governed worker sessions require one local or remote disposable OpenShell Cell on a Linux/systemd host
- the Cell host must provide official, unmodified `/usr/bin/openshell` and `/usr/bin/openshell-gateway` binaries at exactly `0.0.80`, containerd, Docker Engine and CLI, util-linux `flock`, and `curl`; the NanoCore host must provide the official OpenShell CLI `0.0.80` at its platform path
- the fixed `/usr/local/libexec/openkit-openshell-cell` helper and Cell image cache must be installed as documented in [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md)
- the configured Codex account can be prepared through the Settings Diagnostics Codex ChatGPT account panel, or ahead of time with `codex login` in the selected worker environment

## Commands

```bash
pnpm --filter @openkit/nanocore dev
pnpm --filter @openkit/nanocore test
pnpm --filter @openkit/nanocore typecheck
pnpm --filter @openkit/nanocore build
pnpm --filter @openkit/nanocore lint
pnpm --filter @openkit/nanocore format
pnpm --filter @openkit/nanocore run openapi:generate
pnpm --filter @openkit/nanocore run openapi:validate
pnpm --filter @openkit/nanocore run openapi:check
pnpm --filter @openkit/nanocore run test:e2e
pnpm --filter @openkit/nanocore run test:e2e:smoke
pnpm -w verify:release
pnpm -w verify:full
```

## Local Integration

Run this app first when you want to drive the product through the browser or MCP with the configured worker container runtime:

```bash
mise exec -- pnpm --filter @openkit/nanocore dev
```

Run the skip-aware real Codex smoke e2e locally only after `codex` is installed, `codex login` has completed, and a credential marker is present:

```bash
OPENKIT_E2E_REAL_CODEX=1 OPENKIT_E2E_REAL_CODEX_CREDENTIAL=1 pnpm --filter @openkit/nanocore run test:e2e
```

The smoke spec stays skipped unless `OPENKIT_E2E_REAL_CODEX=1` is set, `codex` resolves in the selected worker environment, and either `OPENAI_API_KEY` or `OPENKIT_E2E_REAL_CODEX_CREDENTIAL=1` is present.

The server listens on `http://localhost:3000` and exposes the demo protocol surface under `/api`.

The unified Human Attention Action Center is available at `GET /api/app/workspaces/:workspaceId/action-center`. It replaces the old split pending approvals and pending questions endpoints, and projects approval gates, user-input gates, Goal Mode attention, pending input, checkpoint recovery, scheduler admissions, agent readiness failures, artifact review, durable workspace review, and explicit knowledge proposal records into one App API read model. Scheduler admission readback is available at `GET /api/app/workspaces/:workspaceId/scheduler/admissions`; it returns workspace-filtered queued and denied admissions with queue position and denial reasons, but excludes raw turn input, user ids, captured cwd, and workspace root paths. Scheduler admission actions are available at `POST /api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/retry` for denied admissions and `POST /api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/cancel` for queued or denied admissions. Durable workspace review decisions are available at `POST /api/app/workspaces/:workspaceId/workspace-sync/reviews/:reviewId/decision` for accepted, refinement, rejected, and blocked outcomes.

Live default-accept Goal Review rows created by human-reviewed steps expose an accept action; accepting one atomically resolves the review and advances the goal task graph.

Redacted Agent Environment Package snapshot readback is available at `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots` and `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots/:snapshotId`. These routes return durable workspace-owned package snapshots for diagnostics and evidence without exposing backend-private fields, raw credentials, or host-local runtime references.

Knowledge Store observation ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/observations` and `GET /api/app/workspaces/:workspaceId/knowledge/observations`. Knowledge Store claim ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/claims` and `GET /api/app/workspaces/:workspaceId/knowledge/claims`. Knowledge Store conflict ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/conflicts`, `GET /api/app/workspaces/:workspaceId/knowledge/conflicts`, and `POST /api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution`. Knowledge Store derived indexes are available at `GET /api/app/workspaces/:workspaceId/knowledge/indexes`. The index route rebuilds disposable workspace knowledge indexes from file-backed records and returns the current Markdown concept-link graph, per-page validation report, source-reference index, and portable full-text index. Deterministic first-slice retrieval is available at `POST /api/app/workspaces/:workspaceId/knowledge/retrievals`; it ranks active valid pages from the full-text index and appends the selected/excluded decision trace to `knowledge/traces/<YYYYMM>.jsonl`. Knowledge Manager context preparation is available at `POST /api/app/workspaces/:workspaceId/knowledge/manager/context`; NanoCore persists the response snapshot under `knowledge/context-packages/<YYYYMM>.jsonl`, `GET /api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId` reads one persisted trace, and `POST /api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId/materialization` writes the first worker-visible `/openkit/context` package snapshot under workspace-owned storage.

The storage App API exposes `GET /api/app/storage/layout-report`, `POST /api/app/data-root/backups`, and `POST /api/app/data-root/backups/:backupId/verify` for layout diagnostics and server-managed hot backup verification. All three deployment-wide routes accept only the implicit local actor or a `server-admin` bearer token; Better Auth sessions and workspace-scoped tokens receive `403 Forbidden`. Backup responses return only a backup id, manifest, and checked inventory summary; they do not expose filesystem paths.

Restore is intentionally a stopped-server operator command, not a live App API:

```bash
pnpm --filter @openkit/nanocore run data-root:restore -- \
  --backup-root /absolute/path/to/openkit-backup \
  --data-root /absolute/path/to/openkit-data
```

The restore command refuses to run when `server/runtime/nanocore.lock` exists, verifies the backup manifest first, replaces the target data root through the storage restore helper, and prints a path-free JSON summary.

The Codex ChatGPT subscription login app API is available under `/api/app/oauth/openai-codex/accounts/*`. Every status, login, cancel, and logout action is scoped to an explicit account slot; each server-owned account slot uses its own `DATA_ROOT/server/files/oauth/openai-codex/accounts/<slot>/codex-home` as `CODEX_HOME`, and public payloads contain only sanitized login state, URLs, device codes, account label, plan type, and non-secret provider bindings. This server-owned OAuth surface accepts only the implicit local actor or a `server-admin` bearer token; a valid Better Auth session is not deployment-admin authority.

The agent-facing LLM Gateway exposes `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, and `GET /health`. The `/v1/*` surface uses the same actor authentication and workspace-scope checks as product APIs in server mode; local mode uses the implicit local actor. The separate internal `POST /api/worker-inference/v1/chat/completions` and `POST /api/worker-inference/v1/responses` routes accept only a live scheduler lease token bound to a hydrated trusted-relay AEP, derive provider/model/lineage from that package, reject caller authority and provider-side state, and require a fresh durable capability call before dispatch. Provenance-required packages must also supply the pinned canonical runtime hint; NanoCore derives product-safe origin and cache refs, strips every native value before dispatch, and reconciles provisional origin refs against the verified turn-end provenance index. Provider diagnostics show whether each provider supports Chat Completions and Responses natively or through a bridge. The public Gateway preserves OpenAI-compatible `prompt_cache_key` and `prompt_cache_retention` fields, ensures every upstream native Chat Completions or Responses request has a `prompt_cache_key`, and reports process-local cached input token summaries in Settings Diagnostics. Workspace-attributed capability calls and usage rows can be read through `GET /api/app/workspaces/:workspaceId/capability-usage`; CapabilityCall owns the authorizing package snapshot plus optional product-safe runtime-origin and cache-lineage refs, while linked usage and audit rows remain unchanged. NanoCore-owned domain producers write workspace evidence bundles and consumers read them through `GET /api/app/workspaces/:workspaceId/evidence-bundles`; workspace audit events can be read through `GET /api/app/workspaces/:workspaceId/audit/events`; server audit events can be read through deployment-admin `GET /api/app/audit/events`; workspace permission decisions can be read through `GET /api/app/workspaces/:workspaceId/permission-decisions`; and server permission decisions can be read through deployment-admin `GET /api/app/permission-decisions`. It does not expose `POST /v1/completions` or the superseded `/internal/v1/chat/completions` facade. The `openai_codex` provider uses Codex-managed ChatGPT subscription auth for native Responses calls and supports Chat Completions through the text-only bridge.

Pi-ai-routed requests observe one provider-native terminal usage payload before public OpenAI normalization. Workspace-attributed calls write positive input, output, cache-read, and cache-write token rows plus one `unit: "usd"` cost-estimate row when reported; that estimate is telemetry, not billing truth. Public responses, SSE, errors, and diagnostics keep the existing OpenAI-compatible vocabulary and never expose raw cost objects or prompt-cache keys.

Deployment-wide diagnostics at `GET /api/diagnostics`, `GET /api/app/diagnostics`, and `GET /api/setup/diagnostics` accept only the implicit local actor or a `server-admin` bearer token. Better Auth sessions and workspace-scoped tokens cannot read deployment provider, OAuth, runtime-config, storage, or readiness projections.

Vault admin routes expose redacted status and lock controls under `/api/app/vault/*`. Global status, unlock, lock, Codex auth JSON bootstrap, and server vault-use evidence accept only the local actor or a `server-admin` bearer token; Better Auth sessions and workspace-scoped tokens cannot use that deployment-admin surface. `POST /api/app/vault/bootstrap/codex-auth-json` stores base64 request content as the server-owned `vault_codex_auth_json` reference and creates `grant_codex_auth_json` for OpenShell runtime-file injection to `/sandbox/.codex/auth.json`; responses never echo the submitted auth JSON. Workspace vault recovery uses `GET /api/app/workspaces/:workspaceId/vault/references` for redacted reference discovery and `POST /api/app/workspaces/:workspaceId/vault/references/:referenceId/rebind` for imported unbound reference re-binding. Better Auth sessions require active membership; workspace and workspace-readonly tokens require active membership plus a binding to the addressed workspace; local and `server-admin` actors are not workspace-bound; readonly tokens cannot rebind. Server vault-use evidence can be read through `GET /api/app/vault/use-records`, and workspace vault-use evidence can be read through `GET /api/app/workspaces/:workspaceId/vault/use-records`; responses contain only non-secret use metadata and linked audit ids. The owning authorization matrix is in `docs/specs/20260704-vault_backend_implementation.md`.

For the encrypted-file backend, `config/server.jsonc` may set `vault.encryptedFile.keyFilePath` to an absolute external file containing exactly 32 raw bytes with exact `0600` permissions and process-user ownership. NanoCore verifies that key against the authenticated store header during the non-critical Vault boot phase, reuses the same unlock state for runtime requests, stays locked and degraded on any redacted key failure, and clears owned key material on lock and shutdown. The full operator contract is in [the DATA_ROOT config guide](../../docs/nanocore-data-root-config.en.md).

Source ownership and local verification for this subsystem are documented in [the Vault source guide](src/vault/README.md).

Real subscription inference smoke tests must be opt-in because they can consume user quota:

```bash
OPENKIT_E2E_REAL_CODEX_SUBSCRIPTION=1 pnpm --filter @openkit/nanocore run test:e2e
```

Set `OPENKIT_DATA_ROOT` to persist canonical workspace records under `temp/nanocore-data/users/user_local/workspaces/<workspaceId>/` from the repository root.

## Repository Resources And Goal Mode

Worker turns and Goal Mode tasks require a ready workspace repository resource when a task needs repository context or writes.

Link the default repository resource with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/repositories/default \
  -H 'content-type: application/json' \
  --data '{"displayName":"OpenKit","localPath":"/absolute/path/to/git/repository"}'
```

Read the redacted repository summary with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/repositories
```

Read repository diagnostics with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/repositories/diagnostics
```

Goal Mode starts from an existing thread:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal \
  -H 'content-type: application/json' \
  --data '{"objective":"Make the release ready for end users."}'
```

Draft a plan with:

```bash
curl -s -X POST http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/plan
```

Approve the returned `planItemId` and `plan` with `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/approve`, or request changes with `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/revise` to return the goal to planning before a revised draft is approved.

Read the active Goal Mode summary with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal
```

Pause and resume an active goal at a safe workflow boundary with:

```bash
curl -s -X POST http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/pause
curl -s -X POST http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/resume
```

Pause is accepted only for a running goal when the thread has no active running or human-gated worker turn. While the goal is paused, `/goal/step` returns `goal_paused`; resume returns the same durable goal to `running` so the next bounded step continues from stored goal and task state.

Goal steering currently fails closed with `goal_steering_delivery_unavailable` and creates no business records until the real worker path can persist an immutable Context Package delivery trace.

Run one real bounded worker step with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/step \
  -H 'content-type: application/json' \
  --data '{"requestId":"goal-step-1","followUpDrainMode":"one_at_a_time"}'
```

The real step route requires a ready workspace repository before worker checkpointing begins, asks Workflow Coordinator for the selected worker summary, records the worker context digest and product-safe context assembly summary in the checkpoint, normalizes terminal worker outcomes to stable stop reasons, and clears terminal checkpoints only after the goal and task read models are saved.

`reviewPolicyOverride` accepts `human` or `none` and defaults to `human`. `human` creates a durable actionable unresolved Goal Review after the completed step; accepting it atomically advances the task graph. `none` skips only that step's review and still advances dependencies and remaining tasks.

NanoCore stores and projects task-scoped verification evidence, but it does not yet run Task Evaluator loops or enforce an independent final-verifier completion gate.

`POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/test/supervise/step` is local-mode deterministic test support for local e2e and L6 story validation.

For user-facing deployment documentation, see [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md).

For user-facing `DATA_ROOT/config` documentation, see [NanoCore DATA_ROOT Config Guide](../../docs/nanocore-data-root-config.en.md) and [NanoCore DATA_ROOT 配置使用说明](../../docs/nanocore-data-root-config.zh.md).

Workspace config is loaded from `DATA_ROOT/users/<userId>/workspaces/<workspaceId>/config/workspace.jsonc`. V1 supports only workspace-relative `host-dir` roots under the workspace directory, and accepted turns pass materialized roots to governed workers through Agent Environment Package workspace inputs. The declared `access` field is recorded for adapters and must be enforced by the selected worker container backend. `workspace.assistant.repositoryInspection.enabled` can disable Chat Mode repository inspection for that workspace, and `excludedPaths` hides exact repository-relative path prefixes from Chat Mode reads.

NanoCore also creates and migrates `data/server/db/core.sqlite` on boot. The baseline SQLite schema is managed by Drizzle definitions under `src/storage/schema` and committed SQL migrations under `drizzle/`.

Use a fresh `OPENKIT_DATA_ROOT` for the disposable Cell lifecycle. NanoCore does not migrate an earlier worker-lifecycle data root.

In local mode, NanoCore upserts the implicit `user_local` row on boot and accepts requests without auth headers. Local mode binds to `127.0.0.1` by default; set `OPENKIT_BIND_HOST` to override the HTTP bind host.

## Release Verification

Run the app-level black-box e2e suite with:

```bash
pnpm --filter @openkit/nanocore run test:e2e
```

The e2e surface boots NanoCore as a process, uses fresh temporary data roots, covers empty boot, internal self-check turns, restart replay, configuration loading, migration idempotency, agent readiness diagnostics, secret redaction, and the skip-aware real Codex smoke spec.

The worker restart e2e kills and restarts the built NanoCore process after the sequence-zero process-key hash and first post-launch heartbeat are durable, then proves bounded reconnect adoption, final-status closeout, backend cleanup projection, and lease release over HTTP. It starts final closeout from an already durable `physical-cleaned` boundary; the thin A1 acceptance owns real stock OpenShell Cell recycle coverage.

Run the quick NanoCore e2e smoke subset with:

```bash
pnpm --filter @openkit/nanocore run test:e2e:smoke
```

That subset covers built-process local boot, server boot, unauthenticated rejection, and agent readiness diagnostics.

Run the repository tag release gate with:

```bash
pnpm -w verify:release
```

That command runs L0-L2 verification, nanocore e2e, and built-artifact smoke tests. Use `pnpm -w verify:full` only for explicit full local validation that also includes web Playwright e2e and deterministic story acceptance tests. The real Codex smoke spec is skipped unless explicitly enabled, so the normal gate succeeds without host credentials.

Run the real Codex Goal Mode L6 kernel story only when accepting real Codex and provider quota usage and after starting NanoCore on the same A1 host as the disposable OpenShell Cell:

```bash
OPENKIT_L6_REAL_CODEX=1 \
OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 \
OPENKIT_L6_NANOCORE_URL=http://127.0.0.1:54101 \
OPENKIT_L6_NANOCORE_DATA_ROOT=/absolute/path/to/nanocore-data \
OPENKIT_L6_GOAL_REPO_ROOT=/absolute/path/to/disposable/git/repository \
OPENKIT_L6_EVIDENCE_DIR=/absolute/path/to/evidence \
OPENKIT_NANOCORE_TOKEN='server-admin-token-when-required' \
pnpm -w test:stories:real-codex
```

Run the story command from the synchronized checkout on A1. The runner requires built `@openkit/core-client` and `@openkit/mcp` artifacts, `codex app-server` on A1 for the account-status probe, a clean disposable repository with one baseline commit, and local access to the fresh NanoCore data root. A1's Codex auth is imported into NanoCore's server-owned default OAuth account file with mode `0600`, then the runner configures the `openai_codex` provider and Codex agent and runs the public MCP Goal flow. The auth content is never placed in command arguments, environment variables, logs, evidence, a vault grant, an AEP credential declaration, or the worker sandbox.

## Server Mode Auth

Server mode uses Better Auth email/password routes under `/api/auth/*`, protects product APIs with HTTP-only session cookies, and accepts server-issued `okt_` bearer tokens for remote access. A valid session establishes the actor identity but does not grant deployment-admin authority or bypass active workspace membership checks.

Access-token administration is available to `server-admin` bearer tokens at `GET /api/app/auth/tokens`, `POST /api/app/auth/tokens`, `POST /api/app/auth/tokens/:tokenId/revoke`, and `POST /api/app/auth/tokens/:tokenId/rotate`. Better Auth sessions and workspace-scoped tokens are denied. Token list, revoke, and rotate responses expose only redacted token records; plaintext tokens are returned only once by create and rotate.

Start in server mode:

```bash
BETTER_AUTH_SECRET="replace-with-at-least-32-random-characters" OPENKIT_CORE_MODE=server OPENKIT_DATA_ROOT="$PWD/temp/nanocore-data" pnpm --filter @openkit/nanocore dev
```

Create a user:

```bash
curl -i http://127.0.0.1:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  --data '{"email":"user@example.com","password":"password123456","name":"User"}'
```

Sign in:

```bash
curl -i http://127.0.0.1:3000/api/auth/sign-in/email \
  -H 'content-type: application/json' \
  --data '{"email":"user@example.com","password":"password123456"}'
```

Use the returned session cookie for protected APIs such as `/api/workspaces`. Sign out with `POST /api/auth/sign-out`.

## OpenShell Worker Mode

NanoCore runs real Goal Mode worker turns through governed containers. The first backend is one single-slot disposable OpenShell Cell, either co-located with NanoCore or controlled on a remote Linux/systemd host.

The Cell contains the complete effect-capable runtime epoch: one stock OpenShell Gateway `0.0.80`, one dedicated containerd, one dedicated dockerd, fresh runtime roots and authentication material, and at most one active backend session. NanoCore prepares the Cell before materialization and returns scheduler capacity only after whole-Cell recycle creates a verified empty replacement. A sandbox or provider delete is not cleanup proof.

The canonical contract is [OpenShell Disposable Cell Lifecycle](../../docs/specs/20260715-openshell_disposable_cell_lifecycle.md).

For the trusted worker-inference path, NanoCore owns the Codex OAuth account and provider call. The worker receives one package-scoped placeholder route to NanoCore and must not receive host Codex auth, a provider attachment, vault material, or an external provider endpoint:

```bash
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=local \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=http://host.openshell.internal:3000/api/worker-control \
pnpm --filter @openkit/nanocore start
```

The Cell Gateway and health endpoints remain fixed at `http://127.0.0.1:17670` and `http://127.0.0.1:17671/readyz` on the Cell host. Local placement uses that Gateway directly. Remote placement requires `OPENKIT_OPENSHELL_CELL_SSH_TARGET`, a loopback HTTP `OPENKIT_OPENSHELL_GATEWAY_URL` backed by a separate operator-managed SSH local-forward, and an explicit credential-free HTTP(S) `OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL` ending at `/api/worker-control` and reachable from the remote sandbox; loopback and unspecified worker-control addresses are rejected. The optional `OPENKIT_OPENSHELL_GATEWAY` name must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. NanoCore's SSH lifecycle command disables forwarding and invokes only the fixed helper action, while every official OpenShell CLI subprocess removes inherited Gateway target overrides before using the validated argv target. The deployment guide records the proven A1 test tunnel that combines the Gateway local-forward with an exact Cell-bridge reverse worker-control listener without binding a wildcard address.

Do not start a naked shared Gateway or use a custom binary path, the OpenShell CLI TLS-verification bypass flag, a patched OpenShell artifact, or a forked OpenShell artifact. The Cell Gateway intentionally serves unauthenticated HTTP only on its host loopback address, and remote access preserves that boundary through an authenticated SSH local-forward. The exact local and remote configuration profiles are in [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md).

Do not set `OPENKIT_OPENSHELL_CODEX_CONFIG_TOML` or provider-specific extra network endpoints for the real Goal kernel story. NanoCore has no host-path Codex auth upload option: non-relay runtime auth may enter a sandbox only through the vault-backed runtime-file path, while a relay-required AEP receives no Codex auth file and instead receives one package-scoped transient OpenShell generic provider containing only the short-lived worker placeholder. Its policy permits only the two internal worker-inference POST paths for the two pinned Codex binaries, explicitly disables Codex provider-side web search, rejects backend-private direct credentials, and revokes process-local placeholder authority before whole-Cell recycle on failure or teardown. Token-only route authentication, restart hydration, AEP-owned request authority, durable per-call attribution, bounded identity and Zstd decoding, JSON and SSE dispatch, client cancellation, Codex turn-state continuity, provider-drift failure accounting, privileged provider-state denial, and cancellation-safe ledger termination are implemented. The worker boundary also validates Codex 0.144.1 canonical turn metadata, verifies its request kind plus session, thread, parent, sub-agent, and request-header projections, and removes raw runtime and cache hints before provider dispatch.

### A1 Cell Preparation And Verification

Synchronize the branch checkout to A1, then build and smoke the worker image on A1 and save it into `/var/lib/openkit/openshell-cell/image-cache`. A fresh Cell starts with an empty dockerd, so its cache must contain the arm64 worker archive and the exact supervisor tag baked into the official Gateway `0.0.80` binary: `ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898`.

Install `apps/nanocore/scripts/openshell-cell.sh` as root-owned mode `0700` at `/usr/local/libexec/openkit-openshell-cell`. The A1 `ubuntu` account that runs NanoCore receives passwordless sudo for only `/usr/local/libexec/openkit-openshell-cell prepare *` and `/usr/local/libexec/openkit-openshell-cell recycle *`; do not grant passwordless shell, Docker, containerd, or systemd commands. The full build, cache, install, sudoers, and startup commands are in [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md).

Use a new empty `OPENKIT_DATA_ROOT`; no previous worker-lifecycle data root is migrated. For local acceptance, start NanoCore and run the real Goal story from A1 so NanoCore, the Cell helper, the worker-control endpoint, Cell image cache, and disposable repository are co-located. For remote acceptance, keep NanoCore on its selected host, control A1 through the fixed SSH helper command, and provide separate Gateway and sandbox-reachable worker-control connectivity. Acceptance requires a completed worker turn followed by successful whole-Cell recycle, absence of the old epoch processes, network, and mutable roots, and two stable-empty checks against the replacement Gateway and dockerd. The remote backend materialization path is verified, and the separate real Codex `0.144.1` root-plus-two-child provenance story passed on A1 against stock OpenShell `0.0.80`.

The verified loop-0 deployment allowed `api.openai.com`, `chatgpt.com`, `chat.openai.com`, and `auth.openai.com` for `/usr/local/bin/codex` and `/usr/local/lib/codex/bin/codex`.

When the worker step also needs GitHub access, include `github.com` and `api.github.com` for Git and Codex-owned GitHub calls. The generated policy default includes `/usr/bin/git`, `/usr/lib/git-core/git-remote-http`, `/usr/lib/git-core/git-remote-https`, `/usr/local/bin/codex`, and `/usr/local/lib/codex/bin/codex` for extra endpoints unless an endpoint overrides `binaries`.

The intended pair is:

- `apps/web` for the SPA
- `apps/nanocore` for the real prototype HTTP + SSE backend
