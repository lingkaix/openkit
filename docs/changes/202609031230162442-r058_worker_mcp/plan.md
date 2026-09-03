---
status: Active
---
# R058 Worker MCP

## Intent Epoch 1

- **Source:** Engineer instruction in the current task, `/home/ubuntu/handoff-a2-testenv-20260903.md`, and `docs/roadmap.md` R058.
- **Requested outcome:** Deliver the accepted R058 worker MCP plane so a governed Codex Worker can discover and invoke Workspace-enabled stdio and Streamable HTTP MCP tools through the existing Gateway path.
- **Non-negotiables:** Preserve accepted lifecycle, schema, credential, policy, approval, Item, usage, audit, bounded-failure, and teardown semantics; keep R005 parked and independently mergeable; use no compatibility path; make the smallest coherent change; do not restart, replace, or lifecycle-manage the A1 Codex App Server or any A1 service; do not access or change A2.
- **Acceptance observations:** A packaged Codex Worker discovers and calls a credential-free stdio tool through the single Sandbox Integration path; an HTTP tool receives a gateway-only Vault credential without leaking credential or upstream topology; an approval-required call ends before upstream contact and only a fresh call in a new Turn can execute after approval; every product-visible call has coherent Item, schema snapshot, CapabilityCall, usage when upstream was contacted, audit, and typed bounded outcome evidence; teardown leaves no owned child process or live credential material.
- **Exclusions:** Marketplace, registry discovery, OAuth browser flow, HTTP+SSE compatibility, arbitrary API proxying, server sandboxing, Web catalog editing, OpenCode and Pi delivery, multi-worker concurrency, HA, durable process registry, streaming results, automatic schema repin, generic connector or capability frameworks, and A1/A2 lifecycle effects.
- **Effect boundary:** Repository edits, package installation, temporary local child processes, and isolated local test data are allowed; tests may terminate only their own children; the completed pin probe used the engineer-authorized Codex subscription in an isolated temporary `CODEX_HOME`, while deciding feature checks will use deterministic local inference and MCP stubs; commit, push, PR, merge, publication, deployment, and real-environment effects remain separate later decisions under repository governance.

## Owning Documents

- `docs/core/agent-capability.md` owns capability terminal semantics, Item projection, Gateway mediation, and credential boundary.
- `docs/core/vault.md` owns injection plans, uses, receipts, uncertainty, revocation, and teardown.
- `docs/specs/20260704-worker_mcp_tool_supply.md` owns the R058 MCP catalog, transports, tools, schema snapshots, policy, approval, usage, failures, and acceptance.
- `docs/specs/20260703-worker_agent_capability.md` owns the worker-local capability route and independent credential boundary.
- `docs/specs/20260704-capability_usage_gateway_foundation.md` owns shared CapabilityCall, UsageRecord, idempotency, terminal, and recovery behavior.
- `docs/specs/20260531-human_attention_intervention_model.md` owns approval gates and forbids implicit current-call or AgentSession resumption.
- `docs/specs/20260629-worker_runtime_communication_model.md` owns the shared Worker Shim contract and single Sandbox Integration path.
- `docs/specs/20260716-codex_worker_adapter.md` owns the pinned Codex adapter and inline native configuration projection.
- `docs/specs/20260802-nanohost_runtime_and_transport.md` owns NanoHost carriage, stream, and byte bounds.
- `docs/specs/20260529-test_strategy.md` and `docs/verification-instruments.md` own test level and deciding-evidence quality.

## Accepted Direction

- The independent Consultant accepted ignored proposal SHA-256 `b2bc88232b392501f660b65656d9d72a47d1a0bc80bcb574ddcb4e42d7c18504` after two correction rounds.
- R058 starts from `origin/main`; the parked R005 ref remains untouched, while R058 ports and independently accepts only the minimum shared CapabilityCall terminal vocabulary, atomic terminal AuditEvent, and restart-`unknown` seam required by accepted Core semantics.
- The Workspace MCP catalog mirrors the existing deployment-admin runtime-config pattern and is the sole owner of stdio commands, HTTP endpoints, finite transport-specific credential bindings, tool rules, approval marks, timeouts, and schema policy.
- AEP freezes only worker-safe catalog digest, server id, tool rules, approval marks, schema policy, and an optional existing pinned snapshot id; it never projects command, endpoint, credential reference, or live schema guesses.
- NanoCore and Worker Shim use the official TypeScript MCP SDK directly; the process-local NanoCore supervisor has no durable registry; Codex receives only a fixed loopback MCP URL through inline `-c` arguments.
- The third Turn token has its own raw-token injection, durable hash and active-lease lineage binding, monotonic request sequence, restart verification, terminal cleanup, and cross-family rejection.
- MCP policy reuses `tool.use` with server and tool resource context; approval ends the current call as typed denied before upstream contact and creates evidence that a later new-Turn call must reauthorize.
- A deterministic Item id binds each product-visible call; CapabilityCall and Audit terminalize before terminal Item publication, and startup reconciliation fills only a missing Item from the durable terminal winner.
- Upstream contact creates exactly one `tool_calls=1` UsageRecord even when the later outcome fails, interrupts, or becomes unknown; pre-effect invalid or denied calls create no usage.
- Vault handling follows Plan, audited Use, and proved-sink Receipt order; only a possibly transmitted tool request with unprovable outcome becomes `unknown`; exact resolved credential bytes cause whole-result rejection if echoed.
- Schema snapshots reuse the existing table with canonical tool and object-key ordering, deterministic digests, a fixed tracking retention bound, explicit current selection, pinned comparison, and snapshot id attribution on CapabilityCall.

## Current Evidence

- Git branch `codex/r058-worker-mcp` was created from `origin/main@9a87cee9028fbe4dd985c24b384ca4b81ddd25d0`; parked R005 remains at `origin/codex/phase1-host-recovery-campaign@b0871db3df2518283d57d1fda5335968ecddad2f`.
- The pre-branch fresh-context Verifier returned `Continue`; the Consultant then returned `DISAGREE`, direct artifact inspection confirmed its owner conflicts, and the corrected proposal received Consultant `AGREE` at the exact hash above.
- The post-Reframe Verifier accepted the separate-main branch and narrow R005 seam, and required branch creation, bounded pin probe, this plan, then production changes in that order.
- The bounded probe installed stock Codex CLI `0.144.1` under ignored `temp/r058-pin-probe`, ran it with `--ignore-user-config --strict-config`, and projected `mcp_servers.probe.url` through inline `-c`.
- The probe completed Streamable HTTP initialize, tool discovery, and exactly one `echo({text:"pin-ok"})` call, returned `echo:pin-ok`, and left the call observation at `temp/r058-pin-probe/run1/calls.jsonl`; its owned MCP child was terminated by exact PID after completion.
- Current `origin/main` still has the documented CapabilityCall terminal/recovery divergence; the candidate seam exists in R005 commit `582ac99` but that commit also contains unrelated Phase 1 paths and will not be cherry-picked wholesale.
- The first independent review blocked unsound message-based timeout inference and provider-originated `AbortError` cancellation inference; the corrected classifier now requires typed timeout evidence or the current caller signal's exact reason, with attributed regressions for both negative cases and genuine caller cancellation.
- The post-compaction Verifier confirmed that correction and then found the committed App API OpenAPI projection stale; the candidate now preserves the canonical lifecycle metadata through the capability usage read model, tests its representable constraint with AJV, and regenerates the tracked artifact.
- The second independent review accepted both corrections but found three stale owning regressions; Worker inference now asserts CapabilityCall `aborted` while retaining AuditEvent `cancelled`, and boot recovery asserts `unknown`, with both complete affected test files green.

## Current Checkpoint

- **Disposition:** Continue.
- **Current fact:** Native Codex inline Streamable HTTP projection is feasible, and the isolated shared ledger seam now implements the complete terminal vocabulary, atomic call/Audit completion, restart `unknown`, parsed timestamp ordering, proof-backed LLM abort/timeout mapping, and synchronized JSON Schema plus OpenAPI projections without importing worker-control or NanoHost paths.
- **Current method:** Independently review and commit the shared prerequisite, then build one credential-free stdio vertical slice through the existing runtime-config catalog, AEP, Integration, Codex, Gateway, Item, and ledger owners before adding HTTP Vault and fresh-Turn approval behavior.
- **Current frontier:** The tracked candidate consists of this plan plus 24 protocol, App API schema, NanoCore ledger, LLM and Worker-inference consumers, storage recovery, generated projection, test, guide, and owning specification files; focused protocol tests pass 21/21, ledger tests pass 10/10, gateway attribution tests pass 3/3, App API schema tests pass 1/1, OpenAPI tests pass 2/2, complete Worker-inference tests pass 33/33, complete scoped-storage tests pass 12/12, OpenAPI validation passes, protocol, App API schema, plus NanoCore typechecks pass, and all three package lints pass.
- **Material unknown:** The smallest catalog and AEP shape that enables one server without exposing command, endpoint, or credential binding must be reconciled with the existing hard-coded MCP fixture and disabled capability union.
- **Next Action:** Obtain independent re-review of the exact corrected shared seam, commit it if accepted, then add the lowest-sufficient catalog/AEP regression before replacing the hard-coded fixture.
- **Predicted observable:** Review finds no missing terminal dependency or Phase 1 contamination, and the next catalog/AEP regression fails only because the Workspace MCP catalog and enabled capability projection do not yet exist.
- **Reframe evidence:** Any hidden dependency on R005 worker-control or NanoHost bytes, a requirement to expose server topology in AEP, or an owner conflict not resolved by accepted precedence changes the route before broader implementation.

## Acceptance And Closeout

- A normal independent Reviewer must inspect the exact final diff and named execution output before feature acceptance.
- Fresh verification or audit is used at owner reconciliation, major direction changes, and final closure where consequence or uncertainty warrants it; producer reports alone never accept their artifacts.
- Focused checks run during each slice; final scope determines package lint, typecheck, tests, build, packaged smoke, and deterministic story evidence.
- Closeout records commits, exact check results, external effects, unresolved findings, and surviving conclusions promoted to their owning documents; the roadmap changes only after the whole accepted R058 plane passes.
