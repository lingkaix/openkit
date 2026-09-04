---
status: Accepted
implementation: Partial
---
# OpenKit Agent Skill Interface

## Owns

This spec owns the user-facing AI-native OpenKit interface composed of one end-user `openkit` Skill, its progressively disclosed reference material, its bundled `openkit` CLI, and the transport-neutral operation catalog that maps the CLI to governed public NanoCore behavior.

It owns the Skill audience and trigger boundary, Skill package shape, progressive disclosure model, CLI process contract, operation discovery and invocation contract, public capability coverage rule, agent-facing loop guidance, Skill/CLI version alignment, and removal of the former user-facing MCP and four-Skill model.

## Does Not Own

This spec does not own NanoCore workflow state, App API routes, Core protocol records, worker execution, policy decisions, approvals, idempotency, audit storage, vault internals, runtime supervision, Web UI behavior, worker-side MCP capability supply, or private administration surfaces.

It does not own the general worker Skill Catalog in `docs/specs/20260711-skill_catalog_versioning_pinning.md`, Agent Environment Package Skill supply, public Skill marketplace design, generic shell access, arbitrary HTTP access, or a repository-developer workflow.

It does not own product-wide release identity, authorization, channels, retry, or completion, which are owned by `docs/specs/20260829-release_management.md`.

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/agent-workflow.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

Related specs:


## Related Docs

- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260829-release_management.md`

## Summary

OpenKit exposes one AI-native end-user interface: a single Skill named `openkit` with a bundled CLI.

The Skill teaches an agent how to connect to NanoCore, discover available capabilities, select Chat Mode, Task Mode, or Goal Mode, operate bounded loops, surface Action Center decisions, inspect artifacts and evidence, use knowledge, recover interrupted work, and perform explicitly authorized operator actions.

The CLI performs deterministic discovery and invocation over public NanoCore contracts. Its catalog sources are exactly `app-api`, `core-projection`, and `local-only`; it does not preload every capability into the agent context. The agent first receives Skill metadata, then the concise `SKILL.md`, then only the reference file relevant to the current task, and finally only the operation schemas requested through CLI search and description.

The interface exposes every supported public end-user and operator capability. Private NanoCore internals, raw storage, arbitrary routes, arbitrary shell, credentials, process handles, and runtime-private records are not public capabilities and remain inaccessible.

NanoCore remains the source of truth. The Skill recommends how to work, the CLI validates and transports calls, and NanoCore decides what is valid, authorized, durable, reviewable, and executable.

The accepted change removes the user-facing `@openkit/mcp` package and the four Skills `openkit-setup`, `openkit-setup-dev`, `openkit-loop`, and `openkit-loop-dev` without compatibility adapters or aliases. Worker-side MCP capability supply is a different plane and remains unchanged.

## Goals / Non-goals

### Goals

- Provide one discoverable end-user Skill for the complete OpenKit product surface.
- Let an agent progressively discover and combine all supported public NanoCore capabilities without loading a flat catalog into initial context.
- Combine setup, normal operation, loop methodology, recovery, knowledge, and administration guidance in one Skill package without combining all details in one Markdown file.
- Keep the Skill focused on end users and remove repository-developer and OpenKit self-improvement variants.
- Keep the CLI thin, deterministic, typed, JSON-only, and backed by shared schemas and `@openkit/core-client`.
- Keep workflow truth, authorization, approval, idempotency, audit, recovery, and execution in NanoCore.
- Make capability coverage mechanically auditable as the App API and public Core projections grow.
- Keep credentials and one-time secret material out of command arguments, normal output, logs, Skill context, artifacts, and knowledge.
- Replace the user-facing MCP channel, MCP resources, and MCP prompts completely.
- Preserve the distinction between the end-user Agent Skill Interface and worker-side capability supply.

### Non-goals

- Do not support an OpenKit repository developer Skill, self-improvement Skill, or development-only setup path.
- Do not retain MCP for clients that cannot execute Skill scripts; those clients are outside this interface contract.
- Do not expose private NanoCore modules, internal routes, raw SQLite, `DATA_ROOT`, raw worker checkpoints, process handles, provider secrets, or runtime credentials.
- Do not provide a generic HTTP client, arbitrary route caller, arbitrary shell, arbitrary filesystem access, or unrestricted admin escape hatch.
- Do not move workflow decisions or durable state into Skill text or CLI code.
- Do not require a human-friendly interactive CLI in the first implementation; the CLI is agent-first and structured-output-only.
- Do not add an interactive shell, daemon, background service, subscription transport, or streaming CLI mode; each invocation is bounded, and long-running work is followed through durable NanoCore reads.
- Do not build a public Skill registry, marketplace, plugin system, or cross-Skill dependency manager.
- Do not preserve former MCP tool names, resources, prompts, package entrypoints, configuration aliases, or legacy Skill names as compatibility contracts.
- Do not alter worker-side MCP tool supply or the Agent Capability gateway.

## Background

The former AI Interface combined four Skills with a user-facing stdio MCP server. As NanoCore capabilities grew, the MCP server accumulated a large flat tool registry plus resources and prompts.

The transport remained thin, but every tool schema was advertised as one eager surface, the four Skills repeated setup and loop guidance across audience variants, MCP prompts overlapped Skill guidance, and package documentation had to remain synchronized with all of them.

The underlying architecture does not require MCP. The former `OpenKitNanoCoreClient` already called `@openkit/core-client`, and NanoCore already owned validation, authorization, state transitions, approvals, audit, evidence, recovery, and execution.

The clean design therefore removes the eager transport and retains the valuable layers: a guided agent workflow, typed public operations, Core Client reuse, credential mediation, redaction, and NanoCore-owned product semantics.

## Decision

### One end-user Skill

OpenKit ships one repository-authored Skill named `openkit`.

The Skill targets an agent helping an end user operate OpenKit. Its frontmatter description must include end-user setup, connection diagnostics, workspace and repository operation, Chat/Task/Goal work, loop coordination, Action Center decisions, artifacts, evidence, knowledge, recovery, runtime configuration, vault administration, audit, usage, automation, Git operations, and workspace portability as trigger contexts.

The Skill must not contain a developer audience switch, repository self-improvement mode, OpenKit source-checkout setup, package-development instructions, or developer-only fallback path.

### One bundled CLI

The Skill distribution contains an executable `openkit` CLI entrypoint under its `scripts/` resources.

The executable is part of the same versioned Skill artifact. It may be built from repository TypeScript or JavaScript sources, but the distributed Skill must contain everything required to invoke it in the supported host environment without installing the former MCP package.

The first distribution is a single-file JavaScript executable with a `node` launcher contract and no runtime package installation, `node_modules`, package-manager command, or OpenKit source checkout. The supported host must provide Node.js 24, matching the repository runtime contract; a different self-contained runtime packaging model requires a later accepted spec change.

The logical release artifact is the complete `skills/openkit/` directory. A host installs or updates that directory as one unit through its native Skill mechanism; OpenKit does not publish or install a separate CLI package for this interface.

The GitHub Release attachment is `openkit-skill-<tag>.tar.gz`, with one `openkit-skill-<tag>/` envelope containing the repository `LICENSE` and the complete `skills/openkit/` tree. The sibling `SHA256SUMS` file is the portable checksum authority for that archive.

The CLI calls only public NanoCore behavior through `@openkit/core-client` and shared schemas. It must not import NanoCore implementation, storage, runtime, or adapter modules.

The CLI operation catalog is a curated agent-facing projection, not a second route catalog. Each operation has exactly one source: `app-api` references an existing App API `operationId`, one existing public Core Client method, and its shared App API schema; `core-projection` references an existing typed `client.core` method and `@openkit/protocol` schema; and `local-only` states why no NanoCore call exists. The catalog must not copy HTTP methods, paths, or payload schemas.

### No user-facing MCP

The `@openkit/mcp` package, `openkit-mcp` binary, stdio JSON-RPC transport, MCP tools, MCP resources, MCP prompts, and MCP-specific configuration are deleted.

No compatibility server, proxy, alias, redirect, deprecated package, or second operation surface is retained.

The separately authenticated worker-side MCP capability plane remains governed by `docs/specs/20260704-worker_mcp_tool_supply.md` and is unaffected. Selected Codex Worker AEPs may expose its exact three private capability operations, but they do not recreate a user-facing MCP server, CLI operation family, or compatibility surface.

## Contract / Expected Behavior

### Supported host contract

An AI application is supported by this interface only when it can:

- install or load a filesystem-backed Skill package
- read `SKILL.md` and referenced files on demand
- execute the bundled `openkit` script as a child command
- provide Node.js 24 for the bundled single-file executable
- provide stdin and read stdout, stderr, and process exit status
- protect local credential storage and environment state according to the host's security model

MCP-only hosts without Skill script execution are intentionally unsupported.

### Skill package contract

The canonical package shape is:

```text
skills/openkit/
  SKILL.md
  agents/
    openai.yaml
  scripts/
    openkit
  references/
    setup.md
    loop.md
    knowledge.md
    recovery.md
    administration.md
    capability-map.md
```

The implementation may omit a reference file when no current capability requires it, but it must not create additional overview, installation, quick-reference, changelog, or README files inside the Skill folder.

`SKILL.md` must remain a concise router and default operating procedure. It must link every reference directly and state when to load it. References must not depend on deeper nested references.

`SKILL.md` frontmatter must contain only `name: openkit` and a comprehensive `description` that carries all trigger contexts. The body must use imperative instructions, remain below 500 lines, and avoid a separate “when to use” section because trigger selection occurs before the body is loaded.

Any reference longer than 100 lines must include a table of contents, and detailed schemas or examples must live in one reference owner rather than being repeated in `SKILL.md` and reference files.

`agents/openai.yaml` must be generated from the final Skill contract and validated with the repository-approved skill-creator tooling.

### Progressive disclosure contract

The interface uses four disclosure levels:

1. Skill name and description identify when OpenKit should be used.
2. `SKILL.md` provides the invariant safety rules, default loop, CLI entrypoint, and reference-selection guide.
3. One-level reference files provide the detailed method and operation families for the current task.
4. CLI search and description return only matching operation metadata and the requested input contract.

The complete operation catalog must not be copied into `SKILL.md` or loaded by default.

The Skill must prefer search before description and description before invocation when the required operation or input shape is not already known from the loaded reference.

### CLI command contract

The first CLI exposes exactly these command families:

```text
openkit doctor
openkit ops search <query>
openkit ops describe <operation-id>
openkit ops call <operation-id> --input -
```

`openkit doctor` validates executable version, endpoint configuration, reachability, authentication availability, NanoCore readiness, and capability compatibility without invoking a mutating product operation; normal authentication last-use and audit recording may still occur.

`openkit ops search` returns only concise matching operation metadata. Search must support operation id, capability group, and summary text.

`openkit ops describe` returns one operation's description, mutating flag, sensitivity metadata, required actor/capability summary, and JSON input schema.

`openkit ops call` reads one strict flat JSON object from stdin, validates it against the shared operation schema, invokes the public client mapping, and writes one JSON result envelope. Flat means that path scope, query, and body fields share one top-level namespace instead of `params`, `query`, or `body` wrappers; nested product values explicitly required by the referenced schema remain valid. The catalog rejects unknown fields and maps the validated fields to the referenced Core Client method.

The first implementation must not add a large tree of hand-authored convenience subcommands. Repeated real-agent mistakes may justify a later focused command, but only after usage evidence shows that search, describe, and call are insufficient.

### Operation identity and metadata

Operation ids are transport-neutral product identifiers with a `<domain>.<verb>` shape, such as `workspace.list`, `goal.start`, `goal.step`, `attention.resolve`, `knowledge.retrieve`, or `vault.unlock`.

Former MCP tool names are migration inputs, not compatibility contracts. Implementation may reuse a product verb only when it remains the clearest operation identity.

Each operation definition must own:

- stable operation id
- source classification of exactly `app-api`, `core-projection`, or `local-only`
- existing App API `operationId` and public Core Client method for `app-api`, existing typed `client.core` method for `core-projection`, or reason for `local-only`
- capability group
- concise summary
- mutating flag
- input schema
- public client handler
- input sensitivity classification
- output sensitivity classification
- required actor or capability summary when narrower than normal authenticated access
- redaction behavior

The operation catalog must not duplicate server authorization or workflow transition rules.

One catalog operation maps to one public Core Client operation plus any required local credential-store handling. The CLI must not compose multi-step OpenKit workflows internally; the Skill-guided agent performs that composition through separate bounded calls.

The first implementation uses one cohesive literal inventory and native lookup. It must not introduce a registration framework, plugin system, generated client, second SDK, or catalog-specific workflow layer.

### Public capability coverage

Every public App API operation and public Core projection intended for an end user or operator must be represented by one CLI operation or one explicit machine-checked exclusion with a reason and owning spec.

The existing checked App API OpenAPI operation catalog is the `app-api` coverage authority. `core-projection` entries and exclusions must resolve to existing typed `client.core` methods and protocol schemas. The coverage guard compares these authorities with CLI mappings and exclusions; the CLI catalog must not copy HTTP methods, paths, request schemas, or response schemas into another hand-maintained inventory.

The coverage guard must fail when a new public user/operator operation is added without an Agent Skill Interface decision.

Valid exclusions include Web-only presentation reads, internal service callbacks, worker-authenticated routes, provider-compatible gateway routes, and operations that would expose unsafe private state.

An exclusion cannot be justified only by implementation effort or because the capability is rarely used.

The initial operation groups cover:

- connection, readiness, diagnostics, and bootstrap
- access tokens and credential storage
- NanoHost enrollment, redacted transport-token inventory and revocation, named-slot issue and rotation, rotation abort, and decommission
- workspaces, resources, repositories, and Git operations
- threads, Chat Mode, Task Mode, Goal Mode, plans, and bounded steps; steering without an accepted durable delivery contract remains an explicit exclusion with a typed fail-closed result
- Action Center, approvals, questions, reviews, artifacts, evidence, audit, and usage
- knowledge sources, observations, claims, conflicts, retrieval, context packages, proposals, repair, and health
- interrupted-worker inspection and checkpoint retry, scheduler admissions, and exact S16 Goal pending input only after its durable owner and delivery proof exist
- runtime configuration and product-safe runtime availability; AgentSession identity and replacement remain hidden internal behavior
- vault status, unlock, lock, bootstrap, grants, injection records, use records, and rebind
- provider-subscription inventory, account lifecycle and status, and quota
- automations
- backup, export, import, and workspace portability

The provider-subscription projection freezes these exact transport-neutral identities:

| Agent operation id | App API `operationId` | Core Client method |
| --- | --- | --- |
| `provider-subscription.provider-list` | `listSubscriptionProviders` | `providerSubscriptions.listProviders` |
| `provider-subscription.account-list` | `listProviderSubscriptionAccounts` | `providerSubscriptions.listAccounts` |
| `provider-subscription.account-create` | `createProviderSubscriptionAccount` | `providerSubscriptions.createAccount` |
| `provider-subscription.account-update` | `updateProviderSubscriptionAccount` | `providerSubscriptions.updateAccount` |
| `provider-subscription.account-delete` | `deleteProviderSubscriptionAccount` | `providerSubscriptions.deleteAccount` |
| `provider-subscription.account-status` | `getProviderSubscriptionAccountStatus` | `providerSubscriptions.getAccountStatus` |
| `provider-subscription.account-login-start` | `startProviderSubscriptionAccountLogin` | `providerSubscriptions.startAccountLogin` |
| `provider-subscription.account-login-cancel` | `cancelProviderSubscriptionAccountLogin` | `providerSubscriptions.cancelAccountLogin` |
| `provider-subscription.account-logout` | `logoutProviderSubscriptionAccount` | `providerSubscriptions.logoutAccount` |
| `provider-subscription.account-quota` | `getProviderSubscriptionAccountQuota` | `providerSubscriptions.getAccountQuota` |

These ten `app-api` entries use the existing generic literal catalog and `openkit ops call` path. They add no provider-specific CLI branch, convenience command, exclusion, alias, or new Skill narrative.

### Output and error envelopes

Every CLI command that completes writes exactly one JSON object to stdout.

A successful operation uses:

```json
{
  "ok": true,
  "command": "ops.call",
  "operation": "goal.start",
  "requestId": "...",
  "data": {}
}
```

A failed operation uses:

```json
{
  "ok": false,
  "command": "ops.call",
  "operation": "goal.start",
  "requestId": "...",
  "error": {
    "code": "...",
    "message": "...",
    "details": {}
  }
}
```

Every envelope includes `ok` and `command`. The `command` value is one of `doctor`, `ops.search`, `ops.describe`, or `ops.call`; `operation` is present only for `ops.call`, and `requestId` is present whenever the command issued or attempted a NanoCore request.

Diagnostics that are not part of the result envelope go to stderr and must remain redacted.

Exit status is `0` for success, `2` for local input or usage failure, `3` for connection or authentication failure, `4` for a typed NanoCore rejection, and `1` for an unexpected internal CLI failure.

The CLI generates an idempotency request id for mutating operations when the public operation permits client generation and the caller did not supply one. The generated id is returned in the envelope.

SIGINT or a transport abort stops only the local wait and must not be reported as product cancellation. Product cancellation or interruption requires an explicit catalog operation followed by a durable state read; the CLI does not infer the remote outcome from local process termination.

### Authentication and secret handling

The CLI accepts the NanoCore endpoint from non-secret configuration, including `OPENKIT_NANOCORE_URL` for explicit process configuration.

Every networked CLI request must send stable Core Client audit metadata with channel `openkit-cli` and source `agent-skill`. Host-specific detail may be added only through an existing bounded metadata field and must not replace those stable interface labels.

Persistent bearer credentials are resolved from the supported local credential store keyed by NanoCore endpoint under `docs/specs/20260704-remote_auth_credential_bootstrap.md`: OS keychain first, with only its explicitly permitted encrypted fallback and degraded-storage warning when no keychain is available. `OPENKIT_NANOCORE_TOKEN` may remain an explicit ephemeral automation override, but it must never be printed or copied into Skill context.

Except for the explicit ephemeral `OPENKIT_NANOCORE_TOKEN` automation override, secret input must use stdin or a platform credential mechanism. Secret values must never be accepted through command arguments.

Generic access-token create and rotate operations are excluded from V1 because the endpoint-keyed credential store has no safe named destination and must not overwrite the current administration credential. Bootstrap consumption may store the returned current credential directly and return only redacted storage metadata, or fail closed with a typed setup error when secure storage is unavailable; one-time secret material must never be printed into normal agent-visible output.

Redaction applies to stdout, stderr, errors, operation traces, test evidence, Skill examples, artifacts, knowledge, and audit summaries.

### Default loop method

The Skill teaches one default end-user loop:

1. Run `openkit doctor` and resolve connection or authentication blockers.
2. Select or create a workspace and inspect its resources.
3. Link or verify required repositories and data sources with the user's confirmation.
4. Create or resume a thread.
5. Select Chat Mode for a lightweight answer, Task Mode for one bounded delegated task, or Goal Mode for planned multi-step work.
6. For Goal Mode, draft the plan and obtain the required human approval before execution.
7. Execute one bounded action or step.
8. Read durable thread state, Action Center, artifacts, evidence, and relevant audit or usage summaries.
9. Present required decisions to the human and resolve them only from explicit user direction.
10. Continue, steer, refine, recover, or stop from durable NanoCore state.

The Skill may adapt this method to the task, but it must not skip server-required approval, review, recovery, or authorization gates.

### Authority boundary

The Skill owns guidance and operation selection.

The CLI owns local parsing, schema validation, credential resolution, redaction, public client invocation, and structured output.

NanoCore owns accepted state transitions, actor authorization, policy, approval, idempotency, audit, persistence, recovery, scheduling, artifacts, evidence, and worker execution.

Neither the Skill nor CLI may infer that a successful local validation means an operation is authorized.

### Version alignment

The Skill, references, CLI executable, and operation catalog ship as one versioned artifact.

`openkit doctor` must report the local interface version, connected NanoCore contract version or capability digest, and a typed incompatibility when the required public contract is absent.

The first implementation needs exact supported contract identity, not a general dependency solver or compatibility range system.

## Proposed Design

```text
Human
  -> Skill-capable agent host
      -> openkit/SKILL.md
          -> one relevant reference
          -> bundled openkit CLI
              -> operation catalog
                  -> @openkit/core-client
                      -> NanoCore public App API
                          -> Core-owned state, policy, approval, audit, and execution
```

The operation catalog is the single agent-facing capability inventory. References organize operations by user intent, while CLI search and description expose authoritative machine-readable details.

The Skill must not mirror every schema. The CLI must not mirror NanoCore business logic. The catalog must not become a second App API.

## Current Implementation Projection

The base mechanism is implemented by `skills/openkit/`, `skills/openkit-cli.mjs`, `skills/openkit-operations.mjs`, and `skills/openkit-secrets.mjs`. The checked operation catalog references public App API or typed Core Client owners, the bundled CLI provides JSON-only discovery and invocation, and the Skill progressively routes agents to one-level references.

All ten provider-subscription operations are present in the existing literal `app-api` catalog under the frozen transport-neutral identities. They map one-to-one to the checked App API operation ids and `client.providerSubscriptions` methods, use the shared strict input schemas through the generic `openkit ops call` path, and add no provider-specific command, alias, exclusion, workflow, or duplicated route contract. The bundled executable is regenerated from that source and passes the existing reachability and interface checks.

The seven NanoHost transport operations map through that same generic path to `client.app` methods and shared App API schemas. They write secrets only to named execution-host slots and return redacted inventory; they add no CLI credential destination, alias, or second delivery path.

Repository checks enforce public-operation coverage and reject a reachable user-facing MCP package, binary, import, script, release step, Skill metadata entry, active-guide projection, or one of the four former Skill directories. The former user-facing MCP implementation and its dedicated acceptance platform are deleted without an alias or compatibility path.

`scripts/package-release-assets.mjs` now archives the complete Skill and repository license from the tagged Git revision, preserves the executable bit of `skills/openkit/scripts/openkit`, and writes `SHA256SUMS`; the tag workflow publishes and independently verifies those two portable assets.

NanoCore remains authoritative for validation, authorization, idempotency, state, recovery, audit, and execution. Worker-side MCP remains a separate accepted capability plane, and current worker AEPs expose no capability routes. This spec remains `Partial` until the complete public user/operator operation surface satisfies the catalog-or-exclusion acceptance predicate; the provider-subscription subset is aligned and has no separate CLI or Skill package.

## Alternatives Considered

### Split the MCP server into capability-specific servers

Rejected. It moves the eager catalog into multiple configuration units and adds server selection, installation, and release coordination without simplifying the canonical user interface.

### Keep MCP and add one Skill as a router

Rejected. It preserves two release artifacts, continues MCP schema advertisement and host configuration, and retains duplicated MCP prompts and Skill guidance.

### Keep the four Skills and replace only MCP with CLI

Rejected. Setup versus loop can be represented through progressive references, and the developer variants are no longer product use cases.

### Expose raw NanoCore HTTP through a generic CLI

Rejected. It bypasses product operation curation, duplicates endpoint knowledge in Skill text, weakens redaction and coverage checks, and encourages agents to treat private or presentation routes as supported workflows.

### Build a large human-friendly CLI command tree first

Rejected for the first implementation. Search, describe, and typed call provide the smallest complete agent interface; convenience commands must be earned by observed failures.

### Keep MCP for hosts without shell execution

Rejected. The chosen product interface explicitly requires a Skill-capable host that can execute bundled scripts, and OpenKit does not preserve an additional channel without a current product requirement.

## Consequences

- Initial agent context becomes small even as public capability count grows.
- Setup, loop methodology, recovery guidance, and capability use ship in one end-user package.
- Agent hosts need Skill installation and bundled script execution instead of MCP configuration.
- User-facing MCP-only clients stop being supported.
- CLI and Skill releases must remain aligned with NanoCore public contracts.
- All public end-user/operator capabilities gain an explicit coverage decision.
- The repository deletes a package, four Skill folders, MCP protocol code, resources, prompts, tests, and release wiring.
- The new Skill becomes broad in capability but stays context-efficient only if detailed content remains in references and CLI discovery.

## Rollout / Migration Plan

1. Accept this spec and create the linked change plan.
2. Supersede the former AI Interface spec and retire the former developer-loop spec.
3. Add tests for CLI discovery, description, invocation, envelopes, redaction, auth, and capability coverage.
4. Extract a transport-neutral operation catalog from the existing tested mappings and implement the bundled CLI.
5. Create and validate the single `openkit` Skill with only end-user guidance and progressively loaded references.
6. Replace MCP acceptance with lower-layer coverage, one representative local Skill-plus-CLI story, existing auth-owned server evidence, and one real progressive-discovery story.
7. Delete `mcp/`, all MCP-only wiring, and the four legacy Skill directories in the same implementation change sequence.
8. Update every active implementation projection, command, package inventory, release gate, and current guide after deletion.
9. Close the change record only when repository searches and release verification show no reachable user-facing MCP or legacy Skill surface.

No compatibility period, alias, dual transport, or migration shim is permitted.

## Testing Strategy / Acceptance Criteria

Coverage is proportional: complete capability mapping is static and contract-tested at L0/L2, CLI behavior is focused at L1, integration uses one representative local L3 plus existing auth-owned proof, and progressive discovery uses one real L6. No new runner or acceptance framework is authorized.

### L0

- Skill metadata and folder structure pass skill-creator validation.
- `SKILL.md` contains only the permitted frontmatter fields, stays below 500 lines, links every reference directly, and contains no developer-only mode.
- Operation coverage fails when a public end-user/operator App API operation or typed Core projection has neither a CLI mapping nor an accepted exclusion.
- Operation coverage reads the checked App API OpenAPI catalog and rejects CLI-owned copies of route methods, paths, request schemas, or response schemas.
- Repository checks reject reachable user-facing MCP and legacy Skill surfaces after deletion by scanning current package directories, workspace dependencies, imports, binaries, scripts, release wiring, Skill metadata, and active guides. Canonical removal rules, historical records, and worker-side MCP design may retain those names.

### L1

- CLI argument parsing, strict flat stdin JSON parsing, search, description, schema validation, envelopes, exit statuses, request-id generation, redaction, local abort behavior, and credential resolution have focused tests.
- Operation catalog handlers map to Core Client methods without importing NanoCore internals.
- Secret-bearing operations never emit submitted or returned material through stdout or stderr.

### L2

- CLI input and output mappings conform to shared App API schemas.
- The public operation coverage guard matches the current App API registry and resolves every `core-projection` reference to a typed Core Client method and protocol schema.
- Auth, permission, error, redaction, and capability-version behavior remain consistent across CLI and NanoCore.

### L3

- One representative local NanoCore story proves doctor, one mutating call, and a durable read through the packaged CLI without recreating a full capability matrix.
- Existing auth-owned server and bootstrap evidence remains authoritative; this interface adds no parallel server-mode runner or generic token create/rotate story.

### L5

- The packaged Skill artifact can execute its bundled CLI from a clean supported host setup.
- Build and smoke tests run without the MCP package or MCP configuration.

### L6

- One real-agent story starts with only Skill metadata, loads `SKILL.md` and one relevant reference, discovers an operation not named in `SKILL.md`, describes and calls it, and completes a bounded loop without loading the complete catalog.
- Legacy stories remain only when they prove a distinct risk not covered at L0-L3; confirmed defects are reduced to the lowest sufficient deterministic regression.
- No L6 story depends on a developer Skill, OpenKit repository self-improvement workflow, MCP tool, MCP resource, or MCP prompt.

## Risks & Mitigations

### Risk: The single Skill becomes another monolith

Mitigation: keep `SKILL.md` as the invariant workflow and reference router, enforce one-level references, and use CLI search/description for operation details.

### Risk: Generic invocation weakens safety

Mitigation: expose only cataloged public operations, validate shared schemas, retain sensitivity metadata, forbid raw HTTP and shell, and keep NanoCore authorization and approvals authoritative.

### Risk: The agent sees credentials

Mitigation: use credential stores and stdin, redact every channel, and fail secret-returning operations when secure direct storage is unavailable.

### Risk: CLI and App API drift

Mitigation: reuse Core Client and shared schemas and enforce public-operation coverage in L0/L2.

### Risk: Unsupported hosts lose access

Mitigation: state the Skill-plus-command host requirement explicitly. Do not reintroduce MCP without a new accepted product decision.

### Risk: Progressive references still duplicate operation schemas

Mitigation: references explain intent and method only; CLI description remains the machine-readable input authority.

### Risk: Developer workflows leak back into the end-user Skill

Mitigation: reject repository source setup, package commands, self-improvement procedures, and developer audience branches in Skill validation and review.

## Open Questions

None. The clean replacement, audience, package shape, command families, capability coverage, authority boundary, removal policy, and supported-host requirement are accepted.

## Deferred / Future Work

- Human-oriented formatted CLI output, interactive prompts, and shell completion may be added only after the agent-first JSON interface is stable.
- Convenience subcommands may be added when real operation traces show repeated search/describe/call errors.
- Additional Agent host distributions may package the same canonical Skill artifact without changing its contract.
- A future product decision may add another user channel, but it must not revive MCP as a compatibility measure.

## Links


- `docs/specs/20260528-core_client_boundary.md`
- `docs/specs/20260704-app_api_openapi_projection.md`
- `docs/specs/20260704-remote_auth_credential_bootstrap.md`
- `docs/specs/20260529-l6_story_acceptance.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `skills/README.md`
