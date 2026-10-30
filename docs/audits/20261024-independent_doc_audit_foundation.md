---
date: "2026-10-24"
---
# Independent Documentation Audit: Foundation Group

This non-authorizing record holds the foundation group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `4aa0e655f36beb6771201fb4658c1555e6a1c85a` (`main` on 2026-10-24). Issue #440 had no comments and held no group in this scope.
- Core documents: `docs/core/doctrine.md`, `docs/core/core-concepts.md`, `docs/core/README.md`, and `docs/core/AGENTS.md` (audit only, no edit).
- Specifications: `docs/specs/20260709-quick_chat_workspace.md` and `docs/specs/20260711-scheduler_recurring_event_triggers.md`.
- Cited decisions read: `20261015-private_assistant_timeline_and_rolling_context.md`, `20261016-retire_stateless_quick_chat.md`, `20260924-schedule_admission_numbers_are_empirical.md`, `20261002-specification_numeric_values_are_defaults.md`, and `20261014-pre_stable_data_continuity.md`.
- G3 inspection: three read-only inspector contexts (FND-PW for the personal Workspace, FND-RT for recurring triggers, FND-CC for the Core invariants of `core-concepts.md` and a doctrine spot check). They read code only and ran no tests. The auditor verified each finding listed below against the code before it was kept.

## G2 Core Against Specifications

- FND-G2-01: `docs/core/README.md` showed the aspect-file template with a body line `Status: Accepted`. Every current Core document uses YAML frontmatter `status: Accepted`, and the documentation model validates frontmatter. Disposition: editorial fix to the template.
- FND-G2-02: `docs/core/doctrine.md` says that agent-principal activation "remains unclaimed". That is an implementation-status statement inside Core. Code partly activates agent principals for the I16 agent gate (`apps/nanocore/src/policy/statements.ts`, `apps/nanocore/src/policy/agent-gate-provider.ts`, `apps/nanocore/src/policy/README.md:42`), and `docs/specs/20261018-nanocore_interception_and_information_consolidation.md` lists agent-principal authority as Not Started. Disposition: no edit in this group, because the owner of the status fact is the Policy specification set. Carried to the policy group (move the status fact into the owning specification projection) and to the mediation group (the interception projection).
- FND-G2-03: `docs/core/core-concepts.md` says that Protocol owns the concrete trigger-source values, while `docs/core/protocol.md` says that Core Concepts owns `TriggerSource`. Carried to the protocol group, which owns the value list.
- No other conflict between the two specifications and the four Core documents was found. Both specifications cite their Core references and keep the Core vocabulary.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| FND-PW-01 | `20260715-multi_user_workspace_system.md:799` closed sharing error list contains `quick_chat_not_shareable` | `apps/nanocore/src/workspace-sharing-operations.ts:1072` throws `personal_workspace_not_shareable`; `packages/app-api-schemas/src/workspace-sharing.ts:433` lists `quick_chat_not_shareable` | Code differs from a current accepted document | Issue #454. The spec value stays until the engineer chooses the value; the identity group re-checks it. |
| FND-PW-02 | Personal Workspace naming | Code symbols and the identifier derivation input still say Quick Chat, for example `quickChatWorkspaceIdForUser` in `apps/nanocore/src/lib/store.ts:1262` | No record decides whether identity-bearing derivation input is renamed | Question Q-04 |
| FND-PW-03 | Current Implementation Projection names `store.ts` as the owner of the Demo fixture helper | The helper is `createDemoWorkspaceForUser` in `apps/nanocore/src/test-support/demo-store.ts:50` | Projection drift | Projection corrected |
| FND-PW-04 | `implementation: Partial` | Not evidenced either way by the inspector | Low confidence | No change |
| FND-RT-01 | Projection: identifier registry integration "remains pending" | `packages/protocol/src/common/entity-id.ts:14-16` declares `auto`, `occ`, `range`; `apps/nanocore/src/lib/automation-store.ts:105,354,526,588` allocate and derive through the shared API | Projection drift | Projection corrected |
| FND-RT-02 | Projection: migration, boot, publication, audit, portability, contracts, and surfaces "require integration" | `apps/nanocore/drizzle/core/0002_durable_recurring_schedules.sql`, `0006_external_trigger_admissions.sql`; `apps/nanocore/src/index.ts:757`; `apps/nanocore/src/runtime/recurring-turn-publication.ts`; `apps/nanocore/src/audit-events.ts:311`; `apps/nanocore/src/storage/workspace-backup.ts`, `workspace-export.ts`, `workspace-import.ts`, `workspace-restore.ts`, `recurring-portable-history.ts`; `packages/app-api-schemas/src/automation-operations.ts`; `apps/web/src/app/surfaces.ts:207` | Projection drift; owners exist and are wired, end-to-end behavior not verified | Projection corrected without an end-to-end claim. `implementation: Partial` kept, because the Timer And Admission Replacement section still points to a Draft replacement. |
| FND-RT-03 | Projection: User and Server joins "remain pending" | `apps/nanocore/src/app.ts:1576` (User), `:1584` (Workspace), `:1768` (Server scope); `apps/nanocore/src/knowledge/user-memory-schedule.ts:78` admits only the local User | Projection drift | Projection corrected, including that scheduled User maintenance skips any User other than the local User and retains its Thread in that User's personal Workspace |
| FND-RT-04 | "Calendar or timestamp overflow is a refusal, not wraparound." | `intervalSeconds` has no maximum (`packages/app-api-schemas/src/automation.ts:29`); `checkedDate` throws after year 9999 (`apps/nanocore/src/lib/recurring-cadence.ts:97`); the throw happens in the scan transaction (`apps/nanocore/src/lib/automation-store.ts:267`) and in `sealSchedule` (`:490`) | Code differs from a current accepted document | Issue #456 (blocking candidate: recovery) |
| FND-RT-05 | Expired ranges persist "within the same fixed bound" | The stale-pending expiry query has its own limit of 128, separate from the range budget | No record decides whether pending expiries share the bound | Question Q-06 |
| FND-CC-01 | `core-concepts.md:177` User before Workspace before Server | `apps/nanocore/src/app-dashboard.ts:451,594` call `resolveDefaultAgentId` without the User | Code differs from a current accepted Core clause | Issue #455 |
| FND-CC-02 | `core-concepts.md` handoff Item "referencing the new Thread" | The origin Thread receives a `status` Item with no Thread field; `AgentHandoffItemSchema` has no production producer; the link is the receiving Thread's `parentThreadId` and the command receipt | Core and the Chat and Task specifications differ, and no record decides | Question Q-05 |
| FND-CC-03 | Doctrine activation sentence | See FND-G2-02 | Projection drift in the interception specification | Carried to the policy and mediation groups |

The inspectors also reported matches with no finding: Owner kinds, `threadSource`, fixed creation fields, one in-flight Turn per Thread, one current AgentSession per Thread, terminal Turn immutability, handoff Thread creation, Server Thread authority, opaque identifiers, the secret-input refusal, the recurring occurrence states and attempt codes, the three-outcome rule, the ten-minute deadline, the five-second serialized scan, cadence validation, the atomic acceptance transaction, the backlog guard, pause and delete sealing, recurring authorization, and ExternalTriggerAdmission.

## G4 Organization

- FND-G4-01: in `20260711-scheduler_recurring_event_triggers.md` the paragraph about the Server Knowledge daily scan sat after `## Links`. It was moved without change into `### Knowledge Manager daily maintenance`, after the paragraph about the Knowledge Manager owner.
- No merge or split is proposed. The file name `20260709-quick_chat_workspace.md` no longer matches its title, Personal Workspace (Question Q-03).

## G5 Writing

- FND-G5-01: [Documentation Writing](../writing.md) requires a number chosen from experience to be marked as a current default with the property it protects. `20260924-schedule_admission_numbers_are_empirical.md` records that the five-second scan, the ten-minute deadline, and the three committed outcomes are such numbers. A sentence that marks them and names the property each one protects was added at the start of `### Scan and retry lifecycle`. The scan bound of 128 was not marked, because no record calls it empirical.
- Noted, not changed: the label "B01 probe" in `### External events through scheduled pull` is not defined in the specification; `startProductTurn` and `core.sqlite` appear in normative text; "Better Auth" appears in the normative text of the personal Workspace specification. Changing these could change meaning or placement, and issue #218 owns the general alignment of untouched text.

## Semantic Preservation

Counts are from the inventory diff between the group base SHA and the working tree. "Unchanged" items are present at the same text; "added" items are new.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `docs/core/README.md` | 27 unchanged, 0 removed | 0 | 97 unchanged | 24 unchanged | 0 |
| `docs/specs/20260709-quick_chat_workspace.md` | 27 unchanged, 0 removed | 0 | 44 unchanged, 1 added | 25 unchanged | 3 unchanged |
| `docs/specs/20260711-scheduler_recurring_event_triggers.md` | 69 unchanged, 0 removed, 1 added | 1 unchanged | 123 unchanged, 3 added | 27 unchanged | 10 unchanged, 1 added |

The added normative-pattern sentence is the projection fact that scheduled User maintenance admits only the local User. The removed projection status sentences ("remains pending" and "require integration before this feature is complete") are projection text, not normative sentences, and FND-RT-01 to FND-RT-03 record their correction. The moved paragraph keeps its text. No heading anchor or file moved, so no inbound link changed.

## Issues Opened

- #454 `[workspace-sharing] Personal Workspace share refusal emits a code outside the published error enum` (FND-PW-01).
- #455 `[dashboard] Default Agent projection skips the User preference` (FND-CC-01).
- #456 `[recurring-schedules] A very large fixed interval can stop every recurring scan` (FND-RT-04), blocking candidate.

## Questions For The Engineer

### Q-03. Should the personal Workspace specification file keep its Quick Chat file name?

- Context: the file `20260709-quick_chat_workspace.md` has the title Personal Workspace after `20261016-retire_stateless_quick_chat.md`. Change and decision records link to the current path, and those records cannot be edited.
- Options: (A) Keep the path. (B) Rename it and accept broken historical links. (C) Rename it and leave a redirect file.
- Recommendation: A. A path is an identifier, not a description. B breaks evidence, and C adds a compatibility file that NONNEG-001 does not require.
- Meanwhile: no rename.

### Q-04. Should code and identifier derivation input drop the Quick Chat name?

- Context: code symbols such as `quickChatWorkspaceIdForUser` and the derivation input of the personal Workspace identifier still use the Quick Chat name. The derivation input decides retained identifiers.
- Options: (A) Rename code symbols only and keep the derivation input. (B) Rename both, which changes every personal Workspace identifier at the pre-stable reset boundary. (C) Keep both.
- Recommendation: A. Symbol names are free to change, but the derivation input is identity-bearing, and changing it gives no user value.
- Meanwhile: no change; this needs code work, which the audit does not do.

### Q-05. Must the origin-Thread handoff Item itself reference the receiving Thread?

- Context: `core-concepts.md` says that the originating Thread retains a handoff Item referencing the new Thread. `20260704-chat_mode_assistant.md` also accepts a status Item or a read model that maps back to the Thread. Code writes a status Item with no Thread field; the receiving Thread links back through `parentThreadId`.
- Options: (A) Add a receiving-Thread reference to the Item (additive). (B) Amend Core to accept the reverse `parentThreadId` link and the command receipt as the reference. (C) Leave both texts.
- Recommendation: A. Imported and replayed history then finds the receiving Thread from the origin Thread alone, without a receipt ledger.
- Meanwhile: no document change.

### Q-06. Do stale pending expiries share the per-scan write bound of expired ranges?

- Context: the recurring specification bounds live candidates to 128 per scan and persists expired ranges "within the same fixed bound". Code expires up to 128 stale pending occurrences in a separate step, so one scan can write up to 128 expiries and 128 ranges.
- Options: (A) Read the bound per phase and state that in the specification. (B) Make code share one write budget.
- Recommendation: A. The current behavior is already bounded, and A needs only a clarifying sentence.
- Meanwhile: no change.

### Q-07. Does the "Migration preserves" acceptance bullet of the personal Workspace specification still apply?

- Context: the Observable Acceptance list says "Migration preserves existing identities, Threads, Knowledge, ownership, and tombstones". The Decision section of the same specification and its projection say that no `quick-chat` conversion happens before `v0.1.0` and that the prerelease reset is the cutover boundary. Both texts landed in the same commit.
- Options: (A) Replace the first clause with "No pre-`v0.1.0` `quick-chat` record is converted", and keep "restart never creates a duplicate home or resets data". (B) Keep the bullet for a future post-stable migration.
- Recommendation: A. The bullet asserts a migration that the accepted Decision excludes.
- Meanwhile: the bullet is unchanged, because the edit removes an acceptance criterion.

### Q-08. How should a past audit record that contains a local absolute path be handled?

- Context: `docs/audits/20261003-goal_mode_coordination_terminal_archive.md` contains a local absolute path that names a machine user. The repository is public, and audit records are never edited.
- Options: (A) Accept it as historical evidence. (B) Approve a one-time redaction of that record.
- Recommendation: B. Confidentiality is a Safety Kernel concern, and the path carries no evidence value.
- Meanwhile: no change.

## Proposals For Agent Files

- `docs/core/AGENTS.md`: no change is proposed from this group.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory counts, and checked the cited code itself. Verdict: accept with changes. Dispositions:

1. The User-scope projection sentence was incomplete, because scheduled User maintenance admits only the local User and retains its Thread in the personal Workspace. Accepted; the sentence was corrected after the auditor read `apps/nanocore/src/knowledge/user-memory-schedule.ts:76-80`.
2. "The interval bounds admission latency" read as a guarantee, although the timer is soft. Accepted; it now says that the interval sets the scan cadence and so the usual admission latency.
3. "Generated App API contracts" was supported only by the schema source. Accepted; it now says "App API contract schemas".
4. This section and the Checks section were placeholders. Accepted; filled here.

The Reviewer confirmed the moved paragraph is byte-identical, the current-default sentence adds no rule, the spot-checked findings are supported, the inventory counts match the diff, and the diff has no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (662 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
