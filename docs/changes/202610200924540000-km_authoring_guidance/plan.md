---
type: change-plan
status: implemented
---
# Knowledge Authoring Guidance

## Intent Revision 1

The engineer approved a seven-file guidance correction after diagnosis found approximately 34 KB of Tool arguments per edit. Knowledge pages must be short syntheses with exact Source references. Original text stays in Sources. Replace broad copying cues and keep the combined prompt text at approximately its current size or smaller. Add only a few direct contract assertions in the existing delivery tests.

The scope is the fixed prompt, schema authoring guidance, their two existing regression files, the two local guides and this record. No retained format, field, registry, runtime mechanism, output cap, Provider setting or live operation changes. SourceSummary editing remains separate.

## Owners And Acceptance

[Knowledge](../../core/knowledge.md) separates Source evidence from curated interpretation. [Notebook editing](../../specs/20260909-knowledge_notebook_editing.md) owns fixed-base editing and publication. This change corrects their guidance projections and does not amend either owner.

The fixed prompt and native Workspace, User and Server guidance must each request synthesis, retention of originals in Sources and exact Source citations. Existing schema, size, authority and Review controls remain. The runner double proves instruction delivery, not model comprehension, Tool argument reduction or latency.

Run focused regression files, lint, typecheck and build checks. Obtain one independent read-only review and exact-SHA branch CI with the complete L0-L2 gate. The engineer reviews and lands the branch.

## Rewritable Checkpoint

Baseline: c19367d1d7f99a6a1e5a285c827d33dbe190e0e9. Test commit d6d2bbfd6 adds three direct assertions for each delivery path. Before production edits, the two complete test files reported four expected assertion failures and eleven passes, with no skipped tests. Each failure identified the absent synthesis instruction; collection and native setup succeeded.

The implementation replaces the broad organization and complete-page cues with short synthesis and Source-reference guidance. The publication sequence and required frontmatter remain. The fixed prompt decreases from 1671 to 1613 UTF-8 bytes. Literal schema authoring instructions increase from 1705 to 1761 bytes; dynamic schema and version text remain unchanged. The combined guidance decreases by two bytes.

All sixteen cases in the three complete focused files pass, with no skips. Biome reports no fixes or errors in the four TypeScript files. The NanoCore build completes its TypeScript check with no errors. The documentation-model check and diff check pass. Seven files change, no governing documents change, one existing Knowledge responsibility is affected, and no registry or closed set is added. Next: obtain the independent read-only judgment and qualify the exact candidate through branch CI. No live model run or measured latency improvement is claimed.
