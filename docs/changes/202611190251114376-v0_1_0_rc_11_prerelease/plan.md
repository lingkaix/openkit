---
type: change-plan
status: in-progress
date: "2026-11-19"
started: "2026-11-19"
branch: main
---
# v0.1.0-rc.11 Prerelease Preparation

[Release Management](../../specs/20260829-release_management.md), the [Release Cookbook](../../cookbooks/release.md), [Development Security](../../specs/20261109-development_security.md) and the [standing scratch grant](../../decisions/20261015-standing_scratch_rehearsal_grant.md) own the release procedure. This record tracks preparation and verification.

## Intent

### Intent Revision 1 (2026-11-19 UTC)

The coordinator assigned release preparation after the full rc.11 scope reached main at `82bf3da451797ff4b9245efbe32cdc7fb1bcf894`. Prepare one guarded documentation commit. Use its exact head as P once the hosted batch CI and both-architecture golden path pass on that parent and the main range still contains only the release preparation commit. Publication requires separate coordinator approval and the private admission input.

The rc.10 to rc.11 update preserves the Data Root in place. The accepted Workspace migration advances `drizzle.workspace` from 1 to 2 (#912). Workspace operational backups require the exact creating build. Cold Data Root backups can be restored across releases and migrate at startup. Cross-release Workspace bundle restore is tracked in #764.

## Preparation Checkpoint (Rewritable)

| Field | Fact or pending evidence |
| --- | --- |
| Intended identity | Non-draft prerelease `v0.1.0-rc.11`. Stable promotion is separate. |
| Previous release | `v0.1.0-rc.10` at `9e297df865c8ed7f02fa7fb33f52f34ec4b885f0`, published 2026-11-18 15:18:35 UTC. Tag run 44329212270, attempt 1. |
| Controlled assets | Three release image indexes and six platform manifests. Thirteen GitHub Release attachments cover the operations Skill, two native NanoHost archives, eight SBOMs, the release manifest and SHA256SUMS. |
| Tested T and candidate P | Batch CI 44446771801 and golden path 44446779965 cover the scope head. Exact-P release-gate and golden-path results are pending. The later publication subject is one empty commit with the same tree and no CI skip marker. |
| Non-product comparison | This preparation adds the notes and this record. Between the previous tag and the scope head, the generated publication-input fingerprints differ. |
| Publication-path evidence | Independent review and a fresh scratch rehearsal against the selected source are pending. |
| Visibility | The repository is public. The Worker Common image requires anonymous access by digest. R6 checks the published identity and visibility and compares the Latest pointers with their recorded initial state. |
| Frozen checklist | Verify 13 attachments, 11 manifest assets, checksums and platform provenance, both NanoHost contained-stage checks, anonymous Worker Common access and the published-mode golden path. |
| Issue and security evidence | The generated preparation snapshot observed 838 issues and 553 open. The release-blocker check and current dispositions use a fresh snapshot. #850 admission applies through 2026-12-17 only to approved exact Debian bindings on the six platform manifests. |
| Known limitations | #120/R001 remains open for supported NanoHost Worker execution. DeepSeek remains disabled (#868). #249 stays open until both published App images pass packaged-notice verification. |
| Machine-readable transition assessment | Pending owner decision. The current validator accepts a migration-free update or a pre-stable reset. It rejects a migration with retained-data continuity (#912). The notes describe the approved in-place transition. |

## Evidence And Next Action

Release preparation used the published rc.10 tag, its retained issue snapshot and its exact publication commit as the comparison baseline. The generated draft, issue facts and fingerprints stay outside the repository. The known issues in the notes remain open in the current snapshot. The published rc.10 golden path closed its fresh persistent Worker proof. The Retrieval Kernel source notice list is empty and the published-image check remains open.

Land the documentation through the guard and run preliminary preflight, release security scanning and issue triage. Resolve the compatible manifest assessment with the release owner before advancing to candidate validation. Exact-source gates, image register review and authorized publication precede R6. Deployment and Worker qualification use the published release under separate authority.

This preparation adds two documentation files and changes zero owning documents, closed sets or registries.
