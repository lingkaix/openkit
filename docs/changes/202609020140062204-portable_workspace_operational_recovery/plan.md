---
type: change-plan
status: in-progress
started: 2026-09-02
branch: codex/phase1-operational-recovery
---
# Portable Workspace And Operator Recovery

## Intent Epochs

### Intent Epoch 1 — 2026-09-02 — Deliver the next Phase 1 operational-continuity slice

- **Outcome:** Complete R008, R009, and R010 as three independently usable owner slices: portable `.openkit-workspace.tar.zst` transfer through the real local-mode bundled CLI, stopped-server recovery of one existing active User's `server-admin` credential, and owner-authorized Workspace deletion with a verified recovery archive, independent audit closure, and tombstone-authorized recovery.
- **Non-negotiables:** Preserve the repository's no-backward-compatibility direction; add no HA, replication, distributed transaction, archive registry, remote transfer service, server-mode user credential system, generic workflow engine, repair service, trash service, or schema migration dependency; do not restart, stop, replace, or lifecycle-manage the current Codex App Server, host services, Docker daemon or containers, Herdr, or the machine.
- **Acceptance:** A real two-runner artifact transfer preserves the accepted Workspace semantic graph and full history through the bundled CLI; the recovery credential is durable, resumable, directly consumable by `credential.store`, and secret-safe across file and SQLite crash windows; deletion fences concurrent mutation, records exact durable progress, leaves a verified portable archive and pre-terminal closure, terminates ordinary authority through a unique registry tombstone, and recovers into the ID selected by the existing collision rule.
- **Effect boundary:** Repository files, ignored temporary directories, process-local app fixtures, self-terminating isolated subprocesses, and fresh GitHub Actions runners only. No current deployment mutation, service or container lifecycle action, tag, release publication, host reboot, outbound user communication, or machine-wide configuration change is authorized.
- **Completion truth:** R008, R009, and R010 may close independently only after their supported user path, lowest-sufficient regression, real-use evidence, owner documentation, and independent acceptance all agree. R003 remains open for a later material change because the current mutable setup migration cannot evolve an existing migration ledger.

## Accepted Owners

- `docs/core/storage.md` owns storage authority, retention, legal hold, and effect-domain boundaries.
- `docs/specs/20260704-workspace_backup_export_import.md` owns portable Workspace format, verification, import identity rules, backup, restore, and portability acceptance.
- `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns remote authentication, bootstrap, access-token credential lifecycle, and the currently unspecified locked-out administrator recovery gap.
- `docs/specs/20260703-audit_usage_evidence_records.md` owns the deletion audit closure, retained evidence, and legal-hold behavior.
- `docs/specs/20260715-multi_user_workspace_system.md` owns Workspace registry, owner and membership authority, and Workspace lifecycle projections.
- `docs/specs/20260529-test_strategy.md` owns proof layers; `docs/verification-instruments.md` owns oracle and harness quality; `docs/toolchain.md` owns dependency and CI procedure.
- `docs/roadmap.md` owns the R008, R009, and R010 completion projection but supplies no implementation authority.

## Current Facts And Gaps

- HEAD is `0c874e8` on `codex/phase1-operational-recovery`; the tracked worktree was clean when this plan was created.
- Workspace V2 export and import already preserve the implemented canonical history, knowledge, files, repository lineage, Vault references, audit, usage, permission, and runtime evidence, but the public surface only passes a server-managed export handle.
- The accepted portable filename is `.openkit-workspace.tar.zst`; Node 24 provides native Zstandard streams, and `tar-stream` is already present transitively but is not a direct NanoCore dependency.
- Existing imports preserve the source Workspace ID when available and remint only on collision. Existing foreign server-managed handles are over-readable, while local-mode CLI and Better Auth sessions are the only current canonical-user import authorities; server-mode bearer credentials are deliberately insufficient.
- Existing `credential.store` accepts only the strict `{ token }` input. The data-root lock owner already exists, but recovery must hold one acquisition across the complete command to prevent NanoCore startup races.
- `workspace_registry` already has `active`, `deleting`, and `deleted` states, and ordinary role resolution accepts only `active`. It does not identify an in-progress deletion request or its artifacts, and the current terminal command receipt cannot own intermediate phases.
- The current concrete `legal-hold` record owner is `evidence_bundles.retention_class`. Portable export excludes deployment-local ownership, membership, invitation, administrator recovery, and complete Core-local audit facts, so it cannot be the sealed audit closure.
- The existing migration implementation applies only mutable `0000_setup.sql` to a fresh ledger and intentionally refuses predecessor ledgers. R003 therefore needs a separate accepted forward-migration owner before deployment install, upgrade, and rollback can be truthful.
- Cursor CLI Fable 5 could not inspect the proposal because the account reached its usage limit. The authorized registered Verifier returned three `Reframe` decisions, then `Continue` after the fourth proposal closed archive authority, CLI applicability, credential effect-domain, deletion lifecycle, concurrency, and closure-authority blockers.

## Accepted Direction

### R008 — Stream One Portable Archive Without A Foreign Handle Registry

- Reuse the existing verified export tree and verifier. Stream archive download through `tar-stream` and Node Zstandard without buffering complete bytes or creating a second server archive.
- Require current source-owner `workspace.export` authority for download. A foreign deployment identity is lineage only and grants no read or import authority.
- Implement one-shot archive dry-run and import through request-owned `0700` staging directories and `0600` files created exclusively without link following. Bound compressed bytes, expanded bytes, entry count, and per-entry bytes with accepted code constants; reject unsafe paths, duplicate entries, links, special files, extras, omissions, and verifier failures.
- Delete only the current request's staging in `finally`; before listener binding, boot cleanup may remove the dedicated request-staging namespace because no request can be active. No running request scans another request's staging.
- Preserve the source Workspace ID when it has no registry, memory, or disk collision and reuse the existing deterministic remint rule on collision. The importer becomes the only owner, while repository and Vault references remain unbound.
- Add streaming Core Client methods and local-mode bundled CLI operations for archive download, dry-run, and import. CLI download uses `O_CREAT|O_EXCL`, mode `0600`, rejects existing destinations and links, and never encodes archive bytes as JSON.
- Keep server-mode canonical-user CLI credentials out of scope. The accepted terminal user path is the implicit local actor; Better Auth sessions remain the existing server-mode user surface.

### R009 — Hold One Lock Across A Resumable File-First Recovery

- Add stopped-server `openkit-operator admin recovery-users` and `admin recover-access` commands. Both acquire the existing data-root exclusive lock before opening a database and retain that same lock through query or commit, file and directory `fsync`, database close, and final command completion.
- Recovery targets one explicitly selected existing active User and creates one `server-admin` token through the current access-token owner. It does not create or reactivate a User, modify a password, reopen bootstrap, revoke unrelated tokens, or grant Workspace content authority.
- Publish a strict `0600` recovery envelope with `O_CREAT|O_EXCL` before committing the matching token hash and redacted AuditEvent in one SQLite transaction. The envelope binds `kind`, request ID, token ID, owner User ID, expiry, and plaintext token.
- A retry with the same request and output resumes an inactive file-before-database result or confirms a matching committed result. Missing, conflicting, or contradictory file, token, request, or Audit state returns `recovery_required`; no retry overwrites or deletes the only credential copy.
- Extend `credential.store` with one strict union between its current `{ token }` shape and the complete recovery envelope. Both paths pass only the token to the existing endpoint credential store.

### R010 — Fence Mutation And Make The Registry Tombstone The Only Recovery Authority

- Check every concrete legal-hold owner before creating an export or changing registry state. The first implementation checks `evidence_bundles.retention_class = 'legal-hold'` through one deletion predicate with a coverage regression that must grow with any future legal-hold owner.
- Add one file-backed deletion-request owner under `server/exports/workspace-deletions/<workspaceId>/<requestId>/request.json`. Exclusive creation binds the request, original owner, expected revision, and Workspace; atomic same-directory replacement advances only the fixed deletion phases and binds exact recovery export, closure, staging, and terminal identities.
- Add one concrete in-process per-Workspace mutation admission fence at current App mutation and late runtime-publication entry points. A mutation enters and increments only while the gate is open, rechecks current authority before publication, and exits in `finally`; deletion closes the gate, waits admitted writes and named runtime owners to become quiescent, and never stops a service or cancels a worker automatically.
- While the exclusive fence remains closed, CAS `active` to `deleting`, create and verify the portable recovery export, and seal an independent closure under `server/exports/workspace-closures/`. The closure cutoff is after the deleting transition and before the terminal deletion AuditEvent; it contains deployment-local governance and retained-evidence facts plus the exact recovery-export reference.
- Rename the canonical Workspace root to request-owned deletion staging, then transactionally CAS `deleting` to `deleted`, tombstone current authority projections, and record the terminal AuditEvent and command receipt. Cleanup failure reports `deleted_with_retained_staging`; phase, digest, path, registry, or tombstone contradiction reports `recovery_required`.
- Rebuild nonterminal mutation fences before listener binding after process restart, but do not automatically resume destructive phases. Ordinary routes never reactivate `deleting` or `deleted` Workspaces.
- The registry status owns the `active`, `deleting`, and `deleted` lifecycle state; the file-backed deletion request is the unique intermediate-phase and retry owner; and the deleted registry tombstone is the unique recovery authority. The closure is non-authorizing evidence, and any disagreement between these owners and projections fails closed. Terminal deletion audit and tombstones remain in Core, while the closure is only the remaining Workspace content and evidence record.
- Closure recovery requires the original owner identified by the tombstone and reuses R008 import. The tombstone creates an ID collision, so the existing import rule remints a new Workspace ID; no server administrator content bypass or original-ID reuse is added.

## Lowest-Sufficient Regression

- Begin each owner slice with one focused RED seam that names the expected failure before implementation. R008 first proves the missing archive route and unsafe foreign handle boundary; R009 first proves the missing stopped-server recovery command and complete-lock requirement; R010 first proves mutation can publish after deletion admission and no durable request owns a crash window.
- R008 focused checks use only temporary local-mode data roots and process-local apps. They cover owner-only download, staging modes and exclusivity, bounded streams, malicious tar entries, corruption, concurrent request isolation, ID preservation and collision reminting, new ownership, unbound references, and CLI file behavior.
- R009 focused checks use only a temporary server-mode data root. They cover discovery, lock contention and startup exclusion, `0600` exclusive publication, file-before-database crash, database-after-file retry, contradictions, audit and output redaction, strict credential-store union inputs, and one authenticated request with the recovered token.
- R010 focused checks use only temporary Workspaces and process-local apps. They cover legal-hold preflight, mutation admission races, late publication rejection, quiescence pending, each deletion-request phase and crash point, pre-terminal closure cutoff, unique tombstone authority, boot fence reconstruction, retained staging truth, and collision-derived recovery ID.
- A two-job GitHub Actions proof runs the real local-mode bundled CLI on two fresh runners. It compares the transferred archive SHA across jobs, then compares the owning semantic graph, complete history, knowledge, unbound-to-rebound references, and target behavior after import and re-export; it does not compare re-export archive or manifest digests and does not call itself L6.

## Verification And Independent Acceptance

- Run focused formatter, lint, typecheck, tests, OpenAPI generation, Skill bundle checks, documentation lifecycle and index checks, and `git diff --check` in proportion to each committed slice.
- No local check may restart, stop, replace, or lifecycle-manage the current Codex App Server, host services, Docker daemon or containers, Herdr, or the machine. A harness that requires such an action is invalid and must be replaced with a temporary directory, process-local app, self-terminating isolated subprocess, `bwrap`, or fresh CI runner.
- The GitHub two-runner job is an L3 public-process boundary plus L5 artifact-transport smoke. L6 remains agent-first and opt-in; a fixed mechanical script is not promoted into L6.
- A registered independent Reviewer inspects every authority-bearing specification revision and each material implementation slice. A registered Verifier falsifies direction after any reframe or compaction before the next durable commitment. A registered Auditor inspects final owner alignment, exact evidence, closure truth, and roadmap marking before the PR.
- Producer reports never accept their own artifacts. Any accepted correction that changes reviewed bytes requires renewed independent review of that revision.

## Commit And PR Boundary

- Commit the accepted owner documentation before production code depends on it. Keep the three implementation slices coherent and separately reviewable; a failed slice may be removed without blocking the others.
- Commit only tracked plan, owner, test, implementation, generated contract, guide, and roadmap bytes. Proposal drafts, consultant output, raw commands, fixtures produced only for inspection, and intermediate CI artifacts remain ignored under `temp/`.
- Push and create one PR only after the accepted slices and their exact checks are complete. The user has authorized project-related repository and GitHub PR operations, but no tag, release publication, deployment, current-service lifecycle, or machine reboot is authorized.

## Rewritable Checkpoint

- **Intent epoch:** 1.
- **Current facts:** The fourth proposal received independent `Continue`; this plan passes specification lifecycle, documentation model, index, and whitespace validation; R008, R009, and R010 remain selected, R003 remains excluded, and no tracked implementation or owner change has begun.
- **Current method:** Independently verify and commit this plan baseline, then revise the four accepted owning specifications as one documentation slice before writing the first focused RED regression.
- **Frontier:** The next durable artifact is the specification diff that accepts archive transport, stopped-server recovery, deletion request and mutation-fence lifecycle, closure cutoff, and tombstone authority without relying on this plan for behavior.
- **Unknowns:** Exact archive byte limits and the smallest complete set of App/runtime mutation entry points remain implementation probes whose results may change constants or file ownership but may not weaken the accepted safety or authority boundaries.
- **Next action:** Confirm that this durable plan faithfully projects the accepted proposal, commit it, then commission an independent review of the actual owner-document diff before that diff's commit.
- **Predicted observation:** The plan review should find no product decision invented beyond the accepted proposal; the later owner diff should make every new behavior interpretable without reading this plan.

## Acceptance Observations

- R008 is observable through a real local-mode CLI archive produced on one fresh runner and imported on another, with exact transferred SHA and semantic acceptance after rebind and re-export.
- R009 is observable when a locked-out operator can select an active User, produce a resumable `0600` recovery envelope, store it through the existing CLI credential owner, and authenticate without exposing the secret or racing NanoCore startup.
- R010 is observable when an owner deletion either stops before effects, reports pending, completes with exact retained evidence, or returns a truthful recovery state at every crash point; no admitted late mutation publishes after the fence closes, and only the tombstone authorizes new-ID recovery.
- The current App Server and all current host services and containers remain continuously untouched by every local development and verification command.
