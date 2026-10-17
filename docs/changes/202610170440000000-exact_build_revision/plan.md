---
type: change-plan
status: in-progress
date: 2026-10-17
---
# Exact Build Revision For Outcome Lineage

## Intent Revisions

The coordinator assigned this engineer-approved rc.10 R080 correction on 2026-10-17: built App images and release artifacts carry their exact source commit and release tag when available, and retained work observations use that revision instead of package version `0.0.0`. An uninjected local run records `unknown`, never a guessed revision. When the xAI Worker API change reaches green main, its deployment and Worker validation take priority over this increment.

## Authority And Scope

[Work Data Retention Format](../../specs/20260921-work_data_retention_format.md) owns the internal-agent environment record. [Container Image Packaging](../../specs/20260708-container_image_packaging.md) owns build identity, and [Release Management](../../specs/20260829-release_management.md) owns portable release provenance. The owner amendments land with the implementation. Package versioning, runtime configuration, identity authentication and release authorization remain separate.

Reuse the existing image identity file and its reader. A source build without a release tag carries a null tag with its exact source commit. The local image script derives a commit only from a clean checkout or explicit build input. Missing input remains unknown. Neither runtime environment replay nor live Git supplies the record. Existing `env.bound.payload.version` stores `tag@commit`, the commit alone, or `unknown`; retained earlier labels remain historical observations without rewriting. The operations archive adds its revision beside the existing package, helper and license. NanoHost manifests already retain the revision.

## Working Checkpoint

The Builder helpers own isolated capture and portable-archive seams and merge through their branches. The primary owns existing identity admission, image inputs, owner/manual alignment and integration. No workflow or publication job is changed. No deployment, tag, registry write or stable publication is part of this increment. Publication-path rehearsal is assessed by the next release preparation because the App Dockerfile and archive inputs change.

## Verification

Use one lowest-sufficient real-capture regression for tagged, untagged and unknown identity; strengthen the existing reader and archive checks for the new accepted forms and exact selected-ref provenance. Run complete changed-module and package suites, generated OpenAPI/CLI checks and the normal local express gate. Retain exact observed results here before landing. An independent Reviewer inspects the complete diff and actual deciding output. No source pass substitutes for live Worker or published-artifact acceptance.

## Remaining Work

Finish integrated checks, independent review and the express landing. Observe the containing main-push gate. No gate result or landing is claimed yet.
