---
type: change-plan
status: verified
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
- The accepted portable filename is `.openkit-workspace.tar.zst`; Node 24 provides native Zstandard streams, while the strict importer rejects PAX extensions and therefore requires a matching strict USTAR producer.
- Existing imports preserve the source Workspace ID when available and remint only on collision. Existing foreign server-managed handles are over-readable, while local-mode CLI and Better Auth sessions are the only current canonical-user import authorities; server-mode bearer credentials are deliberately insufficient.
- Existing `credential.store` accepts only the strict `{ token }` input. The data-root lock owner already exists, but recovery must hold one acquisition across the complete command to prevent NanoCore startup races.
- `workspace_registry` already has `active`, `deleting`, and `deleted` states, and ordinary role resolution accepts only `active`. It does not identify an in-progress deletion request or its artifacts, and the current terminal command receipt cannot own intermediate phases.
- The current concrete `legal-hold` record owners are `evidence_bundles.retention_class` and the strict `retentionClass` inside each persisted `workspace_quarantine_records.payload_json`. Portable export excludes deployment-local ownership, membership, invitation, administrator recovery, and complete Core-local audit facts, so it cannot be the sealed audit closure.
- The existing migration implementation applies only mutable `0000_setup.sql` to a fresh ledger and intentionally refuses predecessor ledgers. R003 therefore needs a separate accepted forward-migration owner before deployment install, upgrade, and rollback can be truthful.
- Cursor CLI Fable 5 could not inspect the proposal because the account reached its usage limit. The authorized registered Verifier returned three `Reframe` decisions, then `Continue` after the fourth proposal closed archive authority, CLI applicability, credential effect-domain, deletion lifecycle, concurrency, and closure-authority blockers.

## Accepted Direction

### R008 — Stream One Portable Archive Without A Foreign Handle Registry

- Reuse the existing verified export tree and verifier. Reject any file or derived directory path that cannot fit the strict POSIX USTAR name and prefix fields during export creation and offline verification, then stream deterministic headers and bodies through Node Zstandard without buffering complete archive bytes, emitting extensions, or creating a second server archive.
- Require current source-owner `workspace.export` authority for every server-managed handle operation regardless of deployment lineage, and reject unrelated-deployment handles. A foreign deployment identity is lineage only and may enter import solely through the one-shot archive body.
- Implement one-shot archive dry-run and import through request-owned `0700` staging directories and `0600` files created exclusively without link following. Bound compressed bytes, expanded bytes, entry count, and per-entry bytes with accepted code constants; reject unsafe paths, duplicate entries, links, special files, extras, omissions, and verifier failures.
- Delete only the current request's staging in `finally`; before listener binding, boot cleanup may remove the dedicated request-staging namespace because no request can be active. No running request scans another request's staging.
- Preserve the source Workspace ID when it has no registry, memory, or disk collision and reuse the existing deterministic remint rule on collision. The importer becomes the only owner, while repository and Vault references remain unbound.
- Add streaming Core Client methods and local-mode bundled CLI operations for archive download, dry-run, and import. CLI download uses `O_CREAT|O_EXCL`, mode `0600`, rejects existing destinations and links, leaves an exclusively created partial destination after transfer failure instead of racing pathname cleanup, and never encodes archive bytes as JSON.
- Keep server-mode canonical-user CLI credentials out of scope. The accepted terminal user path is the implicit local actor; Better Auth sessions remain the existing server-mode user surface.

### R009 — Hold One Lock Across A Resumable File-First Recovery

- Add stopped-server `openkit-operator admin recovery-users` and `admin recover-access` commands. Both acquire the existing data-root exclusive lock before opening a database and retain that same lock through query or commit, file and directory `fsync`, database close, and final command completion.
- Recovery targets one explicitly selected existing active User and creates one `server-admin` token through the current access-token owner only after an exact confirmation literal binds that User and expiry. The expiry is strictly future and at most 24 hours from first command execution. Recovery does not create or reactivate a User, modify a password, reopen bootstrap, revoke unrelated tokens, or grant Workspace content authority.
- Make the exact output path the attempt identity. On an absent path, generate the request ID, Token ID, and secret once and publish their strict `0600` recovery envelope with `O_CREAT|O_EXCL` before committing the matching token hash and redacted AuditEvent in one SQLite transaction; callers do not select a request ID.
- A retry with the same output, owner, expiry, and confirmation resumes an unexpired inactive file-before-database result or confirms a matching committed result. Missing, conflicting, expired-inactive, or contradictory file, token, request, command-input, or Audit state returns `recovery_required`; no retry overwrites or deletes the only credential copy.
- Extend `credential.store` with one strict union between its current `{ token }` shape and the complete recovery envelope. Both paths pass only the token to the existing endpoint credential store.

### R010 — Fence Mutation And Make The Registry Tombstone The Only Recovery Authority

- Check every concrete legal-hold owner before creating an export or changing registry state. The first implementation checks both `evidence_bundles.retention_class = 'legal-hold'` and schema-validated `workspace_quarantine_records.payload_json.retentionClass = 'legal-hold'` through one deletion predicate, with one blocking regression per owner and a coverage regression that must grow with any future legal-hold owner.
- Add one file-backed deletion-request owner under `server/exports/workspace-deletions/<workspaceId>/<requestId>/request.json`. Under exclusive per-Workspace admission, an exact request replays, changed input under its id returns `idempotency_key_conflict`, a different nonterminal request returns in-progress, multiple nonterminal or structurally contradictory durable records return `recovery_required`, and unrelated terminal history does not block an unused request id; exclusive creation binds the request, original owner, expected revision, exact irreversible confirmation, and Workspace, while atomic same-directory replacement advances only the fixed deletion phases and binds exact recovery export, closure, staging, and terminal identities.
- Add one concrete in-process per-Workspace mutation admission fence at current App mutation and late runtime-publication entry points. A mutation enters and increments only while the gate is open, rechecks current authority before publication, and exits in `finally`; deletion closes the gate, waits admitted writes and named runtime owners to become quiescent, and never stops a service or cancels a worker automatically.
- While the exclusive fence remains closed, CAS `active` to `deleting`, create and verify the portable recovery export, and seal an independent closure under `server/exports/workspace-closures/`. The closure cutoff is after the deleting transition and before the terminal deletion AuditEvent; it contains deployment-local governance and retained-evidence facts plus the exact recovery-export reference.
- Rename the canonical Workspace root to request-owned deletion staging, then transactionally CAS `deleting` to `deleted`, retain the original owner's required `active` `editor` membership only as non-authorizing history, mark every other active membership removed, revoke every pending invitation, and record the terminal AuditEvent and command receipt. The deleted registry remains the sole authorization gate and recovery authority. Cleanup failure reports `deleted_with_retained_staging`; phase, digest, path, registry, or tombstone contradiction reports `recovery_required`.
- Rebuild nonterminal mutation fences before listener binding after process restart, but do not automatically resume destructive phases. A disabled original owner observed before the `deleting` transition safely terminates the request as blocked with no export or registry effect; after `deleting`, only the active original owner may use exact-request non-content retry authority, and a disabled or different actor terminates in `recovery_required` without another destructive action. Ordinary routes never reactivate `deleting` or `deleted` Workspaces.
- The registry status owns the `active`, `deleting`, and `deleted` lifecycle state; the file-backed deletion request is the unique intermediate-phase and retry owner; and the deleted registry tombstone is the unique recovery authority. The closure is non-authorizing evidence, and any disagreement between these owners and projections fails closed. The terminal deletion audit, retained original-owner membership, removed non-owner membership rows, and revoked invitation rows remain in Core, while the closure is only the remaining Workspace content and evidence record.
- Closure recovery requires the original owner identified by the tombstone and reuses R008 import. The tombstone creates an ID collision, so the existing import rule remints a new Workspace ID; no server administrator content bypass or original-ID reuse is added.

## Lowest-Sufficient Regression

- Begin each owner slice with one focused RED seam that names the expected failure before implementation. R008 first proves the missing archive route and unsafe foreign handle boundary; R009 first proves the missing stopped-server recovery command and complete-lock requirement; R010 first proves mutation can publish after deletion admission and no durable request owns a crash window.
- R008 focused checks use only temporary local-mode data roots and process-local apps. They cover owner-only download, rejection of every unrelated server-managed handle, staging modes and exclusivity, bounded streams, malicious tar entries, corruption, concurrent request isolation, ID preservation and collision reminting, new ownership, unbound references, and CLI file behavior.
- R009 focused checks use only a temporary server-mode data root. They cover discovery, exact confirmation, past, exact-24-hour, and over-limit expiry, lock contention and startup exclusion, `0600` exclusive publication, generated request identity, same-output file-before-database and database-after-file retry, contradictions, audit and output redaction, strict credential-store union inputs, and one authenticated request with the recovered token.
- R010 focused checks use only temporary Workspaces and process-local apps. They cover exact confirmation, both current legal-hold owners, mutation admission races, late publication rejection, quiescence pending, same-request replay, same-id changed-input conflict, a new request after unrelated terminal history, different-request in-progress, multiple-nonterminal and structurally contradictory-record rejection, each deletion-request phase and crash point, active-original-owner retry after `deleting`, original-owner disable on both sides of that transition, the retained original-owner membership, removed non-owner memberships, revoked pending invitations, ordinary role-resolution and active-list denial behind the deleted registry, pre-terminal closure cutoff, unique tombstone authority, boot fence reconstruction, retained staging truth, and collision-derived recovery ID.
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
- **Current facts:** R008 is closed through `607d34d`, and R009 is closed through `949cad1`. R010 now exposes owner deletion and tombstone recovery through the App API, Core Client, bundled CLI, and Skill; keeps one strict file-backed request across crash phases; fences direct routes, authorized Workspace collections, own-invitation discovery, and the registered late publisher; waits every named runtime owner; drains admitted mutations before a live owner-disable blocks and reopens a pre-transition request; binds the exact recovery-export and closure manifest-file bytes; retains only the non-authorizing original-owner lineage required by the current trigger; and fails closed on legal hold, durable contradiction, unsafe staging, reappeared canonical storage, or disabled post-transition authority. Typed registries and coverage regressions now make future legal-hold carriers and late publishers explicit. Formatter and lint pass across 557 NanoCore files, NanoCore typecheck and build pass, OpenAPI generation and validation pass, the Skill interface passes 17/17, six affected test files pass 186/186 including deletion lifecycle 15/15, documentation checks pass 86/86, `git diff --check` passes, and the disposable built-artifact process smoke reports `OpenKit NanoCore dual-listener and deletion-recovery built-artifact smoke PASS` after observing the listener-preflight fence and exact same-request continuation.
- **Current method:** Preserve the independently accepted final bytes and integrate them through the existing PR.
- **Frontier:** The independent Verifier returned `CONTINUE`; renewed Reviewer inspection accepted the direct, collection, own-invitation, concurrent-disable, and process-smoke corrections; and the final Auditor returned `ACCEPT` after confirming every prior finding remained resolved. No independent finding remains open.
- **Unknowns:** Git commit, PR checks, and merge remain external integration steps.
- **Next action:** Commit the accepted R010 bytes, fast-forward the existing PR head, wait for exact-head checks, and merge without creating another branch or PR.
- **Predicted observation:** One coherent R010 commit fast-forwards the existing PR head, exact-head checks pass, and the existing PR merges without another branch or PR.

## Closeout Summary

R008 delivers portable Workspace archive transfer, R009 delivers stopped-server administrator credential recovery, and R010 delivers owner deletion with strict fencing, exact retained evidence, tombstone recovery, live-disable reconciliation, and restart continuation. All three slices align with their accepted owners and passed their required independent acceptance gates without touching the current deployment lifecycle.

## Final Verification Evidence

- R008 is observable through a real local-mode CLI archive produced on one fresh runner and imported on another, with exact transferred SHA and semantic acceptance after rebind and re-export.
- R009's packaged stopped-server path is observable in fresh GitHub Actions job [100133607452](https://github.com/lingkaix/openkit/actions/runs/33593999118/job/100133607452), where the operator selected an active User, produced and exactly retried a `0600` recovery envelope, and kept its secret out of captured stdout and stderr while NanoCore remained stopped; the focused process-local recovery regression separately proves authentication through the resulting server-admin token.
- R010 is observable when an owner deletion either stops before effects, reports pending, completes with exact retained evidence, or returns a truthful recovery state at every crash point; no admitted late mutation publishes after the fence closes, and only the tombstone authorizes new-ID recovery. The temporary-data-root built-artifact smoke starts only its own random-port child, observes a fenced read on the first available listener, continues the pre-existing exact request to `cleaned/deleted`, and reports `OpenKit NanoCore dual-listener and deletion-recovery built-artifact smoke PASS` before removing the fixture.
- The current App Server and all current host services and containers remain continuously untouched by every local development and verification command.
