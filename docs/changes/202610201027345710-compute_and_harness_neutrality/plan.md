---
type: change-plan
status: implemented
started: "2026-10-20"
branch: design/compute-neutrality
---
# Compute And Harness Neutrality

This record preserves the approved documentation scope and its verification. The linked owners contain the governing rules.

## Intent Revisions

### 2026-10-20 — Engineer Direction

Record neutrality at the NanoCore boundary, with direct platform integration and NanoHost as one first-party peer. Insert the engineer's Product Vision section verbatim. Clarify existing AEP, native continuity, retained image identity, and runtime topology meanings without schema or code changes. Current records retain their NanoHost meanings; external representations come later as additive forms.

Acceptance requires the exact Product Vision insertion, bounded owner edits, local documentation checks, and one branch CI run for the pushed commit. The effect boundary permits documentation edits, one commit, branch publication, and that CI dispatch. Durable-execution receipt and reservation design remains with its existing owners.

## Owners And Accepted Decision

- [Product Vision](../../product-vision.md) states the product direction.
- [Architecture](../../core/architecture.md) owns platform neutrality and the governance boundary.
- [Runtime Model](../../core/runtime-model.md) scopes the NanoHost topology.
- [AgentSession](../../core/agent-session.md) and [AgentSession Continuity](../../specs/20260704-agent_session_continuity.md) distinguish Core binding authority from native state.
- [Agent Environment Package](../../specs/20260616-agent_environment_package.md) owns the current resolved package meaning.
- [Work Data Retention Format](../../specs/20260921-work_data_retention_format.md) owns retained observation and image-identity meanings.
- [Compute And Harness Neutrality](../../decisions/20261020-compute_and_harness_neutrality.md) records the engineer's decision.

## Working Checkpoint

The branch starts from freshly fetched main commit `80181c1be`. Foundation already permits external runtime state and needs no edit. The change touches nine documentation files and adds no code, schema, field, enum, registry, or integration.

The owner edits now state direct NanoCore integration, scope the in-Sandbox topology to NanoHost, and preserve current retained meanings. Foundation and durable-execution proof contracts remain unchanged. Local checks passed. The next action commits and publishes this documentation, then dispatches one branch CI run with the `pr-check` gate. The run must identify the pushed commit and pass before the ready-to-land handoff.

## Verification And Closeout

- `pnpm check:repo` passed with Node 24.18.0 and pnpm 10.33.3. Documentation validation covered 647 documents; the generated index was current. Biome checked 2,127 files with no errors, three warnings, and 25 informational diagnostics in untouched files.
- A byte comparison against the base file confirmed the verbatim Product Vision insertion and no other change to that file.
- The changed-path check confirmed exactly nine permitted Markdown files. Added-text checks confirmed the language boundary and absence of private coordination context.
- `git diff --check` passed. Direct diff inspection confirmed no schema, code, field, enum, registry, or capability-list changes.

The change has nine files, seven owning documents, and four owning areas: product direction, Core architecture/runtime, Worker/AEP continuity, and work-data retention. It adds zero closed sets or registries. External representations and integrations remain future work under the decision; remote-effect receipt and reservation rules remain with the durable-execution owners. No unresolved finding remains in this documentation scope.

Branch publication and its exact-commit CI result are reported at handoff. This record does not claim independent acceptance of the resulting text.
