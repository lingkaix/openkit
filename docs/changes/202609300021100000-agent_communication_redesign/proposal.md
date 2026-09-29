# Agent Communication Interfaces Redesign Proposal

This proposal preserves why the communication redesign was chosen, the scheme it settles on, the alternatives it rejected, the decisive assumptions, and the material Consultant objections with their resolutions. It has no design authority of its own. The accepted decisions are listed in [plan.md](plan.md), and lasting design moves into the Core and specification owners the plan names. It consolidates four exploration documents that stay uncommitted under `temp/`:

- the engineer-approved lifecycle proposal, `temp/proposals/20260929-agent-session-process-lifecycle.md`;
- the engineer-approved four-runtime proposal, `temp/proposals/20260929-four-runtime-adapters.md`;
- the primary's upward MCP proposal, `temp/agent-interfaces/mcp-upward-capability-interface.md`, at revision 5;
- the primary's downward ACP proposal, `temp/agent-interfaces/acp-downward-session-control.md`, at revision 4.

The research behind the adapter choices is in `temp/research/20260929-four-runtime-integration/`.

## 1. Why This Work Exists

OpenKit is agent-native: without agents the platform stands neither as a product nor in operation. The engineer observed that communication between NanoCore and workers, between workers, and from workers up to NanoCore was connected but fragmented. There was no unified, clean interface that an agent could use as naturally as calling an MCP tool. Four concrete defects made this visible:

1. **Per-Turn processes.** A worker's native process ended with every Turn, so a follow-up instruction restarted the runtime and depended on file-level resume.
2. **Human decisions stopped the model.** A worker reached a human only through Gates that Core created. Every Gate stopped the Turn, closed the AgentSession, and required a separately admitted successor Task before work could continue. An approved MCP call had to be re-proposed by the model in a later Turn so that it could "claim" the grant.
3. **No worker-facing Core capabilities.** No first-party tool let a worker ask the user a question, see what sibling workers were doing, or deliver data to Core. Only `openkit-generative` and `openkit-repository` existed.
4. **Different and partial runtime integrations.** Codex, Pi, and OpenCode each had a different integration. Pi disabled MCP entirely, so it was ineligible for the capability plane.

The engineer set the outcome: re-examine every communication interface and redesign it where needed, settle every design question, amend Core and the specifications, then land the implementation. At handoff, all four supported runtimes (Codex, Pi, OpenCode V2, and DeepSeek Harness) must run every designed mechanism correctly at code level, and the ground must be laid for the engineer's colleague to test and accept them in a deployed environment.

## 2. The Scheme In One Picture

```text
                         NanoCore — agent control plane, sole canonical writer
      ┌──────────────────────────────────────────────────────────────────────────┐
      │ Threads, Turns, AgentSessions, pending requests, change sets, audit      │
      │ MCP Gateway (official SDK v2, both protocol eras)                        │
      │   first-party servers: openkit-work, openkit-generative, openkit-repository
      │   proxied vendor servers: e.g. the official GitHub MCP server            │
      └───────────────┬───────────────────────────────▲──────────────────────────┘
          downward:   │ lifecycle operations          │ upward: MCP tool calls
          common      │ (NanoHost carriage)           │ (Integration /capabilities/mcp/*)
          runtime     ▼                               │
          contract ┌──────────────────── Sandbox (one warm multi-runtime image) ─┐
                   │ Integration (link) + Harness (supervision, Turn coordination)│
                   │   adapters: Codex App Server v2 | Pi SDK host |               │
                   │             OpenCode V2 server | DeepSeek Harness ACP         │
                   │ resident native runtimes, full permission inside the Sandbox │
                   │ in-Sandbox MCP servers and tools (e.g. CodeGraph), unrestricted│
                   └──────────────────────────────────────────────────────────────┘
      NanoHost: read-only snapshot-chain collection of the work volume from outside the Sandbox
```

There are three directions:
- **Downward (Core to worker)** uses the common runtime contract, carried as the existing worker-control operations and implemented by each adapter on the runtime's own first-party interface.
- **Upward (worker to Core)** uses MCP tools served by NanoCore through the existing Gateway. The runtime loads them as ordinary MCP supply.
- **Between workers**, the only edges are read-only peer reads through Core, and tree-shaped control edges that Core owns. Workers never control each other.

## 3. Downward: The Common Runtime Contract

### 3.1 AgentSession Is An Execution Binding

A Thread is the durable user conversation and holds its retained native conversation. An AgentSession is one authorized active execution binding to that conversation, on one admitted runtime host instance. Sequential Turns use the same binding. Completing a Turn does not close the AgentSession or stop the runtime. Closing an AgentSession stops its work, revokes its routes, and releases its binding while preserving the native context and work files. A later instruction after closure creates a successor AgentSession, which reopens the exact retained conversation through the runtime's native resume. Native resume failure is explicit, and an empty conversation or a transcript replay never silently replaces it.

The binding is not an operating-system process. A dedicated conversation process (the Pi SDK host) and a native thread inside a shared server (Codex App Server, OpenCode server) are both bindings. Closing a shared-host binding stops that conversation's work and detaches it; it does not kill the server or delete native data. A host restart invalidates every binding it hosted.

**Why.** Binding AgentSession to one active execution gives a clear scope for authority, fault attribution, and cleanup, without requiring an operating-system process per conversation. The Thread and its retained native conversation already carry the logical continuity. The rejected alternatives were binding AgentSession to each Turn, which keeps today's unnecessary restarts; treating every network disconnect as terminal, which creates avoidable failures; and rebuilding context from the visible transcript, which loses native state while presenting a misleading continuation.

### 3.2 The Semantic Operations

| Operation | Common guarantee | Carried as |
| --- | --- | --- |
| Start a new conversation | Bind a new AgentSession on an admitted host and establish the exact native conversation identity | `session.open` without a resume reference |
| Start by resuming | Bind a new AgentSession to the Thread's exact retained conversation, validating the native result, before any work | `session.open` with the retained resume reference |
| Submit a Turn | Use the current binding, with one active Turn and current authorization | `turn.start` |
| Cancel a Turn | Report the actual cancellation outcome; cancellation alone does not close the session | `turn.interrupt` |
| Inspect or reconnect | Distinguish a surviving execution instance from a replacement or unknown one | `session.inspect` |
| Close | Stop the bound work, revoke live authority, and preserve resumable context | `session.close` |
| Observe | Translate native events, including compaction, into candidate observations without inventing missing facts | Worker-control observations |

These already map onto the Harness's worker-control operations. The change is that the native runtime becomes resident across Turns. The `bounded-turn` adapter mode and every per-Turn native launch path are deleted rather than kept beside the resident path.

### 3.3 One Adapter Per Runtime, On Its First-Party Interface

| Runtime | Interface | Initial hosting | Main reason |
| --- | --- | --- | --- |
| Codex | App Server v2 over local stdio, with version-matched protocol types | One supervised App Server per binding until shared-host isolation is proved | Native Thread and Turn control, correlated events, and compaction, with no ACP translation layer |
| Pi | Official SDK in a dedicated host process | One host per AgentSession; a successor host resumes the exact retained session | Full host control of model, credentials, tools, and resources, while keeping Pi's Extension ecosystem |
| OpenCode V2 | Native server driven by the official `@opencode/client` | One native server per binding initially, with private configuration and persistent native data | A full typed API with no OpenKit-owned SDK IPC wrapper |
| DeepSeek Harness | Native ACP over local stdio, through the official `@agentclientprotocol/sdk` client | One supervised runtime process | Its ACP profile supplies the session cancel, close, and resume operations that its SDK wire lacks |

Runtime adapters run native engines in disposable, separately supervised processes. Plugins, Extensions, and tool execution never run inside the long-lived Integration and Harness process. A runtime that cannot keep live context between Turns, or cannot resume the exact retained conversation, does not satisfy the contract, and that is reported as an unsupported capability.

**Why these interfaces.** The inspected Codex TypeScript SDK launches `codex exec` per run. The Python SDK would add Python only for a wrapper. The maintained `codex-acp` bridge adds a process and its own translation policy. For Pi, raw RPC proves that persistent prompting is feasible, but the official `RpcClient` inherits the parent environment and does not establish descendant cleanup, while the SDK's model, auth, resource, and tool controls cover the full requirement. For OpenCode, `@opencode/sdk` embeds the server in the caller, so hosting it elsewhere would need an OpenKit IPC wrapper, whereas the native server with its network client avoids that. DeepSeek Harness's first-party control interface is ACP. The independent Consultant challenged unnecessary OpenCode SDK IPC and broad claims that all embedding is unsafe. The final choices keep embedded engines only inside isolated runtime hosts, and prefer native clients where they already cover the seam.

### 3.4 The ACP Boundary

The engineer asked whether ACP should be the only downward path or an option used in some adapters. The answer:
- The common runtime contract is the single downward standard.
- Each adapter uses the runtime's most capable maintained first-party interface.
- ACP is used only where that interface is ACP, which today means DeepSeek Harness.
- No third-party bridge (`codex-acp`, `pi-acp`, or OpenCode's ACP mode) sits beside a first-party native interface, and a non-ACP adapter uses no partial ACP, not even as an internal event model.
- A future runtime that speaks ACP natively and has no richer first-party interface is onboarded through the ACP adapter profile. Shared ACP code is extracted only when a second ACP runtime exists.

Inside the DeepSeek adapter, ACP carries `session/new`, `load`, `resume`, and `close`, prompts and cancellation, `session/update`, and `mcpServers` materialization, all over stdio local to the Sandbox. ACP is not used for these:
- native permission requests;
- client filesystem and terminal callbacks, which are not advertised;
- carriage between Core and Integration, or any network transport;
- communication between workers or upward, which is MCP.

**Why.** Upward, OpenKit is the MCP server and defines the tools, and every runtime supports that standard first-party. Downward, OpenKit is the client controlling each runtime's own lifecycle. ACP v1 leaves out, or makes optional, the hard obligations of that direction: exact identity, compaction evidence, per-Turn credential rotation and fencing, quiescence and release, and recovery admission. Forcing ACP everywhere would keep all of that adapter work while adding lossy bridges. Revisit when a later ACP version standardizes those obligations and vendors maintain first-party ACP at parity with their native interfaces. Rule 2 then selects ACP everywhere without a policy change.

### 3.5 Full Permission Inside The Sandbox

Agents run inside Sandboxes precisely so that they can have full permission there. Restrictions sit only at the Sandbox boundary: storage and network policy, and external systems reached through the MCP Gateway, where approval and audit happen without configuring or operating the worker. Every adapter disables native permission prompts.
- If a native permission request arrives anyway, the Harness selects an offered `reject_once` option. If no such option is offered, it cancels the prompt and records the request.
- It never selects an allow option, because it cannot bind an allow to an exact effect.
- Turning native prompts off grants nothing beyond what the Sandbox already enforces.
- In-Sandbox MCP servers and tools, such as CodeGraph configured for a development Sandbox, are Sandbox execution and are unrestricted. The Gateway governs only interaction with external systems.

### 3.6 Credentials Across Resident Turns

A resident runtime outlives the per-Turn inference and capability route tokens, so the native process can no longer receive the Turn token in its environment. The scheme, decided by the engineer after the direction check:
- **Two loopback credentials.** At `session.open`, NanoCore mints one session-local loopback credential for each route family (inference and capability). The Harness gives them to the runtime host as bearers for its fixed loopback endpoints. NanoCore keeps the values only in memory, so it can include them in the literal credential check (Section 7). After a NanoCore restart they are gone, the binding cannot be adopted, and a successor resumes natively.
- **Mapping to the Turn.** Integration authenticates a credential, maps it to its AgentSession and route family, and forwards the request under the route token of the Turn bound to that AgentSession when the request arrives.
- **No authority between Turns.** With no Turn bound, every request is refused, so an idle AgentSession holds no authority.
- **Turn barrier.** At the Turn's terminal barrier, Integration drains that AgentSession's in-flight requests within a bound, aborts the rest, and only then clears the Turn route tokens.
- **Close.** `session.close` destroys both credentials.

Upstream tokens still rotate every Turn, and the native process never holds them; before, the inference token itself reached the native environment. The scheme does **not** fence generations. A timer, background process, or queued retry from Turn A that fires after Turn B binds is admitted as Turn B, with B's authority and attribution. The Consultant's in-memory trace of the first draft showed exactly that, although the draft had claimed fencing.

The engineer accepted this relaxation explicitly, choosing request-arrival attribution over authority quiescence. Leftover work can obtain only the authority the same agent holds at that moment, narrowing and revocation apply at once, and proving quiescence would mean stopping legitimate long-running background processes. Codex App Server also has no per-Turn credential field that could tag requests by generation. The rejected options were:
- authority quiescence, which stops background work or replaces the AgentSession at every Turn end;
- per-request generation tokens, which are not available in every runtime;
- a single bearer for both families, which merges route authority;
- a session-wide upstream bearer, which stops rotation.

**Declared runtime-env credentials** remain session-static in a resident binding. A changed declaration or value gives a successor AgentSession at the next Turn, and a revocation interrupts and closes the binding at once.

### 3.7 Tool Surface At Turn Boundaries

Tool-surface changes happen only at Turn boundaries, because the audit must show which tools the agent could see, and because a change mid-Turn invalidates prompt caching and the plan the model has already made. The Gateway serves each request from the current Turn's AEP snapshot, so a runtime whose MCP client lists tools again at each Turn start sees the new supply on its next Turn. Each adapter declares whether its runtime does this. The boundary runs in a fixed order:
1. fence the earlier Turn;
2. admit and bind the new Turn;
3. discover tools;
4. verify the snapshot the model will see;
5. prompt.

When the runtime cannot refresh its tools, a changed supply is a setup change. It is replaced at the boundary the continuity owner names (AgentSession, Harness, or Sandbox), and the successor resumes the native conversation with the new supply. The resume itself can still fail explicitly. Narrowing and revocation always apply at the next call; a revoked tool returns `capability_denied`.

## 4. Upward: NanoCore-Served MCP

### 4.1 The Gateway

A Core capability that an agent needs is a Core operation projected as a tool on a NanoCore-served MCP server behind the existing Gateway. MCP is only the projection: Core commands keep authority, lifecycle, retention, and lineage. NanoCore-internal agents keep calling the same command implementations natively; they do not take a protocol hop through OpenKit's own endpoint.

The Gateway moves from `@modelcontextprotocol/sdk@1.30.0`, which speaks only the legacy `initialize` era up to `2025-11-25`, to the official v2 packages (`@modelcontextprotocol/server`, `client`, and `core`). v2 negotiates both eras:
- **Modern.** `2026-07-28`, through `server/discover`.
- **Legacy.** Through the `initialize` list.

The negotiation belongs to the SDK and is not an OpenKit compatibility layer, so pinned worker clients that still speak the legacy era keep working. The Gateway has two faces, and both negotiate both eras:
- toward workers, as server, where it is already stateless (request-scoped servers, JSON responses, POST only);
- toward upstream servers, as client, negotiated per upstream.

The v1 path is removed, not kept beside v2.

### 4.2 Server Families

| Server | Tools | Maps onto |
| --- | --- | --- |
| `openkit-work` (new, reserved built-in target) | `work_request_input`, `work_list_peers`, `work_read_peer` | The pending-request mechanism (Section 5) and Core Thread, Item, Artifact, and change-set reads (Section 6) |
| `openkit-generative` | Unchanged | Existing |
| `openkit-repository` | Unchanged, except that its human approval uses the pending-request mechanism | Existing host-side push of an exact applied commit |
| A vendor's own MCP server, such as the official GitHub server | Its own tools | The Workspace MCP catalog and upstream proxy, with credentials resolved from Vault, allowlists, per-tool `approval-required` marks, schema snapshots, and one CapabilityCall per call |

OpenKit builds first-party MCP servers only for its own Core operations. An external system is integrated by proxying its vendor's MCP server, and a first-party server for an external system needs a stated reason, for example that no upstream server exists. The comparison between `openkit-repository` and the GitHub server (acting identity, repository binding, and commit transport) is deferred.

A worker receives no dispatch, cancel, or respond tool. The Orchestrator's tools are never exposed to workers. What decides tree versus mesh is which destinations and authority Core admits, not the shape of a message.

## 5. Pending Tool Calls: One Mechanism For Approval And Input

### 5.1 Why The Old Mechanism Went

The old Gate-stop path paused the Turn in `awaiting_human`, interrupted the native process with `purpose="human-gate"`, closed the AgentSession after the answer, and required a new Task. An approved MCP call executed only when the model re-proposed identical arguments in that later Task and "claimed" the grant, which required the source AgentSession to be `closed`. The engineer judged this unreasonable. It existed only because the old lifecycle bound AgentSession lifetime to Turns. With AgentSession decoupled from Turns, none of those steps is needed.

### 5.2 The Mechanism

It follows the unreleased MCP draft SEP-2848 (asynchronous authorization through SEP-2663 Tasks), adapted for clients without the Tasks extension:
1. **Requestable call.** A call is requestable when the policy result for an `approval-required` tool, or for the human mode of repository push, is a requestable denial, or when the tool is `work_request_input`.
2. **Capture.** The Gateway captures the immutable call binding before returning: the tool, the full arguments, and the originating authorization context (Thread, Turn, AgentSession, AEP and schema snapshot, principal, and policy result). It stores the binding with an existing Approval Gate or user-input Gate, and records the originating CapabilityCall.
3. **Immediate return.** The call returns at once with a pending handle, and the Turn continues. There is no `awaiting_human`, no human-gate stop, and no interrupt. The agent may keep working and may end its Turn.
4. **Out-of-band resolution.** The approver or responsible user resolves the request out of band, through Action Center or the owning response command.
5. **Execution after approval.** The Gateway re-evaluates the stored binding against current authority, credentials, policy, and tool schema. It executes the call once through an atomic claim, which is mutually exclusive with invalidation and withdrawal, and records the disposition. The agent never re-issues the call to claim a grant.
6. **Delivery.** The outcome is delivered to the agent as a new Turn on the same Thread, with trigger source `approval-resolution` or `user-input`. That Turn is queued behind any active Turn.
   - Admission freezes a bounded set of undelivered outcomes into the Turn, within the existing input bounds, and records each outcome's association with that Turn. An outcome resolved after admission waits for the next Turn.
   - A proved pre-native refusal releases the set to the next Turn.
   - An unknown native submission is never resubmitted automatically. Its outcomes are marked delivery-unknown and follow the existing Turn recovery. Exactly-once holds for proved submissions, and cross-domain atomicity is not invented.
   - If the requester's AgentSession has closed, the delivery Turn opens a successor through native resume, as any Turn does.

Dispositions follow SEP-2848 and map onto existing records, not a new status family:

| Disposition | Meaning | Existing record |
| --- | --- | --- |
| `approved-executed` | Granted, re-evaluated, executed; the result is delivered | CapabilityCall `succeeded` |
| `denied-not-executed` | Denied, invalidated, or refused at re-evaluation | CapabilityCall `denied` |
| `execution-error` | Executed; the tool returned an error | CapabilityCall `failed` |
| `outcome-unknown` | The claim was taken, but completion cannot be determined | CapabilityCall `unknown`, with `upstreamEffect` recording contact knowledge |

Every outcome carries its deliberately visible disposition in the delivery Turn, so the model can tell "executed" from "not executed" without inferring it.

**Deadlines and blocking:**
- **No time deadline.** A pending request waits until it is resolved or invalidated. A configurable deadline policy may be added later.
- **Blocking is derived, not stored.** A request is blocking when the agent ended its Turn while the request was outstanding and no later Turn has run. Task and Thread projections show waiting from that fact.
- **Invalidating events:**
  - Thread closure, archive, or deletion;
  - Workspace deletion;
  - loss of the requester's membership or authority;
  - denial;
  - withdrawal by the user;
  - withdrawal by the agent, which is design only until SEP-2848 releases `tasks/cancel`.
- **AgentSession release does not invalidate a request.**
- **Staleness.** It is guarded by re-evaluation at execution, and the approval card shows the request's age, the Turns run since, and recent changes.
- **Accumulation.** It is bounded by a per-Thread count of outstanding requests, not by time.
- **Deduplication.** After current authorization, a repeated call whose qualified immutable effect binding matches a non-terminal request returns that request instead of creating a second one, as SEP-2848 recommends. The binding is server id, catalog revision, schema snapshot, tool, canonical arguments, Thread, Agent, and responsible user. A match never substitutes an old approved effect for a new one. General occurrence identity after a terminal result stays unsolved, and the limit is stated rather than hidden.
- **Response validation.** The same-Turn schema rule checked the responder. Its checks move to the pending-request owner, at command admission and at canonical load: one outstanding request, the responder's authority, and one winning response.
- **Deferred execution authority.** Execution after the originating Turn has ended cannot reuse live-Turn admission. It re-evaluates current Workspace membership and Agent authority, the Thread's current supply for that server and tool, current credentials and policy, and the current schema. It runs inside the owner of the response command. After a restart, a claimed but unfinished execution is `outcome-unknown` and is never executed again. No background runner is added.

### 5.3 Call Examples

An approval-gated external tool:

```text
tools/call  server=github  name=merge_pull_request  arguments={"owner":"acme","repo":"api","pullNumber":42}

result (isError: true — the tool did not execute; SEP-2848's degraded path for clients without Tasks):
  structuredContent:
    { "status": "pending-approval", "requestId": "apr_…",
      "next": "Approval was requested. Do not retry this call. Continue other work or end your Turn;
               the outcome will arrive as a new message in this conversation." }

errors: capability_denied (not requestable, or not in this Turn's supply), request_limit_reached (per-Thread
        bound), idempotency_key_conflict (same protocol identity, different arguments), turn_not_active
side effects: one Approval Gate with the captured binding; one CapabilityCall; nothing executed yet
later: approver grants → Gateway re-evaluates and executes once → a new Turn delivers
       "merge_pull_request: approved-executed", with the tool result
```

The user-input tool:

```text
tools/call  server=openkit-work  name=work_request_input
  arguments={ "prompt": "The migration needs one decision.",
              "questions": [ { "id": "target", "header": "Target database",
                               "question": "Which database should the migration target?",
                               "options": [ {"label":"postgres","description":"Keep the production engine"},
                                            {"label":"sqlite","description":"Match the local baseline"} ],
                               "isOther": false, "isSecret": false } ] }

result (isError: false — recording the request is this tool's function):
  structuredContent: { "status": "pending-input", "userInputRequestId": "uir_…", "recipient": "responsible-human",
                       "next": "The question is with the user. Continue other work or end your Turn;
                                the answer will arrive as a new message in this conversation." }

errors: secret_input_not_supported, request_limit_reached, turn_not_active, capability_denied,
        idempotency_key_conflict
side effects: one user-input-request Item on the originating Turn and one user-input Gate; the Turn continues
later: the user answers → a user-input-response Item in a new Turn with trigger user-input → the agent continues
```

Repository push in human mode:

```text
tools/call  server=openkit-repository  name=repository_push
  arguments={ "sourceRef": "refs/heads/openkit/review-…", "commit": "<exact applied commit>", "targetBranch": "main" }

automatic mode: policy grants at once → the Git owner's host-side push runs in this call → GitPushRecord → result
human mode (isError: true): { "status": "pending-approval", "requestId": "apr_…", "next": "…" }
later: grant → the Gateway runs the host-side push for exactly that intent, under current Vault, target,
       and review-linkage checks → a new Turn delivers approved-executed with the GitPushRecord summary,
       or execution-error, or outcome-unknown (a push attempt whose outcome is unknown is never retried)
removed: the separate repository_push_execute tool
```

The question schema is the existing `UserInputQuestionSchema`. A response Item now references its request anywhere in the same Thread, instead of only in the same Turn. That is an additive relaxation, so every retained record remains valid.

### 5.4 Alternatives Rejected

- **Keep the Gate-stop path.** Rejected by the engineer, for the reasons in Section 5.1.
- **Hold the native call open while waiting.** It binds nothing ACP or MCP can express, ties up the Turn lease for human latency, and still needs a policy for other native activity.
- **Native MCP Tasks now.** Deferred until a pinned client drives the Tasks extension. The mechanism above keeps the same server-side semantics, so the switch changes only the wire.
- **Replay through the model.** It depends on the model reproducing arguments and cannot guarantee at-most-once execution.
- **A time deadline.** A blocked request should not expire just because a human is slow.

## 6. Between Workers: Read-Only Peer Reads

`work_list_peers` lists the other AgentSessions currently resident in the caller's Sandbox. `work_read_peer` reads one peer's canonical Core records:

```text
tools/call  server=openkit-work  name=work_list_peers  arguments={}
result: { "peers": [ { "peer": "peer_…", "threadTitle": "Fix flaky login test", "runtime": "codex",
                       "state": "running", "lastTurn": { "status": "completed", "endedAt": "…" } } ] }

tools/call  server=openkit-work  name=work_read_peer
  arguments={ "peer": "peer_…", "view": "summary" | "recent_items" | "artifacts" | "changes", "cursor": null }
result: the selected view of Core's canonical Thread records, paged by cursor
errors: peer_not_found (no longer resident, or never a co-resident), capability_denied, turn_not_active
side effects: one CapabilityCall; no effect on the peer
```

**Why it is safe.** Same-Sandbox AgentSessions already share one compromise domain with compatible trust: they belong to one Workspace and one responsible-user trust class under the shared-Sandbox admission envelope. Read-only information creates no control edge. The `peer` handle is opaque and never exposes AgentSession identity.

The same-Sandbox relatedness boundary is an interim simplification. It is removed when relatedness must cross Sandboxes or depend on permissions, and a disclosure design must precede that. Asking a peer to act is deferred, because a tool that makes Core start a Turn elsewhere initiates work and needs busy-Thread, duplicate-wake, responder, and failure semantics.

## 7. Workspace Collection: The Snapshot Chain

Collection must never affect the running worker, and must never duplicate or omit data between the states it captures. Each collection is a snapshot link:
- **The link.** It records `base`, the previous `head`, and a new `head`, taken by NanoHost scanning the work volume read-only from outside the Sandbox into a private host-side Git store. Successive change sets telescope, so no captured change is counted twice or skipped.
- **The guarantee.** It holds for captured states. A state that exists only between two scans is not observed, and a torn multi-file state is possible while writers run.
- **Stability.** Each collection scans twice. When the scans differ, it retries a bounded number of times, and if writers persist it records the last scan with `unstable` set. The next link starts from that head.
- **Contiguity.** NanoCore rejects a change set whose `base` differs from the previous `head` as `recovery_required`.
- **Collection points:**
  - Turn end, where the next Turn is dispatched only after collection completes;
  - AgentSession release;
  - before a successor starts on the same work volume, which catches writes after release;
  - mid-way checkpoints, which exist in design but are enabled only when a consumer exists.
- **Review stays Core's.** A review candidate is computed from Core's accepted base, the last applied or origin state, to the current head, not from one per-Turn link. A rejected candidate does not advance the accepted base.
- **Git on the host, narrowly.** NanoHost runs a pinned Git only against its own private `GIT_DIR`, with the retained volume as the work tree. No worker-controlled configuration, hooks, attributes, filters, or drivers apply. Blobs are hashed byte-exact without filters, and untracked ignored paths are excluded, as today. This amends the data-boundary rule that NanoHost never executes Git.
- **Credential check.** The literal credential-value check runs in the scan over exact staged blob bytes. NanoCore supplies the values in memory with each collection command: the Vault-resolved runtime-env values and the binding's loopback credentials. On a hit, that scan's private objects are deleted, the head does not advance, and the collection fails with a typed rejection. The Harness keeps its assistant-text and diagnostic checks.

**Why not the old path.** The old path captured inside the Sandbox after native exit, and gated export on process-group absence. A resident runtime never exits between Turns, and in-Sandbox capture wrote into the worker's own object store. Freezing the Sandbox was rejected because it pauses legitimate background processes.

## 8. Consequences For Task Mode, Human Attention, And Goal

- **Task Mode.** A Task becomes its Thread and all its Turns. The single-worker-Turn rule and `remainingWorkerIterations=0` are removed. Task state is projected as running (a Turn is active or queued), waiting (a blocking request is pending), or completed, over the Turns and pending requests.
- **Human attention.** Approval and user-input requests remain Action Center items, but they no longer imply a paused Turn. Their card shows the request's age, the Turns run since it was made, and recent changes.
- **The internal Assistant.** Its MCP approval exit, not yet implemented, follows the same execute-after-approval rule.
- **Open legacy Gates.** Worker Gates still open at upgrade are closed honestly as not executed, with an upgrade reason, and their history stays readable. Old Approvals store only an argument digest, so they cannot move to the new binding.
- **Goal Mode.** Its issues are deferred to a later complete Goal redesign. Where the removed mechanisms would leave Goal paths incoherent, Goal entry returns an explicit unavailable result, and old Goal data stays readable.

## 9. One Multi-Runtime Sandbox Image

All four runtimes and the worker-shim with its four adapters are packaged into one container image, used in two roles:
- the Sandbox configuration for the initial version's test and acceptance phase;
- the first, deliberately simple warm Sandbox after launch.

It uses the accepted shared-Sandbox model: one static compatibility envelope with a declared Harness set, where the AEP selects the runtime per AgentSession. The image owner already allows a declared runtime set of many, and requires catalog, CI, preflight, and OCI-label consumers to migrate with the first multi-runtime artifact. The engineer chose it as the sole deployment image. `worker-common` stays the public base, the three single-runtime images are removed, and stored agent manifests are rewritten to it by a one-way migration.

Pi customization is an obligation, not a packaging claim. The Pi host loads users' packages, file-based Extensions (including their session-start hooks), Skills, and prompt templates through Pi's normal settings and resource loaders, with an explicit agent directory. It delivers browser and tool environment variables to the non-interactive runtime. It maps headless-incompatible UI features to an explicit unsupported result. `pi-mcp-adapter` serves OpenKit-managed MCP through its host-managed entry and user sandbox-local MCP through its own configuration file, so no server has two clients. The `mcp.json` file that `pi-optimized-agent` writes conflicts with the adapter's `mcp-adapter.json`, and the pinned combination must choose one. An installed package is not a supported feature until its behavior is proved.

## 10. What Is Removed

These are removed without compatibility layers, per NONNEG-001:
- the `bounded-turn` adapter mode and every per-Turn native launch;
- `codex exec`-based execution;
- Pi JSON-mode per-Turn processes;
- the OpenCode V1 `run` integration;
- the `human-gate` interrupt purpose and the `blocked/ask_user` mapping for worker Turns;
- the Turn-level `humanGate` pause for worker Turns;
- the claim-on-later-Turn grant rule and its `closed` source-AgentSession requirement;
- the Task single-Turn rule;
- in-Sandbox workspace capture at native exit;
- the v1 MCP SDK path;
- the single-runtime worker images.

Retained data stays usable:
- old Turns, Gates, Approvals, CapabilityCalls, and change sets remain readable;
- open legacy Gates close through the one-way upgrade above;
- retained native conversations remain resumable where their runtime and version allow;
- old records without an exact resume identity report that limitation instead of guessing a session.

## 11. Decisive Assumptions And Defeating Observations

| Assumption | Cheapest observation that would defeat it |
| --- | --- |
| Codex App Server v2 keeps one native thread across Turns, resumes it on a new server instance, and releases it without affecting siblings | Two Turns on one thread, a new server resuming the thread, and an unsubscribe with a sibling thread running, against a synthetic Responses provider |
| The Pi SDK host keeps one native session across prompts and resumes the exact session file in a new host | Two prompts in one host, then a new host resuming, with the prior context visible in the captured provider input |
| OpenCode V2 server mode loads the required plugin and configuration explicitly, and aborts without deleting the session | A server started with explicit configuration, a session aborted mid-tool, and the session still present |
| DeepSeek Harness ACP resumes an exact session and closes it with drained output | `session/resume` by exact id after a process restart, then `session/close`, with no further `session/update` |
| Each runtime's MCP client re-lists tools at Turn start, or the adapter correctly declares that it does not | Change the supply between two Turns and list tools on the second |
| The session loopback credential refuses between Turns and never reaches another AgentSession | A request with no Turn bound; a request with a sibling's credential; a request in flight across the Turn barrier |
| The NanoHost read-only scan sees a stable tree at Turn end without pausing the Sandbox | A background writer during collection, which should give `unstable` and then a contiguous next link |
| Models use `work_request_input` instead of asking in final text | A real-model Task that needs one answer, counting prose questions (a live check, handed off) |

## 12. Review History And Material Objections

A fresh Pi Consultant session on `openai-codex/gpt-6-astra` (high thinking, read-only tools) reviewed the upward and downward proposals for three rounds each, on 2026-09-29. The upward review ended at Continue, and the downward review had one bounded point that revision 4 fixed. The material objections and how they were resolved:

1. **Request identity was asserted, not feasible.** Resolved by using the Gateway's existing request identity plus the receipt, and now by SEP-2848 deduplication over the captured binding.
2. **Holding a native permission request open changes the authorization lifecycle.** Resolved: native permission requests are outside the supported profile (full permission inside the Sandbox), and approval-bearing effects use Gateway operations.
3. **`session/load` does not restore a pending RPC.** Resolved: there are three process-loss cases, and no transparent recovery of in-flight work.
4. **The shared compromise domain does not justify carrying authority across Turns.** The upward and downward reviews separated rotation from generation fencing. At the direction check the Consultant showed that the first loopback design did not fence generations, although it had claimed to. The engineer then explicitly accepted request-arrival attribution (Section 3.6), so this objection was resolved by an engineer decision, not by a proof.
5. **Cross-Thread reads lacked disclosure semantics.** Resolved: general cross-Thread reads are deferred, and peer reads are limited to the same-Sandbox trust class, with a stated removal condition.
6. **The Gate-wait trace conflated active-Turn lease with open-session capacity.** Resolved by the redesign rather than by patching: pending requests no longer pause a Turn, so no lease is held for human latency.
7. **Excluding native approvals is a capability restriction, not an equivalent.** Accepted as a restriction by the engineer. A native effect that needs approval but has no Gateway operation stays unsupported.

**The direction check (2026-09-30).** A fresh Pi Consultant session on gpt-6-astra challenged the consolidated direction and the primary's derivations, and returned Ask Human:
- **Two engineer decisions.** Request-arrival attribution and the sole combined image; the engineer chose both recommendations.
- **Five corrections, made in this revision:**
  - the literal credential check stays at a boundary that knows the values and exact bytes;
  - delivery states its unknown branch honestly;
  - the snapshot chain states its guarantee as contiguity of captured states, and keeps review Core's;
  - repository push and the internal Assistant got their owners and a push call example;
  - the four-runtime configuration and conformance obligations were restored.

The engineer's later rulings superseded the upward proposal's Gate-stop design for `work_request_input` and the downward proposal's resident Gate-continuation trace (its W1 and W2 wait policies). Both came from the old lifecycle and are not carried forward.

## 13. Evidence Pins

| Subject | Examined source identity |
| --- | --- |
| Codex | 0.159.0, `687a119f0fcaace47e1f1abcc77cec6c813fd6da` |
| Pi | Existing 0.85.1; published 0.87.1 `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` |
| OpenCode V2 | 2.0.19, `1fd016ef32286de9489b7b24f1029f52c49a27b3` |
| DeepSeek Harness | `639ed015397290b3745d163aafe02ffee4aa3f84`; ACP source package 0.2.0-rc.2 |
| Pi MCP adapter | `nicobailon/pi-mcp-adapter` `b33382ac057d033b0368c4dfdf10dbb3c634d7dc`, package 3.2.0 |
| Optimized Pi configuration | `lingkaix/pi-optimized-agent` `7aa487cb9f64d87066dedc19a1f769020568cd88` |
| MCP SDK | v1 `@modelcontextprotocol/sdk@1.30.0` in use; v2 `@modelcontextprotocol/server`, `client`, `core` 2.2.0 |
| SEP-2848 | modelcontextprotocol PR 2848, head `e7fff475`, draft |

Research pins are not deployment version decisions. Implementation pins each runtime release, and checks published package bytes and SDK exports against the selected image.
