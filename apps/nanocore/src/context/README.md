# LLM Context Projection

Retained Context Package manifests and traces admit descriptive annotations while verifying the original canonical representation and byte digests. A direct Task trace retains the complete scope-qualified retrieval trace reference that selected its Knowledge bytes. The trace reader returns known fields with its original immutable representation retained for same-identity serialization. Inventories and structured instructions remain exact; portable import remints only owned references and recalculates target digests. See [Worker Context Package](../../../../docs/specs/20260703-worker_context_package.md).

This directory owns deterministic projection of durable OpenKit items into provider-visible LLM context.

## Boundaries

- `projection-policy.ts` classifies item types and records versioned inclusion or exclusion decisions.
- `llm-projection.ts` creates provider messages, deterministic context-package digests, and attachment records.
- `worker-context-package.ts` builds, publishes, and verifies the immutable S39 worker-Turn package and delivery trace without owning a lifecycle. Knowledge selections carry the supplying Notebook commit separately from their exact page digest, matching the digest-addressed source snapshot projection.
- `worker-context-authorities.ts` maps the existing Core, Workspace, and product-store owners into the shared S39 verifier without retaining state.
- `worker-context-projection.ts` fully verifies present traces before deriving S16 Material, Goal steering, and exact Worker request objective read fields without storing them.
- Projection must not dispatch providers, mutate thread history, or become a second persistence owner.
- Every excluded item keeps a stable policy reason; provider-visible content must follow the selected projection policy.

S39 recognizes the existing frozen Pending Request input envelope as worker request context. Outcome-initiated Turns use scheduler request lineage without inventing a Task checkpoint; their exact input bytes enter the existing immutable package and trace before native launch. The Material projection still refuses a genuinely missing accepted trace.

The S39 authority reader locates the trace's exact AEP snapshot filename under retained Workspace AgentSession owners, independently of a session's mutable current-package pointer. It requires one strictly validated match for both package and backend-handoff reads, so unrelated malformed historical snapshots cannot prevent new delivery. Missing, malformed, or conflicting selected snapshots remain unavailable; workspace export still validates the full retained AEP inventory.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/context` and the workflows that materialize context packages.

See [Work Model](../../../../docs/core/work-model.md).

Revalidating a parsed Context Package trace with its retained original requires equality of their normalized known core; a changed supplied core fails closed before serialization.

A conversation-to-Task receiving Thread retains the entry owner's existing frozen Knowledge selection choice. Direct Task entry still requires its single selection; a Chat handoff with no selection still needs its exact persisted handoff lineage to admit null. The identifier cutover changes neither query triggers nor accepted selection bytes.

Context Package manifests and traces reuse the Protocol kind validators for Workspace, Thread, Turn, Item, logical AgentSession, Material and Material revision references. Package digests, authored Goal/Task selectors, native snapshots and request correlation keep their existing codecs.

The frozen Pending Request input schema reads its existing S59 delivery bound at parse time. Notebook portability links Store and context imports, so module initialization must not capture that bound before S59 initializes it. No second delivery limit or envelope is introduced.
