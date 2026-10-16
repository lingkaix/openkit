---
type: change-plan
status: implemented
date: "2026-10-16"
branch: lane/ga-d53
---
# Private deletion recovery export

## Intent Revision 1

The coordinator selected D53 as a separate feature after bounded MCP preview, before the coupled Equal-member cutover. Restore the accepted internal deletion recovery export for private Thread history while retaining its original private owners. The [Multi-User Workspace owner](../../specs/20260715-multi_user_workspace_system.md#pre-cutover-deletion-projection) requires the exact current deletion request, original recovery owner, registry transition and request-derived export identity. Ordinary exports keep their existing audience requirements. No member-tier, initiating-actor schema, durable state, compatibility or identifier mechanism is added here.

## Method And Expected Evidence

Extend the existing deletion-route test owner with one current deletion/private-history case. Its baseline must reject the otherwise valid exact recovery export at the private-history guard; setup failure proves nothing. The same case retains ordinary-export refusal, unchanged private owner, wrong-export rejection before publication and stale-request refusal without changing the verified export. Move the existing narrow checker/context to the deletion-request owner so the caller and existing lower writer can use the same current authority before preserving private history. Use P14's actual deriveEntityId('wsexp', ['delete', requestId]) owner without changing the name or trigger. Run the affected suites and types, inspect the source and named output independently, then get exact-head review and the required Express gate. No live account, host, reset, release, automatic repair or new evidence store is authorized.

## Checkpoint

The branch starts from prepared Preview463323b7, which normally contains Server/P14 preparation and actual committed P14 fixture corrections74914814. Final actual main must still be joined. The regression is authored before production correction. No deciding result, review or gate is claimed yet. All heavy commands use the lane slot wrapper, one Vitest worker and an owned disk TMPDIR. The root primary owns this worktree; helpers do not write here.

The first baseline pipeline20356 completed the offline frozen install and prerequisite builds, then its selected test stopped at the existing outer-Core-transaction requirement. No product RED is claimed. The fixture now uses the same transaction as the existing deletion tests. Its final offline verification also uses the known canonical export path rather than a nonexistent result property. The next selected baseline run must reach the valid private export refusal before production changes.

The corrected baseline59061 reached the exact valid recovery export and failed at the private-history guard with Private Thread history requires a separately authorized export (one failed,25unselected). This is the deciding D53 RED. The existing checker/context now lives with the deletion request and is reused before collection and by the lower writer. Its complete request/registry/original-owner facts and accepted P14 derived export tuple remain unchanged. No Equal-only initiating-user schema, tier change, authority-actor default or compatibility reader was imported. The owner, storage guide and existing Skill manual align with this bounded correction. Focused GREEN and review/gate remain pending.

Focused73649 completed exit0 in d53-focused.log: all59cases across the complete existing deletion and export-boundary files passed, including the one private recovery regression. Native typecheck, focused Biome, documentation model530, lifecycle/index/governance and whitespace also passed. No timeout, audience assertion or private owner was weakened. The eight-path feature consists of three production owners, one existing test file, the accepted multi-user owner, storage guide, existing Skill manual and this plan. Final generation, independent exact-head review, actual main dependency join and required Express gate remain pending. No full module, browser, live effect or landing claim is made.

The first final-generation command20834 stopped before producing a CLI because the new worktree had not built Core Client. Native prerequisites and the deciding59test results remain separate. The next generation command builds that existing prerequisite and repeats the actual generators; no generated side or stale artifact is accepted from this setup failure.

Final generation95143 completed exit0 after the exact Core Client prerequisite build: actual CLI/OpenAPI generation and validation, docs530/lifecycle/index and whitespace passed. Both generated artifacts are byte-identical to prepared Preview463323b7 (CLI751528bytes and OpenAPI3367858bytes), so neither is an own changed path. The complete D53 diff is eight files. Implementation and focused proof are complete; exact independent review and actual-main Express gate remain, with P14 priority preserved.
