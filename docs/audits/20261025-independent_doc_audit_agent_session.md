---
date: "2026-10-25"
---
# Independent Documentation Audit: Agent-Session Group

This non-authorizing record holds the agent-session group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `b648f860e3eeab8bf1a7a419f16b674882ed7a55` (`main` on 2026-10-24 and 2026-10-25). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/agent-session.md`.
- Specifications: `20260704-agent_session_continuity.md` (CON), `20260704-session_static_workspace_materialization.md` (SSM), `20260716-codex_worker_adapter.md` (CDX), `20260716-opencode_worker_adapter.md` (OPC), `20260716-pi_worker_adapter.md` (PI), and `20260930-deepseek_worker_adapter.md` (DSK).
- G3 inspection: four read-only inspector contexts (AG-SSM; AG-CON for CON and DSK; AG-CDX for CDX and OPC; AG-PI). They read code only and ran no tests. The auditor verified each kept finding against the code.
- Hand-off received: the mediation group handed the `contextManagement` projection drift in `20260902-agent_runtime_context_compaction.md` to this group. That specification belongs to the work-model group, which issue #440 holds, so it is not edited here. The item stays open for the work-model group.

## G2 Core Against Specifications

- AG-G2-01: CON says "A new process is a successor AgentSession or a replacement host after the previous host is invalid"; Core AgentSession says a new runtime host instance is a new binding and therefore a successor. A replacement host serves successor bindings, so the two agree; no action.
- AG-G2-02: Core says an authorized actor continues after a resume failure in a new Thread with the old Thread as parent, and Fault Tolerance owns that policy; CON says "the user continues in a new Thread" and that the current projection has no linked-Thread action. Compatible; no action.
- AG-G2-03: Core Exact Reconnect, Replacement, Termination, and Retry And Recovery match the CON outcomes (exact reconnect, later-Turn reuse, internal successor) and the four adapter session operations. No conflict.
- AG-G2-04: SSM Default Directory Skeleton prefers `/workspace/threads/<thread-id>` and a disposable per-session `transcript/` directory; the later accepted [NanoHost Workspace Data Boundary](../specs/20260801-nanohost_workspace_data_boundary.md) places `main-worktree` at `/workspace/worktrees/<workSlotRef>` as the working directory, and the later accepted [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md) retains `/openkit/threads` for capture. SSM already permits backend-specific paths, so SSM now names those later owners for the OpenShell realization (see G3).

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| AG-CON-01 | CON projection: "No resident adapter is registered yet" | `packages/worker-shim/src/adapter-registry.ts:230-235` registers `codex`, `deepseek`, `opencode`, and `pi`; `containers/worker-runtimes/smoke.sh:49` checks the same keys | Projection drift | Corrected |
| AG-DSK-01 | DSK: image and manifest integration "remain outside this slice"; "Until that probe, image install stays blocked" | `containers/worker-runtimes/versions.json:30-37`, `containers/workers/Dockerfile:276-279`, `containers/images.json:47`, `smoke.sh:20,58-59,130`; IMG line 220 names the built-in DeepSeek template | Projection drift; the conditional is now met | Corrected in Upstream Contract, Manifest And Image Contract, and Implementation Evidence And Limit |
| AG-DSK-02, AG-CDX-01 | DSK, CDX, OPC: `turn.steer` returns the shared unsupported refusal; "The seven operations are owned by" Worker Control Protocol | `packages/worker-protocol/src/harness-control.ts:70-77` has six operations; Worker Control Protocol line 72 says the accepted seventh operation `turn.steer` is not implemented | The owner already states the gap; the adapter specifications agree with the owner | No action |
| AG-CDX-03 | OPC and CDX projections cite build reports under `temp/` and a "worktree report" | `temp/comm-redesign/reports/` does not exist; OM-011 keeps `temp/` uncommitted | Projection drift (a pointer to evidence a reader cannot open) | Pointers removed; the "builder execution is not independent acceptance" limit and the open qualification list are kept |
| AG-SSM-07 | SSM projection: only external provider and object-store adapters, superset reuse, and native mounts are unimplemented; workspace synchronization "stages filesystem changes" | The production path is NanoHost only; the planner returns no collection plan; `stageWorkspaceChangeSet` has no production caller (issue #495) | Projection drift | Corrected |
| AG-SSM-01, 02 | SSM skeleton: Thread-addressed worktree and working directory; disposable per-session transcript | `packages/config-schema/src/session-workspace.ts:372-396`; `apps/nanocore/src/runtime/worker-governance-backend.ts:928`; `turn-executor-factory.ts:3180` | SSM permits backend-specific paths; the later NWB and VOL decide the OpenShell realization | A sentence names those owners; the skeleton rewrite is Question Q-133 |
| AG-SSM-03, 04 | SSM: automatically cleared slots MUST be outside retained volumes, and such a layout is rejected; a Turn input MUST bind to a compatible slot | `session-workspace.ts:394-445` declares `turn-inputs`, `artifact-input`, and `scratch` with Turn retention under `/workspace`; `superRefine` (`:80-139`) has no retention rule; `selectSlotForInput` (`:541-573`) and `selectModeForInput` (`:614-627`) ignore `allowedSourceKinds`, slot access, and `allowedMaterializationModes` | Code differs from the accepted specification (latent) | Issue #496 (ordinary) |
| AG-SSM-06 | SSM: on credential revocation the NanoHost MUST terminate the affected Sandbox | `apps/nanocore/src/vault/vault-grants.ts:316-321,459-469` cascades only to grant, plan, and receipt rows | Same defect as issue #476 | Linked to #476; no new issue |
| AG-OPC-01, 02, 03 | OPC: inspect native automatic recovery before startup admission; default plugin installation disabled; `OPENCODE_AUTH_CONTENT={}` not replaced by a stored credential | `packages/worker-shim/src/adapters/opencode.ts:63-66,305-307`; no recovery, default-plugin, or auth-content control or test | Code differs from the accepted specification, unless a probe shows the pin needs no control | Issue #497 (blocking candidate, recovery and authorization) |
| AG-PI-01 | PI: host producer and reader admit the same reasons and reject unknown reasons | `packages/worker-shim/src/adapters/pi-channel.ts:23` closed list; `packages/pi-runtime-host/src/outcome.ts:12` plain `string`; `host.ts:412-414` forwards free strings | Code differs from the accepted specification | Issue #498 (low) |
| AG-PI-02 | PI: a correlated inference error returns `pi-inference-failed` and needs no assistant text | `outcome.ts:120-141` checks route, size, and structure before the `error` branch | Match: PI lines 193-194 say an error must not disguise a route mismatch or malformed evidence, and malformed or over-limit output fails collection closed | No action |
| AG-PI-03 | CDX, OPC, PI: "The authored manifest is the sole launch-time capability declaration" | The manifest carries its requirements in `requiredFeatures` (`packages/config-schema/src/agent.ts:284`, validated at `:293-301`, consumed at `setup-resolver.ts:352-357`) and its `mcp`, `skills`, and `profiles` declarations; Core Agent Supply and `20260703-agent_manifest_aep_resolution.md` line 607 make launch capability the intersection of those requirements with adapter and image proof | Match | No action |
| AG-PI-04 | PI: managed servers use exactly the admitted server ids | `packages/worker-shim/src/adapters/pi.ts:50` admits `.` and the Pi host admits only `[A-Za-z0-9_-]`, but the catalog grammar `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` (`mcp-catalog.ts:10,19`) is stricter than both, so the mismatch cannot be reached from admitted ids | No defect; the catalog grammar is code-owned and no specification states it | No action |
| AG-SSM-05, G2 items | SSM: `/workspace/shared-working` in the default skeleton; a `fuse-mount` mode in the layout example while FUSE is deferred; "marked stale" against "widens the fence" on a clearing failure | No `shared-working` slot; the schema enum has no `fuse-mount` | Internal inconsistencies | Question Q-133 |
| AG-PI-G2b | PI Upstream Evidence cites the removed `0.85.1` JSON-mode pin | PI lines 275-277 and 313-327 are labeled historical and non-contract | Historical section | No action; part of Question Q-135 |
| AG-PI-G2 | PI and IMG: whether `/usr/local/lib/openkit/allow-anthropic-api-key` remains "is not settled" | `smoke.sh:28` asserts it is absent; `containers/workers/openkit-worker-shim:51` still reads it | Open in both accepted documents | Question Q-134 |
| AG-CDX-02 | CDX: image smoke does not verify `codex exec` flags | `Dockerfile:254` runs `codex exec --help` during the build; `smoke.sh:19` checks only `--version` | The rule is about smoke, which matches | No action |
| AG-CON-02, AG-OPC-04 | CON tie rule along the predecessor walk; OPC direct-route refusal | `worker-governance-turn-executor.ts:247-320`; `opencode.ts:1556-1568` | Match (OPC is looser than CDX but refuses every expressible direct route) | No action |
| AG matches | CON resume pair, walk, retained-storage fact, cleanup proof, `session.open`, statuses, deleted snapshot table; SSM source admission, Git boundary, fetch refusal, ordering, Context Package binding, compatibility key, slot kinds, hygiene; CDX pins, launch, MCP, Turn path, stop mapping, permissions, limits, manifest; OPC server, sessions, Turn path, native configuration; PI pins, session operations, reasoning effort, output mapping, Extensions and MCP, headless UI, native home; DSK session operations, supply, permissions, bounds, stop mapping, effort, spawn, pins | The inspectors' tallies in the audit working space | Match | None |

`implementation: Partial` is consistent with each specification's own open qualification list. The SSM frontmatter `updated` date is older than its last content change; the audit does not change frontmatter dates.

## G4 Organization

No move, merge, or split is applied.

## G5 Writing

- Amendment and history wording: CON "This amends disposable-only successor/file fallback rules", "This change adds no idle timer", and "outside this selection change"; SSM "Persistent Working Volumes Amendment" heading, "this documentation change performs no host action", and "Previously open questions are resolved"; CDX, OPC, and PI "Generic Volume Retention Amendment" headings and "The engineer accepted this amendment"; round-by-round narratives in CDX, OPC, and PI; DSK "This replaces the earlier refusal". Question Q-135.
- Repetition: CON repeats "A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively" in seven places. Question Q-135.
- Experience-chosen numbers not marked as a current default: the 16 MiB result and 16 KiB diagnostic bounds in CDX, OPC, PI, and DSK; CDX "sixteen-record bound" and "one-second filesystem deadline"; OPC "eight-second completion timeout". Question Q-135.
- Version pins, sizes, and file layout in normative text: DSK and OPC package byte sizes and `node_modules` paths; PI `pnpm-workspace.yaml` and patch file names. Question Q-135.
- Undefined labels: CON L1, L2, L3, A1; SSM S39, WIS, WMR; CDX S33; PI N4b, M3, M4, "option B", #10239, #10215; DSK N4c. The historical PI `0.85.1` evidence is part of the same history item. As Q-28: Question Q-135.

## Semantic Preservation

The inventory tool compared each changed file with the group base.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260704-agent_session_continuity.md` (CON) | 60 unchanged | 0 | 43 unchanged, 1 added | 19 unchanged | 15 unchanged |
| `20260704-session_static_workspace_materialization.md` (SSM) | 118 unchanged | 1 unchanged | 206 unchanged, 3 added | 48 unchanged | 25 unchanged, 2 added |
| `20260716-codex_worker_adapter.md` (CDX) | 62 unchanged | 7 unchanged | 158 unchanged | 26 unchanged | 43 unchanged |
| `20260716-opencode_worker_adapter.md` (OPC) | 44 unchanged | 7 unchanged | 109 unchanged, 2 removed (the `temp/` report paths) | 25 unchanged | 33 unchanged |
| `20260930-deepseek_worker_adapter.md` (DSK) | 47 unchanged | 14 unchanged | 210 unchanged, 1 removed (`containers/` in the out-of-slice sentence), 6 added | 24 unchanged | 32 unchanged |

Other changed sentences: the CON registry sentence; the SSM later-owner sentence and projection; the CDX and OPC evidence pointers; the DSK Upstream Contract, smoke, and image sentences. The DSK sentence "Until that probe, image install stays blocked" is removed because its condition is met: the image installs the probed pin and smoke proves it. No other design rule changed.

## Issues Opened

- #496 `[workspace] Default session layout puts Turn-cleared slots under retained /workspace, and inputs bind to slots without a compatibility check`, ordinary.
- #497 `[opencode] Adapter does not inspect native automatic recovery or prove its isolation outcomes before startup admission`, blocking candidate (recovery and authorization).
- #498 `[pi] Pi runtime host emits free-form failure reasons instead of the closed vocabulary the reader admits`, low.

## Questions For The Engineer

### Q-130. Withdrawn after review

- Decided by PI lines 193-194; AG-PI-02 is a match.

### Q-131. Withdrawn after review

- Decided by Core Agent Supply and Agent Manifest And AEP Resolution; AG-PI-03 is a match.

### Q-132. Withdrawn after review

- The catalog grammar makes the mismatch unreachable; AG-PI-04 needs no action.

### Q-133. Should the SSM skeleton and layout example follow the current realization?

- Context: the SSM skeleton shows Thread-addressed worktrees, `/workspace/shared-working`, and a disposable per-session `transcript/`; the layout example lists `fuse-mount` while SSM defers FUSE; SSM says a clearing failure marks the AgentSession stale and elsewhere that cleanup uncertainty widens the fence. NWB and VOL decide the OpenShell paths.
- Options: (A) Rewrite the skeleton to the NWB and VOL layout, mark `shared-working` optional, drop `fuse-mount` from the example, and state that a clearing failure both marks the AgentSession stale and widens the fence. (B) Keep the text with the later-owner sentence.
- Recommendation: A.
- Meanwhile: the later-owner sentence is added.

### Q-134. Does the `allow-anthropic-api-key` carrier remain?

- Context: PI and IMG leave the carrier unsettled; the image smoke asserts the file is absent, while the Harness launcher still reads it.
- Options: (A) Settle that the carrier is absent, and remove the launcher branch. (B) Keep it under `credentials.declarations`.
- Recommendation: A, because the image never creates it.
- Meanwhile: no change.

### Q-135. How should the agent-session history, repetition, numbers, and labels be fixed?

- Context: the G5 items above.
- Options: (A) As Q-28: remove amendment and history wording or move it to change records, state the repeated CON sentence once, mark experience-chosen numbers as current defaults, move sizes and file paths to projections, and replace each label with its meaning or a link. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code and issues #496 to #498 and #476 itself. Verdict: accept with fixes. Dispositions:

1. Q-130 was not open: PI lines 193-194 say an error must not disguise malformed evidence and that malformed or over-limit output fails closed, and the code follows that order. Accepted; AG-PI-02 is a match and Q-130 is withdrawn.
2. Q-131 was not open: Core Agent Supply and Agent Manifest And AEP Resolution line 607 make launch capability the intersection of the manifest requirements (`requiredFeatures` and the supply declarations) with adapter and image proof. Accepted; AG-PI-03 is a match and Q-131 is withdrawn.
3. The Pi id-grammar mismatch is unreachable, because the catalog grammar is stricter than both checks. Accepted; AG-PI-04 needs no action and Q-132 is withdrawn.
4. The new OPC sentence about uncommitted reports added history wording. Accepted; the sentence is removed and only the pointers are dropped.
5. Only DSK received a note that the steer refusal has no implementation, although CDX and OPC make the same claim and Worker Control Protocol already states the gap. Accepted; the DSK note is removed and the row is no action.
6. The historical PI `0.85.1` evidence had no disposition. Accepted; it is a no-action row inside Q-135.
7. Line references: `superRefine` starts at line 80, and the DeepSeek smoke evidence includes `smoke.sh:20`. Accepted in this record.
8. The #497 title named only recovery although the issue also covers the isolation outcomes. Accepted; the title names both. The severity hint was judged proportionate.

The Reviewer confirmed the other edits, the DSK removal of the met "Until that probe" condition, that the SSM later-owner sentence adds no intent beyond NWB and VOL, that AG-SSM-06 is the #476 defect, and the severities of #496 and #498. It found no content-safety, frontmatter, or line-break problem, and no edit to the held compaction specification.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (673 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
