---
type: change-plan
status: implemented
date: "2026-10-16"
branch: lane/ga
---
# Vault Injection Identity

## Intent Revision 1

Source: the L-GA P22 assignment and the Vault injection identity-conflict backlog item. Reject changed immutable content under an existing plan or receipt identity. Preserve exact replay, original completion and current lifecycle projections. This feature changes no credential class, durable format, public operation or import authority.

## Owners And Boundaries

[Vault Secret Injection](../../specs/20260703-vault_secret_injection.md) owns plan intent, successful receipt completion, immutable lineage and lifecycle projections. The existing SQLite plan and receipt modules remain the writers. Creation cannot change revocation. Import remains historical and does not gain use authority. This feature does not claim the full P22 grant-review, shared MCP or delegated Policy outcome.

## Checkpoint

The existing tests accepted changed immutable input under the same identity. The corrected regression first failed in both modules because changed input returned the old record. The modules now compare each immutable field after insertion or replay and reject a conflict. Nullable fields normalize only absent to null. A plan replay ignores the newly supplied clock and returns its original creation time. A receipt replay preserves the original injection and expiry facts. Lifecycle status remains with its existing revocation owner.

The first focused run after implementation passed both files and all five tests. Replay after revocation and the three related Vault/Agent files also passed in the wider run. NanoCore typecheck passed. The wider run ended with 272 passing and 38 failing tests: both Worker files failed during retrieval admission because this worktree lacked the declared Retrieval Kernel executable. An isolated Worker case reproduced that admission failure before the subject behavior. The declared kernel build then passed under the shared CPU slot with one Cargo job. The same seven-file check with that prerequisite present passed all 310 tests in seven files. This settles the tested injection identity caller risk without a product change to retrieval. Keep this feature separate from the earlier D-GA-1 landing. Temporary logs remain outside the repository. No secret or external effect is used.

`pnpm check:repo` and `pnpm lint` exited 0 on the identity change. NanoCore typecheck exited 0. The immutable-field regressions cover exact replay, changed targets and intent, unchanged history, nullable input and replay after revocation. Independent package review and its landing remain pending; the subsequent revocation projection correction is not part of this identity commit.
