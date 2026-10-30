---
date: "2026-10-30"
---
# Independent Documentation Audit: Team Review Of Part 1

This non-authorizing record documents how the development team reviewed and landed the first part of the [independent documentation audit](20261023-independent_doc_audit.md) and its [supplement](20261025-independent_doc_audit_supplement.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records verdicts, amendments, and stale record claims. It does not authorize design.

## Scope

- Part 1 covers the foundation, contract-evolution, and architecture groups, and `docs/INDEX.md`.
- This landing also adds the 18 audit records of pull requests #521 and #530, unchanged, as dated history. Later parts land the documentation corrections of the other open groups.
- Source: the audit head `6b86ecd05`, merged with `main` `44450f033`.
- Review: one fresh, independent, read-only context gave a verdict on every changed hunk against the current `main`. Criteria, in order:
  1. authority: an accepted decision or the owning specification, never the auditor's own opinion;
  2. truth on the current `main`;
  3. semantic preservation of renames;
  4. consistency with the other Core documents and specifications;
  5. the writing rules.

## Verdicts

56 hunks in 21 documents: 51 accepted, 5 amended, 0 reverted.

The amendments follow existing owners. They need no new decision.

- [Contract Stability Baseline](../specs/20260715-contract_stability_baseline.md): ordinary portable import is a retiring implementation, not the accepted preservation path, under the [online Workspace snapshots and recovery decision](../decisions/20261027-online_workspace_snapshots_and_recovery.md). A catalog listing does not by itself make an operation callable with a given credential. Ordinary user bearers cannot invoke the own-invitation, leave, and deleted-recovery operations.
- [Web Product Surface Projection](../specs/20260628-web_product_surface_projection.md): the catalog now has 340 entries, 89 of them server-scoped; the 248 included operations are unchanged. The two archive-import roadmap entries describe the retiring implementation and authorize no future Web import workflow.

## Stale Record Claims

The audit records stay unchanged as dated history. These claims are stale on the current `main`:

- AR-WEB-01 and AR-WEB-02: the totals of 337 entries and 86 server-scoped entries are now 340 and 89, after three composed server backup operations were added.
- CE-CSB-04: "the counts are correct" mixes up being listed in the catalog with being callable by a bearer credential. All 16 current lifecycle definitions declare administrator credentials, and only seven declare `user-bearer`.
- SUP-S-08 and Q-184: the online Workspace snapshots and recovery decision overtakes the reading of both archive-import operations as deferred Web work.
- SUP-C-06 and item 1 of the supplement's Review: 52 replacements in 24 documents is the supplement's historical count. On the merged delta the Permissions rename has 51 replacements in 24 documents. The merge kept one `Core Permissions` link label from `main` in the [Thread Visibility And Sharing](../specs/20260909-thread_visibility_and_sharing.md) specification; Part 2 owns it.

## Open Contradictions

This record decides none of these. They stay with their questions or with the held groups of issue #440:

- Q-202: the shipped Web offers a monthly UTC cadence, but the Web owner states no calendar choices. The implementation observation is recorded; a Web requirement is not.
- AR-WFB-01 and Q-17: the code differs from the held Work Model.
- The Web UI rebuild stack claims a complete Composer, but the held unified conversation composer specification is Partial.
- The physical-file rows of the retained format register conflict with the held control-store model: CE-RFR-01, CE-RFR-02, CE-RFR-06 to CE-RFR-12, and Q-16.

The questions of these groups are answered in a later record.
