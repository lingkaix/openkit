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
- Goal Mode planning, task supervision, review, verification, steering, and terminal closeout storage
- real HTTP + SSE protocol surface
- thread-bound agent reuse

## Runtime

- `nanocore` starts governed worker sessions through the configured container worker runtime.
- one nanocore thread binds to one Codex agent session
- follow-up turns on the same thread reuse the same agent session when it stays healthy
- current capabilities: turn execution, streaming assistant text, approval bridging, user-input questions, interruption, artifact inventory/content and review decisions, workspace configuration, workspace knowledge editing, repository linking, Goal Mode start and plan approval, Goal Mode steering and closeout read models, unified Human Attention Action Center projection, Codex/ChatGPT login coordination, and dual-entry LLM Gateway routing
- current non-goals: remote agents and full Sustained Mode automation

## Prerequisites

- a configured container worker backend must be available to run governed worker sessions
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

Redacted Agent Environment Package snapshot readback is available at `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots` and `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots/:snapshotId`. These routes return durable workspace-owned package snapshots for diagnostics and evidence without exposing backend-private fields, raw credentials, or host-local runtime references.

Knowledge Store observation ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/observations` and `GET /api/app/workspaces/:workspaceId/knowledge/observations`. Knowledge Store claim ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/claims` and `GET /api/app/workspaces/:workspaceId/knowledge/claims`. Knowledge Store conflict ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/conflicts`, `GET /api/app/workspaces/:workspaceId/knowledge/conflicts`, and `POST /api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution`. Knowledge Store derived indexes are available at `GET /api/app/workspaces/:workspaceId/knowledge/indexes`. The index route rebuilds disposable workspace knowledge indexes from file-backed records and returns the current Markdown concept-link graph, per-page validation report, source-reference index, and portable full-text index. Deterministic first-slice retrieval is available at `POST /api/app/workspaces/:workspaceId/knowledge/retrievals`; it ranks active valid pages from the full-text index and appends the selected/excluded decision trace to `knowledge/traces/<YYYYMM>.jsonl`. Knowledge Manager context preparation is available at `POST /api/app/workspaces/:workspaceId/knowledge/manager/context`; NanoCore persists the response snapshot under `knowledge/context-packages/<YYYYMM>.jsonl`, `GET /api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId` reads one persisted trace, and `POST /api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId/materialization` writes the first worker-visible `/openkit/context` package snapshot under workspace-owned storage.

The storage App API exposes `GET /api/app/storage/layout-report`, `POST /api/app/data-root/backups`, and `POST /api/app/data-root/backups/:backupId/verify` for layout diagnostics and server-managed hot backup verification. Backup responses return only a backup id, manifest, and checked inventory summary; they do not expose filesystem paths.

Restore is intentionally a stopped-server operator command, not a live App API:

```bash
pnpm --filter @openkit/nanocore run data-root:restore -- \
  --backup-root /absolute/path/to/openkit-backup \
  --data-root /absolute/path/to/openkit-data
```

The restore command refuses to run when `server/runtime/nanocore.lock` exists, verifies the backup manifest first, replaces the target data root through the storage restore helper, and prints a path-free JSON summary.

The Codex ChatGPT subscription login app API is available under `/api/app/oauth/openai-codex/accounts/*`. Every status, login, cancel, and logout action is scoped to an explicit account slot; each server-owned account slot uses its own `DATA_ROOT/server/files/oauth/openai-codex/accounts/<slot>/codex-home` as `CODEX_HOME`, and public payloads contain only sanitized login state, URLs, device codes, account label, plan type, and non-secret provider bindings.

The agent-facing LLM Gateway exposes `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, and `GET /health`. Provider diagnostics show whether each provider supports Chat Completions and Responses natively or through a bridge. The Gateway preserves OpenAI-compatible `prompt_cache_key` and `prompt_cache_retention` fields, ensures every upstream native Chat Completions or Responses request has a `prompt_cache_key`, and reports process-local cached input token summaries in Settings Diagnostics. Workspace-attributed capability calls and usage rows can be read through `GET /api/app/workspaces/:workspaceId/capability-usage`, workspace evidence bundles can be created and read through `POST /api/app/workspaces/:workspaceId/evidence-bundles` and `GET /api/app/workspaces/:workspaceId/evidence-bundles`, workspace audit events can be read through `GET /api/app/workspaces/:workspaceId/audit/events`, server audit events can be read through `GET /api/app/audit/events`, workspace permission decisions can be read through `GET /api/app/workspaces/:workspaceId/permission-decisions`, and server permission decisions can be read through `GET /api/app/permission-decisions`. It does not expose `POST /v1/completions`. The `openai_codex` provider uses Codex-managed ChatGPT subscription auth for native Responses calls and supports Chat Completions through the text-only bridge.

Vault admin routes expose redacted status and lock controls under `/api/app/vault/*`. `POST /api/app/vault/bootstrap/codex-auth-json` stores base64 request content as the server-owned `vault_codex_auth_json` reference and creates `grant_codex_auth_json` for OpenShell runtime-file injection to `/sandbox/.codex/auth.json`; responses never echo the submitted auth JSON. Workspace vault recovery uses `GET /api/app/workspaces/:workspaceId/vault/references` for redacted reference discovery and `POST /api/app/workspaces/:workspaceId/vault/references/:referenceId/rebind` for imported unbound reference re-binding. Server vault-use evidence can be read through `GET /api/app/vault/use-records`, and workspace vault-use evidence can be read through `GET /api/app/workspaces/:workspaceId/vault/use-records`; responses contain only non-secret use metadata and linked audit ids.

Real subscription inference smoke tests must be opt-in because they can consume user quota:

```bash
OPENKIT_E2E_REAL_CODEX_SUBSCRIPTION=1 pnpm --filter @openkit/nanocore run test:e2e
```

Set `OPENKIT_DATA_ROOT` to persist state under `temp/nanocore-data/users/user_local/workspaces/<workspaceId>/store.json` from the repository root.

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

Submit active steering with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/steering \
  -H 'content-type: application/json' \
  --data '{"requestId":"steer-1","message":"Keep the next task limited to docs and tests."}'
```

Run one real bounded worker step with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/step \
  -H 'content-type: application/json' \
  --data '{"requestId":"goal-step-1","followUpDrainMode":"one_at_a_time"}'
```

The real step route requires a ready workspace repository before worker checkpointing begins, asks Workflow Coordinator for the selected worker summary, drains safe-point steering before context preparation, records the worker context digest and product-safe context assembly summary in the checkpoint, normalizes terminal worker outcomes to stable stop reasons, and clears terminal checkpoints only after the goal and task read models are saved.

`POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/test/supervise/step` is local-mode deterministic test support for local e2e and L6 story validation.

For user-facing deployment documentation, see [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md).

For user-facing `DATA_ROOT/config` documentation, see [NanoCore DATA_ROOT Config Guide](../../docs/nanocore-data-root-config.en.md) and [NanoCore DATA_ROOT 配置使用说明](../../docs/nanocore-data-root-config.zh.md).

Workspace config is loaded from `DATA_ROOT/users/<userId>/workspaces/<workspaceId>/config/workspace.jsonc`. V1 supports only workspace-relative `host-dir` roots under the workspace directory, and accepted turns pass materialized roots to governed workers through Agent Environment Package workspace inputs. The declared `access` field is recorded for adapters and must be enforced by the selected worker container backend. `workspace.assistant.repositoryInspection.enabled` can disable Chat Mode repository inspection for that workspace, and `excludedPaths` hides exact repository-relative path prefixes from Chat Mode reads.

NanoCore also creates and migrates `data/server/db/core.sqlite` on boot. The baseline SQLite schema is managed by Drizzle definitions under `src/storage/schema` and committed SQL migrations under `drizzle/`.

Use a fresh `OPENKIT_DATA_ROOT` for v0.0.2. NanoCore does not automatically migrate v0.0.1 JSON snapshot data.

In local mode, NanoCore upserts the implicit `user_local` row on boot and accepts requests without auth headers. Local mode binds to `127.0.0.1` by default; set `OPENKIT_BIND_HOST` to override the HTTP bind host.

## Release Verification

Run the app-level black-box e2e suite with:

```bash
pnpm --filter @openkit/nanocore run test:e2e
```

The e2e surface boots NanoCore as a process, uses fresh temporary data roots, covers empty boot, internal self-check turns, restart replay, configuration loading, migration idempotency, agent readiness diagnostics, secret redaction, and the skip-aware real Codex smoke spec.

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

Run the real Codex Goal Mode L6 preflight only when accepting real Codex and provider quota usage:

```bash
OPENKIT_L6_REAL_CODEX=1 \
OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 \
OPENKIT_L6_GOAL_REPO_ROOT=/absolute/path/to/disposable/git/repository \
OPENKIT_L6_EVIDENCE_DIR=/absolute/path/to/evidence \
pnpm -w test:stories:real-codex
```

The preflight defaults `OPENKIT_L6_CODEX_OAUTH_ACCOUNT_DIR` to `/Users/m5pro/nano-data/server/files/oauth/openai-codex/accounts/default` on this developer machine.

## Server Mode Auth

Server mode uses Better Auth email/password routes under `/api/auth/*`, protects product APIs with HTTP-only session cookies, and accepts server-issued `okt_` bearer tokens for remote access.

Access-token administration is available at `GET /api/app/auth/tokens`, `POST /api/app/auth/tokens`, and `POST /api/app/auth/tokens/:tokenId/revoke`. Token list and revoke responses expose only redacted token records; the plaintext token is returned only once by the create route.

Start in server mode:

```bash
OPENKIT_CORE_MODE=server OPENKIT_DATA_ROOT="$PWD/temp/nanocore-data" pnpm --filter @openkit/nanocore dev
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

NanoCore runs real Goal Mode worker turns through governed containers. The first backend is OpenShell.

For ChatGPT-account based Codex workers, bootstrap `auth.json` into the NanoCore vault through `POST /api/app/vault/bootstrap/codex-auth-json`, then provide the non-secret Codex config from a host `CODEX_HOME` that already works with `codex exec`:

```bash
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=local \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_GATEWAY=openshell \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:3000/api/worker-control \
OPENKIT_OPENSHELL_CODEX_CONFIG_TOML=/home/ubuntu/.codex/config.toml \
pnpm --filter @openkit/nanocore start
```

Use `OPENKIT_OPENSHELL_CODEX_MODEL` only when a deployment intentionally overrides the model from `config.toml`.

If OpenShell network policy is enforced, also configure `OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS` with the HTTPS endpoints required by the selected Codex account and provider.

### Remote OpenShell Verification

Remote container placement keeps NanoCore as the source of truth while creating the worker sandbox through a remote OpenShell gateway.

Run NanoCore with a remote OpenShell gateway by setting:

```bash
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=remote \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_GATEWAY=a1-openkit \
OPENKIT_OPENSHELL_GATEWAY_URL=https://127.0.0.1:54003 \
OPENKIT_OPENSHELL_WORKER_IMAGE=openkit/worker-codex:dev \
OPENKIT_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:54002/api/worker-control \
pnpm --filter @openkit/nanocore start
```

For the current `a1` development topology, keep the OpenShell mTLS profile in the local OpenShell config as `a1-openkit`, expose the remote gateway with a local SSH tunnel, and expose the local worker-control server back to the remote sandbox with a reverse tunnel:

```bash
ssh -N -L 127.0.0.1:54003:127.0.0.1:17670 a1
ssh -N -R 127.0.0.1:54002:127.0.0.1:54101 a1
```

Do not set `OPENKIT_OPENSHELL_GATEWAY_INSECURE=1` for the `a1-openkit` mTLS profile. The profile authenticates with the gateway client certificate and the insecure direct-endpoint mode does not carry that profile authentication.

The real remote OpenShell backend e2e test is opt-in because it requires the remote gateway, SSH tunnels, and sandbox image to be ready. It does not consume provider quota by default; the worker command is a local `node -e` probe inside the remote sandbox:

```bash
OPENKIT_E2E_REMOTE_OPENSHELL=1 \
OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY=a1-openkit \
OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL=https://127.0.0.1:54003 \
OPENKIT_E2E_REMOTE_OPENSHELL_LOCAL_RELAY_PORT=54101 \
OPENKIT_E2E_REMOTE_OPENSHELL_CONTROL_RELAY_UPSTREAM=http://host.openshell.internal:54002/api/worker-control \
pnpm --filter @openkit/nanocore exec vitest run src/runtime/openshell-cli.e2e.test.ts
```

The remote test starts a local NanoCore worker-control server on `OPENKIT_E2E_REMOTE_OPENSHELL_LOCAL_RELAY_PORT`, creates a remote OpenShell sandbox through `OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY`, uploads a temporary Git workspace, runs a bounded worker command, downloads the transcript and patch evidence, asserts a pending staged review, and tears down the sandbox.

The verified loop-0 deployment allowed `api.openai.com`, `chatgpt.com`, `chat.openai.com`, and `auth.openai.com` for `/usr/local/bin/codex` and `/usr/local/lib/codex/codex/codex`.

When the worker step also needs GitHub access, include `github.com` and `api.github.com` for Git and Codex-owned GitHub calls. The generated policy default includes `/usr/bin/git`, `/usr/lib/git-core/git-remote-http`, `/usr/lib/git-core/git-remote-https`, `/usr/local/bin/codex`, and `/usr/local/lib/codex/codex/codex` for extra endpoints unless an endpoint overrides `binaries`.

The intended pair is:

- `apps/web` for the SPA
- `apps/nanocore` for the real prototype HTTP + SSE backend
