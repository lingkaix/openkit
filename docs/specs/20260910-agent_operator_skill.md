---
status: Accepted
implementation: Partial
kind: boundary
date: "2026-09-10"
---
# Agent Operator Skill

## Persistent Worker Environment Procedure

The packaged operations Skill must project [Persistent Worker Volumes](20260910-persistent_worker_volumes.md): prepare and verify the exact image first, preview and authorize affected work, stop/fence prior writers, reuse whole compatible volumes, observe readiness and preserve failure/unknown outcomes. Routine App update is separate from NanoHost update; neither permits volume deletion. Backup claims state execution-host coverage, and whole-storageRef purge requires its explicit authority. The same owned operations are available to internal administration; the Skill gains no Docker-socket or arbitrary-host privilege.

## Owns

This specification owns the independently distributable `openkit-ops` Skill: its installation, configuration, upgrade, diagnosis and recovery guidance; its host capability boundary; the migration of user manuals into maintained Skill references; and its package completeness and verification requirements.

This specification owns the bundled administrator CLI's process, runtime, discovery, invocation, envelopes, credential handling, redaction, version alignment and coverage obligations. [Operation Definition](20261002-operation_definition.md) owns online operation semantics.

## Does Not Own

[Remote MCP Interface](20261002-remote_mcp_interface.md) owns the user-facing agent channel. This specification does not create a general shell API, internal Agent harness, host credential store, deployment supervisor, approval mechanism, release identity or automatic maintenance service. Configuration, backup, authentication, Vault, NanoHost, release and App-update owners retain their contracts. Skill instructions grant no capability or authorization. Credential eligibility stays with [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md), [Multi-User Workspace System](20260715-multi_user_workspace_system.md), [Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md), `docs/core/permissions.md`, `docs/core/identity.md`, and [Pending Requests](20260930-pending_requests.md). `docs/core/permissions.md` owns the administrator rule as Administrator Eligibility, and the other listed owners apply it at their boundaries.

## Core References

- `docs/core/architecture.md`
- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/vault.md`

## Summary And Decision

Installation and offline recovery require a client that can operate when NanoCore cannot answer. Supply one operations Skill containing the administrator CLI; ordinary product work uses remote MCP and Web. It serves the same operator whether their Agent runs on a desktop or performs explicitly authorized operations for the deployed product. It is not a development-only product client or another workflow engine.

The operations Skill is a concise router to directly linked references and repeatable supported scripts. It teaches the Agent to establish the requested target and effect scope, inspect current facts, choose the existing procedure, perform authorized work and verify its result. It must work outside the source checkout. Source builds may explicitly acquire the selected source snapshot; an installed Skill must not silently depend on the author's checkout, private SSH alias, credentials, temporary investigation files or network-accessible documentation to recover an offline deployment.

## Contract

`skills/openkit-ops/SKILL.md` is the entrypoint. Canonical English operator material lives in its `references/` directory. Scripts exist only for demonstrated repeatable operations; the package has no daemon, dependency manager, fleet inventory or runtime-specific agent implementation. The installed Agent supplies supported shell/SSH/network tools and current authority. An internal Agent without the required host tools delegates to an authorized execution capability or reports it unavailable; loading this Skill must not pierce Worker containment or supply a Docker socket to NanoCore.

Use public NanoCore operations for running-product configuration and records. Ordinary users use remote MCP or Web. Administrators use this package's CLI for online operations and separately authorized host tools for inspection, installation, process replacement and offline recovery. The package derives its online catalog from operation definitions; it must not maintain a second public operation catalog or credential implementation. Offline procedures remain usable when NanoCore cannot answer.

The bundled CLI belongs to this Skill and is not a separate package. It is used with an administrator token. Its online commands are derived from the operation definitions in [Operation Definition](20261002-operation_definition.md), not copied into a second catalog. It writes one-time secrets to local secret-safe sinks instead of model output. Bootstrap, which uses the bootstrap secret, and offline host procedures, including stopped-server recovery and restore, stay separately authorized. An online route cannot replace them. Covering product operations does not expand this CLI into arbitrary host control. Connection probing for doctor and capabilities uses the existing metadata support binding outside the operation catalog; connection.meta has no operation-catalog row or compatibility alias.

First-release user-facing Skill retirement requires remote MCP guide and reach of every release operation except one-time-secret results and the three streaming Workspace archives under [Operation Definition](20261002-operation_definition.md#remote-mcp-projection). Web and administrator CLI cover archives; authorized operator procedures cover one-time-secret results. Discovery and dispatch reach do not override an owner-required refusal or prove domain execution. The accepted exception is recorded in [Streaming Archives Use Web And Administrator CLI](../decisions/20261003-streaming_archives_use_web_and_admin_cli.md).

The accepted target is that a currently usable administrator credential, the administrator's Web session or an administrator bearer, is eligible for every operation, including operations on other users' resources, through one rule in the existing authorizer and not through a second permission model. That eligibility includes recovering a resource another user deleted, reading other users' private Threads and private-derived content, answering approvals raised to other users, archive export and import of any Workspace, and managing the administrator's own access tokens. Attribution stays truthful. The administrator is the recorded actor and does not impersonate the affected user, and a recovered resource returns to its original owner. Per-effect authority objects, such as approval records and Vault grants, still exist and are checked, and the administrator may create or issue them. Credential limits and the sandbox boundary are unchanged. A read-only credential stays read-only, revocation and expiry apply, and the sandbox boundary applies to every actor. The Policy Kernel later refines this authority with fine-grained policy. `docs/core/permissions.md` owns this rule as Administrator Eligibility. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md), [Multi-User Workspace System](20260715-multi_user_workspace_system.md), [Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md), `docs/core/identity.md`, and [Pending Requests](20260930-pending_requests.md) apply it at their boundaries. The rulings are recorded in [Operation Definition Rulings](../decisions/20261002-operation_definition_rulings.md) and [Administrator Authority](../decisions/20261002-administrator_authority.md).

Routine update guidance targets NanoCore and Web together. NanoHost installation, image supply and recovery are clearly separate procedures requiring their own task scope. A single persistent deployment is the normal target; no second instance or second machine is required. Additional staging is optional when a particular destructive, isolated or container-owning check needs it.

Every executable procedure states its prerequisites, target identity, effects, success observation and failure/recovery action. Offline recovery through the existing release-image `openkit-operator` executable requires a working container runtime and the selected compatible App image already available locally or explicitly acquired; it does not require the target NanoCore process to run. Source procedures explicitly acquire the selected checkout and its toolchain. Current credentials and data are reused; credential material stays in protected files or existing secure stores, never prompts, argv, logs or evidence. Recovery does not mean bootstrap replay, direct live database mutation, Vault key regeneration or silent loss of user work. A changed image is not proof that data migration is reversible. A procedure that cannot establish safe preconditions stops before its dependent effect and retains the deciding non-secret observation.

Procedures retain exact source/image and current boot identity where relevant. Existing public Audit, Usage, Task and Artifact records remain product evidence. Host observations remain external evidence until explicitly recorded through an existing public owner; neither a successful shell exit nor a receipt rewrites interrupted product work as completed.

## Manual Migration And Maintenance

Move maintained user/operator instructions from `docs/manual/` into Skill references and update current inbound links. The old manual directory retains its discovery README and any single-source pointers needed by frozen historical links, not parallel instruction pages or placeholders claiming implementation. All migrated manuals, including the product-use overview, belong to `skills/openkit-ops/references/`. Remote MCP guide supplies product workflow, knowledge, exact human decisions, recovery and acceptance guidance; maintained product-use references explain the same user intent without copying operation schemas. A topic has one maintained source. Unsupported roadmap behavior is identified as unavailable, not presented as an executable procedure.

`docs/documentation-model.md` owns the resulting non-authoritative operator-reference type and localization rules. Repository cookbooks retain developer procedure ownership. A release packager may copy a required cookbook into the Skill as a generated projection with explicit provenance, but it must not introduce another independently maintained copy or require unresolved repository-relative links in the installed archive. Generated files are recreated from their source, never hand-maintained. Product Vision is unchanged.

A relevant runtime, CLI, configuration or deployment change updates the affected Skill reference in the same slice. Replacing the installed complete package is the upgrade lifecycle; there is no in-place self-modifying Skill code, installed-source merge, compatibility alias or automatic rollback of user data. Unknown versions, missing files or an unsupported host yield a specific unmet prerequisite, not a speculative repair.

## Release And Acceptance

The release-management owner distributes a separate `openkit-ops-skill-<tag>.tar.gz` containing the complete Skill tree and repository license, under the same source tag and checksum verification as other portable assets. Local source packaging uses the same tree and verification. Packaging or installation does not start a service, enroll NanoHost, acquire privileges or mutate product state.

Acceptance requires a complete archive used from outside the checkout, resolvable internal reference links, current commands and declared runtime requirements, and a fresh Skill-capable Agent completing a bounded authorized operator task using only that package and normal host tools. An offline recovery procedure must remain readable and executable without the target NanoCore. Validate secret handling and the actual effects of any supplied script using the lowest sufficient regression; do not treat Skill metadata validation as behavioral proof.

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


### Output and error envelopes

Every CLI command that completes writes exactly one JSON object to stdout.

A successful operation uses:

```json
{
  "ok": true,
  "command": "ops.call",
  "operation": "workspace.list",
  "requestId": "...",
  "data": {}
}
```

A failed operation uses:

```json
{
  "ok": false,
  "command": "ops.call",
  "operation": "workspace.list",
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

`token.create` and `token.rotate` project their same canonical operation ids through `client.operations` only with an explicit non-reserved local `destination` name under the named credential storage contract in `docs/specs/20260704-remote_auth_credential_bootstrap.md`. Their strict flat stdin inputs combine the complete shared operation input, including `tokenId` for rotation, with `destination`; the CLI removes only the local `destination` before invoking the public client. Both require deployment-admin authority in server mode, which the CLI supplies through a server-admin bearer token. NanoCore remains the authorization owner; local-mode and insufficient-authority rejections propagate unchanged. Existing `token.list` and `token.revoke` remain available.

Create and rotate MUST preflight named storage before requesting issuance and MUST write the one-time secret only with `credentialStore.writeNamedToken({ baseUrl, destination, token })`. Success returns `{ record, credentialStorageBackend, destination }`, plus `rotatedRecord` for rotation, and never the raw token field. The endpoint administration credential MUST NOT be changed or selected implicitly. Missing storage or preflight failure returns `credential_storage_unavailable` before issuance. Storage failure after issuance returns `credential_storage_failed` with a redacted statement that NanoCore already issued the token and inventory must be inspected before a new request; it does not claim rollback or recoverable secret material. Transport aborts or unknown outcomes require inspection, not automatic replay.

Bootstrap consumption retains `credentialStore.writeToken({ baseUrl, token })` for the current endpoint credential and returns only redacted storage metadata, or fails closed with a typed setup error when secure storage is unavailable. Generic create/rotate MUST NOT reuse that destination. One-time secret material must never be printed into normal agent-visible output.

Redaction applies to stdout, stderr, errors, operation traces, test evidence, Skill examples, artifacts, knowledge, and audit summaries.

CLI result redaction removes credentials and secret material, not generic absolute-path text. NanoCore's authorized operation projections own the non-exposure of private host layout and internal routes; the CLI preserves paths, quoting, and syntax in authorized configuration documents and review patches so these product contents remain usable. This does not authorize new filesystem access, expose private projection fields, or relax Token, provider-secret, runtime-credential, or one-time-secret protection. Missing or failed authorization remains a server rejection; the CLI must not reconstruct withheld content. This presentation rule creates no durable state or new lifecycle, and applies equally to fresh reads and retries.


### Runtime, Coverage And Version Alignment

The complete operations Skill contains its executable under scripts and is installed or replaced as one versioned unit with its references and definition-derived catalog. The single-file JavaScript executable requires Node.js 24, stdin, stdout, stderr, process exit status and protected local credential/environment storage. It requires no runtime package installation, node_modules, source checkout, daemon, interactive shell, subscription transport, general dependency solver or compatibility range system. The three accepted archive transfers are bounded local-file streams; event subscription is not a CLI mode.

The CLI imports only public Core Client and shared schemas, never NanoCore implementation, storage, runtime or adapters. One online invocation maps to one public operation plus required local credential/file handling. Multi-step workflows remain separate agent calls. The definition owns identity, summary, mutation posture and schemas; the projection retains capability group, actor summary, input/output sensitivity and redaction. Local-only entries state their reason. No registration framework, plugin execution layer, second SDK, raw HTTP caller, arbitrary shell/filesystem access or business-logic mirror is admitted.

Every public App API operation and typed Core projection intended for a user or operator has one unique CLI mapping or one explicit machine-checked exclusion with a reason and owning specification. Compare the checked OpenAPI operation ids and full composed definitions with the CLI mappings, and resolve typed Core references against existing methods and protocol schemas. Missing, duplicate, overlapping or unjustified dispositions fail the guard. Effort or infrequency alone cannot justify exclusion. Connection metadata remains a support probe and event subscription remains outside bounded CLI invocation; no second catalog is introduced.

Public dashboard, search, runtime-target and Worker reads retain their existing authorization, missing/restricted detail, private Thread and Artifact audience, audit.read usage boundary and redaction owners. Worker records do not expose ordinary native runtime/session identifiers or infer process liveness, assignment or model identity. Administrator eligibility keeps truthful administrator attribution; ordinary session-only bearer refusals stay with credential owners. The definition and domain owners retain the ten Goal and eleven provider-subscription identities, without aliases or provider-specific commands.

Doctor reports the local interface version, connected NanoCore contract version or capability digest, and a typed incompatibility when the required public contract is absent. Keep exact supported contract identity. Local parsing success never grants authorization; NanoCore owns transitions, actor authority, approval, idempotency, audit, persistence, recovery, scheduling and execution. Former user-facing stdio MCP and four-Skill variants remain deleted without compatibility paths; worker capability supply is unchanged.

Focused tests cover parsing, strict flat inputs, shared schema refinements, mapping, output validation, envelope/status/request identities, redaction, local aborts, credentials and version refusals. Preserve whole-public coverage, named storage preflight before issuance, redacted post-issuance unknown/failure outcomes and existing bootstrap/server-auth proof. A representative administrator-server CLI story proves doctor, mutation and durable read. Execute the packaged CLI outside the checkout under supported Node; package metadata is not behavioral evidence.

## Current Implementation Projection

The administrator executable is generated into skills/openkit-ops/scripts/openkit. Connection probing and local-file archive handling retain their existing owners. Remote MCP coverage and guide regressions cover the retirement seam; live-client acceptance and the former specification terminal archive remain separate observations.

The operations Skill entrypoint, generated executable and six maintained references are present, and current user manuals have moved into that tree. The old manual directory retains discovery pointers for existing and frozen links. The release packager produces the separate archive, and both packaging and post-publication verification use the same extracted-reference check. Local archive verification and a fresh Agent's bounded read-only deployment diagnosis have passed. Release publication and actual offline recovery execution were not demonstrated by that diagnosis. App-triggered host updates follow the separately accepted `20260910-app_update_delivery.md`; this Skill does not independently authorize that effect path.

## Alternatives And Deferred Work

Keeping another manual corpus duplicates maintenance. Expanding the product CLI into arbitrary host control breaks its public-contract boundary. A co-deployed coding Agent, autonomous customer optimization and mandatory dual-instance operation are not required. New procedures may be added when their existing owners and working commands can be projected; unsupported operations remain explicit rather than triggering speculative infrastructure.
