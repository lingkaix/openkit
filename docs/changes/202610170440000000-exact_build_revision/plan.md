---
type: change-plan
status: completed
date: 2026-10-17
---
# Exact Build Revision For Outcome Lineage

## Intent Revisions

The coordinator assigned this engineer-approved rc.10 R080 correction on 2026-10-17: built App images and release artifacts carry their exact source commit and release tag when available, and retained work observations use that revision instead of package version `0.0.0`. An uninjected local run records `unknown`, never a guessed revision. When the xAI Worker API change reaches green main, its deployment and Worker validation take priority over this increment.

## Authority And Scope

[Work Data Retention Format](../../specs/20260921-work_data_retention_format.md) owns the internal-agent environment record. [Container Image Packaging](../../specs/20260708-container_image_packaging.md) owns build identity, and [Release Management](../../specs/20260829-release_management.md) owns portable release provenance. The owner amendments land with the implementation. [Operational Telemetry](../../specs/20260731-operational_telemetry_standardization.md) aligns the diagnostics projection with untagged source builds. Package versioning, runtime configuration, identity authentication and release authorization remain separate.

Reuse the existing image identity file and its reader. A source build without a release tag carries a null tag with its exact source commit. The local image script derives a commit only from a clean checkout or explicit build input. Missing input remains unknown. Neither runtime environment replay nor live Git supplies the record. Existing `env.bound.payload.version` stores `tag@commit`, the commit alone, or `unknown`; retained earlier labels remain historical observations without rewriting. The operations archive adds its revision beside the existing package, helper and license. NanoHost manifests already retain the revision.

## Working Checkpoint

The Builder helpers own isolated capture and portable-archive seams and merge through their branches. The primary owns existing identity admission, image inputs, owner/manual alignment and integration. No workflow or publication job is changed. No deployment, tag, registry write or stable publication is part of this increment. Publication-path rehearsal is assessed by the next release preparation because the App Dockerfile and archive inputs change.

## Verification

The real-capture regression covers tagged, untagged and unknown build identity before model access. Existing identity-reader, generated OpenAPI and archive tests admit the new form while retaining malformed-value and tag-without-commit refusals. Archive tests bind bytes to the selected commit, preserve additive-key tolerance and prove deterministic output. The image-writer regression executes the Dockerfile's actual writer. An offline invocation of the existing image script also passed clean-source, dirty-source and explicit-input cases.

With Node 24.18.0, the unchanged root entrypoint/archive/publication-contract suites reported `tests 110`, `pass 110`, `fail 0`. The focused capture, Administration and identity suites passed 81 cases. The later integrated diagnostics and observation-consumer run passed 140 of 141 cases; its sole failure was the unchanged base Knowledge fixture expecting 23 operations instead of 27. Main repaired that fixture; it was not skipped or weakened by this increment.

After merging main and preserving the incoming Memory and xAI work, the complete App API schema suite reported `Test Files 30 passed (30)` and `Tests 366 passed (366)`. Complete LLM and OpenAPI suites reported `Test Files 29 passed (29)` and `Tests 1342 passed (1342)`. Repository checks, lint, typecheck and the retrieval build passed. The exact gate ended at 2026-10-17T06:54:18Z with `LOCAL-GATE PASS f2727005547f8ce8e94489f41a271bc28a8ffff5`. Later non-overlapping main changes and this record closeout retain those unchanged suites under Express item 8; final committed-head baseline checks and containing main CI are retained in the lane checkpoint and landing review.

The independent Reviewer approved the complete merged source and regenerated output. All non-generated R080 patches remained identical to the earlier approval; OpenAPI and CLI changed only for the nullable build tag and required source digest. No source pass substitutes for live Worker or published-artifact acceptance.

## Closeout

Implementation and owner alignment are complete. Source and gate receipts remain in the lane checkpoint and independent landing review. The next release preparation must assess the changed App Dockerfile and portable-packaging inputs through the existing publication-path proof and scratch-rehearsal rules. No tag, release, deployment or stable publication is performed by this code increment.

Complexity: 32 changed files, four owning specifications, four concerns (retained build label, image identity, diagnostics projection and portable provenance), and no new record family, registry or closed set.
