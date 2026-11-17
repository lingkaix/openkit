---
date: "2026-11-15"
---
# Independent Documentation Audit: Evidence Group

This non-authorizing record holds the evidence group of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15). Issue #440 releases this group.
- Core document: `docs/core/evidence.md` (EV).
- Specifications: `20260703-audit_usage_evidence_records.md` (AUE) and `20260731-operational_telemetry_standardization.md` (OTS).
- Cited records read: the [retention completeness decision](../decisions/20261019-work_data_retention_completeness.md), the [full model I/O switch decision](../decisions/20260921-full_model_io_switch_default_off.md), and the [BWM support decision](../decisions/20261018-bwm_support_and_information_consolidation.md).
- G3 inspection: two read-only inspector contexts (AUE, OTS). They read code only and ran no tests. The auditor verified each kept finding against the code at the base SHA.

## G2 Core Against Specifications

- EV-G2-01: EV (Decision Trace) ended "implementation is Not Started". Core is implementation-neutral. Removed. The fact is still true: no Core Decision Trace view exists in code (`PolicyDecisionTrace` in `packages/policy-kernel/src/index.ts` is the policy evaluator's own trace). The BWM decision names the view a later view; the accepted [NanoCore interception specification](../specs/20261018-nanocore_interception_and_information_consolidation.md) owns it (Decision Trace And Provenance, row C08, marked later).
- EV-G2-02: EV (Capture Coverage) held a status list ("Today the implementation defaults are off ... the current implementation remains partial with explicit named completeness gaps ..."). The status list is removed. The first correction kept "Implementation defaults stay off until the final activation"; the independent review showed that this turns a status fact into a rule, contradicts "Capture Coverage defaults to on" in the same section, and cites a decision whose default-off disposition the [retention completeness decision](../decisions/20261019-work_data_retention_completeness.md) replaced, so the whole sentence is removed. The implementation default (`apps/nanocore/src/config/runtime-config.ts:337`) is a gap row of the work data retention format, and issue #732 now also tracks the default-on resolution. The seven named gaps are rows of the gap table in the [work data retention format](../specs/20260921-work_data_retention_format.md), which the storage group corrected (ST-WDR-01, issue #732).
- EV-G2-03: AUE (Agent Data Mapping) restates Core storage (Agent Data Retention And Deletion). The two agree. No action.
- EV-G2-04: AUE gives `restricted-raw` a bounded retention window; Core storage says that it is an access class, not a duration. Storage-group Question Q-207.
- EV-G2-05: OTS defers the closed lifecycle stage vocabulary to the journal mapping, and the Draft DECS maps to "the telemetry owner's ten stages"; neither fixes the strings. Question Q-225.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| EV-AUE-01 | AUE (Recurring Trigger Attribution): "These producers are target design, not currently implemented coverage." | `apps/nanocore/src/storage/automation-definition-native.ts:247,323` and `apps/nanocore/src/storage/recurring-attempt-native.ts:100` write all seven named actions in the same Core transaction as the mutation | Projection drift | Corrected to name the producers |
| EV-AUE-02 | AUE (Execution-Substrate Epoch Boundaries): "Neither epoch boundary is implemented today" | `apps/nanocore/src/runtime/nanohost-epoch-audit.ts:83,117` define both recorders; no production file calls them | Code differs from a current accepted document (AUE Producer Obligations and Execution-Substrate Epoch Boundaries) | Projection corrected: the recorders exist without a production caller; the consequence for diagnostics is kept. Issue #741 |
| EV-AUE-03 | AUE projection names `runtime/workspace-sync-records.ts` and `runtime/workspace-apply-results.ts` as emitters | Both re-export; the emitters are `apps/nanocore/src/storage/workspace-stage-review-records.ts:130` and `apps/nanocore/src/storage/workspace-apply-result-records.ts:106` | Projection drift | Corrected to name the `storage/` owners |
| EV-AUE-04 | AUE: `runtime/goal-owner.ts` emits Goal audit rows | Rows exist through `applyControlGoalCommand` and the control-store worker; the file itself has no audit call | Indirect owner path | No action |
| EV-AUE-05 | AUE: `restricted-raw` retained for a bounded window | See EV-G2-04 | Undecided | Storage-group Question Q-207 |
| EV-AUE-06 | AUE: Core storage owns the closed retention-class vocabulary; the deletion predicate parses every quarantine record | `apps/nanocore/src/runtime/workspace-sync-outcomes-v1.ts:83` and `packages/app-api-schemas/src/workspace-sync.ts:439` carry `restricted-evidence`; the work data retention format records the class question as pending | Undecided | Question Q-226 |
| EV-AUE-07 | AUE (Security Event Projection): each producer supplies its listed fields | `server.config.update`, `channel.pairing.bind`, `channel.pairing.unbind` and `auth.revoked-credential-presented` have consumers (`apps/nanocore/src/storage/security-trigger-codecs.ts:84,88,91`) and no producer | Code differs from a current accepted document for `server.config.update`; the other three rows are marked "(new)" | Issue #737 (security group) |
| EV-AUE-08, -09, -10 | AUE: five scheduler restart-recovery audit events; AuditEvent and UsageRecord "should carry" field lists; "every" audit, usage and capability-call row carries `ownerScope` | No producer for the five events; `packages/protocol/src/models/audit.ts` and `usage.ts` lack the listed fields; `owner_scope` exists only on `permission_decisions` and `vault_use_records` | Undecided: SHOULD-level target lists, and AUE elsewhere accepts the row form for cache and cost | Question Q-228 |
| EV-AUE-11 | AUE says "Implementation is Partial" for Workspace deletion and "now-implemented Workspace deletion closure" | `apps/nanocore/src/workspace-deletion-operations.ts` and `workspace-deletion-evidence.ts` implement the closure | Status wording | Question Q-229 |
| EV-AUE-12, EV-OTS (frontmatter) | `updated` dates | Git history | Metadata | No action |
| EV-OTS-01 | OTS projection: unsupported exporter headers disable "telemetry" | `apps/nanocore/src/telemetry.ts:155-158` guards only the external exporter; OTS says "disables external export" in two other places | Internal contradiction | Corrected to "external export" |
| EV-OTS-02 | OTS projection: "The locked `@opentelemetry/otlp-transformer` 0.221.0"; semantic conventions 1.41.1 "already resolved in the lock" | `apps/nanocore/package.json:54` pins 0.301.0; `pnpm-lock.yaml` resolves only `semantic-conventions@1.45.0` | Projection drift | Corrected: the facts were inspected on 0.221.0 and are not re-inspected on 0.301.0; the lock resolves only 1.45.0 |
| EV-OTS-03 | OTS (Stage-Duration Histogram): one sample per ended stage-step under the journal mapping | `withLifecycleStageTelemetry` (`apps/nanocore/src/telemetry.ts:330-420`) samples process-local wrappers with eight stage values | Code differs from a current accepted document; journal-backed statistics are already stated as not complete | Projection corrected; issue #742; the stage set is Question Q-225 |
| EV-OTS-04 | OTS: "Stage follows the journal mapping"; DECS: "map to the telemetry owner's ten stages" | Neither document fixes the attribute strings; code has eight; `deliver-steer` has no row | Circular ownership | Question Q-225 |
| EV-OTS-05 | OTS: "Worker kind is release-defined, or `internal`/`unknown`" | `apps/nanocore/src/telemetry.ts:56` has `claude-code` and lacks `deepseek`; `packages/worker-shim/src/adapter-registry.ts` registers `deepseek` and no `claude-code` | Code differs from a current accepted document | Issue #727 |
| EV-OTS-06 | OTS projection: "bounded OTLP/HTTP trace export" | `apps/nanocore/src/telemetry.ts:169-181` also exports metrics | Projection drift | Corrected to "trace and metric export" |
| EV-OTS-07 | OTS: the Collector is pinned in "the implementation dependency lock and deployment assets" | No deployment asset pins a Collector; OTS states that live Collector proof is not executed | Wording precision | Question Q-229 |

## Held G1 Probe Findings

| Item | Verdict | Disposition |
| --- | --- | --- |
| M2-G10 | Stands: AUE names legal holds but no set or release operation, record or authority; code only reads `legal-hold` | Question Q-227 |
| M3-G26 | Partly: AUE names token, security, recurring, epoch and capability actions; Workspace membership, deletion and ownership actions exist in code only | Round-1 Question Q-01 (delegated sweep) |
| M4-G36 | Resolved: EV states default on under the retention decision, which replaced the default-off disposition; the implementation default is a gap row of the work data retention format (#732) | No action |
| M8-G42 | Partly: the local sink is implemented and needs no endpoint; sink file names and the Turn-view operation are unspecified | Round-1 Question Q-01 for the file names; the Turn view is stated as not implemented |

## G4 Organization

No move, merge, or split is applied.

## G5 Writing

Dependency versions and `unpkg` links in the OTS projection decay with each lock change. Question Q-229.

## Semantic Preservation

| File | Normative sentences | Other sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- | --- |
| EV | 59 unchanged | 181 unchanged, 1 changed, 1 removed | 4 unchanged | 56 unchanged | 23 unchanged | 11 unchanged, 1 removed |
| AUE | 119 unchanged, 1 changed | 644 unchanged, 3 changed | 13 unchanged | 277 unchanged, 5 added (file paths) | 38 unchanged | 11 unchanged |
| OTS | 101 unchanged, 1 added | 426 unchanged, 5 changed | 30 unchanged, 2 added (versions) | 138 unchanged, 2 added | 39 unchanged | 25 unchanged |

- EV: the Decision Trace sentence loses only the status clause. The Capture Coverage paragraph loses the status sentence and with it the only link to the full model I/O switch decision, whose default-off disposition the retention decision replaced; the default-on rule, the resolution order, the no-backfill rule and the explicit-gap rule are kept, and the gap list stays with the gap table owner.
- AUE: the changed normative sentence keeps "diagnostics must not claim that audit or usage is complete" and the consequence for epoch diagnostics.
- OTS: the exporter-header sentence narrows "disables telemetry" to "disables external export", which two other OTS sentences already state. The added sentence that the script counts as normative is the lock fact ("resolves only 1.45.0"), not a rule. No acceptance item was removed.

## Issues Opened

- #727 `[telemetry] The worker-kind set omits the deepseek adapter and keeps claude-code, which has no adapter`, low.
- #741 `[audit] The runtime.epoch.invalidate and runtime.epoch.ready recorders have no production caller`, low.
- #742 `[telemetry] The stage-duration histogram samples process-local wrappers, not ended journal stage-steps`, low.
- A comment on #732 extends it to the server default against the default-on target.
- EV-AUE-07 is in the security-group issue #737.

## Questions For The Engineer

### Q-225. Which owner fixes the closed lifecycle stage vocabulary?

- Context: OTS says that the stage dimension "follows the journal mapping". DECS, which is a Draft (fault-tolerance Question Q-222), maps invocations to "the telemetry owner's ten stages" in display names. Neither document fixes the attribute strings. The code emits eight values from process-local wrappers, and the `deliver-steer` step kind has no row. `openkit.lifecycle.stage` is a metric dimension, so its closed set is a contract.
- Options: (A) OTS owns the closed attribute strings and DECS maps step kinds to them. (B) DECS owns both.
- Recommendation: A, because OTS owns the metric contract; DECS then adds the `deliver-steer` row.
- Meanwhile: no change.

### Q-226. Is quarantine `restricted-evidence` a retention class?

- Context: Core storage owns the closed retention-class vocabulary, which has `restricted-raw` and no `restricted-evidence`. Workspace synchronization quarantine records carry `restricted-evidence`, and the deletion predicate parses them. The work data retention format records the question as a pending admission of Core storage.
- Options: (A) Map `restricted-evidence` to `restricted-raw` by a one-way migration. (B) Admit `restricted-evidence` into the Core vocabulary.
- Recommendation: A, because the quarantine records need the same access restriction and no separate duration.
- Meanwhile: no change.

### Q-227. Who sets and releases a legal hold?

- Context: AUE names material held by policy, administrator action or external compliance, and deletion refuses held material. No operation, record or authority sets or releases `legal-hold`, and no code writes it.
- Options: (A) Add a legal-hold operation and audit record under an owner. (B) State that `v0.1.0` has no legal-hold writer, so the class is reserved.
- Recommendation: B for `v0.1.0`, with A as later work; the deletion predicate stays.
- Meanwhile: no change.

### Q-228. Are the AUE field lists and recovery events targets or contracts?

- Context: AUE says that five scheduler restart-recovery events are audit events, that AuditEvent and UsageRecord "should carry" evidence bundle ids, redaction level, required features, endpoint family, cache metrics and cost estimate, and that every audit, usage and capability-call row carries `ownerScope`. The code has none of these. AUE elsewhere accepts cache and cost as usage rows, and the admitted database scope supplies storage authority.
- Options: (A) Mark the lists as target and state the current row form. (B) Open issues for each missing field and event.
- Recommendation: A for the field lists and `ownerScope`, because the row form and database scope already carry the facts; B for the five recovery events if the engineer wants them audited in `v0.1.0`.
- Meanwhile: no change.

### Q-229. May the evidence writing cleanups be applied?

- Context: AUE says both "Implementation is Partial" and "now-implemented Workspace deletion closure"; OTS says that the Collector is pinned in "deployment assets", which do not exist; the OTS projection keeps dependency versions and `unpkg` links that decay.
- Options: (A) Apply the cleanups. (B) Keep the text.
- Recommendation: A, under the round-1 delegated sweep for labels and history wording.
- Meanwhile: no change.

## Independent Review

One fresh reviewer read the group diff, this record and the claim inventory against the base SHA. It confirmed the AUE producer, owner-path and epoch-recorder facts, the OTS exporter, lock and histogram facts, the gap table, the inventory counts, and the routing of EV-AUE-06, EV-AUE-08 to -10, M2-G10 and EV-OTS-04 to questions. It returned seven findings; the auditor verified each against the base SHA and applied all of them:

- The first EV-G2-02 correction kept a default-off sentence in Core that contradicted the default-on rule and cited a replaced disposition. The sentence is removed; EV-G2-02, M4-G36 and the Semantic Preservation bullet are updated. The server default against the default-on target is added to #732 by a comment.
- EV-AUE-02 and EV-OTS-03 are code gaps against current accepted text; issues #741 and #742 are opened.
- EV-G2-01 now names the accepted interception specification as the Decision Trace owner.
- The record cites #737 for EV-AUE-07 and copies the exact #727 title.
- The AUE producer sentence now names its antecedent ("the seven recurring actions above").
- Q-225 now states that DECS is a Draft.

## Checks

At commit time: `node scripts/validate-doc-model.mjs` passed, `node scripts/generate-doc-index.mjs` regenerated `docs/INDEX.md`, `pnpm check:repo` passed, and the content scan of the staged diff found no email, token, credential path, private host, local absolute path or Vietnamese text.
