# Findings

This record preserves an unresolved pre-existing conformance question encountered during the cleanup; it supplies no design authority and does not classify an untraced path as a demonstrated product defect.

## Follow-up Index

- [ ] `QUALITY2-FND-001` [open] Trace selected profile instruction supply

## [open] QUALITY2-FND-001 — Trace selected profile instruction supply

- **Observation:** The live AuthoredAgentProfileSchema accepts instructionsRef, but the inspected setup-resolver and runtime projection paths did not establish how a selected profile's instruction reference reaches Worker instruction supply. The deleted AgentProfileShapeSchema had no consumers and did not enforce that behavior either.
- **Impact:** AgentProfile validation is present, but instruction-supply completeness must not be inferred from a schema declaration or from this cleanup's passing tests. The possible behavior gap predates this batch and has not been demonstrated end to end.
- **Evidence:** The R2 reconciliation in temp/changes/202609220100000001-engineering_quality_batch2/builder-one-checks.txt names the old and current schemas, agents-loader parsing, setup-resolver selection/composition, catalog projection, and runtime projection. Original orphan bytes are retained in the baseline commit and before snapshot.
- **Owner:** docs/core/agent-supply.md and docs/specs/20260703-agent_manifest_aep_resolution.md own profile behavior and resolved supply; their implementation consumers own the remaining trace.
- **Next action:** Trace the selected profile's declared instruction source through accepted AEP and Worker supply before asserting completeness or opening a behavior-changing fix. Preserve this as a non-blocking investigation question; the current batch only removes unreachable obsolete code and leaves the live schema and supply path unchanged.
