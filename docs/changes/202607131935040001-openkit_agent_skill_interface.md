# OpenKit Agent Skill Interface

Type: change-plan
Status: planned
Canonical Spec: `docs/specs/20260713-openkit_agent_skill_interface.md`

## Intent

Replace the user-facing `@openkit/mcp` channel and the four current OpenKit setup/loop Skills with one end-user-only `openkit` Skill that bundles a small CLI, exposes every supported public NanoCore capability through progressive disclosure, and teaches the agent how to operate OpenKit loops safely and effectively.

This is a clean replacement. OpenKit is in internal development, so the implementation will delete the MCP package, MCP transport, MCP resources and prompts, the four existing Skill folders, and their compatibility surface rather than preserving adapters or aliases.

This record begins with documentation and lifecycle alignment. Skill and CLI implementation starts only in a later execution turn.

## Decision Summary

- The canonical AI-native end-user interface becomes one Skill named `openkit`.
- The Skill targets end users only. It does not contain a repository-developer setup mode or an OpenKit self-improvement mode.
- A bundled, versioned `openkit` CLI performs deterministic discovery and invocation over public NanoCore contracts.
- Progressive disclosure occurs through Skill metadata, a concise `SKILL.md`, on-demand reference files, and CLI operation search/description.
- NanoCore App API remains the machine contract and the source of truth for state, policy, approval, idempotency, audit, recovery, and execution.
- The user-facing MCP channel is deleted without a compatibility adapter.
- Worker-side MCP capability supply remains a separate supported plane and is not changed by this work.

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
- Replace the MCP-specific tool registry with one transport-neutral end-user operation catalog projected from existing App API operation ids, Core Client methods, and shared schemas rather than creating a second route or payload inventory.
- Expose operation discovery, description, and invocation without loading the complete catalog into the agent context.
- Cover all supported public end-user and operator capabilities, including setup, authentication, workspaces, repositories, threads, Chat Mode, Task Mode, Goal Mode, Action Center, artifacts, evidence, knowledge, recovery, scheduler controls, runtime configuration, vault administration, audit, usage, automations, Git operations, and workspace portability.
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

- `@openkit/mcp` currently exposes 99 flat tools plus MCP resources and prompts through a custom stdio JSON-RPC process.
- `mcp/src/registry.ts` owns MCP-specific schemas, descriptions, dispatch, resources, and prompts, while `mcp/src/nanocore-client.ts` already delegates public behavior to `@openkit/core-client`.
- Four repository Skills split setup versus loop and end-user versus developer use.
- Current deterministic Goal, Task, Chat, recovery, and workspace-portability stories run through MCP.
- NanoCore already owns public validation, state transitions, authorization, approvals, audit, recovery, artifacts, evidence, and execution; these contracts do not need to move into the new Skill.
- Worker-side MCP is implemented through a separate capability plane and shares no user-facing product contract with `@openkit/mcp`.

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

- Add tests first for the CLI process contract, operation search, operation description, stdin JSON invocation, stable JSON success/error envelopes, exit codes, redaction, secret-safe credential handling, and server capability/version checks.
- Add a focused contract test proving that the CLI calls only public Core Client surfaces.
- Add a coverage test that reads the checked App API OpenAPI catalog, requires a CLI mapping or explicit exclusion for every public end-user/operator operation, and rejects copied route or schema ownership.
- Define the smallest transport-neutral operation metadata needed by both discovery and invocation; do not add a generic framework beyond the demonstrated catalog.

### Stage 2 — Implement the operation catalog and CLI

- Extract the reusable public operation definitions and handlers from the MCP registry without preserving MCP protocol concepts.
- Implement the bundled `openkit` CLI entrypoint and keep it agent-first and JSON-only for the first version.
- Ship the CLI as one Node.js 24 single-file executable with no runtime package installation, `node_modules`, package-manager command, or OpenKit source checkout.
- Reuse the existing Core Client and credential-store behavior instead of reimplementing HTTP or auth.
- Send stable `openkit-cli` channel and `agent-skill` source metadata through every networked Core Client request.
- Keep every invocation bounded and request/response-oriented; do not add an interactive shell, daemon, background process, subscription transport, streaming mode, or CLI-owned multi-step workflow composition.

### Stage 3 — Create the unified end-user Skill

- Initialize `skills/openkit/` with skill-creator tooling and only the required `scripts/` and `references/` resources.
- Keep frontmatter to `name` and `description`, and make the description trigger for end-user setup, workspace operation, Chat/Task/Goal work, loop coordination, human attention, knowledge, recovery, and administration.
- Write imperative instructions, keep the body below 500 lines, and use directly linked one-level references for detailed capability families.
- Teach the default loop: diagnose, select or create workspace, select mode, perform one bounded action, inspect Action Center and evidence, ask for human decisions, and continue or stop from durable NanoCore state.
- Validate metadata and forward-test the Skill on representative end-user tasks without developer-only context.

### Stage 4 — Replace interface acceptance stories

- Port deterministic MCP stories to invoke the bundled CLI through the unified Skill path.
- Preserve Goal, Task, Chat, workspace portability, recovery, redaction, approval, artifact, and evidence coverage.
- Add at least one clean setup story and one real agent story in which only the Skill metadata is initially visible and detailed references are loaded on demand.
- Verify that the agent can discover a capability without receiving the complete operation catalog in its initial context.

### Stage 5 — Delete MCP and legacy Skills

- Delete the MCP package and every MCP-only test, resource, prompt, command, dependency, script, and release step.
- Delete the four legacy Skill folders.
- Remove MCP and legacy Skill names from active documentation and checked artifacts.
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
- Contract tests against a temporary NanoCore using local and server-mode auth.
- Secret-redaction tests proving credentials and one-time token material do not appear in argv, logs, Skill context, or normal CLI envelopes.
- Existing L0-L5 package, API, NanoCore, smoke, and release gates after MCP removal.
- Replaced L6 stories for setup, Chat, Task, Goal, Action Center, artifacts, evidence, recovery, knowledge, and workspace portability.
- Skill-creator metadata validation and representative forward tests.
- Final repository searches showing no reachable `@openkit/mcp`, `openkit-mcp`, `openkit-setup`, `openkit-setup-dev`, `openkit-loop`, or `openkit-loop-dev` product surface.

## Expected Handoff Points

- Stage 0 ends this documentation-only turn and is the handoff into implementation planning.
- Stage 1 must complete before CLI production code.
- Stage 3 begins only after the CLI invocation contract is usable enough for the Skill to call.
- Stage 4 must pass before any MCP or legacy Skill deletion.
- Stage 5 is intentionally irreversible and begins only after Skill-plus-CLI parity is demonstrated through the replacement stories.
- Stage 6 closes the change after the repository contains one end-user Skill and no user-facing MCP surface.

## Known Risks

- **Skill bloat:** exposing the complete public system can recreate the 99-tool context problem inside one Markdown file. Mitigation: keep `SKILL.md` as a router and move details into one-level references plus CLI search/description.
- **Transport portability:** some AI applications may support MCP but cannot execute Skill scripts. This is accepted by the clean target; those applications are not supported by this interface unless they gain the required Skill and command-execution capability.
- **Secret exposure:** generic operation invocation can surface one-time credentials. Mitigation: sensitivity metadata, direct credential-store writes, stdin-only secret input, redacted envelopes, and NanoCore-side authorization remain mandatory.
- **Duplicated contracts:** a new CLI catalog could drift from App API schemas. Mitigation: reuse Core Client and shared schemas and delete the MCP registry rather than copying it.
- **Prompt-owned workflow:** the Skill could accidentally become a second workflow engine. Mitigation: the Skill recommends sequences, while NanoCore remains the only owner of durable state and valid transitions.
- **Ambiguous "all capabilities":** exposing internals would violate Core boundaries. Mitigation: interpret the requirement as all supported public, governed end-user and operator capabilities, never private runtime or storage internals.
- **Broad deletion blast radius:** MCP names appear across tests, scripts, active specs, and historical records. Mitigation: delete reachable surfaces and update active guidance while preserving immutable historical records as history.

## Checkpoints

- 2026-07-13 — Clean replacement direction approved: one end-user `openkit` Skill plus bundled CLI, no user-facing MCP, no developer Skill variants, and no compatibility layer.
- 2026-07-13 — Documentation authority and lifecycle alignment completed; spec lifecycle, relative-link, and whitespace checks passed; Skill and CLI implementation not started.
