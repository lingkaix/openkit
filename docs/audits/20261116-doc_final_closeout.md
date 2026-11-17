# DOC-FINAL Closeout

Observation date: 2026-11-17. Generating owner: the evidence rule in [Documentation Model](../documentation-model.md#audit-records), which keeps this record as the DOC-FINAL final audit record. Decision: [DOC-FINAL Information Architecture](../decisions/20261116-doc_final_information_architecture.md).

## Observed

DOC-FINAL rewrote the documentation corpus against the implementation on `main`. Where a document disagreed with the code, the document was corrected. Where the code disagreed with an accepted rule, the rule stays and the spec's Implementation Gaps name a GitHub issue with the `doc-final` label. The coordinator triages the scope of those issues.

The closeout deleted the records below. The last commit on `main` that holds all of them is `2643f9f7d069ae53632f1e78c3a7e22a1be67e28`.

| Class | Deleted |
| --- | --- |
| Terminal archive: specifications under `docs/specs/retired/` and `docs/specs/superseded/` | 65 |
| Terminal archive: directory guides | 2 |
| Archive-only audit records | 5 |
| Change records with terminal status | 35 |
| Change records with stale `in-progress` or `implemented` status | 109 |
| Change records with `planned` or `blocked` status, work held by an issue, the roadmap or a later record | 5 |
| Other audit records | 40 |

Before deletion, every open or deferred finding and every residual obligation that a record declared was checked against `main`. Each one was found resolved, superseded, ended by a DOC-FINAL ruling, or held by a GitHub issue. Issues #820 to #846 were filed for findings without an existing holder.

## Kept

- `docs/changes/202608302326560001-composable_agent_runtime_configuration/`: an operator Skill reference reads it.
- `docs/changes/202609092147350001-persistent_live_acceptance/`: the roadmap names it as an acceptance path.
- `docs/changes/202609220000000001-engineering_quality_pilot/` and `docs/changes/202609220100000001-engineering_quality_batch2/`: issue #820 uses them as comparison baselines.
- `docs/changes/202610201240000000-core_execution_journal/`: a live plan that the runtime README reads.
- `docs/changes/202611151940360000-v0_1_0_rc_9_prerelease/`: the current release record.
- This record and the directory guides.
