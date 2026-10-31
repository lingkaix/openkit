---
status: Accepted
date: "2026-10-31"
decider: Engineer
---
# Reserved Audit Question Rulings

## Decision

On 2026-10-31 the engineer adopted the coordinator's reserved-audit recommendations. The linked owners state the operative contracts as their amendments land.

1. Issue #464, [Worker Control Protocol](../specs/20260703-worker_control_protocol.md): retire the two mandatory `final_status` digest bullets. Keep the optional descriptive `evidenceManifestDigests` map, open for extension: worker-reported, descriptive, never coverage, proof, or acceptance; empty means not reported.
2. Busy-Workspace [backup capture](../specs/20260704-workspace_backup_export_import.md) uses a crash-consistent bounded cut inside the DatabaseOwner foundation. Restore boots through existing crash recovery and running execution facts fail closed, while destructive restore, MOVE, and delete blockers stay unchanged.
3. Q-171: run the [Compute Neutrality Target](../specs/20261020-compute_neutrality_target.md) specification's five proposed fake-backend cases before the freeze, using the existing fake backend and no new harness.
4. Q-09: prefer stock [Pi capability](../specs/20260716-pi_worker_adapter.md). Approve one bounded MCP-discovery patch exception, with a removal condition, only if Pi 1.4.0 still needs it.
5. Q-179: require distinguishable native outcomes before enabling the [DeepSeek adapter](../specs/20260930-deepseek_worker_adapter.md) template; otherwise exclude the template from v0.1.0. An unknown abort is never completed.
6. Q-01: amend [Documents Pass When A System Can Be Rebuilt From Them](20260923-documentation_rebuild_test.md) with bounded corpus A, preserving the rebuild criterion. [Documentation Model](../documentation-model.md#admitted-rebuild-corpus) owns admission of explicitly owned declarative boundary schemas and standalone conformance fixtures, the supported-saved-data limit on DDL and retained fixtures, and exclusion of generators, whole packages, and implementation source.
7. Q-166: [Engineering Doctrine](../engineering-doctrine.md) states one falsifiable commitment: delegation is reconsidered when repeated independent calibration shows it cannot meet the required correctness at acceptable engineering cost. Link existing calibration observations; add no score.
8. Q-153: [Generative Kernel Data And Operations](../specs/20260908-generative_kernel_data_operations.md) current acceptance matches the narrower implemented initial contract. Joins, aggregation, delete, upsert, and bulk data operations move out of v0.1.0 acceptance into that specification's existing deferral wording.
9. Q-194: authored Provider `env:` credential references are allowed in every mode. They are operator-authored server configuration, resolved only inside NanoCore, and never Worker-visible.
10. Q-08 and Q-169: one-time minimal redaction of local absolute paths and private host aliases in the named public records, keeping all substantive evidence. A host alias remains only where an executable or operator contract requires it; no git history is rewritten.
11. Q-170 and Q-173: consolidate only `docs/specs/AGENTS.md` and `docs/core/AGENTS.md`, joining hard-wrapped paragraphs and replacing duplicated rules with owner pointers. Preserve every directory-specific requirement and standing boundary, remove completed one-off commands, and leave root `AGENTS.md` unchanged.
12. Q-174: in [Product Vision](../product-vision.md), change the five `Foundation` link labels that target `docs/core/doctrine.md` to `Doctrine`. Add no alias and leave historical change records unchanged.

## Reason

Source: the engineer's 2026-10-31 answers to the coordinator review sheet, adopting recommendations 2-12 and specifying the optional digest map for item 1. The consultation explains why reconstruction needs boundary shapes and semantics without the old implementation, why current acceptance must match the admitted release scope, and why public-record cleanup must preserve evidence. The remaining rulings apply the same accepted limits in their named owners; this record does not create a second behavioral contract.

## Rejected Alternatives

- Admit whole packages or implementation source into the rebuild corpus, or add a retained-format generator. Rejected under Q-01.
- Keep joins, aggregation, delete, upsert, and bulk inside v0.1.0 Generative Kernel Data acceptance. Rejected under Q-153.
- Restrict Provider `env:` references to development-only input. Rejected under Q-194.
- Rewrite git history to remove identifying paths. Rejected under Q-08 and Q-169.
- Edit root `AGENTS.md` in this pass. Rejected under Q-170 and Q-173.
- Add a glossary alias for Foundation. Rejected under Q-174.
- Accept the Compute Neutrality Target by metadata edit without the five fake-backend cases. Rejected under Q-171.
- Label an unknown DeepSeek abort as completed. Rejected under Q-179.

## Revisit When

A rebuild probe shows the admitted corpus is too narrow or too wide. Repeated independent calibration meets the Q-166 falsifier. The DeepSeek template gains distinguishable native outcomes. Stock Pi supplies the MCP connection-state capability that the bounded patch exposed. A later public record needs the same redaction treatment.

## Affected Owners

- docs/specs/20260703-worker_control_protocol.md
- docs/specs/20260704-workspace_backup_export_import.md
- docs/specs/20261019-durable_execution_and_control_store.md
- docs/specs/20261020-compute_neutrality_target.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md

- docs/documentation-model.md
- docs/engineering-doctrine.md
- docs/writing.md
- docs/specs/20260719-verification_calibration.md
- docs/decisions/20260923-documentation_rebuild_test.md
- docs/specs/20260908-generative_kernel_data_operations.md
- docs/specs/20260703-vault_secret_injection.md
- docs/audits/20261003-goal_mode_coordination_terminal_archive.md
- docs/decisions/20261014-release_cadence.md
- docs/specs/AGENTS.md
- docs/core/AGENTS.md
- docs/product-vision.md
