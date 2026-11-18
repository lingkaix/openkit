---
type: change-plan
status: in-progress
date: "2026-11-18"
started: "2026-11-18"
branch: main
---
# v0.1.0-rc.10 Prerelease Preparation

This record preserves release preparation and outstanding evidence. It supplies no publication or deployment authority. [Release Management](../../specs/20260829-release_management.md), the [Release Cookbook](../../cookbooks/release.md), [Development Security](../../specs/20261109-development_security.md) and the [standing scratch grant](../../decisions/20261015-standing_scratch_rehearsal_grant.md) own the release boundaries.

## Intent

### Intent Revision 1 — 2026-11-18 (UTC)

Source: the coordinator assigned RELEASE-10 to prepare `v0.1.0-rc.10` after the rc.10 scope landed on main `2b36818ef4351df2b08e42965b6e82e189aafbca`. Land the generated and reviewed user-facing notes and this record before the coordinator selects P. The rc.9 to rc.10 transition is an in-place update with no data reset, migrations, SQL baseline edits or retained-format edits. Candidate selection, issue dispositions, security-register approval and publication GO belong to the coordinator.

## Preparation Checkpoint — Rewritable

| Field | Current fact or missing gate |
| --- | --- |
| Intended identity | `v0.1.0-rc.10`, non-draft prerelease; GHCR `latest`, GitHub Latest and stable remain unchanged |
| Previous release | `v0.1.0-rc.9`, source `ad5a5b0db27e746b575e270c7e4ab25a1cea065e`; verified tag run 44042293475, attempt 1 |
| Controlled assets | Three catalog release images; operations Skill archive; native amd64 and arm64 NanoHost archives; eight SBOM attachments; release manifest; SHA256SUMS. Thirteen GitHub Release attachments |
| Tested T / publishing P | Not selected. COORD names P after full-batch CI reds are classified and fixed. Preparation main is not publication evidence |
| Non-product comparison | This change contains only this record, notes and manifest assessment. The rc.9-to-current range includes product and publication changes; no exact-P CI equivalence is claimed |
| Candidate CI | Pending exact P: `gate=release-gate candidate_tag=v0.1.0-rc.10`; every required gate must be green |
| Publication path | Changed since rc.9. Preparation comparison reports unequal inputs. Independent publication-path review and fresh scratch tag rehearsal are required on P |
| Authorization | Standing conditional prerelease grant; complete current issue reconciliation, unused identities, exact-P evidence, reviewed rehearsal, private admission and explicit COORD publication GO still required |
| Visibility | Public repository. Only worker-common is required anonymously public. No visibility change; final package visibility and exact-digest anonymous access are R6 observations |
| Frozen checklist | Release Management and Release Cookbook at preparation main; rc.9 baseline R6 records 13 attachments, 11 manifest assets, six attested platform manifests, contained NanoHost staging and unchanged Latest pointers |
| Manual gate and limitations | #120/R001 remains open: NanoHost archives are installable but supported Worker execution is not yet release-ready. DeepSeek Worker disabled pending #868. Published qualification and stable eligibility remain separate |
| Next action | Land this preparation through the guard; run preliminary R2 and security count; send the undispositioned issue snapshot through seams; stop until COORD names P |

## In-Place Transition Assessment

The frozen rc.9 Core and Workspace SQL baselines and retained formats remain unchanged. The manifest assessment declares migration-free, configuration-compatible and retained-data-compatible update from rc.9 with previous-image-compatible recovery. The actual rc.9 App amd64 image ID is `sha256:586128812860c50c38269790b5212749bef5aee183be4b9cba5f8511e5d8b7b5`, read from the config descriptor of the published rc.9 amd64 manifest. It is distinct from that manifest's registry digest. These release-level facts do not replace protected host assessment, component readiness, fencing or the operator update procedure. No reset, deletion or deployment is authorized by this preparation.

## Issue And Security Reconciliation

The generated complete preparation snapshot observed 791 issues, 518 open and zero open release-blocker labels. Label absence is not a disposition. Existing after-v0.1.0 labels and prior reconciliation remain evidence; COORD decides current applicability and every missing disposition, including #848, #846, #847 and #857. No label is changed by this lane. Final admission needs a fresh complete snapshot and its reviewed hash.

#851 installed-npm image scanning and image-content reductions are included. The delegated #850 acceptance keeps its original expiry of 2026-12-17 and applies only to exact final six platform manifests with reviewed Debian critical residue. Known exploitation, an available fix, non-Debian packages, unreviewed advisories or increased per-image counts refuse admission. Native arm64 App parity is still a hosted candidate gate. COORD independently checks the completed register and sets its secret; this lane never sets Actions secrets.

## Evidence And Remaining Gates

The read-only release preparation used `--previous-tag v0.1.0-rc.9`, the complete retained rc.9 snapshot and the actual rc.9 publication source. It generated commit facts, the complete issue snapshot, reconciliation delta, carried-forward known issues and the unequal publication-input comparison. Raw evidence remains outside the repository.

On P, repeat preflight and release security scanning. Require exact-P candidate CI, independent publication-path PASS, a successful fresh scratch publication rehearsal and a golden-path Worker Turn on fresh persistent storage with both native architectures. After register checks, stop for COORD publication GO and the private admission input. The later publication subject is one empty commit with no skip marker; this preparation commit ends in `[skip ci]`.

R6 must verify the full published attachment/checksum inventory, six platform provenance bindings, both contained NanoHost staging checks, anonymous worker-common exact-digest access, unchanged Latest pointers and a published-mode golden path. Post-publication rc.9 to rc.10 story 2 and Worker qualification remain separate. Neither they nor R3–R6 are complete in this preparation.

Complexity: three new documentation/assessment files; zero owning documents changed; one release owner with its security dependency; no new closed set or registry.
