# nanocore

`nanocore` is the tiny real demo core server for the UI-first protocol slice.

NanoCore derives private AEP and Context input paths from the admitted AgentSession, opens or inspects that exact session before importing its complete Turn inputs, and starts the Worker only after all imports succeed. Turn-specific paths and payloads do not partition otherwise compatible shared Sandbox or Harness identities.

## Scope

- local-mode implicit single-user operation
- server-mode registered-user small-team operation with HTTP-only session auth and bounded Workspace sharing
- optional file-backed state through `OPENKIT_DATA_ROOT`
- implicit local actor `user_local`
- governed container Worker AgentSessions
- provider-neutral subscription account state for `openai-codex` and `xai`
- agent-facing LLM Gateway endpoints for Chat Completions and Responses
- workspace repository resources for governed worker materialization
- Goal Mode planning, task supervision, actionable human review, stored verification evidence, and terminal summaries
- real HTTP + SSE protocol surface

## Runtime

- `nanocore` admits governed worker sessions only through the configured NanoHost RuntimeTarget and its current native HTTP/2 connection generation.
- NanoCore persists separate Sandbox runtime, Harness instance, and AgentSession runtime-binding records, and stores only hashes of raw Turn route credentials
- the selectable NanoHost foundation supports one long-lived Harness, fixed private Harness operations, multiple AgentSessions for distinct Threads, restricted Codex handles, and shared-Sandbox retention
- product admission computes the exact static SessionCompatibilityKey before a scheduler lease, reuses the Thread's sole compatible idle AgentSession, and closes or fences an incompatible predecessor before selecting one internal successor; the Store and Harness projections reject duplicate current bindings, and ordinary App API read models expose no AgentSession identity or action
- the one-Sandbox scheduler loop keeps incompatible placement queued while its resident Sandbox is busy, Goal-pinned, or unproved; synchronous Task/Goal callers retain their existing deferred-admission cancellation. After scheduler admission, an idle unpinned resident is drained, its private sessions are proved closed, and its bridge and Sandbox are removed before replacement, while Core conversation history remains intact
- restart Phase 8 performs only durable classification, fencing, read-only restoration, and result-only expectation registration; after the ordinary listener is available, the existing single-flight lease-maintenance service drains effect-owning cleanup and fail-closed accepted-final-status recovery
- current capabilities: turn execution, streaming assistant text, approval bridging, user-input questions, interruption, registered-user Workspace invitation and membership lifecycle, owner transfer, explicit administrator access recovery, owner-authorized Workspace deletion and verified new-ID recovery, one-way user disable, Artifact inventory, content, direct import, idle-Thread introduction, version-owned Artifact Review decisions, Workspace Material revision, binding, proposal apply, and portable history, durable Workspace Sync Review decisions, workspace configuration, workspace knowledge editing, repository linking, Goal Mode start and plan approval, actionable Goal Review, stored verification evidence, terminal summaries, unified Human Attention Action Center projection, provider-subscription login coordination, and dual-entry LLM Gateway routing
- current non-goals: remote agents, full Sustained Mode automation, Task Evaluator loops, and an independent final-verifier completion gate

## Prerequisites

- real governed worker sessions require one configured Linux/systemd NanoHost running the stock OpenShell Gateway at exactly `0.0.99` with its private container backend and required deployment images
- an AgentManifest may select one preloaded deployment image by exact lowercase `sha256:` digest with pull policy `never`; NanoCore then proceeds directly to `sandbox.create`, while other reference forms use `image.acquire`
- NanoCore accepts NanoHost admission only on a native HTTP/2 physical connection with a valid dedicated `nanohost-transport` Token; it allocates generation one or durable high-water plus one and binds dispatch authority to that exact server-created connection context
- synthetic application requests and caller-provided NanoHost connection handles or generations are not selectable runtime paths
- subscription-backed inference requires a prepared provider-subscription account and bound provider profile; worker-runtime authentication remains a separate adapter concern

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
pnpm -w test:e2e:real-provider
pnpm -w test:e2e:real-subscription:preflight
pnpm -w test:e2e:real-subscription
pnpm -w test:e2e:real-task-mode
pnpm -w verify:release
pnpm -w verify:full
```

The real-provider, real-subscription, real-task-mode, and worker Responses relay L3 gates are explicit opt-ins and return a clean skip when their required environment is absent.

## Local Integration

Run this app first when you want to drive the product through the browser or the bundled OpenKit Skill CLI with the configured worker container runtime:

```bash
pnpm --filter @openkit/nanocore dev
```

The real Codex smoke e2e is a host gate. Run it only after `codex` is installed, `codex login` has completed, and a credential marker is present:

```bash
OPENKIT_E2E_REAL_CODEX=1 OPENKIT_E2E_REAL_CODEX_CREDENTIAL=1 pnpm -w test:e2e:real-codex
```

Without `OPENKIT_E2E_REAL_CODEX=1`, the gate skips cleanly. After explicit opt-in, if `codex` is absent from `PATH` or no credential marker is set, it fails with the missing prerequisite named. It is excluded from `test:e2e` and refuses to run inside the test execution image, which carries no worker runtime. See the Test Execution Environment decision in `docs/toolchain.md`.

The worker Responses relay runner is default-off and relay-only: it proves Codex and OpenCode Responses via Workspace `defaultAgentId` and excludes function-tool (`function_call` / `function_call_output`) proof. The deterministic harness is `node --test apps/nanocore/e2e/worker-responses-relay-real-provider-runner.test.mjs`. The real runner is `node apps/nanocore/e2e/worker-responses-relay-real-provider-runner.mjs`; it is fail-closed, skips when required environment is absent, and a skip or blocked environment is not a product PASS.

The App server listens with HTTP/1.1 for browser, CLI, and SSE traffic. When `nanohost` is configured, NanoCore starts a separate native HTTP/2 listener at `nanohost.bind` for `/api/nanohost/transport/*`; the two listeners use different local ports, and a reverse proxy must expose only the App listener.

The unified Human Attention Action Center is available at `GET /api/app/workspaces/:workspaceId/action-center`. It replaces the old split pending approvals and pending questions endpoints, and projects approval gates, user-input gates, Goal Mode attention, exact unresolved S16 Goal steering owners, checkpoint recovery, scheduler admissions, agent readiness failures, durable Workspace Sync Reviews, and explicit knowledge proposal records into one App API read model. A steering row preserves its original Goal lineage and exposes follow-up and cancellation only after that Goal is terminal; the projection is never command authority. Interrupted-worker rows require the exact interrupted Turn and recorded AgentSession plus a matching terminal restart-cleanup lease; a strict request-identified retry releases only the existing checkpoint and applicable Goal Task for a later fresh start, and never rewrites the old Turn, changes scheduler authority, or starts a worker. Scheduler admission readback is available at `GET /api/app/workspaces/:workspaceId/scheduler/admissions`; it returns workspace-filtered queued and denied admissions with queue position and denial reasons, but excludes raw Turn input, user ids, captured cwd, and Workspace root paths. Scheduler admission actions are available at `POST /api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/retry` for denied admissions and `POST /api/app/workspaces/:workspaceId/scheduler/admissions/:queueEntryId/cancel` for queued or denied admissions. Durable Workspace Sync Review decisions are available at `POST /api/app/workspaces/:workspaceId/workspace-sync/reviews/:reviewId/decision` for `accepted`, `needs_refinement`, `rejected`, and `blocked`; a backing Artifact may supply a read-only legacy review projection but cannot own, resolve, or apply a decision, and no generic Artifact mutation or review route exists.

Live Goal Review rows created by human-reviewed steps expose accept, refinement, retry, and abort actions without a preselected verdict; one decision atomically resolves the Review and advances or closes the Goal Task graph. Direct Task and Chat-to-Task deliver the complete Coordinator request as compact JSON through the existing Turn path. Goal launches read the complete immutable approved Goal Task, preserve its exact active Plan lineage, and deliver one schema-valid Coordinator request containing every accepted Task request fact plus the latest eligible Review context without changing previous Turns or evidence.

A non-secret worker user-input Gate closes its existing worker envelope through `turn.input.submit` without resuming the worker. A worker approval Gate likewise closes only its source envelope through `approval.respond`: Direct Task retains `task.start`, Goal Task retains `goal.step`, and a selected-Worker conversation retains its sole outer `conversation.submit` owner with the exact actor, Workspace, receiving Thread, input hash, result kind, and downstream Turn. Further worker execution requires a separately authorized command, new Turn, and successor AgentSession. The local simulator follows the same user-input Gate path without producing an Approval, records complete accepted final-status and backend cleanup evidence, and imports Material proposals through the existing transcript and Artifact Review owners.

Redacted Agent Environment Package snapshot readback is available at `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots` and `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots/:snapshotId`. These routes return durable workspace-owned package snapshots for diagnostics and evidence without exposing backend-private fields, raw credentials, or host-local runtime references.

Knowledge Store observation ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/observations` and `GET /api/app/workspaces/:workspaceId/knowledge/observations`. Knowledge Store claim ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/claims` and `GET /api/app/workspaces/:workspaceId/knowledge/claims`. Knowledge Store conflict ledgers are available at `POST /api/app/workspaces/:workspaceId/knowledge/conflicts`, `GET /api/app/workspaces/:workspaceId/knowledge/conflicts`, and `POST /api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution`. Knowledge Store derived indexes are available at `GET /api/app/workspaces/:workspaceId/knowledge/indexes`. The index route rebuilds disposable workspace knowledge indexes from file-backed records and returns the current Markdown concept-link graph, per-page validation report, source-reference index, and portable full-text index. Deterministic first-slice retrieval is available at `POST /api/app/workspaces/:workspaceId/knowledge/retrievals`; it ranks active valid pages from the full-text index and appends the selected/excluded decision trace to `knowledge/traces/<YYYYMM>.jsonl`. Knowledge Manager context preparation is available at `POST /api/app/workspaces/:workspaceId/knowledge/manager/context`; it reuses that governed retrieval owner and returns only a bounded selected/excluded projection plus the S61 trace reference. Task Mode alone hands an accepted selection to the existing S39 worker Context Package owner, so NanoCore exposes no second standalone Knowledge package trace or materialization surface.

The storage App API exposes `GET /api/app/storage/layout-report`, `POST /api/app/data-root/backups`, and `POST /api/app/data-root/backups/:backupId/verify` for layout diagnostics and server-managed hot backup verification. Deployment-wide routes accept the implicit local actor, a presented `server-admin` Token, or a Better Auth session whose active canonical User owns a currently usable `server-admin` Token; Workspace-scoped Tokens receive `403 Forbidden`. Backup responses return only a backup id, manifest, and checked inventory summary; they do not expose filesystem paths.

Restore is intentionally a stopped-server operator command, not a live App API:

```bash
pnpm --filter @openkit/nanocore run data-root:restore -- \
  --backup-root /absolute/path/to/openkit-backup \
  --data-root /absolute/path/to/openkit-data
```

The restore command refuses to run when `server/runtime/nanocore.lock` exists, verifies the backup manifest first, replaces the target data root through the storage restore helper, and prints a path-free JSON summary.

Locked-out server administrators use the separate stopped-server operator. Keep NanoCore stopped, list active canonical Users, then issue one recovery credential with an exact owner-and-expiry confirmation:

```bash
pnpm --filter @openkit/nanocore run operator -- admin recovery-users \
  --data-root /absolute/path/to/openkit-data
pnpm --filter @openkit/nanocore run operator -- admin recover-access \
  --data-root /absolute/path/to/openkit-data \
  --owner-user-id user_example \
  --expires-at 2026-09-02T12:00:00.000Z \
  --output /absolute/private/path/admin-recovery.json \
  --confirm issue-server-admin-token:user_example:2026-09-02T12:00:00.000Z
```

Both commands acquire the ordinary data-root lock and never stop a running process. Recovery creates the output once at mode `0600`, commits one matching `server-admin` Token and redacted AuditEvent, and resumes only an exact same-path attempt. Store the complete envelope directly through `credential.store`; that operation retains only its `token` field in the configured endpoint credential store.

The provider-subscription App API is available under `/api/app/provider-subscriptions/*` for `openai-codex` and `xai`. Every account, status, login, cancel, logout, and quota action is scoped to an explicit provider and account-slot pair; strict non-secret metadata lives under `DATA_ROOT/server/files/provider-subscriptions/<provider>/accounts/<slot>/account.json`, credential material remains behind encrypted-file Vault references, and public payloads are sanitized. This server-owned surface accepts the implicit local actor, a presented `server-admin` Token, or a Better Auth session with currently resolved Token-derived deployment-admin authority.

The agent-facing LLM Gateway exposes `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, and `GET /health`. The `/v1/*` surface uses the same actor authentication and workspace-scope checks as product APIs in server mode; local mode uses the implicit local actor. The separate internal `POST /api/worker-inference/v1/chat/completions` and `POST /api/worker-inference/v1/responses` routes accept only a live scheduler lease token bound to a hydrated trusted-relay AEP, derive provider/model/lineage from that package, reject caller authority and provider-side state, and require a fresh durable capability call before dispatch. Provenance-required packages must also supply the pinned canonical runtime hint; NanoCore derives product-safe origin and cache refs, strips every native value before dispatch, and reconciles provisional origin refs against the verified turn-end provenance index. Provider diagnostics show whether each provider supports Chat Completions and Responses natively or through a bridge. Native Codex Responses keeps message-anchored tools client-executed, rejects provider-executed declarations before provider access, and preserves function namespaces and custom inputs through stock pi-ai semantic events. The public Gateway preserves OpenAI-compatible `prompt_cache_key` and `prompt_cache_retention` fields, ensures every upstream native Chat Completions or Responses request has a `prompt_cache_key`, and reports process-local cached input token summaries in Settings Diagnostics. Workspace-attributed capability calls and usage rows can be read through `GET /api/app/workspaces/:workspaceId/capability-usage`; CapabilityCall owns the authorizing package snapshot plus optional product-safe runtime-origin and cache-lineage refs, while linked usage and audit rows remain unchanged. NanoCore-owned domain producers write workspace evidence bundles and consumers read them through `GET /api/app/workspaces/:workspaceId/evidence-bundles`; workspace audit events can be read through `GET /api/app/workspaces/:workspaceId/audit/events`; server audit events can be read through deployment-admin `GET /api/app/audit/events`; workspace permission decisions can be read through `GET /api/app/workspaces/:workspaceId/permission-decisions`; and server permission decisions can be read through deployment-admin `GET /api/app/permission-decisions`. It does not expose `POST /v1/completions` or the superseded `/internal/v1/chat/completions` facade. Every production provider dispatches through `PiAiGatewayClient`; subscription-backed profiles select the exact provider-and-slot pi-ai runtime before dispatch instead of selecting a dedicated backend.

CapabilityCall terminalization writes the call and linked AuditEvent atomically with one terminal timestamp. The closed terminal set is `succeeded`, `failed`, `denied`, `aborted`, `timed-out`, `interrupted`, and `unknown`; restart recovery maps leftover `running` calls only to `unknown`.

Pi-ai-routed requests observe one provider-native terminal usage payload before public OpenAI normalization. Workspace-attributed calls write positive input, output, cache-read, and cache-write token rows plus one `unit: "usd"` cost-estimate row when reported; that estimate is telemetry, not billing truth. Public responses, SSE, errors, and diagnostics keep the existing OpenAI-compatible vocabulary and never expose raw cost objects or prompt-cache keys.

Deployment-wide diagnostics at `GET /api/diagnostics`, `GET /api/app/diagnostics`, and `GET /api/setup/diagnostics` accept the implicit local actor, a presented `server-admin` Token, or a Better Auth session with currently resolved Token-derived deployment-admin authority. Workspace-scoped Tokens cannot read deployment provider-subscription, runtime-config, storage, or readiness projections.

Vault admin routes expose redacted status and lock controls under `/api/app/vault/*`. Global status, unlock, lock, Codex auth JSON bootstrap, authored provider API-key store or replacement, and server vault-use evidence accept the local actor, a presented `server-admin` Token, or a Better Auth session with currently resolved Token-derived deployment-admin authority; Workspace-scoped Tokens cannot use that deployment-admin surface. `POST /api/app/vault/bootstrap/codex-auth-json` stores base64 request content as the server-owned `vault_codex_auth_json` reference and creates `grant_codex_auth_json` for OpenShell runtime-file injection to `/sandbox/.codex/auth.json`; responses never echo the submitted auth JSON. `PUT /api/app/providers/:providerId/api-key` stores or rotates the unique authored provider profile's safe `vault://` reference and returns only redacted configured status. Workspace vault recovery uses `GET /api/app/workspaces/:workspaceId/vault/references` for redacted reference discovery and `POST /api/app/workspaces/:workspaceId/vault/references/:referenceId/rebind` for imported unbound reference re-binding. Better Auth sessions require active membership; workspace and workspace-readonly tokens require active membership plus a binding to the addressed workspace; local and `server-admin` actors are not workspace-bound; readonly tokens cannot rebind. Server vault-use evidence can be read through `GET /api/app/vault/use-records`, and workspace vault-use evidence can be read through `GET /api/app/workspaces/:workspaceId/vault/use-records`; responses contain only non-secret use metadata and linked audit ids. The owning authorization matrix is in `docs/specs/20260704-vault_backend_implementation.md`.

For the encrypted-file backend, `config/server.jsonc` may set `vault.encryptedFile.keyFilePath` to an absolute external file containing exactly 32 raw bytes with exact `0600` permissions and process-user ownership. NanoCore verifies that key against the authenticated store header during the non-critical Vault boot phase, reuses the same unlock state for runtime requests, stays locked and degraded on any redacted key failure, and clears owned key material on lock and shutdown. The full operator contract is in [the DATA_ROOT config manual](../../docs/manual/nanocore-data-root-config.en.md).

Source ownership and local verification for this subsystem are documented in [the Vault source guide](src/vault/README.md).

Set `OPENKIT_DATA_ROOT` to persist canonical Workspace records under `temp/nanocore-data/workspaces/<workspaceId>/` from the repository root.

## Repository Resources And Goal Mode

The retained NanoCore-hosted repository resource remains the current owner for bounded Chat repository inspection and the separate host-side apply/push surfaces. NanoHost Task and Goal worker Turns use the remote Git catalog flow documented below and do not consume this host path.

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

Pause is accepted only for a running Goal when the Thread has no pending, running, or human-gated worker Turn; resume applies the same safe-boundary check to a paused Goal. Each response separates the historical command result from current resource truth through `outcome: "paused" | "resumed"` and the current `goal` projection, so replay after a later opposite transition remains truthful. While the Goal is paused, `/goal/step` returns `goal_paused`; explicit resume changes only the same durable Goal to `running` and does not resume a Turn, AgentSession, Sandbox, lease, or worker.

Goal steering at `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/steering` accepts one exact message or current non-restricted Material revision only for a checkpoint-backed active Goal Turn and returns `202 queued` after its Item, Thread-unique pending owner, and body-free receipt are durable. The consuming Goal step may mark it applied only through the exact verified S39 Context Package trace; an unavailable delivery path or over-budget required Material returns `goal_steering_delivery_unavailable` before Turn reservation and leaves the pending input queued. Terminal follow-up and cancellation preserve the original Goal lineage and never mutate a live worker filesystem.

Run one real bounded worker step with:

```bash
curl -s http://127.0.0.1:3000/api/app/workspaces/ws_demo/threads/th_demo/goal/step \
  -H 'content-type: application/json' \
  --data '{"requestId":"goal-step-1"}'
```

The real step route loads the complete immutable Goal Task selected by stable Plan order, requires exact active Plan lineage, asks Workflow Coordinator to compose one lossless worker request, and derives the reserved Turn from `requestId`. One Workspace transaction reserves the runnable Goal and first ready Task, records the allowed worker-launch decision, and writes the request-bound `preparing` checkpoint; the selected Agent manifest and Workspace data-source catalog validate the remote worker source before scheduler admission. The response is exactly `{ goal }`; its metadata-only receipt stores the original Goal id, and duplicate requests project that Goal's current state while callers query the owning Thread, Turn, Action Center, and Review surfaces for execution details. NanoCore publishes the command receipt before terminal checkpoint cleanup. Any request-owned effect without the receipt, or any missing or contradictory Task fact or post-fence launch state, fails as `recovery_required` without result reconstruction, Coordinator rerun, context reselection, or replacement work.

The immutable Goal Task review policy is the sole post-step Review authority. `required=true` creates a durable actionable unresolved Goal Review whose canonical accept, refine, retry, or abort decision atomically updates the reviewed Task, Goal, and immutable resolution snapshot; `required=false` takes the same accepted closeout path without a Review. The step request rejects caller review-policy and input-drain overrides.

NanoCore stores and projects task-scoped verification evidence, but it does not yet run Task Evaluator loops or enforce an independent final-verifier completion gate.

`POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/test/supervise/step` is local-mode deterministic support for app-owned e2e validation.

For user-facing deployment documentation, see [NanoCore Deployment Modes](../../docs/manual/nanocore-deployment-modes.en.md).

For user-facing `DATA_ROOT/config` documentation, see [NanoCore DATA_ROOT Config](../../docs/manual/nanocore-data-root-config.en.md).

Workspace config is loaded from `DATA_ROOT/workspaces/<workspaceId>/config/workspace.jsonc`. V1 configured roots remain workspace-relative `host-dir` roots under the Workspace directory. A selected Agent may additionally bind one read-write input to a credential-free HTTPS Git source in the Workspace data-source catalog; Turn admission captures its exact commit without a NanoCore host path, and the Worker Shim materializes it at `/workspace/openkit/worktrees/main` before native start. The declared `access` field is enforced by the selected worker runtime. `workspace.assistant.repositoryInspection.enabled` can disable Chat Mode repository inspection for that workspace, and `excludedPaths` hides exact repository-relative path prefixes from Chat Mode reads.

NanoCore creates `data/server/db/core.sqlite` on boot. The current SQLite schemas are managed by Drizzle definitions under `src/storage/schema` and the single scope-sectioned SQL setup at `drizzle/0000_setup.sql`.

Migrate one stopped predecessor data root from owner-nested Workspace storage to the canonical top-level layout with:

```bash
pnpm --filter @openkit/nanocore run workspace-storage:migrate -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/openkit-predecessor-backup
```

The command refuses to run while `server/runtime/nanocore.lock` exists, requires a new external backup destination that is separate from the data root, verifies the complete predecessor cold backup, performs the one-way migration, and writes the evidence-only relative-path report to `server/migrations/workspace-storage-v1-to-v2.json`. Retain the external backup for operator recovery; the report is not retry or resume authority and no compatibility reader remains.

If an existing authoritative Core, User, or Workspace SQLite database fails its boot integrity check, NanoCore stops before product admission, bootstrap credential issuance, or listener binding and leaves the original file unchanged. Derived indexes remain disposable and rebuildable.

In local mode, NanoCore upserts the implicit `user_local` row on boot and accepts requests without auth headers. Local mode binds to `127.0.0.1` by default; set `OPENKIT_BIND_HOST` to override the HTTP bind host.

## Release Verification

Run the app-level black-box e2e suite with:

```bash
pnpm --filter @openkit/nanocore run test:e2e
```

The e2e surface boots NanoCore as a process, uses fresh temporary data roots, covers empty boot, Goal planning, bounded restart read-model replay, configuration loading, migration idempotency, agent readiness diagnostics, secret redaction, and the skip-aware real Codex smoke spec.

The fixed CI portability proof runs the bundled local-mode CLI in separate source and target jobs, transfers the original `.openkit-workspace.tar.zst` plus its SHA-256 and semantic oracle through one workflow artifact, verifies the archive SHA-256 across runners, compares remint-neutral Workspace semantics and complete seeded Turn history, explicitly rebinds repository and Vault references, exercises target behavior, and verifies a target re-export without treating the re-export digest as an equality oracle.

Run the quick NanoCore e2e smoke subset with:

```bash
pnpm --filter @openkit/nanocore run test:e2e:smoke
```

That subset covers built-process local boot, server boot, unauthenticated rejection, and agent readiness diagnostics.

Run the repository tag release gate with:

```bash
pnpm -w verify:release
```

That command runs L0-L2 verification, NanoCore e2e, and built-artifact smoke tests. Use `pnpm -w verify:full` only for explicit full local validation that also includes Web Playwright e2e. The real Codex smoke spec is skipped unless explicitly enabled, so the normal gate succeeds without host credentials.

The end-user interface L6 is the agentic [OpenKit Agent Skill Progressive Discovery story](../../tests/stories/openkit-agent-skill-progressive-discovery.story.md). It has no committed runner; execute it with a real Skill-capable agent only when accepting provider quota use, and reduce deterministic defects to the lowest sufficient L1-L5 regression.

## Server Mode Auth

Server mode uses Better Auth email/password routes under `/api/auth/*`, protects product APIs with HTTP-only session cookies, and accepts server-issued `okt_` bearer Tokens for remote access. A valid session establishes the actor identity and may receive deployment-admin authority only while its active canonical User owns a currently usable `server-admin` Token; it never bypasses active Workspace membership checks.

Workspace Material routes authorize the path Workspace before resolving opaque target identifiers. For an authorized caller, an absent Material, revision, or Thread target, including an identifier that exists only in another Workspace, returns scoped `409 stale`; `403 workspace_access_denied` is reserved for pre-target Workspace authorization failure, and NanoCore does not scan another Workspace to classify the target.

The Workspace sharing App API exposes the fifteen exact operations owned by [Single-Deployment Multi-User Workspace System](../../docs/specs/20260715-multi_user_workspace_system.md): authorized Workspace discovery, owner-visible membership and invitation management, session-bound invitee decisions, non-owner leave, ordinary owner transfer, content-free administrator recovery, and one-way user disable. All lifecycle mutations reuse the Core command receipt and Core audit transaction; `server-admin` never implies ordinary Workspace content access, and Quick Chat remains owner-only and non-shareable.

Access-token administration is available in server mode to presented `server-admin` Tokens and Better Auth sessions with currently resolved Token-derived deployment-admin authority at `GET /api/app/auth/tokens`, `POST /api/app/auth/tokens`, `POST /api/app/auth/tokens/:tokenId/revoke`, and `POST /api/app/auth/tokens/:tokenId/rotate`. Issue may name another exact active canonical `ownerUserId`, with target-owner membership validation for Workspace scopes. Session-only `GET /api/app/auth/my-admin-tokens` and `PUT /api/app/auth/my-admin-tokens/default` expose the signed-in User's redacted `server-admin` Token metadata and effective default selection. Workspace-scoped Tokens are denied; plaintext Tokens are returned only once by create and rotate.

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

## NanoHost Worker Mode

NanoCore runs real Worker Agent Turns only through one configured NanoHost RuntimeTarget. NanoHost owns the stock OpenShell Gateway `0.0.99`, its private container backend, the shared Harness and Sandbox, and the private Harness operations; NanoCore owns product admission, Turn leases, AgentSession continuity, and durable runtime projections.

For the trusted worker-inference path, NanoCore owns the selected provider-subscription account and provider call. The worker receives one package-scoped placeholder route to NanoCore and must not receive host Codex auth, a provider attachment, vault material, or an external provider endpoint. The selected Agent manifest owns the exact worker image, runtime binaries, sandbox policy, backend requirements, provider supply, and the single LLM route resolved into the immutable AEP; NanoCore adds no endpoint, binary rule, global worker-image selector, host-path runtime upload, or environment-configured network expansion.

The real Task Mode gate accepts an existing HTTPS endpoint or NanoCore's native plaintext HTTP/2 endpoint. It creates a Workspace data-source catalog entry from one credential-free HTTPS Git URL and exact lowercase commit, reloads that session-scoped configuration, and requires the selected acceptance Agent to reference `task-mode-repository`; it does not configure a NanoCore host repository. Each run also binds its redacted evidence to one exact lowercase product commit and host-manifest digest:

```bash
OPENKIT_L6_TASK_REAL_WORKER=1 \
OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 \
OPENKIT_L6_TASK_NANOCORE_URL=http://127.0.0.1:3000 \
OPENKIT_L6_TASK_GIT_URL=https://github.com/octocat/Hello-World.git \
OPENKIT_L6_TASK_GIT_COMMIT=7fd1a60b01f91b314f59955a4e4d4e80d8edf11d \
OPENKIT_L6_TASK_WORKER_IMAGE_REF=sha256:<exact-worker-image-digest> \
OPENKIT_L6_TASK_PRODUCT_COMMIT=<40-lowercase-hex-commit> \
OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST=<64-lowercase-hex-digest> \
OPENKIT_L6_EVIDENCE_DIR=/owner-only/evidence-directory \
pnpm -w test:e2e:real-task-mode
```

The worker Responses relay L3 run uses the same fail-closed evidence posture: it skips rather than PASS when opt-in, quota acknowledgement, host-manifest digest, Codex or OpenCode image refs, NanoCore URL, or evidence directory is absent, or when exactly one of `OPENKIT_NANOCORE_TOKEN` and `OPENKIT_NANOCORE_SESSION_COOKIE` is set; set both or omit both for local mode. The runner excludes function-tool proof.

```bash
OPENKIT_L6_WORKER_RESPONSES_RELAY=1 \
OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 \
OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST=<64-lowercase-hex-digest> \
OPENKIT_L6_WORKER_RESPONSES_CODEX_IMAGE_REF=<exact-codex-image-ref> \
OPENKIT_L6_WORKER_RESPONSES_OPENCODE_IMAGE_REF=<exact-opencode-image-ref> \
OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL=http://127.0.0.1:3000 \
OPENKIT_L6_EVIDENCE_DIR=/owner-only/evidence-directory \
node apps/nanocore/e2e/worker-responses-relay-real-provider-runner.mjs
```

The authoritative runtime contract is [NanoHost Runtime And Transport](../../docs/specs/20260802-nanohost_runtime_and_transport.md), and the host workflow is [NanoHost real-use host](../../docs/cookbooks/nanohost-real-use-host.md).

The intended pair is:

- `apps/web` for the SPA
- `apps/nanocore` for the real prototype HTTP + SSE backend
