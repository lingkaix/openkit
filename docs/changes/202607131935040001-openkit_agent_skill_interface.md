# OpenKit Agent Skill Interface

Type: change-plan
Status: verified
Canonical Spec: `docs/specs/20260713-openkit_agent_skill_interface.md`

## Intent

Replace the user-facing `@openkit/mcp` channel and the four current OpenKit setup/loop Skills with one end-user-only `openkit` Skill that bundles a small CLI, exposes every supported public NanoCore capability through progressive disclosure, and teaches the agent how to operate OpenKit loops safely and effectively.

This is a clean replacement. OpenKit is in internal development, so the implementation will delete the MCP package, MCP transport, MCP resources and prompts, the four existing Skill folders, and their compatibility surface rather than preserving adapters or aliases.

The G02 audit preamble freezes the implementation boundary before Stages 1-6 proceed.

## Inherited Audit Responsibility (2026-07-17)

This plan is work package WP-1 of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md) and absorbs audit group G02 from the [alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md). The G02 document set (C07 Protocol, C08 Communication, S01-S04, and their supporting projections) and the G02 exit criteria in the audit ledger are inherited inputs. The program's convergence rules bind all work here, including the central idempotency default and the scoped precision bar: App API, Core Client, CLI, Skill, and Web contracts need single-implementation clarity plus test sufficiency, not implementer-proof prose.

Before implementation starts, record the G02 audit preamble in this plan per Execution Program rule 11: the authority map for the concepts this plan touches, findings classified with the audit's finding codes (in-scope findings fold into this plan's frozen scope; everything else is ticketed to the program Backlog), and confirmation of the inherited exit criteria. The preamble is review-only, bounded to at most one review day, and authorizes no implementation. The S01 Protocol Contract Consolidation review assigned by the audit's Remaining Execution dispositions happens here; supersede S01 only when a named current owner absorbs every continuing contract.

## G02 Audit Preamble (2026-07-18)

The bounded review covered C07, C08, S01-S04, the App API and generated OpenAPI, Core Client, the removal-only MCP and Skill surfaces, credentials, release wiring, and current stories. It found no `SECURITY-GAP` and authorized no implementation.

| Concept | Authority and executable projection | Forbidden duplicate |
| --- | --- | --- |
| Core semantics | C07, owning specs, and `@openkit/protocol`; NanoCore Core routes and `client.core` project them | CLI business rules or App API copies of Core routes |
| Transport and cancellation | C08 and Core Client transport/SSE; owning commands and durable reads prove outcomes | CLI routing, retry, safe-point, or process-exit product truth |
| App API | Owning specs and `@openkit/app-api-schemas`; S03, NanoCore catalog, OpenAPI, and the public Core Client sub-clients project them | CLI copies of paths, methods, or payload schemas |
| Agent interface | S04 owns operation identity, Skill guidance, progressive disclosure, CLI envelopes, and local redaction | MCP registry, raw HTTP catalog, second SDK, or workflow engine |
| Authentication and secrets | Remote Auth, Permissions, and Vault specs plus NanoCore authorization; the CLI reuses the existing credential helper | Secret argv/output, CLI authorization, or another credential store |
| Acceptance and removal | S08 and S04; lower-layer coverage plus bounded interface stories prove the replacement | A new runner platform, compatibility surface, or deletion of worker-side MCP |

| Finding | Classification | Frozen disposition |
| --- | --- | --- |
| G02-F01 | `DESIGN-DEFECT` | Catalog sources are exactly `app-api`, `core-projection`, or `local-only`; inputs are strict flat objects; Core routes do not move into App OpenAPI. |
| G02-F02 | `DESIGN-DEFECT` | Full capability coverage stays L0/L2, CLI logic stays L1, and exit uses one representative local L3, existing auth-owned server proof, and one real progressive-discovery L6; legacy stories survive only for distinct risk. |
| G02-F03 | `DESIGN-DEFECT` | Removal checks reachability through files, packages, imports, binaries, scripts, release wiring, Skill metadata, and active guides; canonical prohibitions, history, and worker MCP may retain the names. |
| G02-F04 | `DESIGN-DEFECT` | Generic create/rotate token operations are excluded until a safe named destination exists; bootstrap consumption may store the current credential directly or fail closed. |
| G02-F05 | `OWNERSHIP-CONFLICT` | Remove C08's generic active-input semantics, the duplicate repository-create operation, and the duplicate Agent health client entry point. |
| G02-F06 | `IMPLEMENTATION-DEFECT` | Preserve typed `path`, `details`, and server `requestId` in Core Client errors before the CLI projects them. |
| G02-F07 | `DOC-DRIFT` | Correct C07/C08 command wording, supersede S01 into named owners, remove stale S02/current-surface claims and tool counts, and state worker MCP as accepted but not implemented. |
| G02-F08 | `DEFERRED-ALIGNMENT`, `TEST-GAP`, `REAL-USE-GAP` | Implement the already-planned catalog, CLI, Skill, reachability guard, packaged smoke, and smallest replacement stories; do not absorb S16, S39, Material, or steering delivery. |

These findings and the existing Stages 1-6 are the frozen WP-1 scope. The inherited G02 exit criteria remain unchanged: one schema and command authority, transport-neutral operations, authentication, idempotency, errors, replay, cancellation, generated-contract parity, and complete removal of the reachable user-facing MCP and split-Skill surfaces.

## Decision Summary

- The canonical AI-native end-user interface becomes one Skill named `openkit`.
- The Skill targets end users only. It does not contain a repository-developer setup mode or an OpenKit self-improvement mode.
- A bundled, versioned `openkit` CLI performs deterministic discovery and invocation over public NanoCore contracts.
- Progressive disclosure occurs through Skill metadata, a concise `SKILL.md`, on-demand reference files, and CLI operation search/description.
- NanoCore public App API and typed Core projections remain the machine contracts, while NanoCore remains the source of truth for state, policy, approval, idempotency, audit, recovery, and execution.
- The user-facing MCP channel is deleted without a compatibility adapter.
- Worker-side MCP capability supply remains a separate accepted future plane, is not implemented in current AEPs, and is not changed by this work.

## Scope

### Documentation and lifecycle

- Add `docs/specs/20260713-openkit_agent_skill_interface.md` as the canonical accepted design.
- Supersede `docs/specs/20260617-openkit_ai_interface.md` because the new spec absorbs the continuing AI-interface contract while replacing its transport and packaging model.
- Retire `docs/specs/20260627-openkit_development_loop_protocol.md` because developer-facing Skill operation and repository self-improvement through the user interface are no longer product use cases.
- Update the active spec index and current product, roadmap, architecture, Skill, and package entry-point guidance.
- Mark the existing MCP package documentation as removal-only historical implementation guidance until the package is deleted.
- Keep historical change records and archived specs unchanged except where lifecycle links require correction.

### Skill implementation

- Replace `openkit-setup`, `openkit-setup-dev`, `openkit-loop`, and `openkit-loop-dev` with one `skills/openkit/` package initialized and validated through the repository-approved skill-creator workflow.
- Keep `SKILL.md` concise and route detailed setup, loop, workspace, knowledge, recovery, and administration guidance into one-level `references/` files.
- Bundle the executable CLI entrypoint under the Skill's `scripts/` directory and ship it as part of the same immutable Skill artifact.
- Generate and validate `agents/openai.yaml` from the final Skill contract.

### CLI and operation catalog

- Reuse `@openkit/core-client`, `@openkit/app-api-schemas`, current credential handling, redaction rules, and public NanoCore behavior.
- Replace the MCP-specific tool registry with one transport-neutral end-user operation catalog whose sources are exactly `app-api`, `core-projection`, or `local-only`; networked entries reference existing Core Client methods and shared schemas rather than creating a second route or payload inventory.
- Expose operation discovery, description, and invocation without loading the complete catalog into the agent context.
- Cover all supported public end-user and operator capabilities, including setup, authentication, workspaces, repositories, threads, Chat Mode, Task Mode, Goal Mode, Action Center, artifacts, evidence, knowledge, recovery, scheduler controls, runtime configuration, vault administration, audit, usage, automations, Git operations, and workspace portability.
- Accept one strict flat input object per call; steering without its accepted durable owner remains an explicit typed fail-closed exclusion, and generic token create/rotate remains excluded until a safe named credential destination exists.
- Exclude private NanoCore internals, raw storage, raw runtime handles, arbitrary HTTP, arbitrary shell, and any operation without a public governed contract.
- Preserve server-side validation and authorization as the final authority for every invocation.

### MCP and legacy Skill removal

- Delete `mcp/`, the `@openkit/mcp` package, the `openkit-mcp` binary, MCP-only protocol and stdio code, MCP resources, MCP prompts, MCP configuration, MCP package tests, and MCP smoke scripts.
- Delete the four legacy Skill directories and all setup/loop handoff rules that distinguish end-user and developer variants.
- Replace MCP-focused deterministic stories and release commands with Skill-plus-CLI stories covering the same product behavior.
- Remove MCP package dependencies, workspace scripts, build steps, release checks, documentation links, and generated artifacts.
- Do not retain an MCP adapter, deprecated package, alias, redirect, or dual Skill layout.

## Non-Goals

- No deletion or redesign of worker-side MCP capability supply under `docs/specs/20260704-worker_mcp_tool_supply.md`.
- No developer-facing OpenKit Skill, repository setup Skill, or self-improvement Skill.
- No Web UI redesign or replacement.
- No new NanoCore business rules in the Skill or CLI.
- No generic API client, raw route caller, arbitrary shell, or unrestricted administration escape hatch.
- No public Skill marketplace, third-party plugin system, or multi-Skill dependency model.
- No backward compatibility for the user-facing MCP package, four legacy Skill names, MCP tool names as transport contracts, or MCP resources and prompts.
- No Skill or CLI implementation during the initial documentation checkpoint.

## Related Context

- [Core Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Communication](../core/communication.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Permissions](../core/permissions.md)
- [Vault](../core/vault.md)
- [Audit](../core/audit.md)
- [Product Vision](../product-vision.md)
- [OpenKit Agent Skill Interface](../specs/20260713-openkit_agent_skill_interface.md)
- [Core Client Boundary](../specs/20260528-core_client_boundary.md)
- [App API OpenAPI Projection](../specs/20260704-app_api_openapi_projection.md)
- [Remote Auth Credential Bootstrap](../specs/20260704-remote_auth_credential_bootstrap.md)
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)

## Current Baseline

- `skills/openkit/` is the one end-user Skill package, with one bundled CLI, one-level progressive references, and generated host metadata.
- `skills/openkit-operations.mjs` is the checked agent-facing catalog over existing App API and typed Core Client owners; `skills/openkit-cli.mjs` and `skills/openkit-secrets.mjs` provide bounded JSON invocation, credential mediation, typed errors, and redaction without owning product behavior.
- The user-facing `@openkit/mcp` package, binary, resources, prompts, dedicated acceptance stories, release wiring, and all four former Skill directories are deleted without compatibility aliases.
- Replacement coverage is proportional: complete catalog and schema coverage at L0-L2, one representative local L3, existing server-auth evidence, clean-copy L5, and one real progressive-discovery L6.
- NanoCore remains authoritative for public validation, state transitions, authorization, approvals, audit, recovery, artifacts, evidence, and execution.
- Worker-side MCP remains a separate accepted capability plane; current AEPs expose no capability routes, and WP-1 did not alter that boundary.

## Impacted Surfaces

- `skills/`
- `mcp/`
- `packages/core-client`
- `packages/app-api-schemas`
- root workspace package scripts and release gates
- L0-L6 interface tests and stories
- root `README.md` and `AGENTS.md`
- `docs/product-vision.md`, `docs/roadmap.md`, relevant core docs, active specs, cookbooks, deployment guides, and package READMEs
- generated or checked artifacts that enumerate workspace packages, commands, or AI-interface surfaces

## Execution Plan

### Stage 0 — Documentation authority and lifecycle

- Accept the new Agent Skill Interface spec.
- Supersede the old Skill-plus-MCP AI Interface spec.
- Retire the developer-loop protocol.
- Align the active spec index and entry-point posture documents.
- Record the current MCP and four-Skill implementation as legacy implementation pending deletion without presenting it as current design guidance.

### Stage 1 — Freeze CLI behavior with tests

- Add focused tests first for the CLI process contract, operation search, operation description, strict flat stdin JSON invocation, stable JSON success/error envelopes, exit codes, redaction, secret-safe credential handling, local abort behavior, and server capability/version checks.
- Add a focused contract test proving that the CLI calls only public Core Client surfaces.
- Add L0/L2 coverage that reads the checked App API OpenAPI catalog, resolves every `core-projection` reference, requires a mapping or explicit exclusion for every public end-user/operator operation, and rejects copied route or schema ownership.
- Define the smallest transport-neutral operation metadata needed by discovery and invocation as one cohesive literal inventory with native lookup; do not add a catalog framework.

### Stage 2 — Implement the operation catalog and CLI

- Extract the reusable public operation definitions and handlers from the MCP registry without preserving MCP protocol concepts.
- Implement the bundled `openkit` CLI entrypoint and keep it agent-first and JSON-only for the first version.
- Ship the CLI as one Node.js 24 single-file executable with no runtime package installation, `node_modules`, package-manager command, or OpenKit source checkout.
- Reuse the existing Core Client and credential-store behavior instead of reimplementing HTTP or auth.
- Send stable `openkit-cli` channel and `agent-skill` source metadata through every networked Core Client request.
- Let SIGINT or transport abort stop only the local wait; product cancellation requires an explicit operation followed by a durable read, and bootstrap consumption may direct-store the current credential or fail closed.
- Keep every invocation bounded and request/response-oriented; do not add an interactive shell, daemon, background process, subscription transport, streaming mode, or CLI-owned multi-step workflow composition.

### Stage 3 — Create the unified end-user Skill

- Initialize `skills/openkit/` with skill-creator tooling and only the required `scripts/` and `references/` resources.
- Keep frontmatter to `name` and `description`, and make the description trigger for end-user setup, workspace operation, Chat/Task/Goal work, loop coordination, human attention, knowledge, recovery, and administration.
- Write imperative instructions, keep the body below 500 lines, and use directly linked one-level references for detailed capability families.
- Teach the default loop: diagnose, select or create workspace, select mode, perform one bounded action, inspect Action Center and evidence, ask for human decisions, and continue or stop from durable NanoCore state.
- Validate metadata and forward-test the Skill on representative end-user tasks without developer-only context.

### Stage 4 — Replace interface acceptance stories

- Keep full capability mapping at L0/L2 and focused CLI behavior at L1; replace broad MCP story parity with one representative local L3, existing auth-owned server/bootstrap proof, and one real progressive-discovery L6.
- Retain a legacy story only when it proves a distinct risk not covered below L6, and reduce any confirmed defect to the lowest sufficient deterministic regression.
- Start the real story with Skill metadata only, load `SKILL.md` and one relevant reference, and discover, describe, and call an operation absent from `SKILL.md` without adding a runner framework.

### Stage 5 — Delete MCP and legacy Skills

- Delete the MCP package and every MCP-only test, resource, prompt, command, dependency, script, and release step.
- Delete the four legacy Skill folders.
- Remove reachable MCP and legacy Skill surfaces from package directories, workspace dependencies, imports, binaries, scripts, release wiring, Skill metadata, and active guides while allowing canonical prohibitions, history, and worker-side MCP design to retain the names.
- Remove current implementation projections that no longer exist instead of retaining compatibility notes.

### Stage 6 — Final documentation and release alignment

- Update all active specs that currently list `@openkit/mcp` as a public projection so they name the unified Skill and CLI projection where relevant.
- Update auth, vault, knowledge, recovery, scheduler, Goal, Task, Chat, workspace, and evidence implementation projections after their CLI coverage lands.
- Update the release and test commands, package inventories, deployment guides, and entry-point docs.
- Close this record with commit links, final verification evidence, and any explicitly deferred work.

## Verification Plan

### Documentation checkpoint

- `node scripts/validate-spec-lifecycle.mjs`
- `git diff --check`
- Link audit for the new spec and change record.
- Repository search proving active indexes and entry-point docs no longer present the old AI Interface or developer-loop specs as current guidance.
- Repository search distinguishing retained worker-side MCP references from user-facing MCP references scheduled for deletion.

### Implementation checkpoint

- Focused CLI unit and process tests.
- App API OpenAPI-to-CLI coverage and duplicate-ownership tests.
- One representative contract story against a temporary local NanoCore, reusing existing auth-owned server and bootstrap proof.
- Secret-redaction tests proving credentials and one-time token material do not appear in argv, logs, Skill context, or normal CLI envelopes.
- Existing L0-L5 package, API, NanoCore, smoke, and release gates after MCP removal.
- One real progressive-discovery L6 plus only legacy stories that prove a distinct uncovered risk.
- Skill-creator metadata validation and representative forward tests.
- Final reachability searches showing no user-facing MCP or legacy Skill package, dependency, import, binary, script, release wiring, Skill metadata, or active-guide surface.

## Expected Handoff Points

- Stage 0 and the G02 preamble freeze authority and scope before implementation.
- Stage 1 must complete before CLI production code.
- Stage 3 begins only after the CLI invocation contract is usable enough for the Skill to call.
- Stage 4 must pass before any MCP or legacy Skill deletion.
- Stage 5 is intentionally irreversible and begins only after Skill-plus-CLI parity is demonstrated through the replacement stories.
- Stage 6 closes the change after the repository contains one end-user Skill and no user-facing MCP surface.

## Known Risks

- **Skill bloat:** exposing the complete public system can recreate the former flat-registry context problem inside one Markdown file. Mitigation: keep `SKILL.md` as a router and move details into one-level references plus CLI search/description.
- **Transport portability:** some AI applications may support MCP but cannot execute Skill scripts. This is accepted by the clean target; those applications are not supported by this interface unless they gain the required Skill and command-execution capability.
- **Secret exposure:** generic operation invocation can surface one-time credentials. Mitigation: sensitivity metadata, direct credential-store writes, stdin-only secret input, redacted envelopes, and NanoCore-side authorization remain mandatory.
- **Duplicated contracts:** a new CLI catalog could drift from App API schemas. Mitigation: reuse Core Client and shared schemas and delete the MCP registry rather than copying it.
- **Prompt-owned workflow:** the Skill could accidentally become a second workflow engine. Mitigation: the Skill recommends sequences, while NanoCore remains the only owner of durable state and valid transitions.
- **Ambiguous "all capabilities":** exposing internals would violate Core boundaries. Mitigation: interpret the requirement as all supported public, governed end-user and operator capabilities, never private runtime or storage internals.
- **Broad deletion blast radius:** MCP names appear across tests, scripts, active specs, and historical records. Mitigation: delete reachable surfaces and update active guidance while preserving immutable historical records as history.

## Checkpoints

- 2026-07-13 — Clean replacement direction approved: one end-user `openkit` Skill plus bundled CLI, no user-facing MCP, no developer Skill variants, and no compatibility layer.
- 2026-07-13 — Documentation authority and lifecycle alignment completed; spec lifecycle, relative-link, and whitespace checks passed; Skill and CLI implementation not started.
- 2026-07-18 — G02 audit and owning-document corrections completed; S01 was superseded into named owners, the frozen fallback and proportional-test contracts are explicit, and Stage 1 test-first implementation is next.
- 2026-07-18 — Stages 1-4 completed through `d41b1dd`: the checked catalog, standalone CLI, unified Skill, secret-safe credential path, clean-copy L5, and one local NanoCore L3 passed; official Codex 0.144.5 on A1 then selected the Skill from metadata, loaded only `SKILL.md` and `loop.md`, discovered and described `workspace.create`, failed closed on one empty-stdin attempt, performed exactly one successful mutation, confirmed it through `workspace.list`, passed the secret-marker scan and independent readback, and left no runner or retained evidence platform. Stage 5 deletion is now authorized; Stage 6 alignment and exit gates remain.
- 2026-07-18 — Stages 5-6 completed: the user-facing MCP package and four legacy Skills were deleted, redundant interface stories and simulator projections were narrowed or removed, all active projections were aligned, and both release and full package-exit verification passed.

## Final Implementation Summary

WP-1/G02 is complete. `skills/openkit/` now ships the single end-user Skill, one bundled JSON-only CLI, progressive one-level references, and generated host metadata. `skills/openkit-operations.mjs` checks complete public operation coverage while referencing existing App API schemas and typed Core Client methods instead of owning routes or business rules.

Credential resolution remains endpoint-scoped and fail-closed, secret material stays out of arguments and normal output, local abort does not claim product cancellation, and NanoCore remains the authority for validation, authorization, idempotency, workflow state, recovery, audit, and execution.

The user-facing `@openkit/mcp` package, binary, resources, prompts, workspace and release wiring, four former Skill directories, and dedicated MCP acceptance paths are deleted without an alias, adapter, or compatibility period. Worker-side MCP remains a separate accepted capability plane, and current AEPs still expose no capability routes.

Implementation lineage is Stages 1-4 through `d41b1dd`, deletion tests `42da171`, `8e7e9ba`, and `7c0cc67`, clean removal `7e12e74`, and bounded cleanup `93f4363` through `d50451e`. The cleanup deleted unsupported or duplicate tests and fixed only two stale test completion/input contracts; it did not add a runner, harness, workflow engine, recovery state, or second SDK.

## Final Verification Evidence

- `CI=true pnpm -w verify:release` and `CI=true pnpm -w verify:full` passed after deletion and cleanup, including repository checks, lifecycle and reachability validation, lint, typecheck, unit tests, coverage, builds, NanoCore L3, Web L4, smoke, and deterministic stories.
- NanoCore unit and coverage runs passed 1,973 tests with 7 explicit skips; NanoCore L3 passed 20 tests with 1 explicit skip; Web L4 passed 4 tests; deterministic story verification passed 40 runner checks and 1 Web story.
- The repository-owned Skill suite passed 8/8, the clean-copy bundled executable passed, and the stock skill-creator validator reported `Skill is valid!` using only a temporary PyYAML installation outside the repository.
- The real A1 progressive-discovery L6 passed with official Codex 0.144.5, metadata-first loading, one reference, one durable mutation, independent readback, secret-marker scanning, and complete temporary-resource cleanup.
- The reachability guard found no tracked user-facing MCP or legacy-Skill path, import, binary, script, release entry, metadata entry, or active-guide projection; the ignored generated residue under the former `mcp/` directory was also removed locally.
- Remaining: none in WP-1/G02. WP-2 may begin only after its bounded G03 audit preamble is recorded.
