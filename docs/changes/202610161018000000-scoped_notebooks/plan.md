---
type: change-plan
status: in-progress
---
# Scoped Knowledge Notebooks

## Intent Revision 1

The engineer assigned P20 to lane L-AK after P19. Implement ordinary Knowledge, personal Memory, immutable Skill versions and the authorized parts of the BWM first loop. Real BWM acceptance requires B01 business inputs; synthetic examples cannot satisfy it. This work grants no host administration or release publication.

## Accepted Owners

The Knowledge Core, Knowledge Store, Personal Memory And Scoped Knowledge Learning, Knowledge Notebook Editing And Publication, Knowledge Manager and Skill Catalog specifications own this work. Their accepted scope, fixed-base Git publication and source admission contracts apply together. Existing Workspace page writers and readers must cut over together; no second writable content authority is permitted.

## Checkpoint

P19 proceeds on lane/ak under landing protocol v2 and requires the P14 landing first. The successor stays independently backed up while integration, review and CI run outside the landing window. This successor branch starts with the notebook content boundary. The current implementation has Workspace-only file-backed pages and create-only reviewed proposals. User/Server scopes, Git content authority, history and replacement remain unimplemented. The content seam now passes44real Git/filesystem regressions. Tests exposed native actor attribution and uppercase path admission defects; both are corrected. Fault coverage includes missing/corrupt commit, tree and blob objects, invalid UTF-8, stale-base/ABA conflicts and candidate isolation. A direction check corrected an erroneous whole-notebook32MiB limit: narrow editing retains omitted blob identities without loading their bytes. Further real faults exposed Git-local alternate/symlink redirection and an omitted blob with a false object hash. Pre-Git indirection guards and full object-closure verification before publication now refuse them. These checks do not establish power-loss durability, current authorization, Audit/receipts, API cutover or worker delivery. The first increment must join the existing mutation and retrieval owners to one scope-bound publisher before it can land.

## Seam And Evidence

The first regression uses real Git objects and refs in a temporary notebook: fixed-base publication changes several files together, stale writers preserve the winner, history and exact old bytes survive reopen, and missing initialized objects fail closed. Strict commit metadata, path and file-kind validation, source checks and durable publication apply at the same owner. Tests must remove temporary directories.

## Next Action

Read the affected storage, validation, retrieval and command owners. Establish the lowest-sufficient regression for immutable content/history and conflict handling, then implement that seam and integrate all current page producers and consumers. Preserve source and current authority at each read and publication. Record missing B01 inputs separately while ordinary work proceeds.


## Bounded History And Candidate Validation

Notebook history returns metadata only, defaults to20revisions and accepts1to100per page, with an exact nextRevision cursor constrained to published ancestry. Exact page bodies remain separate admitted revision reads; retained unpublished candidates cannot enter normal history by cursor. Six native Git regressions first failed against unbounded body-returning history in p20-notebook-history-red.log; the implementation and complete content cohort must pass before acceptance. Final-tree validation uses the same markdown-it parser already shipped by the Web package to distinguish actual concept links from code examples and reference-link syntax. Changed pages use the governed v4 profile and exact trusted owner; all resulting paths participate in link resolution, and existing referrers to removed pages must be repaired. Structural validity does not grant current source disclosure, human confirmation or publication authority. These remain with the common native publisher.
