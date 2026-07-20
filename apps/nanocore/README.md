# nanocore

`nanocore` is the tiny real demo core server for the UI-first protocol slice.

## Scope

- local-mode implicit single-user operation
- server-mode registered-user small-team operation with HTTP-only session auth and bounded Workspace sharing
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
- current capabilities: turn execution, streaming assistant text, approval bridging, user-input questions, interruption, registered-user Workspace invitation and membership lifecycle, owner transfer, explicit administrator access recovery, one-way user disable, Artifact inventory, content, direct import, idle-Thread introduction, version-owned Artifact Review decisions, Workspace Material revision, binding, proposal apply, and portable history, durable Workspace Sync Review decisions, workspace configuration, workspace knowledge editing, repository linking, Goal Mode start and plan approval, actionable Goal Review, stored verification evidence, terminal summaries, unified Human Attention Action Center projection, Codex/ChatGPT login coordination, and dual-entry LLM Gateway routing
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

Run this app first when you want to drive the product through the browser or the bundled OpenKit Skill CLI with the configured worker container runtime:

```bash
mise exec -- pnpm --filter @openkit/nanocore dev
```

Run the skip-aware real Codex smoke e2e locally only after `codex` is installed, `codex login` has completed, and a credential marker is present:

```bash
OPENKIT_E2E_REAL_CODEX=1 OPENKIT_E2E_REAL_CODEX_CREDENTIAL=1 pnpm --filter @openkit/nanocore run test:e2e
```

The smoke spec stays skipped unless `OPENKIT_E2E_REAL_CODEX=1` is set, `codex` resolves in the selected worker environment, and either `OPENAI_API_KEY` or `OPENKIT_E2E_REAL_CODEX_CREDENTIAL=1` is present.

The server listens on `http://localhost:3000` and exposes the demo protocol surface under `/api`.

The unified Human Attention Action Center is available at `GET /api/app/workspaces/:workspaceId/action-center`. It replaces the old split pending approvals and pending questions endpoints, and projects approval gates, user-input gates, Goal Mode attention, exact unresolved S16 Goal steering owners, checkpoint recovery, scheduler admissions, agent readiness failures, durable Workspace Sync Reviews, and explicit knowledge proposal records into one App API read model. A steering row preserves its original Goal lineage and exposes follow-up and cancellation only after that Goal is terminal; the projection is never command authority. Interrupted-worker rows require the exact interrupted Turn and recorded Session plus a matching terminal restart-cleanup lease; a strict request-identified retry releases only the existing checkpoint and applicable Goal Task for a later fresh start, and never rewrites the old Turn, changes scheduler authority, or starts a worker. Scheduler admission readback is available at `GET /api/app/workspaces/:workspaceId/scheduler/admissions`; it returns workspace-filtered queued and denied admissions with queue position and denial reasons, but excludes raw turn input, user ids, captured cwd, and workspace root paths. Scheduler admission actions are available at `POST /api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/retry` for denied admissions and `POST /api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/cancel` for queued or denied admissions. Durable Workspace Sync Review decisions are available at `POST /api/app/workspaces/:workspaceId/workspace-sync/reviews/:reviewId/decision` for `accepted`, `needs_refinement`, `rejected`, and `blocked`; a backing Artifact may supply a read-only legacy review projection but cannot own, resolve, or apply a decision, and no generic Artifact mutation or review route exists.

Live Goal Review rows created by human-reviewed steps expose accept, refinement, retry, and abort actions without a preselected verdict; one decision atomically resolves the Review and advances or closes the Goal Task graph. Direct Task and Chat-to-Task deliver the complete Coordinator request as compact JSON through the existing Turn path. Goal launches read the complete immutable approved Goal Task, preserve its exact active Plan lineage, and deliver one schema-valid Coordinator request containing every accepted Task request fact plus the latest eligible Review context without changing previous Turns or evidence.

Redacted Agent Environment Package snapshot readback is available at `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots` and `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots/:snapshotId`. These routes return durable workspace-owned package snapshots for diagnostics and evidence without exposing backend-private fields, raw credentials, or host-local runtime references.

Knowledge Store observation ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/observations` and `GET /api/app/workspaces/:workspaceId/knowledge/observations`. Knowledge Store claim ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/claims` and `GET /api/app/workspaces/:workspaceId/knowledge/claims`. Knowledge Store conflict ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/conflicts`, `GET /api/app/workspaces/:workspaceId/knowledge/conflicts`, and `POST /api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution`. Knowledge Store derived indexes are available at `GET /api/app/workspaces/:workspaceId/knowledge/indexes`. The index route rebuilds disposable workspace knowledge indexes from file-backed records and returns the current Markdown concept-link graph, per-page validation report, source-reference index, and portable full-text index. Deterministic first-slice retrieval is available at `POST /api/app/workspaces/:workspaceId/knowledge/retrievals`; it ranks active valid pages from the full-text index and appends the selected/excluded decision trace to `knowledge/traces/<YYYYMM>.jsonl`. Knowledge Manager context preparation is available at `POST /api/app/workspaces/:workspaceId/knowledge/manager/context`; it reuses that governed retrieval owner and returns only a bounded selected/excluded projection plus the S61 trace reference. Task Mode alone hands an accepted selection to the existing S39 worker Context Package owner, so NanoCore exposes no second standalone Knowledge package trace or materialization surface.

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

Set `OPENKIT_DATA_ROOT` to persist canonical Workspace records under `temp/nanocore-data/workspaces/<workspaceId>/` from the repository root.

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
curl -s -X POST http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/plan \
  -H 'content-type: application/json' \
  --data '{"requestId":"goal-plan-1"}'
```

Plan creation treats `requestId` as command identity and replays the original immutable Plan without another planning Turn or Item. A complete Plan record can repair a missing creation receipt because `createdByRequestId` proves the winning Workspace transaction; question, error, or partial owner tuples instead return `409 recovery_required`. Approve only the returned `planItemId` with `{ "requestId": "goal-plan-approve-1", "planItemId": "..." }` at `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/approve`; NanoCore loads the immutable Plan and never accepts caller Plan content. Request changes with `{ "requestId": "goal-plan-revise-1", "revision": "..." }` at `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/revise` before drafting a new immutable Plan. An identical revision request replays its original Goal and Item without another Turn; changed input conflicts, while a revision Turn or Item found without its matching command receipt returns `409 recovery_required` rather than inferring a winner.

Read the active Goal Mode summary with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal
```

Pause and resume an active goal at a safe workflow boundary with:

```bash
curl -s -X POST http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/pause \
  -H 'content-type: application/json' \
  -d '{"requestId":"goal-pause-1"}'
curl -s -X POST http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/resume \
  -H 'content-type: application/json' \
  -d '{"requestId":"goal-resume-1"}'
```

Pause is accepted only for a running goal when the thread has no pending, running, or human-gated worker turn; resume applies the same safe-boundary check to a paused goal. Each response separates the historical command result from current resource truth through `outcome: "paused" | "resumed"` and the current `goal` projection, so replay after a later opposite transition remains truthful. While the goal is paused, `/goal/step` returns `goal_paused`; explicit resume changes only the same durable Goal to `running` and does not resume a Turn, Session, sandbox, lease, or worker.

Goal steering at `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/steering` accepts one exact message or current non-restricted Material revision only for a checkpoint-backed active Goal Turn and returns `202 queued` after its Item, Thread-unique pending owner, and body-free receipt are durable. The consuming Goal step may mark it applied only through the exact verified S39 Context Package trace; an unavailable delivery path or over-budget required Material returns `goal_steering_delivery_unavailable` before Turn reservation and leaves the pending input queued. Terminal follow-up and cancellation preserve the original Goal lineage and never mutate a live worker filesystem.

Run one real bounded worker step with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/step \
  -H 'content-type: application/json' \
  --data '{"requestId":"goal-step-1"}'
```

The real step route requires a ready workspace repository before worker checkpointing begins, loads the complete immutable Goal Task selected by stable Plan order, requires exact active Plan lineage, asks Workflow Coordinator to compose one lossless worker request, and derives the reserved Turn from `requestId`. One Workspace transaction reserves the runnable Goal and first ready Task, records the allowed worker-launch decision, and writes the request-bound `preparing` checkpoint. The response is exactly `{ goal }`; its metadata-only receipt stores the original Goal id, and duplicate requests project that Goal's current state while callers query the owning Thread, Turn, Action Center, and Review surfaces for execution details. NanoCore publishes the command receipt before terminal checkpoint cleanup. Any request-owned effect without the receipt, or any missing or contradictory Task fact or post-fence launch state, fails as `recovery_required` without result reconstruction, Coordinator rerun, context reselection, or replacement work.

The immutable Goal Task review policy is the sole post-step Review authority. `required=true` creates a durable actionable unresolved Goal Review whose canonical accept, refine, retry, or abort decision atomically updates the reviewed Task, Goal, and immutable resolution snapshot; `required=false` takes the same accepted closeout path without a Review. The step request rejects caller review-policy and input-drain overrides.

NanoCore stores and projects task-scoped verification evidence, but it does not yet run Task Evaluator loops or enforce an independent final-verifier completion gate.

`POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/test/supervise/step` is local-mode deterministic test support for local e2e and L6 story validation.

For user-facing deployment documentation, see [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md).

For user-facing `DATA_ROOT/config` documentation, see [NanoCore DATA_ROOT Config Guide](../../docs/nanocore-data-root-config.en.md) and [NanoCore DATA_ROOT 配置使用说明](../../docs/nanocore-data-root-config.zh.md).

Workspace config is loaded from `DATA_ROOT/workspaces/<workspaceId>/config/workspace.jsonc`. V1 supports only workspace-relative `host-dir` roots under the workspace directory, and accepted turns pass materialized roots to governed workers through Agent Environment Package workspace inputs. The declared `access` field is recorded for adapters and must be enforced by the selected worker container backend. `workspace.assistant.repositoryInspection.enabled` can disable Chat Mode repository inspection for that workspace, and `excludedPaths` hides exact repository-relative path prefixes from Chat Mode reads.

NanoCore also creates and migrates `data/server/db/core.sqlite` on boot. The baseline SQLite schema is managed by Drizzle definitions under `src/storage/schema` and committed SQL migrations under `drizzle/`.

Migrate one stopped predecessor data root from owner-nested Workspace storage to the canonical top-level layout with:

```bash
pnpm --filter @openkit/nanocore run workspace-storage:migrate -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/openkit-predecessor-backup
```

The command refuses to run while `server/runtime/nanocore.lock` exists, requires a new external backup destination that is separate from the data root, verifies the complete predecessor cold backup, performs the one-way migration, and writes the evidence-only relative-path report to `server/migrations/workspace-storage-v1-to-v2.json`. Retain the external backup for operator recovery; the report is not retry or resume authority and no compatibility reader remains.

If an existing authoritative Core, User, or Workspace SQLite database fails its boot integrity check, NanoCore stops before product admission, bootstrap credential issuance, or listener binding and leaves the original file unchanged. Derived indexes remain disposable and rebuildable.

Use a fresh `OPENKIT_DATA_ROOT` for the disposable Cell lifecycle. NanoCore does not migrate an earlier worker-lifecycle data root.

In local mode, NanoCore upserts the implicit `user_local` row on boot and accepts requests without auth headers. Local mode binds to `127.0.0.1` by default; set `OPENKIT_BIND_HOST` to override the HTTP bind host.

## Release Verification

Run the app-level black-box e2e suite with:

```bash
pnpm --filter @openkit/nanocore run test:e2e
```

The e2e surface boots NanoCore as a process, uses fresh temporary data roots, covers empty boot, Goal planning, bounded restart read-model replay, configuration loading, migration idempotency, agent readiness diagnostics, secret redaction, and the skip-aware real Codex smoke spec.

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

The end-user interface L6 is the agentic [OpenKit Agent Skill Progressive Discovery story](../../tests/stories/openkit-agent-skill-progressive-discovery.story.md). It has no committed runner; execute it with a real Skill-capable agent only when accepting provider quota use, and reduce deterministic defects to the lowest sufficient L1-L5 regression.

## Server Mode Auth

Server mode uses Better Auth email/password routes under `/api/auth/*`, protects product APIs with HTTP-only session cookies, and accepts server-issued `okt_` bearer tokens for remote access. A valid session establishes the actor identity but does not grant deployment-admin authority or bypass active workspace membership checks.

The Workspace sharing App API exposes the fifteen exact operations owned by [Single-Deployment Multi-User Workspace System](../../docs/specs/20260715-multi_user_workspace_system.md): authorized Workspace discovery, owner-visible membership and invitation management, session-bound invitee decisions, non-owner leave, ordinary owner transfer, content-free administrator recovery, and one-way user disable. All lifecycle mutations reuse the Core command receipt and Core audit transaction; `server-admin` never implies ordinary Workspace content access, and Quick Chat remains owner-only and non-shareable.

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

NanoCore runs real Worker Agent turns through governed containers. The first backend is one single-slot disposable OpenShell Cell, either co-located with NanoCore or controlled on a remote Linux/systemd host.

The Cell contains the complete effect-capable runtime epoch: one stock OpenShell Gateway `0.0.80`, one dedicated containerd, one dedicated dockerd, fresh runtime roots and authentication material, and at most one active backend session. NanoCore prepares the Cell before materialization and returns scheduler capacity only after whole-Cell recycle creates a verified empty replacement. A sandbox or provider delete is not cleanup proof.

The canonical contract is [OpenShell Disposable Cell Lifecycle](../../docs/specs/20260715-openshell_disposable_cell_lifecycle.md).

For the trusted worker-inference path, NanoCore owns the Codex OAuth account and provider call. The worker receives one package-scoped placeholder route to NanoCore and must not receive host Codex auth, a provider attachment, vault material, or an external provider endpoint:

```bash
OPENKIT_WORKER_RUNTIME=container \
OPENKIT_CONTAINER_PLACEMENT=local \
OPENKIT_CONTAINER_BACKEND=openshell \
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=http://host.openshell.internal:3000/api/worker-control \
pnpm --filter @openkit/nanocore start
```

The Cell Gateway and health endpoints remain fixed at `http://127.0.0.1:17670` and `http://127.0.0.1:17671/readyz` on the Cell host. Local placement uses that Gateway directly. Remote placement requires `OPENKIT_OPENSHELL_CELL_SSH_TARGET`, a loopback HTTP `OPENKIT_OPENSHELL_GATEWAY_URL` backed by a separate operator-managed SSH local-forward, and an explicit credential-free HTTP(S) `OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL` ending at `/api/worker-control` and reachable from the remote sandbox; loopback and unspecified worker-control addresses are rejected. The optional `OPENKIT_OPENSHELL_GATEWAY` name must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. NanoCore's SSH lifecycle command disables forwarding and invokes only the fixed helper action, while every official OpenShell CLI subprocess removes inherited Gateway target overrides before using the validated argv target. The deployment guide records the proven A1 test tunnel that combines the Gateway local-forward with an exact Cell-bridge reverse worker-control listener without binding a wildcard address.

Do not start a naked shared Gateway or use a custom binary path, the OpenShell CLI TLS-verification bypass flag, a patched OpenShell artifact, or a forked OpenShell artifact. The Cell Gateway intentionally serves unauthenticated HTTP only on its host loopback address, and remote access preserves that boundary through an authenticated SSH local-forward. The exact local and remote configuration profiles are in [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md).

The selected Agent manifest owns the exact worker image, runtime binaries, sandbox policy, backend requirements, provider supply, and the single LLM route that NanoCore resolves into the immutable AEP. NanoCore has no global worker-image selector, host-path native-runtime configuration upload, or environment-configured network expansion. A relay route receives one package-scoped transient OpenShell provider containing only the short-lived worker placeholder, while an accepted direct-provider route receives only its manifest-declared backend credential binding. OpenShell policy is compiled from the AEP's exact endpoints and runtime binaries, and process-local authority is revoked before whole-Cell recycle on failure or teardown.

### A1 Cell Preparation And Verification

Synchronize the branch checkout to A1, then build and smoke the worker image on A1 and save it into `/var/lib/openkit/openshell-cell/image-cache`. A fresh Cell starts with an empty dockerd, so its cache must contain the arm64 worker archive and the exact supervisor tag baked into the official Gateway `0.0.80` binary: `ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898`.

Install `apps/nanocore/scripts/openshell-cell.sh` as root-owned mode `0700` at `/usr/local/libexec/openkit-openshell-cell`. The A1 `ubuntu` account that runs NanoCore receives passwordless sudo for only `/usr/local/libexec/openkit-openshell-cell prepare *` and `/usr/local/libexec/openkit-openshell-cell recycle *`; do not grant passwordless shell, Docker, containerd, or systemd commands. The full build, cache, install, sudoers, and startup commands are in [NanoCore Deployment Modes](../../docs/nanocore-deployment-modes.en.md).

Use a new empty `OPENKIT_DATA_ROOT`; no previous worker-lifecycle data root is migrated. For local acceptance, start NanoCore and run the real Task Mode worker acceptance from A1 so NanoCore, the Cell helper, the worker-control endpoint, Cell image cache, and disposable repository are co-located. For remote acceptance, keep NanoCore on its selected host, control A1 through the fixed SSH helper command, and provide separate Gateway and sandbox-reachable worker-control connectivity. Acceptance requires a completed worker turn followed by successful whole-Cell recycle, absence of the old epoch processes, network, and mutable roots, and two stable-empty checks against the replacement Gateway and dockerd. The remote backend materialization path is verified, and the separate real Codex `0.144.1` root-plus-two-child provenance story passed on A1 against stock OpenShell `0.0.80`.

The verified loop-0 deployment's authored network policy allowed `api.openai.com`, `chatgpt.com`, `chat.openai.com`, and `auth.openai.com` for `/usr/local/bin/codex` and `/usr/local/lib/codex/bin/codex`. GitHub access likewise requires exact `github.com` and `api.github.com` rules in the authored manifest and resolved AEP; NanoCore adds no endpoint or binary rule during materialization.

The intended pair is:

- `apps/web` for the SPA
- `apps/nanocore` for the real prototype HTTP + SSE backend
