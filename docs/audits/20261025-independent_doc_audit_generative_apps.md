---
date: "2026-10-25"
---
# Independent Documentation Audit: Generative-Apps Group

This non-authorizing record holds the generative-apps group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `d818256def07ecebfc0bcc9c85270fde5047341a` (`main` on 2026-10-25). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/generative-apps.md`.
- Specifications: `20260908-generative_kernel_data_operations.md` (GKD) and `20260908-generative_ui_interaction.md` (GUI).
- G3 inspection: two read-only inspector contexts (GA-GKD and GA-GUI). They read code only and ran no tests. The auditor verified each kept finding against the code.

## G2 Core Against Specifications

- GA-G2-01: Core says general data interfaces MUST support useful set-based and transactional operations; GKD defers predicate-wide mutation but provides a transactional batch of up to 50 explicit entries. The batch satisfies the Core rule; no action.
- GA-G2-02: Core says reactivation revalidates schema, dependencies, and authority; GKD says reactivation is unavailable initially. Core states what reactivation requires when it exists; no conflict.
- GA-G2-03: Core requires discoverable limits and refusal conditions; the code exposes only part of them. Issue #512 (see G3).
- GA-G2-04: Core Presentation And Interaction and Observable Conformance agree with GUI; no action.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| GA-GKD-08, 10 | GKD projection: "the ten `kernel.*` operations"; snapshots, rollback, format upgrade, instantiation, and portability not named; a branch name for the landed implementation | `packages/app-api-schemas/src/light-app-definitions.ts:78-170,190-253` defines seven `catalog.light-app-*` and five more Kernel operations, composed into `operation-definitions.ts:154` and joined at `apps/nanocore/src/light-app-definition-operations.ts:321,377-388`; snapshot capture in `generative-kernel/snapshots.ts`, rollback and upgrade at `generative-kernel/commands.ts:398,469`, export and import in `storage/generative-portability.ts`; the branch does not exist | Projection drift | Corrected; the table of ten is unchanged |
| GA-GKD-09 | GKD: the internal Assistant integration "is not implemented by this cutover"; "their implementation remains unavailable" | `apps/nanocore/src/generative-ui/internal-tools.ts:36-48` gives the Assistant the ten Kernel Tools and `generative-ui.publish`; wired at `internal-agents/assistant-tools.ts:153` | Projection drift | Corrected; the owner of the integration is unchanged |
| GA-GKD-01, 02 | GKD: count and rows in one read transaction; 1 MiB request and 2 MiB response limits | `generative-kernel/commands.ts:728-736` two autocommit statements; the 2 MiB check only in `kernel-operation-implementations.ts:53-60` | Code differs from the accepted specification | Issue #510 |
| GA-GKD-07 | GKD line 213: a missing or corrupt app has an explicit unavailable entry, not a fabricated empty schema | `inspectCatalogItem` (`commands.ts:1881-1922`) returns `lifecycle: 'unavailable'`, `schema: null`, `appRevision: 1`, and an empty digest for any id, including one never created | The clause is met for a present app; no record decides the never-created id or the placeholder values | Question Q-156; withdrawn from #510 by comment |
| GA-GKD-03 | GKD: ids are omitted for new entities | `generative-kernel/schema.ts:147-165,178-196` return any supplied id | Code differs from the accepted specification | Issue #511 |
| GA-GKD-04, 06 | Core and GKD: discoverable limits; conflict and validation error details | `generative-kernel/errors.ts:30-37`; conflicts without revisions (`commands.ts:314,412,493,660,1260`); `LIGHT_APP_CAPABILITIES` (`commands.ts:82-95`) lists six limits | Code differs from the accepted Core document and specification | Issue #512 |
| GA-GUI-01, 02 | GUI: supplied themes unavailable; exactly one `createSurface` and one `updateComponents`; refresh expects empty event context | `generative-ui/admit.ts:36,111-118,199-205`; `generative-ui/commands.ts:162-164,326-369` | Code differs from the accepted specification | Issue #513 (low) |
| GA-GKD-05 | `docs/specs/20260703-audit_usage_evidence_records.md:155`: the Kernel AuditEvent names collection/record ids or a bounded affected-set digest (GKD Proposed Design states the same) | `commands.ts:1999-2025` records app, resource, revision, and actor lineage only; the batch passes only `light-app:<appId>` (`commands.ts:1140-1144`) | Code differs from the accepted Audit, Usage, And Evidence Records specification | Issue #514 |
| GA-GKD-11 | GKD line 231: the receipt key is command, request id, and Workspace/app scope; Core protocol lines 550 and 574 | `commands.ts:596-600,945-949` add `actorId` to the scope; `storage/command-request-records.ts:844-849` | Code differs from the accepted specification and Core | Issue #515 |
| GA-GUI-03 | GUI: the native render result embeds the data-model messages, and the URI resolves only the template | `runtime/openkit-generative-mcp.ts:111-128` embeds the template; the data model is in `structuredContent` | Internal ambiguity | Question Q-151 |
| GA-GUI-04 | GUI: a fresh submission gets a fresh id; an uncertain result is inspected, including after reload | `apps/web/src/screens/chat/GenerativePresentationView.tsx:92,110,118-120` keeps the id after an error; no inspection path after reload | Undecided for the reuse; the inspection gap depends on a product path no owner names | Question Q-152 |
| GA-G2-05 | GKD lists joins, aggregation, delete, upsert, and conditional bulk mutation in its scope and acceptance, and defers them elsewhere | GKD Decision and acceptance lines against General Query and Open Questions | Internal inconsistency | Question Q-153 |
| GA-G2-06 | Policy Enforcement Mapping names only the ten Kernel operations | `docs/specs/20260703-policy_enforcement_mapping.md:326-328`; fifteen Kernel and seven catalog operations exist | The policy group did not cover the extra operations | Question Q-154 |
| GA-GUI-05 | GUI frontmatter `updated` predates its projection date | Frontmatter | The audit does not change frontmatter dates | No action |
| GA matches | GKD per-app storage, evolution ceiling, snapshots, schema mapping, query grammar, batch and receipts, limits, meaning references, policy mapping for the ten, Worker supply, retirement; GUI projection files, catalog and retained content, row shape, Item reference, sources and actions, transport and recovery, bounds, authorization | The inspectors' tallies in the audit working space | Match | None |

## G4 Organization

No move, merge, or split is applied.

## G5 Writing

- Proposal wording in Accepted specifications: GKD "This is a proposed integration", "previously proposed", and "This replaces the earlier ... proposal"; GUI "provisionally `PluginWidget`", "Proposed persistence owner", "The persistence proposal below", and "provisional upstream facts". Question Q-155. The heading "Proposed Design And Existing Seams" follows the `Proposed Design` section that `docs/specs/README.md` and `docs/specs/AGENTS.md` require; it stays.
- Dated status narrative: GKD and GUI "As of 2026-10-16". Question Q-155.
- Experience-chosen numbers not marked as a current default: GKD "Fixed initial admission limits", the 1,000 ms lock wait; GUI "Fixed initial bounds". Some bounds may be wire or retained-format limits; the engineer decides which. Question Q-155.
- Undefined labels: GKD R097 and C03; GUI "Tier C". As Q-28: Question Q-155.
- Further experience-chosen numbers: GKD "perPage at most 100" and the "seven-day boundary". Question Q-155.
- Version pins without a stated decision: GUI `@a2ui/react@0.11.0` and `@a2ui/web_core@0.10.7` in its projection. They are projection facts; Question Q-155 asks whether to keep them in the specification.
- GUI names "Material" without a link. Question Q-155.
- GKD and GUI frontmatter `updated` dates predate their projection dates. The audit does not change frontmatter dates; no action.
- The GKD inspector's fourth G2 candidate found no conflict; no action.

## Semantic Preservation

The inventory tool compared the changed file with the group base.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260908-generative_kernel_data_operations.md` (GKD) | 77 unchanged | 10 unchanged | 140 unchanged, 1 removed (`feat/generative-apps-mvp`), 14 added | 26 unchanged | 23 unchanged |

Changed sentences: the GKD Current Implementation Projection, the Assistant sentence in Public And Agent Projections, and two Open Questions sentences. No design rule changed.

## Issues Opened

- #510 `[generative-kernel] Record list reads count and rows outside one transaction, and request and response size limits are missing`, ordinary. After review its third item (unknown app) was withdrawn by comment and the title was changed.
- #511 `[generative-kernel] Callers can choose the stable ids of new collections and fields`, ordinary.
- #512 `[generative-kernel] Conflict and validation errors omit revisions and paths, and capability discovery omits most limits`, ordinary.
- #513 `[generative-ui] Presentation admission keeps extra keys such as theme on the declaration messages, and refresh accepts event context`, low.
- #514 `[generative-kernel] Kernel AuditEvents name no collection or record ids and no affected-set digest`, ordinary.
- #515 `[generative-kernel] Kernel receipt key includes the actor, so a reused request id from another actor does not get idempotency_key_conflict`, ordinary.

## Questions For The Engineer

### Q-149. Withdrawn after review

The Audit, Usage, And Evidence Records specification decides the Kernel audit content. The finding is issue #514.

### Q-150. Withdrawn after review

GKD and Core protocol agree on the receipt key. The finding is issue #515.

### Q-151. What does the native render result embed?

- Context: GUI says the native result embeds the data-model messages and that the URI resolves only the retained template; the code embeds the template and carries the data model in `structuredContent`.
- Options: (A) State the code behavior: the embedded resource is the template, and the data model is in `structuredContent`. (B) Embed the data-model messages.
- Recommendation: A, as it agrees with the URI rule.
- Meanwhile: no change.

### Q-152. How does the web client inspect an uncertain submission?

- Context: GUI requires a fresh id for each intentional submission and inspection rather than resubmission after an uncertain result, including after reload; the web view keeps the id after any error and has no inspection path after reload. This is a question and not an issue because the view does not tell a definite failure from an uncertain one, and reuse of the id after an uncertain failure is the safe retry: a Kernel receipt turns an edited resubmission into `idempotency_key_conflict`.
- Options: (A) Issue a fresh id after a definite failure, and name the inspection operation the view uses after reload. (B) State that reload loses the pending id and the user submits again.
- Recommendation: A.
- Meanwhile: no change.

### Q-153. Which GKD scope items are current?

- Context: GKD Decision and acceptance list joins, aggregation, delete, upsert, and conditional bulk mutation; General Query and Open Questions defer them to later extension contracts.
- Options: (A) Move them to Deferred and narrow the acceptance list to the initial contract. (B) Keep both.
- Recommendation: A.
- Meanwhile: no change.

### Q-154. Which Policy mapping applies to the extra Kernel and catalog operations?

- Context: Policy Enforcement Mapping names the ten Kernel operations only; `kernel.apps.instantiate`, `kernel.schema.activate`, `kernel.snapshots.list`, `kernel.snapshots.rollback`, `kernel.format.upgrade`, and the seven `catalog.light-app-*` operations have no row there. Each of these definitions already carries a `policyOperation` (for example, `kernel.snapshots.list` maps to `workspace.read`), so option A projects facts the code already holds.
- Options: (A) Add rows that state their current permission and mutation posture. (B) Leave them to their definitions.
- Recommendation: A.
- Meanwhile: no change.

### Q-155. How should the generative-apps proposal wording, dates, numbers, and labels be fixed?

- Context: the G5 items above, including the version pins and the unlinked "Material".
- Options: (A) As Q-28: remove proposal, provisional, and dated wording or move it to change records, mark experience-chosen numbers as current defaults where they are not wire or retained-format limits, and replace each label with its meaning or a link. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

### Q-156. What does app get return for an app id that was never created?

- Context: GKD line 213 requires an explicit unavailable entry for a missing or corrupt app, not a fabricated empty schema; the code returns an unavailable entry for any id, with `schema: null`, `appRevision: 1`, and an empty digest.
- Options: (A) Return `not_found` for an id with no app directory, keep `unavailable` for a present but unreadable app, and carry no placeholder revision or digest values. (B) State that any id returns an unavailable entry.
- Recommendation: A, because an unavailable entry for an id that never existed reads as a real app.
- Meanwhile: no change.

## Independent Review

A fresh Opus context, dispatched as the Reviewer role, read the spec diff, this record, the ledger rows, the inventory, the inspector reports, and the cited code. Verdict: accept with fixes. Dispositions:

1. GA-GKD-05 is decided by `docs/specs/20260703-audit_usage_evidence_records.md:155`: accepted. Issue #514 opened; Q-149 withdrawn.
2. GA-GKD-11 is decided by GKD line 231 and Core protocol lines 550 and 574: accepted. Issue #515 opened; Q-150 withdrawn.
3. The changed projection sentence named the wrong files for rollback, format upgrade, and instantiation: accepted. The sentence now names `snapshots.ts`, `commands.ts`, `light-app-definition-operations.ts`, and `generative-portability.ts` for their parts, and the inventory was rerun.
4. GA-GKD-07 has no clear rule for a never-created id: accepted. Moved to Q-156; item 3 of #510 withdrawn by comment and the title changed.
5. The projection implied that the App API exposes only ten Kernel operations: accepted. The sentence now says the derived projections also expose the five further Kernel and seven catalog operations, and the next sentence says "ten tabled".
6. G5 candidates without a disposition: accepted. Added to G5 and Q-155, or recorded as no action.
7. Q-152 reasoning: accepted. Added to its context.
8. Line references: accepted. Corrected in the GA-GKD-04 and GA-GKD-11 rows.
9. Q-154 context: accepted. The existing `policyOperation` values are named.

## Checks

- `node scripts/validate-doc-model.mjs`: validated 675 documents.
- `node scripts/generate-doc-index.mjs`: wrote `docs/INDEX.md` (one added row for this record).
- `pnpm check:repo`: exit 0, with 4 warnings and 17 infos that existed before this group.
- The content scan of the staged diff found no emails, tokens, credential paths, private hostnames, local absolute paths, or Vietnamese text.
