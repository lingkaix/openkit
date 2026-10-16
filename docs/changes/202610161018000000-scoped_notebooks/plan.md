---
type: change-plan
status: in-progress
---
# Scoped Knowledge Notebooks

## Intent Revision 2

The engineer assigned P20 to lane L-AK after P19. Implement ordinary Knowledge, personal Memory, immutable Skill versions and the authorized parts of the BWM first loop. The engineer ruling of 2026-10-16 15:40Z requires BWM first-loop implementation now with synthetic and fake-backed regressions; B01 business inputs are not a build prerequisite. No BWM acceptance occurs now. The engineer adds ideas on 2026-10-17, and acceptance follows that work. Synthetic regressions never establish real-use acceptance. This work grants no host administration or release publication.

## Accepted Owners

The Knowledge Core, Knowledge Store, Personal Memory And Scoped Knowledge Learning, Knowledge Notebook Editing And Publication, Knowledge Manager and Skill Catalog specifications own this work. Their accepted scope, fixed-base Git publication and source admission contracts apply together. Existing Workspace page writers and readers must cut over together; no second writable content authority is permitted.

## Checkpoint

P19 proceeds on lane/ak under landing protocol v2 and requires the P14 landing first. The successor stays independently backed up while integration, review and CI run outside the landing window. This successor branch starts with the notebook content boundary. The current implementation has Workspace-only file-backed pages and create-only reviewed proposals. User/Server scopes, Git content authority, history and replacement remain unimplemented. The content seam now passes44real Git/filesystem regressions. Tests exposed native actor attribution and uppercase path admission defects; both are corrected. Fault coverage includes missing/corrupt commit, tree and blob objects, invalid UTF-8, stale-base/ABA conflicts and candidate isolation. A direction check corrected an erroneous whole-notebook32MiB limit: narrow editing retains omitted blob identities without loading their bytes. Further real faults exposed Git-local alternate/symlink redirection and an omitted blob with a false object hash. Pre-Git indirection guards and full object-closure verification before publication now refuse them. These checks do not establish power-loss durability, current authorization, Audit/receipts, API cutover or worker delivery. The first increment must join the existing mutation and retrieval owners to one scope-bound publisher before it can land.

## Seam And Evidence

The first regression uses real Git objects and refs in a temporary notebook: fixed-base publication changes several files together, stale writers preserve the winner, history and exact old bytes survive reopen, and missing initialized objects fail closed. Strict commit metadata, path and file-kind validation, source checks and durable publication apply at the same owner. Tests must remove temporary directories.

## Next Action

Read the affected storage, validation, retrieval and command owners. Establish the lowest-sufficient regression for immutable content/history and conflict handling, then implement that seam and integrate all current page producers and consumers. Preserve source and current authority at each read and publication. Build the BWM loop with synthetic and fake-backed inputs while keeping its later engineer acceptance separate.


## Bounded History And Candidate Validation

Notebook history returns metadata only, defaults to20revisions and accepts1to100per page, with an exact nextRevision cursor constrained to published ancestry. Exact page bodies remain separate admitted revision reads; retained unpublished candidates cannot enter normal history by cursor. Six native Git regressions first failed against unbounded body-returning history in p20-notebook-history-red.log; the implementation and complete content cohort must pass before acceptance. Final-tree validation uses the same markdown-it parser already shipped by the Web package to distinguish actual concept links from code examples and reference-link syntax. Changed pages use the governed v4 profile and exact trusted owner; all resulting paths participate in link resolution, and existing referrers to removed pages must be repaired. Structural validity does not grant current source disclosure, human confirmation or publication authority. These remain with the common native publisher.

## Publication Evidence Component

The human Workspace publication component uses the existing Workspace Audit and command receipt owners, not another journal. Its lowest-sufficient real Git/SQLite regressions first reached seven intended failures at the unimplemented publication boundary in p20-notebook-publisher-red.log. The implementation prepares a fixed-base candidate, repeats current native admission before synchronous Audit and Git CAS, and returns success only after completion Audit and the existing receipt. Exact replay resolves the original commit after subsequent edits. Actual ref-lock, admission-Audit, completion-Audit and receipt faults must preserve truthful partial results and refuse fabricated success. This component is not activated independently: all existing page readers/writers, initialization, source/policy admission, required Review, pinned context and required portability still need the coordinated cutover. Final checks are pending.

The direct-human publication regression in p20-notebook-human-attribution-red.log proved that a submitted accepted label could enter a new commit unchanged. The common human publisher now validates the governed input and normalizes changed pages to user-authored through the shared YAML edit boundary; it preserves the exact body and unknown metadata, keeps unchanged pages exact, and computes Git/Audit evidence from the final bytes. Replay verifies those same normalized bytes against the original immutable request. The complete publisher cohort passes13cases in p20-notebook-human-attribution-current.log; subsequent typecheck and final integrated gates remain required.


## Native Cutover Work In Progress

The fresh Workspace initializer now creates the first real Git revision inside the existing unpublished staging root with actual creator/request attribution, pre-ref Audit admission and post-ref completion. Four real Git/SQLite component checks pass. The native regression first observed a missing repository; its corrected fresh-create/reopen case now passes. One optional-property TypeScript error in the Store call was corrected after the component run; a fresh integrated typecheck remains required. This evidence is bounded to initialization, not the complete cutover.

Authored knowledgeMaintenance fields are added to the existing User, Workspace and Server schema owners. Omission means disabled with no protected pages; the publisher must use current settings, not a captured model-run snapshot. Native Workspace update schemas and binding join the common publisher with current membership/credential/Policy, canonical scope schema and exact source checks. Protected changes currently fail closed; complete saved multi-file Proposal/Review, removal and restoration are still required before feature completion.

Canonical Workspace page reads and boot projection now select Git revisions, and the broad record writer no longer seeds a page schema, navigation file or page content. Stale Store persistence cannot rewrite the published tree. File-backed low-level entry mutation, accepted create-only Review and reversal refuse until their native paths join the publisher; no operation may return success from an in-memory edit alone. The old page-directory resolver and deletion writer are removed. Remaining integration includes native CRUD/Review, all current source-aware read surfaces, pinned indexes/S39, required import/export/backup integration, runtime settings reload, matching dependency generation and complete regressions. This unactivated branch is not a landable feature.

## Existing Entry And Editor Integration

The retained create/update commands now project explicit fixed-base input into the same Git/Audit/receipt publisher. Creation selects a stable concept path; an exact completed retry reconstructs its original entry from the named immutable commit after later edits. A previous unpublished admission must agree with that commit before an unchanged explicit retry can continue. Service timestamps are recovered from the exact admitted candidate rather than regenerated as new intent. The original command owns the sole receipt; no nested knowledge.notebook.update receipt is created. Current source disclosure and publication policy remain native requirements.

The Web keeps the selected notebook revision in each add/edit draft and in an exact unknown-outcome retry. Background refreshes cannot silently move that base. A new editor regression captures this race; existing Knowledge fixtures now carry the public revision field. The native entry probe stopped at stale built input declarations before publication, so it does not establish the intended behavior failure. Matching dependency builds, Protocol/schema tests, native publication/initializer/component suites and typecheck are queued on the current source. Protected Review, destructive removal, history/restore, source-filtered native list and Source endpoints, pinned index/S39, required portability and full feature gates remain incomplete. This is backed-up integration work, not a landable feature.

## Engineer Rulings Of 2026-10-16 15:40Z

Versioned Skill import must accept ordinary ecosystem repositories without repackaging, using the source, discovery, frontmatter and provenance conventions of vercel-labs/skills. Port the required MIT-licensed logic with its notice rather than running its CLI at runtime; OpenKit keeps exact content, current authority, Review, Audit and delivery ownership. The Skill owner records the exact import contract. BWM implementation proceeds now, with no acceptance claim. No ci.yml dispatch or pull request is permitted for these lane features; express landing uses local gates.

## Simplicity Ruling Of 2026-10-16

Remove the offline Notebook conversion implementation and tests; no pre-v0.1.0 predecessor qualification, compatibility reader or carry-forward migration lands. Fresh initialization and ordinary SQLite schema changes are sufficient under the approved reset boundary. Portability and backup work remains only where the existing paths break or lose notebook content without it. Build only accepted owner predicates, with one sufficient regression per behavior and simple errors/retry. Do not add proof, replay, ledger or recovery mechanisms beyond those owners. Current user/Workspace privacy, authorization, Worker/model secret protection and user-content preservation remain strict.
