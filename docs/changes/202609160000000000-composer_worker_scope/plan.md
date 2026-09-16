---
type: change-plan
status: verified
---
# Conversation Worker Selector Scope

## Intent

The engineer's staging feedback on `/chat/ws_7/th_74` requires identifiable Worker choices scoped to the current conversation, without falsely presenting retained sessions as running Sandboxes. The live selector showed 29 indistinguishable `Codex Agent · Running` entries from different Threads. Fix catalog scope and labels at their source and render existing descriptions in the shared Composer. No runtime cleanup, storage change, or deployment is part of this local correction. The engineer subsequently authorized a separate commit for each completed UI correction, starting with this one.

## Owners

`docs/specs/20260831-unified_conversation_composer.md` owns the catalog, selector, and acceptance-time revalidation; its scope clarification records this engineer decision. `docs/specs/20260704-agent_session_continuity.md` owns current versus terminal AgentSession continuity. Existing API shapes and target references remain unchanged.

## Acceptance

Only the requested Thread's current Worker appears; starters and terminal history have no existing Worker targets. Idle/ready, busy, and unready states project distinct availability. A foreign target fails before effects. Descriptions are accessible in the expanded list without entering the collapsed label. Existing Composer and token tests, focused API tests, typechecks, and Web build pass; independent review inspects the actual changes.

## Closeout Summary

Local implementation and verification are complete and ready for the authorized commit. API regression failed on nine unrelated or incorrectly labeled entries before the fix; the UI regression failed on missing accessible descriptions. Initial API collection and Web build encountered stale generated workspace packages, resolved by rebuilding their existing dependencies. Independent review found stale-busy precedence, corrected it to unavailable with a regression, and returned no actionable findings after inspecting the final artifact. Staging remains unchanged and still needs deployment and live acceptance.

## Verification

- `pnpm --filter @openkit/nanocore exec vitest run src/quick-chat.test.ts`: 23 passed, including current/foreign Thread scope, ten lifecycle states, stale ready/busy, starter exclusion, and no-effect foreign-target rejection.
- `pnpm --filter @openkit/web exec vitest run src/primitives/primitives.test.tsx src/test/tokens.test.ts`: 102 passed, including accessible descriptions and collapsed-label isolation.
- `pnpm --filter @openkit/nanocore typecheck` and `pnpm --filter @openkit/web build`: passed. Web build includes TypeScript checking and retains the existing large-chunk warning.
- Focused `pnpm exec biome check` on all four changed TypeScript files: passed. `node scripts/validate-doc-model.mjs`: 272 documents passed. `git diff --check`: passed.
- Browser inspection used the actual Composer and compiled Web CSS with a static local catalog at 831×803 and 390×803, not a staging backend. Descriptions and current-conversation labels render correctly; the long selected label truncates without overlapping the model or Send control after correcting selector flex sizing. Preview tab closed, viewport reset, and temporary server stopped. No staging message, configuration, or runtime state was changed.
