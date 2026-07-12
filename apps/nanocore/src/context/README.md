# LLM Context Projection

This directory owns deterministic projection of durable OpenKit items into provider-visible LLM context.

## Boundaries

- `projection-policy.ts` classifies item types and records versioned inclusion or exclusion decisions.
- `llm-projection.ts` creates provider messages, deterministic context-package digests, and attachment records.
- Projection must not dispatch providers, mutate thread history, or become a second persistence owner.
- Every excluded item keeps a stable policy reason; provider-visible content must follow the selected projection policy.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/context` and the workflows that materialize context packages.

See [Work Model](../../../../docs/core/work-model.md).
