---
status: Accepted
---
# Exact Build Revision In Outcome Lineage

## Decision

On 2026-10-17, the coordinator assigned the engineer-approved rc.10 R080 correction: carry the exact source commit and optional release tag from build inputs into built App and portable release provenance, and retain that revision in the existing internal-agent build label. A local run without injected identity records `unknown`; package version, runtime environment and current checkout state are not substitutes.

## Rationale And Boundary

The internal package version is `0.0.0` across different builds and cannot identify the producer of a retained outcome. The existing immutable App identity file and portable manifests provide the source boundary. This adds no record family, migration, runtime Git discovery or publication authority. Untagged builds have no release tag even when their exact source is known. A tagged build retains both facts.

The owning criteria are [Work Data Retention Format](../specs/20260921-work_data_retention_format.md), [Container Image Packaging](../specs/20260708-container_image_packaging.md) and [Release Management](../specs/20260829-release_management.md). [The change record](../changes/202610170440000000-exact_build_revision/plan.md) retains execution evidence.
