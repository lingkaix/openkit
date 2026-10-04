# nanocore

Workspace database opens prepare only their safe local directories; ownership and canonical-envelope tree verification stays at boot and stopped-process migration. Outcome delivery contains submission, initial lookup, and recovery failures and logs the Turn identity. A refusal whose bookkeeping fails is retried as a release and recorded with its refusal code; an unknown submission records `delivery_unknown` when writable without being retried, while a failure before submission leaves the frozen outcome and pending Turn for boot resume.

Harness result acknowledgement retries retain the exact prior receipt while a successor operation is queued. An identical replay only returns the acknowledgement; it neither mutates the successor nor notifies its producer. Dispatching the successor clears the prior receipt, after which stale or changed results remain conflicts.

The authorized Thread dashboard derives taskInputs objective summaries through the existing full Context Package verifier and exact request Item. Invalid or missing provenance omits only that summary; stored messages and runtime identity remain unchanged.

The authorized Thread dashboard projects the authenticated viewer and only recorded Item actors and assigned Turn Agents with current User or Agent display names. It exposes no email or unrelated user directory; absent names retain stable actor ids.

Dashboard newest-Artifact selection stays in `src/app-dashboard.ts`, preserving inventory order and the first equal-timestamp candidate. Completion summaries select the newest exact-Turn Artifact before the Thread fallback, then use its summary or the Thread preview; empty summaries remain empty.

`nanocore` is the tiny real demo core server for the UI-first protocol slice.

NanoCore derives private AEP and Context input paths from the admitted AgentSession, opens or inspects that exact session before importing its complete Turn inputs, and starts the Worker only after all imports succeed. Turn-specific paths and payloads do not partition otherwise compatible shared Sandbox or Harness identities.

Harness result timeouts identify the fixed operation and whether it was never dispatched or dispatched while awaiting a result. These diagnostics use the existing Turn failure projection without runtime identities or command content; they do not prove whether a dispatched effect executed or authorize automatic retry.

After a NanoCore-only restart, current package compatibility and the ready physical Epoch can restore an exact healthy idle Sandbox/Harness and its attached storage before later-Turn reuse classification. Empty process-local caches alone do not authorize replacement; native-session proof and current admission remain required.

Git-source Turns accept a new Sandbox-reported commit-pinned baseline and retain captured work evidence without a host repository or host apply prerequisite. Non-Git Workspace publication retains its existing review/apply path.

Structured `conversation.submit` accepts the existing `workerStorageChoice` only for warm/new Task Worker targets. The exact choice participates in both command and Worker checkpoint identity and is forwarded to admission with the actual receiving Task Thread; selection against an originating conversation never replaces receiving-audience, revision or layout validation. Inapplicable targets fail before command effects, and omission keeps the default new environment.

The Agent catalog is a live, product-safe projection of current server manifests through the shared Workspace resources read path. Catalog list/detail, health refresh and dashboard consumers share it; Workspace launch pins do not hide supply. Missing authored roles project as null, and catalog presence does not claim observed runtime health.

Current Workers are a separate selected-Workspace read at `GET /api/app/workspaces/:workspaceId/workers`. The projection lists current nonterminal AgentSessions of visible Threads, copies exact matching checkpoint Task/Goal assignment, and labels package preference and last-used model separately. Thread audience is checked before checkpoint, package, or usage reads; missing Turns and conflicting checkpoint lineage remain unavailable. Reading it creates no Worker lifecycle; last-used usage requires existing `audit.read` or is returned as restricted.

Chat Mode distinguishes explicit external search or browsing requests from ordinary topic mentions and questions about supplied Artifact content. The shared conversation admission path retains external-search refusal without treating words such as Web or internet alone as a request to browse. Explicit Artifact references use their immutable version and remain separate from permission to perform external work. Chat and selected Worker submissions use the canonical Artifact reference identity so persisted attachments remain readable after restart. Assistant submissions with admitted Artifacts skip the Knowledge-only answer shortcut so the supplied content reaches the answering provider; the explicitly selected Knowledge Manager retains its own path. Knowledge Manager `answer` treats a selected page as sufficient only when two distinct query terms appear in that page title or body, or a one-term query matches the page title; weaker one-token overlap is `insufficient-evidence` and Assistant Chat falls through to the accepted provider.

Internal Chat, administration and Goal planning calls keep private cache scope and usage attribution in Gateway dispatch context. They do not send duplicate internal metadata fields to provider-native endpoints; unsupported external request fields still fail admission.

## Native Operation Slice

[`src/operation-invocation.ts`](src/operation-invocation.ts) joins the shared release-authored operation definitions to existing domain handlers and performs native admission and output validation. The migrated Kernel pair derives HTTP, Core Client, selected Worker MCP and retained CLI projections from one table. The existing Kernel receipt, audit and replay owners remain authoritative. [`src/operation-projections.test.ts`](src/operation-projections.test.ts) composes those real projections over isolated SQLite records and checks the result, replay, credential, child and lineage invariants. The administration provenance proof uses the actual fixed internal Tool assembly in `src/administration/operation-invocation.test.ts`.

## Scope

NanoCore's App listener serves stateless Streamable HTTP at `/mcp`. This endpoint requires an ordinary `Authorization: Bearer` Token in both server and local mode, reuses the existing verifier and native invocation, and exposes only `search`, `describe`, `guide`, and `call` over the composed operation definitions. Its read-only discovery tools expose metadata rather than permission grants; the multiplexed call can mutate, and describe gives the selected operation's posture. Token issuance, rotation and bootstrap output contracts are refused before invocation. Token last-use and request audit record `remote-mcp`; no MCP session is product authority. The retained Skill covers operations not yet migrated. Run `pnpm --filter @openkit/nanocore exec vitest run src/remote-mcp-routes.test.ts src/auth/middleware.test.ts src/operation-projections.test.ts` for the focused endpoint, credential and native-seam regressions.

- local-mode implicit single-user operation
- server-mode registered-user small-team operation with HTTP-only session auth and bounded Workspace sharing
- optional file-backed state through `OPENKIT_DATA_ROOT`
- implicit local actor `user_local`
- governed container Worker AgentSessions
- provider-neutral subscription account state for `openai-codex` and `xai`
- agent-facing LLM Gateway endpoints for Chat Completions and Responses, with one-level function namespace identity preserved on the chat-native bridge
- remote Git catalog sources with immutable pins for governed worker materialization
- Goal intent, cards, exact immutable Plan approval, ordinary Task links, human completion acceptance and cancellation through the derived Goal operation family
- real HTTP + SSE protocol surface

Current OpenAI flagship API and Codex subscription profiles are available as opt-in [provider templates](./data-templates/config/providers/README.md#current-openai-flagships), with official metadata overlays and exact GPT-6 routing instructions.

Presented server-admin bearers may start Tasks across active Workspaces without membership. The existing scheduler admission retains only the exact non-secret Token reference; dispatch and later Worker effects revalidate current Token and User facts through exact lease/Turn/package lineage. Revocation cannot fall back to membership, and private conversation ownership, approvals and Vault grants remain separate checks. Retained Worker storage rechecks that exact live authority and each contributing Thread audience at reservation or reuse; whole-volume reuse remains restricted to the same responsible user.

Actor-derived Quick Chat operations establish a usable server-admin bearer's own private home through the existing Workspace provisioner before evaluating Workspace access. This supports first-time administration Assistant use without a preceding browser session. It accepts no caller-selected owner or Workspace, preserves membership tombstones, and never provisions for revoked, expired, or disabled credentials.

Task routing preserves affirmative leading implementation intent when later constraints mention review, refinement, retry or handoff. It reads the request the prompt actually makes, so review, audit, and handoff nouns appearing in supplied context or inside negated constraints do not select those kinds; when no clause is identified as the request, the whole prompt is scanned so routing is never narrower than scanning everything. Explicit leading review and retry requests retain their existing non-delegation decisions; sensitive-effect and Goal checks still precede this heuristic.

Selected-Worker `conversation.submit` returns its existing accepted Turn and result Item before Worker completion. The full Worker loop retains ownership of the Workspace database, checkpoint, scheduler lease, output and cleanup until closeout. The exact result Item then reflects terminal failure or interruption; replay validates current durable state without relaunching the Worker or repairing contradictory history. Web and the public Skill follow the returned receiving Thread and Turn for progress rather than keeping the submit request open through execution.

Before creating a receiving Thread or Turn, selected-Worker submission validates the assembled conversation prompt against the structured delegation objective schema. The 2,000-character limit includes attached Artifact text; invalid input returns HTTP 400 `invalid_request` with the schema issue text and creates no Worker admission or executor effect. Valid objectives pass unchanged, without truncation. Run `pnpm --filter @openkit/nanocore exec vitest run src/mode-entry-routes.test.ts` for the focused route regressions, including rejection at 2,073 characters and unchanged delivery at 2,000.

## Runtime

Authored manifests and profiles are validated by AuthoredAgentConfigSchema in `@openkit/config-schema`; `src/agents/setup-resolver.ts` owns profile selection and composition. The dispatch retry service calls `src/runtime/scheduler-dispatch-loop.ts` directly; its timer, snapshot refresh, and error handling remain in `src/runtime/scheduler-dispatch-service.ts`.

- `nanocore` admits governed worker sessions only through the configured NanoHost RuntimeTarget and its current native HTTP/2 connection generation.
- NanoCore persists separate Sandbox runtime, Harness instance, and AgentSession runtime-binding records, and stores only hashes of raw Turn route credentials
- the selectable NanoHost foundation supports one long-lived Harness, fixed private Harness operations, multiple AgentSessions for distinct Threads, restricted Codex handles, and shared-Sandbox retention
- product admission computes the exact static SessionCompatibilityKey before a scheduler lease, reuses the Thread's sole compatible idle AgentSession, and closes or fences an incompatible predecessor before selecting one internal successor; terminal Core predecessors with an occupying native binding follow that same verified replacement path without rewriting history; the Store and Harness projections reject duplicate current bindings, and ordinary App API read models expose no AgentSession identity or action. Native continuity derives from that same AEP-embedded canonical key; it never recomputes the key from policy paths already rewritten to materialized slots.
- the one-Sandbox scheduler loop keeps incompatible placement queued while its resident Sandbox is busy or unproved; synchronous Task/Goal callers retain their existing deferred-admission cancellation. After scheduler admission, an idle resident is drained and its private runtime state is cleared before replacement, while Core conversation history remains intact. A resident `session.close` refusal with `cleanup_required` widens through `bridge.close` and `sandbox.delete`; settled deletion permits replacement, while wider cleanup failure keeps the fence. Idle records lacking the current backend's process-local continuity proof require whole-Sandbox cleanup before a fresh AgentSession; active-attempt restoration keeps its existing exact recovery checks. Idle closure drops the temporary restored Turn handle after collection and close, so a later Sandbox with the same compatibility-derived identity does not inherit stale process-local occupancy
- proved Sandbox writer cleanup retires the runtime projection even when its storage association is missing, reporting that absence without reconstructing or deleting retained storage; a fresh admission then creates and attaches its own storage through normal image inspection and reservation. Unknown cleanup still requires a different fresh physical Epoch before retirement; old-Epoch residents can then retire regardless of stale runtime lifecycle or cleanup projections, with queued or dispatched Harness operations settled as unknown before replacement, and converted `pre-witness` residents can retire without a Harness or storage binding. Pins, active-Turn occupancy, current Turn/lease references, and nonterminal lease guards remain in force for their existing owners; same-Epoch checks stay strict and old Tasks are never replayed
- live image acquisition, build and inspection failures, and fully rolled-back storage reservation failures before Sandbox creation, settle cleanup locally; they do not install restart-only cleanup expectations or fence the healthy NanoHost connection on its next idle poll. A failed incoming attempt whose idle-resident eviction never reached its own Sandbox creation uses that same local cleanup proof; the resident's cleanup fence remains owned by eviction. Process restart discards that local proof and retains the existing conservative recovery behavior
- restart Phase 8 performs only durable classification, fencing, read-only restoration, and result-only expectation registration; after the ordinary listener is available, the existing single-flight lease-maintenance service drains effect-owning cleanup and fail-closed accepted-final-status recovery
- an authoritative successor’s first effect poll before retained-result delivery settles prior-connection accepted effects and associated result-only expectations in one unknown-outcome fence; a live connection that has completed an effect poll keeps later result-only expectations pending without closing, and repeated readiness does not reset that fact; undispatched commands remain queued, known durable image settlements retain their results, and durable cleanup/capacity fences still require the existing later fresh-coordinator proof. Correlated successful-delete delivery may be discarded without settlement when no pending entry exists and its unique backend row is already `physical-cleaned` or `cleaned`; this supplies no cleanup proof and never discards a delivery that unfinished physical cleanup needs.
- Task checkpoint classification recognizes the exact `conversation.submit` Worker receipt before the direct `task.start` path; both retain their own command identity, and terminal cleanup uses the existing recovery owner without fabricating a second command receipt. Terminal Task checkpoints with no matching scheduler lease are cleared when the product Turn is already completed, failed, or cancelled and no live lease remains; non-terminal or interrupted leftovers stay fail-closed. A null-session checkpoint whose only lease is failed with release reason `turn-start-failed` and recovery state `needs-evidence` is cleared without re-importing required runtime provenance; any other lease tuple, and any checkpoint that still names a worker session, keeps that provenance check. A missing Turn stays fail-closed at boot, including when that error would also be raised for a Turn owned by another Workspace or Thread. The stopped-server `task-checkpoint:clean` command can delete an explicit failed direct Task checkpoint only after dry-run review, an external Workspace-database backup, and exact cancelled-admission or pre-persistence `turn-start-failed` proof. It leaves leases, admissions, receipts, capacity, and product history in place
- current capabilities: turn execution, streaming assistant text, approval bridging, user-input questions, interruption, registered-user Workspace invitation and membership lifecycle, owner transfer, explicit administrator access recovery, owner-authorized Workspace deletion and verified new-ID recovery, one-way user disable, Artifact inventory, content, direct import, idle-Thread introduction, version-owned Artifact Review decisions, Workspace Material revision, binding, proposal apply, and portable history, durable Workspace Sync Review decisions, workspace configuration, workspace knowledge editing, repository linking, Workspace Skill/MCP/plugin catalog management, per-app Light App SQLite Kernel commands, native Generative UI presentations linked from Thread Items, built-in Worker MCP `openkit-generative`, Goal creation, immutable Plan approval, linked Tasks and human completion acceptance, unified Human Attention Action Center projection, provider-subscription login coordination, and dual-entry LLM Gateway routing
- current non-goals: remote agents, full Sustained Mode automation, Task Evaluator loops, and an independent final-verifier completion gate

## Prerequisites

- real governed worker sessions require one configured Linux/systemd NanoHost running the stock OpenShell Gateway at exactly `0.0.99` with its private container backend and the exact image needed by that workload
- every reference uses `image.acquire` before read-only image inspection and Sandbox creation; an exact lowercase `sha256:` digest with pull policy `never` selects verified local Image Store content without registry or build fallback, including after a fresh backend epoch; `image.inspect` carries only its image digest and request identity, while Core session lineage remains in request-identity derivation
- NanoCore accepts NanoHost admission only on a native HTTP/2 physical connection with a valid dedicated `nanohost-transport` Token; it allocates generation one or durable high-water plus one and binds dispatch authority to that exact server-created connection context
- synthetic application requests and caller-provided NanoHost connection handles or generations are not selectable runtime paths
- subscription-backed inference requires a prepared provider-subscription account and bound provider profile; worker-runtime authentication remains a separate adapter concern

Incremental work retention enters through `src/storage/work-observations.ts`; runtime ingress, Gateway capture and the authorized Thread dashboard share that owner. Complete admitted originals remain governed by the Turn-bound capture setting and existing restricted EvidenceBundle lifecycle; runtime activity is a lossy display projection.

Selected Workspace catalog MCP servers resolve into the same secret-free AEP supply for Codex, Pi, OpenCode and DeepSeek. Each adapter projects those ids onto the fixed Integration capability loopback using its native MCP interface; NanoCore retains upstream configuration, credentials and admission checks. Run `pnpm --filter @openkit/nanocore exec vitest run src/runtime/agent-environment.test.ts` for the adapter-neutral supply regression.

Every Worker package supplies the built-in `openkit-work` MCP server. It raises pending input requests and provides read-only same-Sandbox peer discovery and product history under the responsible user's current access. The [runtime guide](src/runtime/README.md) describes the Turn-scoped handles, paging, and existing Gateway evidence path.

## Commands

Tests of unrelated AEP consumers use `src/test-support/prepared-agent-environment.ts` for confirmed image evidence and explicit default-off capture fixtures. Capture-admission tests use the production resolver directly so missing historical coverage remains a dispatch refusal.

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

Conversation-target discovery and submission share one Thread-scoped catalog. Existing Worker targets use only the requested Thread's current AgentSession, exclude terminal history, and distinguish ready or idle availability from busy, stale, or unready state. Starter catalogs include no existing Worker continuation; a foreign Thread target is rejected before execution. This projection does not enumerate running Sandboxes.

Optional boot-bound `appUpdate` configuration enables deployment-admin `prepareAppUpdate`, `startAppUpdate` and `getAppUpdateStatus` operations through a restricted SSH host helper. The helper owns replacement outside the App process; Core records authorization and projects its receipt. Without configuration the capability reports `app_update_unconfigured`. It is not supplied to Workspace Workers, and it never owns NanoHost updates. See [App Update Delivery](../../docs/specs/20260910-app_update_delivery.md) for the accepted boundary and current rollout status.

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

The unified Human Attention Action Center is available at `POST /api/app/operations/attention.list`. It replaces the old split pending approvals and pending questions endpoints, and projects pending approval and user-input requests, Goal Pending Requests, checkpoint recovery, scheduler admissions, agent readiness failures, durable Workspace Sync Reviews, and explicit knowledge proposal records into one App API read model. Workspace Review rows include originating Thread and Turn ids only when their backing Artifact has consistent lineage and that Thread is visible to the caller; absent or inaccessible origins do not remove the Workspace-scoped review or change its decision authority. Interrupted-worker rows require the exact interrupted Turn and recorded AgentSession plus a matching terminal restart-cleanup lease; a strict request-identified retry releases only the existing ordinary Task checkpoint for a later fresh start, and never rewrites the old Turn, changes scheduler authority, or starts a worker. Scheduler admission readback is available at `POST /api/app/operations/scheduler.list`; it returns workspace-filtered queued and denied admissions with queue position and denial reasons, but excludes raw Turn input, user ids, captured cwd, and Workspace root paths. Scheduler admission actions are available at `POST /api/app/operations/scheduler.retry` for denied admissions and `POST /api/app/operations/scheduler.cancel` for queued or denied admissions. Durable Workspace Sync Review decisions are available at `POST /api/app/operations/sync.review-decide` for `accepted`, `needs_refinement`, `rejected`, and `blocked`; a backing Artifact may supply a read-only legacy review projection but cannot own, resolve, or apply a decision, and no generic Artifact mutation or review route exists.

Direct Task and Chat-to-Task deliver the complete Coordinator request as compact JSON through the existing Turn path. Goal-linked admissions use the same ordinary Task request and worker owner, with Plan and card citations reserved in Workspace SQL.

Pending requests preserve the originating Task or selected-Worker conversation receipt. Raising a request leaves the Worker Turn running; the worker ends it normally. The request remains actionable after that Turn completes, and its final outcome enters a later matching executor Turn under current authority. [Pending Requests](../../docs/specs/20260930-pending_requests.md) owns execution, publication, native delivery proof, and recovery.

Redacted Agent Environment Package snapshot readback is available at `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots` and `GET /api/app/workspaces/:workspaceId/agent-environment/snapshots/:snapshotId`. These routes return durable workspace-owned package snapshots for diagnostics and evidence without exposing backend-private fields, raw credentials, or host-local runtime references.

Knowledge pages use pinned OKF v0.2 with nested YAML metadata preserved across managed edits and portability. OpenKit lifecycle authority is `openkit_status`; the standard OKF `status` is its draft/stable/deprecated projection.

Knowledge public operations derive from `KNOWLEDGE_OPERATION_DEFINITIONS` and retained entry operations from `KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS` in `@openkit/app-api-schemas`. HTTP exposes `POST /api/app/operations/<id>`; the same definitions project OpenAPI, `client.operations` and the bundled CLI, with no legacy Knowledge route or alias. `knowledge-operations.ts` joins the definitions to the existing file-backed Source, maintenance-ledger, index, retrieval, proposal/review and entry owners. Index readback rebuilds disposable Workspace Knowledge indexes and returns the current Markdown concept-link graph, per-page validation report, source-reference index and portable full-text index. Deterministic retrieval ranks active valid pages and appends selection evidence to `knowledge/traces/<YYYYMM>.jsonl`. Public preparation returns bounded selected/excluded material and the S61 trace reference. Trusted Task preparation enters the same definition, `knowledge.read` admission and retrieval owner and returns exactly `{ retrievalTraceId }`; Task alone hands the accepted selection to S39, with no second standalone Knowledge package trace or materialization surface.

After building NanoCore, run `pnpm --filter @openkit/nanocore exec vitest run --config vitest.e2e.config.ts e2e/workspace-portability.spec.ts e2e/secret-redaction.spec.ts` to check retained Knowledge through the built server's derived HTTP bindings. The two-job portability runner uses the same derived CLI entry contracts.

The storage App API derives `storage.layout-report`, `backup.create`, and `backup.verify` as `POST /api/app/operations/<id>` for layout diagnostics and server-managed hot backup verification. Deployment-wide routes accept the implicit local actor, a presented `server-admin` Token, or a Better Auth session whose active canonical User owns a currently usable `server-admin` Token; Workspace-scoped Tokens receive `403 Forbidden`. Backup responses return only a backup id, manifest, and checked inventory summary; they do not expose filesystem paths.

Restore is intentionally a stopped-server operator command, not a live App API. The App image exposes it as `/usr/local/bin/openkit-restore`. Stop NanoCore first; the command refuses when `server/runtime/nanocore.lock` exists, verifies the backup manifest, replaces the target data root through the existing restore helper, and prints a path-free JSON summary.

Live `backup.create` stores `/data/openkit.backups/<backupId>` beside the Data Root, so the host must persist `<data-root>.backups` separately from the `/data/openkit` mount. Restore replaces that target with `rename`, so bind a writable host **parent** at `/restore` and restore its child. Binding the Data Root itself at `/data/openkit` makes a mountpoint and fails with `EBUSY`. The parent must be one writable filesystem so `<data-root>.restore-staging` can be renamed onto the child. Mount the retained backup subtree read-only at `/backup`.

```bash
docker run --rm --entrypoint openkit-restore \
  --mount type=bind,src=/absolute/path/to/restore-parent,dst=/restore \
  --mount type=bind,src=/absolute/path/to/openkit.backups/<backupId>,dst=/backup,readonly \
  openkit/app:<exact-version> \
  --backup-root /backup \
  --data-root /restore/data
```

From a source checkout, `pnpm --filter @openkit/nanocore run data-root:restore -- --backup-root /absolute/path/to/backup --data-root /absolute/path/to/restore-parent/data` still runs the same helper. The target must remain a child of a writable same-filesystem parent.

Stopped missing-Turn Task checkpoint cleanup is separate from restore. Stop NanoCore, then dry-run explicit identities and apply only the proved rows:

```bash
pnpm --filter @openkit/nanocore run task-checkpoint:clean -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/checkpoint-backup \
  --checkpoint workspaceId:threadId:turnId
pnpm --filter @openkit/nanocore run task-checkpoint:clean -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/checkpoint-backup \
  --checkpoint workspaceId:threadId:turnId \
  --apply
```

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

The provider-subscription App API is available through canonical `POST /api/app/operations/provider-subscription.<operation>` bindings for `openai-codex` and `xai`. Every account, status, login, cancel, logout, quota, and auto-top-up action is scoped to an explicit provider and account-slot pair; strict non-secret metadata lives under `DATA_ROOT/server/files/provider-subscriptions/<provider>/accounts/<slot>/account.json`, credential material remains behind encrypted-file Vault references, and public payloads are sanitized. Codex quota uses the strict usage reader and xAI quota uses the strict credits reader; both return `available` or `temporarily_unavailable` without blocking inference. The xAI reader preserves actual period fields when usage is absent, omitting percentages instead of guessing zero. It separately projects same-call account observations and optional signed USD-cent balances and extra spending. The independent read-only auto-top-up endpoint retrieves rules only when requested; absent fields, explicit zero, query failure, and disabled rules remain distinct. No billing mutation or quota-based inference gate is introduced. This server-owned surface accepts the implicit local actor, a presented `server-admin` Token, or a Better Auth session with currently resolved Token-derived deployment-admin authority.

The agent-facing LLM Gateway exposes `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, and `GET /health`. The `/v1/*` surface uses the same actor authentication and workspace-scope checks as product APIs in server mode; local mode uses the implicit local actor. The separate internal `POST /api/worker-inference/v1/chat/completions` and `POST /api/worker-inference/v1/responses` routes accept only a live scheduler lease token bound to a hydrated trusted-relay AEP, derive provider/model/lineage from that package, reject caller authority and provider-side state, and require a fresh durable capability call before dispatch. Provenance-required packages must also supply the pinned canonical runtime hint; NanoCore derives product-safe origin and cache refs, strips every native value before dispatch, and reconciles provisional origin refs against the verified turn-end provenance index. Provider diagnostics show whether each provider supports Chat Completions and Responses natively or through a bridge. Native Codex Responses keeps message-anchored tools client-executed, rejects provider-executed declarations before provider access, and preserves function namespaces and custom inputs through stock pi-ai semantic events. Worker Responses preserves admitted tool definitions in the standard top-level `tools` field for generic providers; only the resolved `openai-codex` family receives the native `additional_tools` representation. The public Gateway preserves OpenAI-compatible `prompt_cache_key` and `prompt_cache_retention` fields, ensures every upstream native Chat Completions or Responses request has a `prompt_cache_key`, and reports process-local cached input token summaries in Settings Diagnostics. Workspace-attributed capability calls and usage rows can be read through `GET /api/app/workspaces/:workspaceId/capability-usage`; CapabilityCall owns the authorizing package snapshot plus optional product-safe runtime-origin and cache-lineage refs, while linked usage and audit rows remain unchanged. NanoCore-owned domain producers write workspace evidence bundles and consumers read them through `GET /api/app/workspaces/:workspaceId/evidence-bundles`; workspace audit events can be read through `GET /api/app/workspaces/:workspaceId/audit/events`; server audit events can be read through deployment-admin `GET /api/app/audit/events`; workspace permission decisions can be read through `GET /api/app/workspaces/:workspaceId/permission-decisions`; and server permission decisions can be read through deployment-admin `GET /api/app/permission-decisions`. It does not expose `POST /v1/completions` or the superseded `/internal/v1/chat/completions` facade. Every production provider dispatches through `PiAiGatewayClient`; subscription-backed profiles select the exact provider-and-slot pi-ai runtime before dispatch instead of selecting a dedicated backend. Provider model lists and Gateway routes accept hand-authored upstream IDs; models.dev supplies optional metadata, not an allowlist. Models without catalog family metadata retain a null family and exactly one authored route, while known-family multi-route validation remains strict. Missing model metadata contributes only endpoint-derived capabilities and never invents model features or physical limits.

CapabilityCall terminalization writes the call and linked AuditEvent atomically with one terminal timestamp. The closed terminal set is `succeeded`, `failed`, `denied`, `aborted`, `timed-out`, `interrupted`, and `unknown`; restart recovery maps leftover `running` calls only to `unknown`.

Pi-ai-routed requests observe one provider-native terminal usage payload before public OpenAI normalization. Workspace-attributed calls write positive input, output, cache-read, and cache-write token rows plus one `unit: "usd"` cost-estimate row when reported; that estimate is telemetry, not billing truth. Public responses, SSE, errors, and diagnostics keep the existing OpenAI-compatible vocabulary and never expose raw cost objects or prompt-cache keys.

Deployment-wide diagnostics at `GET /api/diagnostics`, `GET /api/app/diagnostics`, and `GET /api/setup/diagnostics` accept the implicit local actor, a presented `server-admin` Token, or a Better Auth session with currently resolved Token-derived deployment-admin authority. Workspace-scoped Tokens cannot read deployment provider-subscription, runtime-config, storage, or readiness projections.

App Diagnostics samples the current NanoCore process after deployment-admin authorization: observation time, Node version, uptime, memory and nested `process.telemetry` configuration flags. These values do not establish host or Worker health. Optional request tracing uses a same-deployment OTLP Collector configured by `OTEL_EXPORTER_OTLP_ENDPOINT`; it is disabled without a valid endpoint, by `OTEL_SDK_DISABLED=true`, or by unsupported exporter-header environment configuration. Spans and safe terminal diagnostics correlate with the existing boot instance and describe HTTP response handoff, not asynchronous Task completion. Exporter failure does not fail product work. See [Operational Telemetry](../../docs/specs/20260731-operational_telemetry_standardization.md) and [Persistent Live Acceptance](../../docs/cookbooks/persistent-live-acceptance.md).

Vault admin routes expose redacted status and lock controls under `/api/app/vault/*`. Global status, unlock, lock, Codex auth JSON bootstrap, authored provider API-key store or replacement, and server vault-use evidence accept the local actor, a presented `server-admin` Token, or a Better Auth session with currently resolved Token-derived deployment-admin authority; Workspace-scoped Tokens cannot use that deployment-admin surface. `POST /api/app/vault/bootstrap/codex-auth-json` stores base64 request content as the server-owned `vault_codex_auth_json` reference and creates `grant_codex_auth_json` for OpenShell runtime-file injection to `/sandbox/.codex/auth.json`; responses never echo the submitted auth JSON. `PUT /api/app/providers/:providerId/api-key` stores or rotates the unique authored provider profile's safe `vault://` reference and returns only redacted configured status. Workspace vault recovery uses `GET /api/app/workspaces/:workspaceId/vault/references` for redacted reference discovery and `POST /api/app/workspaces/:workspaceId/vault/references/:referenceId/rebind` for imported unbound reference re-binding. Better Auth sessions require active membership; workspace and workspace-readonly tokens require active membership plus a binding to the addressed workspace; local and `server-admin` actors are not workspace-bound; readonly tokens cannot rebind. Server vault-use evidence can be read through `GET /api/app/vault/use-records`, and workspace vault-use evidence can be read through `GET /api/app/workspaces/:workspaceId/vault/use-records`; responses contain only non-secret use metadata and linked audit ids. The owning authorization matrix is in `docs/specs/20260704-vault_backend_implementation.md`.

For the encrypted-file backend, `config/server.jsonc` may set `vault.encryptedFile.keyFilePath` to an absolute external file containing exactly 32 raw bytes with exact `0600` permissions and process-user ownership. NanoCore verifies that key against the authenticated store header during the non-critical Vault boot phase, reuses the same unlock state for runtime requests, stays locked and degraded on any redacted key failure, and clears owned key material on lock and shutdown. The full operator contract is in [the DATA_ROOT config manual](../../skills/openkit-ops/references/nanocore-data-root-config.en.md).

Source ownership and local verification for this subsystem are documented in [the Vault source guide](src/vault/README.md).

Set `OPENKIT_DATA_ROOT` to persist canonical Workspace records under `temp/nanocore-data/workspaces/<workspaceId>/` from the repository root.

## Remote Git Sources And Goal Mode

NanoCore host repository resources, host Git publication, host inspection, and the Repositories screen are removed. Remote Git sources use catalog URL/commit pins and Sandbox-reported baselines; hosted writes use selected vendor MCP through the Gateway.

Goal uses ten canonical JSON POST operations at `/api/app/operations/<operation-id>`: `goal.create`, `goal.intent.revise`, `goal.card.create`, `goal.card.edit`, `goal.card.cancel`, `goal.plan.propose`, `goal.plan.approve`, `goal.cancel`, `goal.completion.accept`, and `goal.read`. Their definition table supplies HTTP, OpenAPI, Core Client, CLI and Coordinator Tools; `runtime/goal-owner.ts` owns their outcomes and Workspace SQL records.

`goal.read` joins current intent and its history, revisioned work-intent cards, immutable proposed and active Plan bytes and digests, shared Pending Request resolution and claim, linked ordinary Task Threads and actual Turn states, and the terminal disposition. A later intent or card edit preserves an unchanged proposal or grant. Plan consumption rechecks current authority, cancellation and exact bytes, then activates the approved version without launching workers or restoring old intent or cards.

The Goal Coordinator runs ordinary internal-agent Turns on the Goal Thread without an AgentSession, using the existing logical-model role configuration `goal-orchestrator`. Native Task admission cites the active Plan version and the current card revision at the ordinary Task reservation boundary and checks current intent and cancellation. Human completion acceptance consumes the exact shared Pending Request candidate; worker completion alone leaves the Goal open.

Goal commands and linked Task terminal facts advance the Goal change marker in the same Workspace commit. `task-terminal-fact.ts` supplies a minimal Task-owned terminal fact so boot can publish a committed terminal after interrupted file publication. Marker consideration occurs at command commits, Task and Coordinator terminal barriers, and boot; no Goal queue or separate run lifecycle exists.

The one-way storage cutover removes the seven retired Goal tables, Goal-owned worker checkpoints, and the Sandbox pin column. Shared conversation history, Artifacts, Artifact Review, evidence, audit, worker-storage contributors, ordinary Task checkpoints and command receipts remain. Current Goal records are carried through the ordinary Workspace archive, without importing grants or recreating retired Goal authority.

For user-facing deployment documentation, see [NanoCore Deployment Modes](../../skills/openkit-ops/references/nanocore-deployment-modes.en.md).

For user-facing `DATA_ROOT/config` documentation, see [NanoCore DATA_ROOT Config](../../skills/openkit-ops/references/nanocore-data-root-config.en.md).

Workspace config is loaded from `DATA_ROOT/workspaces/<workspaceId>/config/workspace.jsonc`. V1 configured roots remain workspace-relative `host-dir` roots under the Workspace directory. A selected Agent may additionally bind one read-write input to a credential-free HTTPS Git source in the Workspace data-source catalog; Turn admission captures its exact commit without a NanoCore host path, and the Worker Shim materializes it at `/workspace/openkit/worktrees/main` before native start. The declared `access` field is enforced by the selected worker runtime. Authored Assistant inspection settings remain loadable as inert data; they do not authorize host reads.

NanoCore creates `data/server/db/core.sqlite` on boot. The current SQLite schemas are managed by Drizzle definitions under `src/storage/schema` and native per-scope SQL journals under `drizzle/{core,user,workspace,app}`. Before first release, each scope keeps its schema in `0000_setup.sql`; later schema-changing releases append one SQL file per affected scope. See [drizzle/README.md](./drizzle/README.md) for the custom SQL creation command.

Migrate one stopped predecessor data root from owner-nested Workspace storage to the canonical top-level layout with:

```bash
pnpm --filter @openkit/nanocore run workspace-storage:migrate -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/openkit-predecessor-backup
```

The command refuses to run while `server/runtime/nanocore.lock` exists, requires a new external backup destination that is separate from the data root, verifies the complete predecessor cold backup, performs the one-way migration, and writes the evidence-only relative-path report to `server/migrations/workspace-storage-v1-to-v2.json`. Retain the external backup for operator recovery; the report is not retry or resume authority and no compatibility reader remains.

A deployment whose NanoHost runtime records predate physical Epoch witnesses requires a separate one-time stopped Core/Host cutover:

```bash
pnpm --filter @openkit/nanocore run physical-epoch:migrate -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/openkit-pre-witness-backup
```

First prove the predecessor NanoHost effect domain fully stopped and preserve its Image Store and retained Worker volumes. The converter uses the existing cold-backup mechanism, refuses a running Core or repeat conversion, and atomically adds the current RuntimeTarget witness and immutable Sandbox/backend-session origins. Converted origins are `pre-witness`, never reusable live handles or defaults for normal writes; readiness starts cleared. Retain `server/migrations/physical-epoch-cutover.json` as evidence and the external backup for recovery. Deploy the matched Core and Host before normal startup; follow the [operator procedure](../../skills/openkit-ops/references/nanocore-operations.en.md#convert-a-pre-witness-deployment). Pending Tasks retain ordinary interrupted/unknown recovery rather than replay.

If an existing authoritative Core, User, or Workspace SQLite database fails its boot integrity check, NanoCore stops before product admission, bootstrap credential issuance, or listener binding and leaves the original file unchanged. Derived indexes remain disposable and rebuildable.

In local mode, NanoCore upserts the implicit `user_local` row on boot and accepts requests without auth headers. Local mode binds to `127.0.0.1` by default; set `OPENKIT_BIND_HOST` to override the HTTP bind host.

## Release Verification

Run the app-level black-box e2e suite with:

```bash
pnpm --filter @openkit/nanocore run test:e2e
```

The e2e surface boots NanoCore as a process, uses fresh temporary data roots, covers empty boot, Goal planning, bounded restart read-model replay, configuration loading, migration idempotency, agent readiness diagnostics, secret redaction, and the skip-aware real Codex smoke spec.

The configured deterministic simulator raises product-backed questions through the built-in Worker MCP `work_request_input` dispatcher and existing Pending Request owner. Its Material regression verifies the request remains decidable after the raising Turn completes, a real `question.answer` admits a distinct later Turn of the same Task, and that Turn accepts the recorded answer in its retained Agent Environment Package and final summary. Standalone protocol fixtures without Core storage do not establish durable request behavior.

The migration-idempotency e2e reads the persisted SQLite ledger against the released Drizzle journal after two process boots; it imports no NanoCore source internals. Secret-redaction e2e reads the Workspace dashboard through `workspace.dashboard` and checks it together with diagnostics and Knowledge payloads.

The fixed CI portability proof runs the bundled local-mode CLI in separate source and target jobs, transfers the original `.openkit-workspace.tar.zst` plus its SHA-256 and semantic oracle through one workflow artifact, verifies the archive SHA-256 across runners, compares remint-neutral Workspace semantics and complete seeded Turn history, explicitly rebinds the surviving Vault reference, exercises target behavior, and verifies a target re-export without treating the re-export digest as an equality oracle. Host repository linking and re-binding are absent because the entire host repository resource retired under [Hosting Goes Through The Gateway MCP](../../docs/decisions/20261002-hosting_through_gateway_mcp.md).

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

Server mode uses Better Auth email/password routes under `/api/auth/*`, protects product APIs with HTTP-only session cookies, and accepts server-issued `okt_` bearer Tokens for remote access. A valid session establishes the actor identity and receives current Administrator Eligibility only while its active canonical User owns a currently usable `server-admin` Token. That session or a presented usable administrator bearer receives owner admission on active Workspaces without a manufactured membership; read-only credentials stay read-only. The synthetic administrator fact's `membershipRevision: 1` is not a membership compare-and-set value.

On an empty server deployment, consume the owner-readable bootstrap token through `POST /api/app/auth/bootstrap/consume` or `bootstrap.consume` with `ownerUserId`, `displayName`, `email`, and `password`. After password hashing, that transaction rechecks the current bootstrap expiry and empty-user state before creating the first server-admin token and the owner email/password account; sign in afterward through the normal `/api/auth/sign-in/email` route.

Workspace Material routes authorize the path Workspace before resolving opaque target identifiers. For an authorized caller, an absent Material, revision, or Thread target, including an identifier that exists only in another Workspace, returns scoped `409 stale`; `403 workspace_access_denied` is reserved for pre-target Workspace authorization failure, and NanoCore does not scan another Workspace to classify the target.

The Workspace sharing App API exposes the fifteen exact operations owned by [Single-Deployment Multi-User Workspace System](../../docs/specs/20260715-multi_user_workspace_system.md): authorized Workspace discovery, owner-visible membership and invitation management, session-bound invitee decisions, non-owner leave, ordinary owner transfer, content-free administrator recovery, and one-way user disable. All lifecycle mutations reuse the Core command receipt and Core audit transaction; current usable administrator sessions and bearers receive owner admission without membership, while Quick Chat remains owner-bound and non-shareable.

Access-token administration is available in server mode to presented `server-admin` Tokens and Better Auth sessions with currently resolved Token-derived deployment-admin authority at `GET /api/app/auth/tokens`, `POST /api/app/auth/tokens`, `POST /api/app/auth/tokens/:tokenId/revoke`, and `POST /api/app/auth/tokens/:tokenId/rotate`. Issue may name another exact active canonical `ownerUserId`, with target-owner membership validation for Workspace scopes. Session-only `GET /api/app/auth/my-admin-tokens` and `PUT /api/app/auth/my-admin-tokens/default` expose the signed-in User's redacted `server-admin` Token metadata and effective default selection. Workspace-scoped Tokens are denied; plaintext Tokens are returned only once by create and rotate.

The private administration entry resolves its current user's Quick Chat Workspace and administration Thread before assembling the internal Agent request. It supplies those exact identities as trusted conversational context so the Agent can refer to its own private Workspace without asking for an opaque ID. This context does not select another Workspace, grant access, or replace the existing per-call authorization of environment tools.

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

Use the returned session cookie for protected JSON operations such as `POST /api/app/operations/workspace.list` with input `{}`. Sign out with `POST /api/auth/sign-out`.

## NanoHost Worker Mode

NanoCore runs real Worker Agent Turns only through one configured NanoHost RuntimeTarget. NanoHost owns the stock OpenShell Gateway `0.0.99`, its private container backend, the shared Harness and Sandbox, and the private Harness operations; NanoCore owns product admission, Turn leases, AgentSession continuity, and durable runtime projections.

Every adapter uses one resident binding per AgentSession, as [AgentSession Continuity](../../docs/specs/20260704-agent_session_continuity.md) and [AgentSession](../../docs/core/agent-session.md) own. `session.open` carries the Thread's resume pair (the latest AgentSession whose ready proof Core accepted, as locator and digest) or `null`, and two freshly minted session loopback credentials whose SHA-256 digests alone persist with the binding. Core records each validated ready proof, including one from a failed non-reusable binding, on the AgentSession record when it is accepted, where it outlives close. A crash between the SQLite binding commit and the AgentSession write can leave the proof only on the binding row until that exact binding is restored and its recorder is bound before cleanup. After a Turn, terminal inspection keeps the binding open for the next Turn when it proves the same ready handle, or, for a first Turn that opened pending, a completed Turn with a ready handle; the next Turn starts on that binding without a new `session.open`, and an unsuccessful Turn on a retained binding leaves its AgentSession `idle`. Otherwise closeout sends `session.close`. Session-static Vault runtime environment and credential receipts belong to the Turn that opened the binding. Interruption is private Harness `turn.interrupt`.

Worker-control requests, responses, and private Harness envelopes use version 2 while canonical worker records retain version 1. There is no worker command queue.

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

The chat-native Responses bridge reuses pi-ai context and event projection for standard function tools, including the default `functions` namespace. It preserves complete function-call/result history and developer instructions; arbitrary namespaces, custom tools, deferred declarations and tool search remain unsupported on that bridge.

Pre-native Harness startup errors expose a validated, value-free stage and reason in the existing Task error message, distinguishing workspace materialization from package, adapter, Integration, control-readiness and native-spawn failures.

Worker Responses relay preserves native assistant message IDs and phases across tool-result continuation and emits typed terminal stream failures. Failed Task/Turn errors include a fixed stream-failure detail when the latest inference call for their exact worker package records that failure.

Private administration supports proposals for existing Provider catalog metadata and Gateway logical-model bindings. The human-confirmed `administration.configuration-apply` public operation rechecks current administrator authority and the exact candidate/source identities, then reports persistence and reload/restart separately. Credential setup remains with the existing forms.

Administration model admission reports missing model selection or responses/tool-calling support as `administration_execution_failed`; `context_compaction_unavailable` identifies a missing context policy after those capabilities admit. A refused Turn performs no provider call.

The centralized Workspace deletion retry guard accepts a currently usable server-admin bearer only when its canonical user is the original registry owner. The deletion route still validates the exact retained request, revision and confirmation; ordinary content reads remain denied after deletion begins.

Deployment admins can edit `config/model-catalog.jsonc` in Settings Configuration to register models beyond the vendored inventory. Exact vendor/native-ID extension leaves override snapshot metadata and precede profile `modelMetadata`; catalog changes require restart and Codex subscription effective context remains capped at 256,000 tokens. The operator recipe is in the [DATA_ROOT manual](../../skills/openkit-ops/references/nanocore-data-root-config.en.md#model-not-in-modelsdev).

Workspace dashboard, Thread dashboard and App search resolve the current actor's Thread audience before reading dependent history or matching content. Private ownership is server-bound. Migrated private reads pass current Administrator Eligibility into `isThreadVisible` through `isThreadIdVisible`; retained route guards and the Turn event stream keep the ordinary audience check until those routes are cut over. Artifact summaries follow immutable origin; dashboard counts exclude inaccessible records. `thread.create` defaults to private, while formal Task/Goal callers request `visibility: workspace` for a new Thread. Direct Task/Goal admission never converts private history.

Canonical Thread envelopes require `openkit.thread-visibility.v1`. On predecessor cutover, owner-bound Quick Chat becomes private and Threads with formal Task/Goal inception become shared. Ambiguous project history blocks startup for explicit classification; missing or contradictory current visibility fails closed. The Core route guard also checks addressed Thread paths, conversation-target queries, Turn inputs and opaque feedback/approval lineage. Core lists and Workspace counts exclude inaccessible Threads; creation replay is actor-bound. SSE rechecks current Workspace authority, presented Token usability and audience before publication. Attention, scheduler and recovery projections admit candidate audiences before dependent reads, and generated presentations preserve Item-source audience by refusing private Item publication into a shared or differently owned private Thread, including administrator requests. Standalone Artifact delivery follows immutable origin. Explicit sharing, private-to-shared work handoff, export/import audience enforcement and remaining runtime context retrieval are still incomplete under the visibility specification.

Deployment administrators can manage workspace secrets through `POST /api/app/workspaces/:workspaceId/vault/secrets`, `.../secrets/:referenceId/rotate`, and `.../secrets/:referenceId/revoke`, and ordinary gateway-only grants with no capability target or GitHub Worker runtime-env grants through `.../vault/grants` and `.../vault/grants/:grantId/revoke`. All material is request-only; reference and grant ids remain redacted lifecycle history after revocation.

Authored `server.jsonc.policy.workspaceApprovalModes` entries for `repo.push`, including `require_human_approval` and `auto_allow`, remain parseable for configuration loadability only. They have no grant or execution consumer and do not control vendor MCP approval. Selected vendor tools retain their per-tool approval rules under [Worker MCP Tool Supply](../../docs/specs/20260704-worker_mcp_tool_supply.md) and [Pending Requests](../../docs/specs/20260930-pending_requests.md).


At boot, pending requests on terminal raising Turns remain pending. Recovery settles unfinished claims as unknown and completes only missing Items on their named publication Turns after scheduler fencing. Contradictory records remain inspect-only.

## Per-Turn Vault Runtime Environment

The NanoHost backend keeps resolved runtime-env values in the live Turn producer and adds them only to the exact private `turn.start` response after durable command recording. Sandbox creation, AEP snapshots, Harness command rows and materialization summaries contain no values. The shim checks that private values exactly match current AEP declarations, forwards them independently of the inference route, and rejects missing or conflicting material before native startup. NanoCore writes injection receipts only after the backend acknowledges native startup; lost or refused startup produces no success receipt. Reused Harnesses receive fresh values per Turn, and restored producers cannot replay credentials from storage.

The product Artifact catalog excludes internal Workspace Sync Review backing records by the exact durable `artifactId` relationship, including completed reviews. Artifact inventory, dashboard output counts, Artifact search and new conversation attachment acceptance use the actor-scoped `listOutputArtifacts` projection; direct Artifact reads and introduction also enforce immutable Thread audience through the existing visibility owner. Retained store history, export and authorized direct content reads remain intact. Names, kinds and JSON shape never classify review evidence.

The actor-authorized conversation navigation App read model derives current/latest activity, exact eligible Turn and Goal review attention, and actual Item/Turn/Goal recency for visible active Threads. It creates no Thread kind, read receipt, or Goal child relationship.

Synchronous product Turn start reports `scheduler_admission_denied` when the scheduler rejects that exact submitted queue entry. A different queue entry's denial remains a deferred dispatch result for the caller. Existing authority checks and unstarted-admission cleanup are unchanged.

Workspace deletion distinguishes containment from historical result uncertainty: a failed `needs-evidence` lease is quiescent only with an exact matching cleaned backend and recorded physical cleanup. Missing or mismatched proof continues to fence deletion, and the recovery flag remains unchanged in Core.

Worker Git fetch failures retain a closed `Turn.error.explanation` alongside fixed recovery guidance. HTTP 401/403 is an unattributed refusal, not proof of sandbox enforcement. After Turn persistence, authorized reads/lists and terminal events retain the same facts across restart; cleanup failures preserve the primary explanation without claiming successful cleanup.

Credential-free non-LLM public endpoints use exactly authored REST network grants with the closed `publicAccess` marker. NanoCore checks current setup, route metadata and scheduler authority when resolving each Agent Environment Package; OpenShell materializes only the existing exact grant constraints. Sink-only runtime credentials for other uses are not guessed to target that destination. The narrow implementation and verification path is documented in the [runtime guide](src/runtime/README.md).

Native environment settings are administered through the existing Agent configuration revision/CAS and safe reload path. Image preparation exposes only names and the defaults digest; activation confirms those identities and freshly inspects the exact measured image before admitting values into its image settlement. An already-pinned manifest follows the same admission and reload path without a configuration write; its revision stays unchanged and the activation result carries that observed revision. A failed configuration write returns no configuration result. Runtime resolution requires that confirmed evidence, and effective-map changes enter a successor AgentSession at the next Turn. The administrator API reports authored, reloaded and native-acknowledged states separately.

Gateway logical models retain their configured IDs and ordered members when Provider or account supply is unavailable; reload reports route-named warnings. Mixed-family tiers derive minimum known limits and intersected capabilities, with a shared-or-null family. Discovery exposes only tiers with available members. Optional `routing.autoFailover` defaults to true and false confines dispatch to the primary.

Logical-model resolution derives `reasoningEffortLevels` from effective models.dev option metadata and currently available members, using the canonical Core effort order. Provider and model-catalog option edits remain restart-required through the existing configuration lifecycle; supply changes recompute the intersection immediately on resolution.

Deployment-admin Provider removal uses `runtime.file-delete` through `POST /api/app/operations/runtime.file-delete` with the exact Provider file ID and existing revision. Key removal revokes its Vault reference before unlinking; partial failures require explicit inspection across both effect domains. Provider activation remains restart-required. Subscription account deletion cancels pending login, awaits settlement and completes exact revocation before removing metadata. Neither operation is blocked by configuration references or rewrites authored routes.

Turn and structured conversation submission accept optional canonical `reasoningEffort`, include explicit effort in command identity, and expose the immutable admitted value in existing Turn projections. Worker admission falls through to the composed Agent default; the conversation catalog publishes each resolver model’s optional effort controls for Composer use.

Workspace list/resources, Thread creation/read/items/dashboard and Turn read now enter through the definition-derived JSON operation bindings. Their old routes are removed. The ordinary Turn event stream remains on SSE; retained Workspace records, Thread audiences and actor-bound creation receipts continue to use their existing owners.

Artifact operations derive their HTTP bindings and admission posture from `ARTIFACT_OPERATION_DEFINITIONS`. `src/artifact-operations.ts` joins inventory, inline content, import, introduction and version-owned Review decisions to the existing domain owners; import and introduction retain HTTP 201. The retired Artifact routes, including raw content, have no alias. Run `pnpm --filter @openkit/nanocore exec vitest run src/artifact-operation-projections.test.ts src/artifact-routes.test.ts` for projection parity and retained lifecycle checks.

Automatic Assistant-to-Goal routing refuses private source input before any shared Goal write when disclosure admission is absent. Explicit Goal commands and handoffs from shared history retain their existing owner checks.

Workspace MCP bindings support raw and bearer credential presentation under [Worker MCP Tool Supply](../../docs/specs/20260704-worker_mcp_tool_supply.md#credential-injection). Bearer delivery uses the SDK inside NanoCore; Worker supply remains secret-free. The HTTP plugin importer refuses an explicit `auth` object with the deferred onboarding reason and a `query` field with the unsupported-query reason, and accepts a query string already part of the endpoint URL. Run `pnpm --filter @openkit/nanocore exec vitest run src/runtime/worker-mcp-gateway.test.ts src/worker-mcp-routes.test.ts src/catalog/resource-catalog.test.ts` for the local synthetic conformance slice.

The Workspace MCP update-binding operation carries optional credential bindings through the App API and CLI; supplied arrays replace the bindings and omission preserves them. It validates the binding against the current transport before publication and returns JSON `invalid_request` for malformed request bodies or invalid proposed bindings. Retained-record and response-schema failures keep the route's error code and status with the fixed message "The retained record could not be read." Workspace MCP bindings support raw and bearer credential presentation under [Worker MCP Tool Supply](../../docs/specs/20260704-worker_mcp_tool_supply.md#credential-injection). Bearer delivery uses the SDK inside NanoCore; Worker supply remains secret-free. The HTTP plugin importer refuses an explicit `auth` object with the deferred onboarding reason and a `query` field with the unsupported-query reason, and accepts a query string already part of the endpoint URL. Run `pnpm --filter @openkit/nanocore exec vitest run src/runtime/worker-mcp-gateway.test.ts src/worker-mcp-routes.test.ts src/catalog/resource-catalog.test.ts` for the local synthetic conformance slice.

Conversation, Task, Attention and Pending Request JSON routes derive from the shared definitions. Native invocation admits selected Workspace and opaque child lineage before the existing domain handlers; captured execution, command receipts and later-Turn delivery remain domain-owned.

Automation inventory/create/update/delete, scheduler admission list/retry/cancel and interrupted worker list/checkpoint release are definition-derived operations. The [source guide](src/README.md) names their native joins. Automation deletion projects logical `null` as a bodyless HTTP 204; recovery retry preserves exact lineage and request receipts without launching work.

Workspace JSON portability uses `workspace.export`, `workspace.import-dry-run`, and `workspace.import` through the definition-derived invocation boundary. `src/storage/workspace-transfer-operations.ts` joins the existing verified-tree export, collision preview and staged import owners; archive streaming remains in `workspace-transfer-routes.ts`. Run `pnpm exec vitest run src/storage/workspace-transfer-operation-projections.test.ts` for the binding cutover and no-write evidence.

Kernel and Generative UI use the canonical JSON operations declared in `packages/app-api-schemas/src/generative-operations.ts`; `src/generative-operations.ts` joins the remaining operations to their native commands. See [Operation Definition](../../docs/specs/20261002-operation_definition.md) for the shared projections and admission contract.

Workspace synchronization uses fifteen definition-derived `sync.*` operations through native invocation. The existing non-Git review/apply and recovery owners retain their authority, request receipts and exact replay; old synchronization routes are removed.

Workspace lifecycle operations use the definition-derived JSON, MCP, client and CLI projections. The sixteen sharing, access-recovery, user-disable, deletion and deleted-recovery joins retain existing receipts, mutation fences, typed errors and deletion phases; current administrator sessions and bearers use the same eligibility without creating memberships. Run `pnpm --filter @openkit/nanocore exec vitest run src/workspace-lifecycle-operations.test.ts src/workspace-sharing-routes.test.ts src/workspace-deletion-routes.test.ts src/remote-mcp-routes.test.ts` for the cutover and lifecycle regressions. The retained test file names identify historical regression suites, not live registrars.

Vault injection-plan storage types and Workspace archive validation derive visibility from `@openkit/app-api-schemas`. The governance-route regression lists a Workspace grant's runtime-env plan through the public HTTP endpoint and checks the complete non-secret response.

The worker Responses relay runner selects the Workspace default Agent through the administrator configuration file owner: it reads and updates the exact revision, activates through safe reload, reads back that revision and selection, and checks the resulting Task's Agent and AEP evidence. Workspace record update is not a configuration editor. Local runner stand-ins cover activation refusal and contradictory Task selection without contacting a provider or host.

Direct `task.start` and the Assistant automatic Task handoff return HTTP 202 at durable Turn admission. Their receipt is available while the worker is running; exact live replay projects that same owner without relaunch. Worker completion, evidence and cleanup continue independently of the connection. Use existing Turn and Thread reads or exact replay for completion; the real Task runner retains its request identity while observing those owners.

Core `turn.start` returns HTTP 202 at its exact durable Turn admission and publishes its Turn-pointer receipt before response delivery. Core, direct Task and Assistant Task handoff share the runtime admission observer and live scheduler predicate; execution retains database handles through terminal closeout, and Core completes the scheduler lease only there. Exact live replay returns current owner state, while terminal replay observes unfinished closeout and its existing fail-closed authority.
