---
date: "2026-10-30"
---
# Independent Documentation Audit: Team Review Of Part 2

This non-authorizing record documents the development team's review and preparation of the second part of the [independent documentation audit](20261023-independent_doc_audit.md) and its [supplement](20261025-independent_doc_audit_supplement.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records verdicts, amendments, and stale claims. It does not authorize design.

## Scope

- Part 2 covers protocol, communication, identity, and policy: 14 Core documents and specifications, plus the generated documentation index.
- The [Part 1 review](20261030-independent_doc_audit_review_part1.md) carries the 18 original audit records unchanged. This part does not rewrite those records or adjudicate documents held under issue #440.
- Source: audit head `6b86ecd05`, merged with `main` `44450f033` as `27c6812b3`. The independent read-only review checked every changed hunk against that main revision and its 126 commits after audit base `5b5ada81c`.
- Application base: Part 1 commit `0a43081ac`, on main `b7098559a`. The 14 normative files had not changed since the reviewed main revision; all audit hunks applied cleanly.
- Review criteria, in order: accepted authority, current implementation truth, rename preservation, cross-document consistency, and repository writing rules. Code supplies implementation evidence, not design authority.

## Verdicts

50 hunks in 14 documents: 45 accepted, 5 amended, 0 reverted. No reverted hunk creates an engineer question.

The five small amendments follow existing owners and need no new decision:

- [Core Client Boundary](../specs/20260528-core_client_boundary.md#client-shape): identify the existing archive-import methods as awaiting removal, not retained contract scope, under [Online Workspace Snapshots And Scoped Recovery](../decisions/20261027-online_workspace_snapshots_and_recovery.md).
- [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md#current-implementation-projection): keep the definition-derived exclusion of secret-returning and non-JSON operations, without the stale eight-stream list. [Operation Definition](../specs/20261002-operation_definition.md) owns projection eligibility; the composed backup download is also streaming.
- [Remote Auth And Credential Bootstrap](../specs/20260704-remote_auth_credential_bootstrap.md#current-implementation-projection): remove both claims that the central private-Thread administrator check remains unimplemented. The common authorizer now passes current administrator eligibility under [Core Policy](../core/policy.md#administrator-eligibility); authenticated Web-session provenance remains required.
- [Policy Enforcement Mapping](../specs/20260703-policy_enforcement_mapping.md#current-implementation-projection): distinguish captured human approval/escalation from Goal-domain escalation, which wakes the Coordinator without a human Pending Request. The existing [Goal-domain projection](../specs/20260703-policy_enforcement_mapping.md#goal-domain-and-container-projection) owns the distinction.
- [Thread Visibility And Sharing](../specs/20260909-thread_visibility_and_sharing.md#current-implementation-projection): describe known-field validation rather than a closed schema. The decoder ignores unknown additions under [Closed Core, Open Extension](../core/contract-evolution.md#closed-core-open-extension); missing Thread feature emission remains a finding.

The 18 reviewed Permissions-to-Policy substitutions preserve requirements and link targets. Engineer direction also restores the one remaining `Core Permissions` link label in Thread Visibility to `Core Policy`, without restoring the obsolete import paragraph. The coordinator reviews this modified revision before landing it.

## Stale Record Claims

The original records remain dated history. Their current applicability differs as follows:

- CM-CCB-01: three archive client methods remain implementation facts, but their import-retention reading is superseded by the online snapshot decision.
- CM-RMCP-03 and Communication Review item 2: the eight-stream inventory omits the composed operational backup download. The separate MOVE input is still uncomposed.
- ID-RA-03, Q-57, and PO-TVS-04: the central private-Thread administrator gap is closed. ID-RA-04 also needs actual authenticated Web-session provenance, not a constructed session actor for a Token owner.
- ID-MU-04: Web implementation evidence comes from the membership and invitation code and browser tests, not independently from the audit's own baseline correction. S10 ownership predates the audit.
- PO-PEM-01: the unconditional escalation-to-Pending-Request description already missed the Goal-domain branch at the audit base.
- PO-TVS-01: missing Thread feature emission remains true, but the correction's closed-schema wording was inaccurate.
- SUP-C-06 and Supplement Review item 1: 52 replacements in 24 documents is the historical supplement count. The merge retained one former label; this part now corrects it.
- Supplement #522/#523: the former import-owner and selective-export remedies no longer define accepted work. The [snapshot decision](../decisions/20261027-online_workspace_snapshots_and_recovery.md) retires ordinary import; the [export decision](../decisions/20261027-workspace_export_administrator_only.md) requires administrator-only complete export.

## Open Contradictions

This record decides none of these; they remain with the owning questions or the held groups:

- CM-WCP-05 / Q-41: Worker Control retains the one-Turn-per-Harness claim; this part changes attempt and interrupt projections, not concurrency authority.
- PO-PEM-02: Core Client still names the deleted supervise-step route outside the reviewed changes.
- Unchanged Core Client and OpenAPI import-binding text still needs the snapshot cutover qualification. It cannot override the newer retirement decision or its held backup owner.
- Multi-User's broad implemented inventory does not prove completion of the newer online snapshot, deletion, and recovery target, whose decision marks the cutover partial.
- Thread Visibility's unchanged file-backed-authority sentence needs reconciliation with the held storage and control-store owners. Missing Thread feature emission remains issue #471.

## Validation

- Frozen-lockfile installation with scripts disabled and documentation-index generation passed. The required slot-managed `check:repo` passed with all normative edits present; it reported 69 existing warnings and 17 informational diagnostics without applying fixes. Final record annotations and the index passed focused documentation checks afterward.
- A repeated full-check invocation timed out while awaiting a shared CPU slot, before check execution. Its queued successor was cancelled; neither produced another test result.
- Safety-scan review hits are inherited from Part 1: labels in the [Architecture audit](20261024-independent_doc_audit_architecture.md), labels and explicit path placeholders in the [Knowledge audit](20261025-independent_doc_audit_knowledge.md), and historical machine constraints in [Deployment Host Requirements](../specs/20260909-deployment_host_requirements.md). These are quoted history and technical placeholders, not new private paths, credentials, or live-host evidence. The scan's review exit is accepted only for those explained hits.
