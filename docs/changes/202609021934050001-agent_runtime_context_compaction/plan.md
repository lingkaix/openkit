---
type: change-plan
status: verified
started: 2026-09-02
completed: 2026-09-03
---
# Agent Runtime Context Compaction Design

This change records the accepted design for one OpenKit-managed context-compaction channel across the Internal Agent Runtime and future compatible Worker runtimes, while retaining harness-native compaction where a Worker runtime already owns it.

## Intent Epoch 1

The engineer accepted a server-managed compaction path expressed through the Responses-compatible `context_management` field, with one centrally configured active-context limit per logical model. Quick Chat is designed to use the shared Internal Agent Loop; its current direct provider call is an implementation gap and MUST NOT become a separate context-management path. The specification must use current official OpenAI, Pi, and OpenCode evidence, and an independent Claude Code agent must inspect and approve the resulting artifact.

## Accepted Owners

- `docs/core/agent-workflow.md` owns the canonical Context Compaction concept and its traceability requirement.
- `docs/core/work-model.md` owns the distinction between durable Knowledge and runtime continuity.
- `docs/core/agent-session.md` owns Worker-native session continuity.
- `docs/specs/20260813-internal_agent_runtime.md` owns the shared Internal Agent Loop.
- `docs/specs/20260526-llm_gateway_responses_api.md` owns the Gateway Responses surface and routing boundary.
- The new specification owns the active-context policy, automatic runtime-compaction lifecycle, normalized request contract, and selection of exactly one compaction authority per execution.

## Working Checkpoint

1. Reconcile the governing Core and accepted specifications with the current implementation, including the Quick Chat divergence and the existing Worker harness boundaries.
2. Retain primary-source research under `temp/research/context-management-protocol/` and distinguish current upstream behavior from OpenKit's pinned runtime versions.
3. Add one accepted specification with exact definitions, exclusions, authority, lifecycle, failure and recovery behavior, wire shape, configuration projection, and observable acceptance predicates.
4. Update only directly conflicting accepted specifications and the specification index; do not implement runtime behavior in this change.
5. Run focused documentation checks, then obtain a read-only Claude Code verdict against a finite review checklist and correct every material finding before closeout.

## Independent Review Questions

1. Does the specification reuse existing owners without creating duplicate durable authority?
2. Does it define the exact `context_management` request shape and distinguish OpenAI compatibility from OpenKit-owned semantics?
3. Does it state that Quick Chat uses the shared Internal Agent Loop by design and accurately identify the current direct call as divergence?
4. Does every execution select exactly one compaction authority across the Internal Agent Runtime, OpenKit-managed Workers, and harness-native Workers?
5. Are source selection, output, provenance, failure, replay, restart, stale input, dependency failure, and user visibility explicit?
6. Is the physical model window distinct from the centrally configured active-context limit, including the one-million-token model capped at 400,000 tokens case?
7. Does the first implementation avoid an unnecessary public endpoint, registry, provider-specific override matrix, or durable Gateway transcript?
8. Are all affected accepted specifications reconciled without contradicting Core?

## Evidence

- Primary-source research is retained at `temp/research/context-management-protocol/report.md`. It verified the current OpenAI Responses control and item contracts, the pinned Pi `0.80.7` summary-and-tail mechanism, the pinned OpenCode `1.18.1` synthetic-part and tail-boundary mechanism, and the absence of one portable checkpoint representation across those runtimes.
- Code and specification inspection confirmed that `packages/config-schema/src/gateway.ts` has no context policy, `apps/nanocore/src/llm/logical-models.ts` does not project physical context limits, `apps/nanocore/src/mode-entry-routes.ts` still calls Quick Chat directly, the strict AEP version 4 has no context-management projection, and current Worker adapters use runtime-local behavior.
- [`docs/specs/20260902-agent_runtime_context_compaction.md`](../../specs/20260902-agent_runtime_context_compaction.md) now owns the accepted design. The six directly conflicting Gateway, reliability, AEP, Assistant, Quick Chat, and Internal Agent Runtime specifications have been reconciled; the existing audit, usage, and evidence specification is named as a required record-projection predecessor; and [`docs/specs/README.md`](../../specs/README.md) plus the generated documentation index expose the new owner.
- `node scripts/validate-spec-lifecycle.mjs`, `node scripts/validate-doc-model.mjs`, and `node scripts/generate-doc-index.mjs --check` passed on the completed draft; `git diff --check` reported no whitespace errors.
- No production code, schema, migration, runtime package version, or test behavior changed in this design-only lifecycle.

## Independent Review

The first read-only Claude Code Opus acceptance pass returned `APPROVAL: CHANGES_REQUIRED` after inspecting the actual diff, current code, pinned packages, Core owners, peer specifications, and research report. Its six findings were corrected locally: Worker fail-closed behavior now begins only when the next AEP actually carries the policy; Provider-native `compaction_trigger` input is rejected; the unsupported Codex threshold-control claim is removed; the audit and evidence record owner is an explicit implementation predecessor; the deciding evaluation oracle is prior and bounded while holistic scoring is informing-only; and context-specific codes are authored under the Gateway's common error envelope and transport owner. The same independent Herdr-managed Claude Code Opus agent then reread the corrected bytes and returned `APPROVAL: PASS`, confirming all six findings closed, no new contradiction, and no remaining material issue across the eight review questions.

## Verification

- `git diff --check` completed with no output.
- `node scripts/validate-spec-lifecycle.mjs` reported `Validated spec lifecycle metadata.`
- `node scripts/validate-doc-model.mjs` reported `Validated documentation model (211 documents).`
- `node scripts/generate-doc-index.mjs --check` reported `Documentation index is current.`
- `node --test tests/doc-model.test.mjs tests/doc-fields.test.mjs tests/change-execution-contract.test.mjs` completed with 103 passing tests, zero failures, zero skips, and zero cancellations.
- Independent acceptance completed through the Herdr-managed `context_acceptor` Claude Code agent using Claude Opus with high effort; its final verdict was `APPROVAL: PASS` after actual-byte review.

## Closeout

The accepted design is recorded and independently verified. It centralizes one threshold per logical model, keeps exactly one compaction authority per execution, routes every model-using internal role including Quick Chat through the shared Internal Agent Loop, preserves native Worker algorithms behind adapter proof, and adds no standalone compact endpoint, Gateway transcript, strategy registry, or runtime implementation in this lifecycle. No unresolved finding remains; production implementation is intentionally `Not Started` and must follow the order and gates in the owning specification.
