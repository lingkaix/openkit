# Findings

This report retains R058 observations and dispositions as execution evidence; the linked Core and specifications remain the design authorities.

## Follow-up Index

- [ ] `R058-FND-001` [deferred] Agent Catalog has no production manifest projection

- [x] `R058-FND-002` [closed] NanoHost prose duplicates a stale Harness poll body

## [deferred] R058-FND-001 — Agent Catalog has no production manifest projection

- **Observation:** A fresh authenticated A2 user created Workspace `ws_2` through the public API on product candidate `09d8b77`; the Agent Catalog remained empty and `agent_codex_host` returned HTTP 404 despite a valid Server Agent Manifest and successful config reload. `agents/catalog-routes.ts` reads only `FsStore.getWorkspaceResources().agents`, new and restored resources initialize that array empty, and no production caller populates it through `upsertAgent`.
- **Impact:** The general Agent Catalog discovery surface cannot show configured Server manifests. The accepted R058 Web Task path uses a separate existing public conversation-target projection from current manifests and Workspace composition, so this defect does not by itself prove Task launch unavailable.
- **Evidence:** `temp/changes/202609031230162442-r058_worker_mcp/a2-prepare/run1-partial-scene.md` retains exact public observations and A2 candidate identity. Independent Reviewer traced `agents/catalog-routes.ts:31`, `lib/store.ts:733`, `app.ts:877`, `mode-entry-routes.ts:1851`, and Web `screens/chat/ThreadScreen.tsx:169`; the primary inspected the catalog, store, Coordinator candidates, and Web selector bytes directly.
- **Owner:** `docs/core/agent-supply.md` owns Workspace-visible Agent discovery and the projection boundary; `apps/nanocore/src/agents/` owns the existing catalog route. Authored manifests and their current Workspace composition should feed that projection, without a second mutable Agent registry.
- **Next action:** Opened during R058 scene preflight. Independently verify that removing the unrelated catalog prerequisite preserves the actual Web Task acceptance path, then record whether this discovery defect remains outside the R058 outcome. Independent Reviewer, Verifier, and Auditor confirmed the current conversation-target Task path, and the real actor launched that path on the sealed Run 1 candidate. Deferred under the engineer's instruction to record adjacent defects without expanding R058. The Agent supply/catalog owner receives this finding when Workspace-visible Agent discovery work is activated.

## [closed] R058-FND-002 — NanoHost prose duplicates a stale Harness poll body

- **Observation:** `docs/specs/20260802-nanohost_runtime_and_transport.md:868` describes the initial private Harness poll as having no body. The unique Worker Control protocol owner specifies an exact one-member version envelope, and its Current Implementation Projection explicitly records implemented V1 versus accepted future V2. Current Shim and NanoCore agree on `{ "schemaVersion": 1 }`.
- **Impact:** A duplicated cross-owner sentence can misdirect future transport implementation; it does not authorize an empty-body migration or broad V2 work while correcting NanoHost's retired sequence selector.
- **Evidence:** Independent fresh direction compared the two owning specifications, `packages/worker-shim/src/harness.ts:431`, `apps/nanocore/src/runtime/nanohost-session-dispatch.ts:773`, and the exact RED NanoHost regression after the sealed real Run 1 timeout.
- **Owner:** `docs/specs/20260703-worker_control_protocol.md` uniquely owns Harness poll semantics; `docs/specs/20260802-nanohost_runtime_and_transport.md` owns carriage and should reference that semantic owner.
- **Next action:** Opened during the NanoHost readiness correction. Reconcile the stale duplicated sentence through the existing Worker Control owner without expanding this runtime repair into the deferred V2 migration. The Reviewer, Verifier, and Auditor accepted the one-line owner reference and this finding transitioned from open to closed.
- **Closing verdict:** Closed by the independently accepted ownership reconciliation; NanoHost now references the unique Worker Control owner for its poll body while retaining its transport and credential boundaries.
- **Closure evidence:** The actual one-line specification diff received normal Reviewer, fresh Verifier, and Auditor acceptance; the focused exact-poll regression passes and no wire-version migration was introduced.
