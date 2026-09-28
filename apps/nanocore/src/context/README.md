# LLM Context Projection

This directory owns deterministic projection of durable OpenKit items into provider-visible LLM context.

## Boundaries

- `projection-policy.ts` classifies item types and records versioned inclusion or exclusion decisions.
- `llm-projection.ts` creates provider messages, deterministic context-package digests, and attachment records.
- `worker-context-package.ts` builds, publishes, and verifies the immutable S39 worker-Turn package and delivery trace without owning a lifecycle.
- `worker-context-authorities.ts` maps the existing Core, Workspace, and product-store owners into the shared S39 verifier without retaining state.
- `worker-context-projection.ts` fully verifies present traces before deriving S16 Material, Goal steering, and exact Worker request objective read fields without storing them.
- Projection must not dispatch providers, mutate thread history, or become a second persistence owner.
- Every excluded item keeps a stable policy reason; provider-visible content must follow the selected projection policy.

The S39 authority reader locates the trace's exact AEP snapshot filename under retained Workspace AgentSession owners, independently of a session's mutable current-package pointer. It requires one strictly validated match for both package and backend-handoff reads, so unrelated malformed historical snapshots cannot prevent new delivery. Missing, malformed, or conflicting selected snapshots remain unavailable; workspace export still validates the full retained AEP inventory.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/context` and the workflows that materialize context packages.

See [Work Model](../../../../docs/core/work-model.md).
