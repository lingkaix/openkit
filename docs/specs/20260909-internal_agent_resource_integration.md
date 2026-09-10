---
status: Accepted
implementation: Not Started
date: 2026-09-09
---
# Internal Agent Resource Integration

## Owned Worker Environment Management

Only the private administration entry acting under the current user's usable administrator authority under Permissions Core (a valid admin Token in server mode) may invoke the exact environment preparation/activation/status and whole-storageRef purge owners specified by [Persistent Worker Volumes](20260910-persistent_worker_volumes.md). This is a bounded Core command integration, not an internal shell, Docker client, generic Worker lifecycle API or Plugin-selected Tool. The existing runtime and authorization owners execute each effect; ordinary Assistant discovery still cannot enlarge its Tool array.

## Owns

This specification owns trusted assembly of selected Skills, internal-capability MCP bindings and native Kernel/UI Tools for NanoCore's internal Assistant: selection/configuration, immutable per-run admission, internal capability lineage, bounded Skill reads, MCP approval/cancellation integration and the caller's publication handoff. It is the implementation seam between existing owners, not a second Agent Runtime, catalog, Plugin loader, Tool registry or effect runner.

## Does Not Own

`20260813-internal_agent_runtime.md` owns the role-neutral transient loop and private message/Tool types. `20260704-chat_mode_assistant.md` owns the ordinary and administration entries and conversation outcomes. Existing Skill, MCP and Plugin catalogs own packages, versions, enablement and bindings. The Kernel, Generative UI, Memory, Policy, Vault, Human Attention, command and Item owners retain their payloads, authority, retention, replay and failure semantics. Worker AEP, AgentSession, Sandbox and Harness mechanisms are not internal-role execution prerequisites.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/architecture.md`
- `docs/core/generative-apps.md`
- `docs/core/permissions.md`
- `docs/core/knowledge.md`
- `docs/core/storage.md`

## Summary

Keep one OpenKit-owned minimal loop and pi-ai transport. Trusted caller assembly supplies a finite Core Tool set and a progressive Skill index; an MCP binding may implement only a separately owned internal capability. The model decides how to use admitted operations; existing owners decide which exact reads, effects and publications may occur. A Light App's schema/data, Agent reasoning and UI remain separate cooperating responsibilities.

## Resource Selection And Configuration

The existing Workspace configuration file `config/workspace.jsonc` owns optional `assistant.resources:{skillIds:readonly string[]}` in the first slice. Absence means an empty list. Skill IDs must be non-empty and unique and reference existing Workspace catalog entries. No inline implementation, credential, path, active version pointer, all-installed selection or per-user Tool membership preference is accepted. Skill current-version/pin selection remains with its catalog. A Plugin is packaging of independently owned components, not an internal harness to load wholesale.

The existing revision-aware Workspace configuration command validates and applies selection of existing Skill entries under current Workspace configuration authority and Policy. This content selection does not activate host code or grant new runtime authority. Ordinary use of an already admitted Skill does not require administrator authority. Changes affect a new bounded run; Skill text and the current message cannot change admission in place. Import rewrites these IDs through the existing catalog maps and retains references as unavailable until fresh target selection; no import activates executable behavior. This is not the removed generic `defaultSkillIds` and creates no separate selection store.

### Internal capability admission

The model sees only Core-owned semantic Tools. Each reachable capability must have an accepted owner defining its exact ID, strict model input/output projection, permitted effect, scope, source audience, confirmation and failure semantics before a factory is implemented. The entry uses a finite reviewed code table to supply those factories. This is ordinary server assembly, not a durable eligibility catalog, a configurable field-mapping engine or a new registration API. No Tool accepts arbitrary server/tool selectors, host shell/code, runtime control or Worker working-directory operations. The sole notebook exception is the Knowledge Manager-only `knowledge.notebook_workspace.update`: interpreted text/file commands over an admitted fixed-base virtual notebook under `20260909-knowledge_notebook_editing.md`; it cannot reach host paths, network, credentials, plugins or Git. The existing policy-bounded read-only repository inspection remains admitted; it is not a workspace-management or filesystem-write capability.

An MCP adapter may fill a capability only after that owner's contract accepts the concrete integration. The reviewed adapter owns the exact upstream Tool name and argument/result translation and carries an immutable `adapterDigest` covering its accepted implementation and Core boundary schemas; the existing catalog owns the selected server configuration, schema evidence, enablement and credentials. A future authored binding selects `{capabilityId,serverId}`, at most one per capability in a Workspace, and never embeds translation rules or upstream Tool names. Its strict configuration field is added with the first accepted adapter consumer, not as an empty extension bag in this slice. Missing or mismatched adapter/schema/binding rejects admission; deployment activation and ordinary `tool.use` permission cannot grant internal-role eligibility.

The first implementation enables the Core Tools enumerated by the Assistant and native Kernel/UI table below plus progressive Skill reads. It enables no arbitrary third-party MCP Tool and defines no production MCP adapter profile here. The MCP lifecycle/approval contract below is ready for a bounded internal capability to use, and is verified with a code-owned test capability before such an adapter is enabled; this is infrastructure conformance, not a claim of a user-facing channel integration. Native Kernel/UI work does not wait for such an integration. New capabilities require a direct entry-owner amendment; adding a server to a catalog cannot silently widen the entry.

### Named extension seams

| Internal need | Existing owner and bounded extension |
| --- | --- |
| Generative Kernel and UI | Exact Core commands below; remain native and do not proxy back through OpenKit's own MCP endpoint. |
| Slack, WhatsApp or Email information | Channel owner must separately admit bounded read and write capabilities, exact destination/account and disclosure rules, and required external-effect confirmation. A write/send is never inferred from a read grant or server annotation. |
| Skill-guided Skill creation/modification | Load selected guidance, then use the existing SkillCandidate owner with exact candidate bytes/base digest. `skill.candidate.propose` is the intended extension seam, not admitted by this slice; promotion retains separate current configuration/review authority. A candidate cannot replace its producing run's Skill or Tools. CLI/code execution, if needed, is an explicit Worker handoff. |
| Existing Artifact retrieval/read | Extend the ordinary entry through the Artifact owner's exact ID/version and current audience rules; no arbitrary NanoCore path reader. |
| Server configuration inspection | Existing redacted `administration.configuration.read` stays in the separate administration entry. Ordinary conversation cannot combine its untrusted resource text with administration capabilities. |

These name supported architectural directions, not extra enabled Tools or a promise to deliver all of them in the initial implementation. Internal agents may reason over and propose data/resources through owned commands; host shell/code execution, build environments, arbitrary filesystem workspaces, background task orchestration and Worker lifecycle remain outside this runtime. The owned virtual notebook editor is a bounded data operation, not a general harness.

## Assembly Order And Model Boundary

1. Resolve the authenticated user, entry, Workspace, Thread/Turn, read scope, output audience, logical model/context policy and existing limits. Validate the entry's composition and current configuration before model dispatch.
2. Resolve selected Skill metadata and exact retained versions/digests. For an owner-admitted MCP adapter, also resolve its exact existing catalog binding and schema snapshot. Metadata discovery uses the existing bounded Gateway/catalog path and is an infrastructure observation, not a business Tool call. No Skill body, business records, personal Memory or external business data is read at assembly.
3. Build the entry's fixed Core Tools in its specified order; an admitted MCP implementation cannot add, rename or reorder those operations. Build a separate ordered Skill index by Skill ID, exposing only authorized name, description, opaque ID and exact version/digest. Retain exact source/configuration evidence through existing Turn/capability evidence; no separately persisted array or prompt is authoritative.
4. Compile immutable private `AgentTool` values using the existing command functions and MCP Gateway. Provider projection contains only `name`, bounded `description` and `inputSchema`. A server-private exact alias map binds canonical Core IDs to closures; reviewed MCP adapters privately bind their upstream targets. Reject collisions or unsupported schema representations before provider dispatch; resolve schema references only within the admitted bounded schema document, with no remote schema fetch, executable validator or automatic server/tool discovery triggered by schema content; never rename two operations onto one alias or offer a generic `mcp.call` dispatcher.
5. Invoke the same internal loop. Before every environment touch the owner rechecks current user/membership, Thread/Turn admission, source/destination audience, catalog enablement, selected configuration/schema/version, Policy, budget and required confirmation. Discovery is not permission, and metadata annotations are not executable Policy.

An unchanged selected entry configuration yields identical ordered definitions across messages and users eligible for that Workspace; authorization differences are typed call results. A known selected Tool that becomes unavailable after assembly remains in that run's array and returns a safe unavailable/stale result. If no validated selected schema can be obtained at assembly, fail admission with a bounded resource-unavailable outcome before calling the model; do not synthesize a permissive schema, silently omit an entry, or substitute a newer version. Explicitly updating the authored selection is the remedy for a permanently removed component.

Model-facing descriptions and schemas come from the owned Core capability, never from a remote server. Existing MCP snapshots retain names/input schemas for dispatch validation; no retained description field is assumed or required. If discovery is needed, it uses current catalog admission, the private internal connection partition below and existing request deadlines. Remote list/schema changes invalidate affected adapter calls; they do not update the model Tool definition or running array. A new run reconstructs from current owners. MCP metadata, Skill prose, tool results and model-generated UI remain delimited untrusted data and cannot modify the trusted base prompt or make an administration Tool reachable.

## Progressive Skill Use

`skill.read` accepts `{skillId,versionId,contentDigest,path}`. `path` defaults to `SKILL.md` and may name only a bounded relative UTF-8 text file inside that selected immutable Skill snapshot. IDs/version/digest must exactly match the admitted index; the closure rechecks current catalog eligibility and source/audience restrictions before reading. Return `{skillId,versionId,path,fileDigest,text}` as bounded model-visible content with provenance, never the underlying absolute path.

Reuse Skill catalog path containment and digest verification. Reject traversal, absolute paths, symlink escape, missing or changed bytes, binary/invalid text and unselected versions. Apply the catalog's existing resource limits and a 64 KiB UTF-8 response ceiling per read; an oversized file returns a bounded size error without truncating instructions into misleading partial guidance. Referenced supporting files remain separate on-demand reads, not recursive directory expansion. A read attempt consumes an ordinary Tool touch; no Skill-specific loop budget is introduced.

Loading a Skill does not execute a CLI, shell script, install hook, code asset or MCP operation. Skill instructions may guide use of already admitted Tools. Procedures needing host filesystem writes, arbitrary code, heavy computation or CLI execution use explicit Task/Goal handoff and existing Worker resources. A Knowledge maintenance entry may follow Skill instructions using its already-admitted virtual notebook editor; loading a Skill grants no additional command or filesystem access. The internal model may request catalog changes only through separately admitted owner operations; it cannot self-install or change its current resources by writing a Skill.

## Native Kernel And UI Tools

The ordinary Assistant exposes the following Core identities in this order after its Memory Tools and `skill.read`. The right column is the existing operation owner, not an HTTP round trip or second implementation. Canonical aliases describe exact semantics while preserving current public IDs.

| Core Tool ID | Owning operation |
| --- | --- |
| `kernel.apps.search` | `kernel.apps.list` |
| `kernel.apps.create` | `kernel.apps.create` |
| `kernel.apps.read` | `kernel.apps.get` |
| `kernel.schema.update` | `kernel.schema.update` |
| `kernel.apps.delete` | `kernel.apps.retire`; retirement only, no database-file purge |
| `kernel.records.search` | `kernel.records.list` |
| `kernel.records.read` | `kernel.records.get` |
| `kernel.records.create` | `kernel.records.create` |
| `kernel.records.update` | `kernel.records.update` |
| `kernel.records.dispatch` | `kernel.records.batch`; the owner's closed transactional data commands only |
| `generative.ui.create` | `generative-ui.publish`; native declaration admission and owned publication |

Reuse strict owner request/response schemas, removing authority fields the internal closure supplies. Workspace, actor, Thread, Turn and command request identities come from trusted context; model Tool call IDs supply correlation only. Exact command request identities derive from the owning conversation request and accepted Tool occurrence, remain stable for that occurrence, and cannot be supplied or reused by model arguments. Commands retain their own receipts and authoritative results independently of the enclosing conversation result; the Assistant's handoff-specific single-receipt exception does not absorb Kernel or UI effects.

The Agent first discovers exact Light App schema and meaning, then uses expressive owner-bounded queries and mutations. No bespoke Tool is needed per app/table/business action and no direct SQLite handle or SQL/CLI executor is exposed. Ordinary Workspace membership is the current resource-access basis; existing Policy and sensitive-operation previews/confirmations still apply. This integration creates no blanket new confirmation for ordinary permitted CRUD and no exception to a required confirmation. Model prose cannot satisfy a human decision.

Headless data calls do not force UI. `generative.ui.create` delegates to the UI owner's native A2UI source/admission/publication contract; accepted content is rendered through its existing Item/resource path, never through loop streaming callbacks. The UI owner specifies how current generated text and completed MCP observations become sources. Tools return safe operation outcomes and exact admitted references to the model; renderer payload may stay in private `details` and is released only through current audience admission. An action invokes its existing Core owner, not a hidden continuation of this run. Saved views, HTML delegates and structured MCP-result data bindings remain their separately scoped UI extensions.

## Internal MCP Invocation

Reuse the existing MCP catalog, official SDK, schema snapshot reader, transport supervisor, credential resolution and normalized capability/usage/audit path from `20260704-worker_mcp_tool_supply.md`. Separate that substrate from its Worker-only capability routes, AEP selection/token, AgentSession and Harness approval interruption. Internal closures call the substrate in process and never forge a Worker session, use the Sandbox listener or recursively call the Worker endpoint.

The caller discriminator is Core-private `{kind:"internal",role:"assistant",userId,workspaceId,threadId,turnId}` versus the existing Worker lineage. Internally originated calls retain canonical capability ID, adapter digest, exact server/Tool, selected catalog revision/schema snapshot, Thread/Turn and request/effect evidence through the existing capability/audit fields, with the responsible user linked under the shared usage owner; Worker-only Agent/AgentSession/package fields are absent, never synthetic. Caller discrimination is transient enforcement input, not a duplicate durable ActorRef or new run record. Reuse the existing optional-lineage GatewayCallContext and recorder. It does not become a Worker protocol or loop message field.

Every product-visible MCP invocation creates a safe `tool-call` Item through the existing Item owner, correlated to its CapabilityCall with deterministic identity. Store only audience-admitted arguments/result text, bounded safe error and timing; omit secrets, raw provider payloads, private diagnostics and reasoning. These Items supplement the conversation's deterministic final result Item and do not change its receipt identity. The safe model-visible observation includes the completed Item reference and digest of its exact retained result text, so a later UI Tool can bind that source without guessing identity; source metadata is separate from the digested text, avoiding a self-referential digest. Infrastructure schema discovery remains outside conversation history. MCP `structuredContent` is output-schema validated when present, and may be safely serialized into result text; text and supported images enter the private loop only after normalization. Unsupported audio/resource links/embedded resources are explicit unsupported observations, never automatic network reads or silent flattening into authorized content. Renderer-only `details` is not a bypass for disclosure.

Current actor authority is checked before upstream contact; the existing `tool.use` mapping and exact server/Tool policy apply. An MCP-backed capability may perform only its accepted Core contract's effects through its reviewed adapter. Generic shell, filesystem, browser-harness, discover-all and call-any capabilities are unreachable regardless of catalog selection or administrator status. Credential material remains in the Gateway. A currently granted Workspace credential represents that shared remote identity; it does not imply per-user remote accounts or audit attribution. The call records the responsible OpenKit user separately, and private data egress must satisfy the existing source/destination and credential grants. Per-user credential binding, when already available, follows Vault; this design invents no new credential mode.

### Connection isolation and lifetime

Each internal bounded run owns a private in-memory MCP connection partition. Its keyspace is structurally separate from the Worker pool and every other internal run; selected servers may reuse a connection only inside that run. Reuse the existing stdio/HTTP supervisor and its bounded timeout/reaping facilities, not a second transport implementation. Start on required discovery/first call, stop accepting work at run exit, and close/reap under the existing bounded shutdown policy. Cleanup cannot delay a typed loop exit indefinitely. Late upstream completion belongs only to its effect record and cannot resume the loop or publish a new UI.

This isolates SDK/protocol session and local process state only. A server's shared database, mutable global files or remote account can retain information across processes; a private pool is not a sandbox or confidentiality guarantee for an untrusted executable. Existing deployment-authorized stdio activation and current resource/egress Policy remain mandatory. HTTP session IDs are private to the run, but the remote service retains its own authorized shared-account semantics. No stateless declaration or per-user Agent process is needed to claim the narrower session isolation actually provided.

### Approval and effect settlement

Before upstream contact, create the existing CapabilityCall attempt identity and persist its required admission/effect evidence. A failed evidence write prevents contact. Approval-required calls make no upstream contact: persist the exact Approval Gate, completed request Item and denied CapabilityCall, set the Turn to `awaiting_human`, and signal cancellation through the caller-bound controller. The model cannot catch this as an ordinary feedback loop and continue calling Tools. The caller recognizes that exact durable Gate after `aborted`; unrelated aborts remain interruptions.

The Gate becomes actionable only when the exact gate/request/denied-call tuple proves no contact and the internal run has returned with no active invocation and its invoking `conversation.submit` or `turn.input.submit` receipt has acknowledged the exact `approval-required` tuple. Gate/request causation identifies that exact input command; an earlier clarification receipt cannot supply this proof and is never rewritten. That existing receipt is the durable stop proof; no separate run-completion record is added. A crash before that proof leaves an inspect-only `recovery_required` gate; no Worker checkpoint, Harness interrupt, automatic repair or fabricated stopped session is introduced. On a valid grant the existing approval response command records the decision and completes the waiting source Turn; deny interrupts it. Neither decision starts a provider call. A separately requested new Assistant Turn reconstructs current admission and may claim one exact granted effect.

The approval tuple is `{workspaceId,threadId,userId,capabilityId,adapterDigest,serverId,toolName,argumentDigest,catalogRevision,schemaSnapshotId,expiresAt}`, with expiry one hour after creation under the existing MCP approval rule. Capability ID and adapter digest bind the Core meaning as well as the upstream effect; two Core capabilities mapping to the same server Tool cannot consume each other's approval. An adapter or Core boundary schema change requires a different digest and new approval even if the upstream tuple stays the same. Before contact a matching new call rechecks current authority and claims the granted, unexpired, unconsumed approval by deriving its CapabilityCall ID from that Approval ID. Persist the one-shot claim before contact; concurrent losers, changed arguments/schema/binding, second use, expiry or revoked authority cannot execute under it. The model supplies neither an approval ID nor a claim. Core records the new allow decision and exact evidence without reusing the old decision as current authority.

A timeout, cancellation, process crash or lost result after contact is not evidence of no effect. Use the capability owner's truthful terminal status and `unknown` when the external outcome cannot be established. Reconcile only through that owner's explicit inspection; do not auto-retry even if MCP annotations say idempotent. Later user-authorized attempts are new requests and cannot hide the earlier uncertainty. Kernel/UI/Memory commands retain their own local replay/partial-write rules; this MCP attempt discipline does not introduce a global transaction or pre-write reservation for every Core command.

## Failure, Restart And Implementation Boundary

Selection errors fail before model projection; per-call denial/stale/schema failure returns bounded correction evidence; approval exits through the actual Gate; provider/deadline failures map through existing Assistant failure semantics. A final Assistant answer is not proof that every Tool succeeded, and conversation replay never redispatches accepted Tool effects. Restart reconstructs from durable Items, command/capability evidence, current catalogs and current authority; it does not restore an internal session, Tool array or incomplete MCP call.

Initial implementation proceeds through the existing NanoCore `internal-agents` assembly, Gateway, Assistant mode service and exact resource command owners. Remove the direct `callQuickChatProvider` bypass when the shared loop lands; keep deterministic non-model routing where already owned. Existing selected-Worker MCP and native Kernel/UI code are foundations, not implementation of this internal caller. Do not add a package or generic adapter interface merely to wrap one caller. This specification remains Not Started until these contracts are implemented and verified.

## Acceptance Predicates

- Distinct internal roles use one product-agnostic loop; none imports Pi Agent Core runtime/session/harness. Text/image/call ordering, three fuses, four exits and safe projection pass the runtime owner's checks.
- Same entry configuration yields identical ordered Tools for a general question and a resource task; the general question reads only bounded configuration/schema/Skill metadata beyond its admitted Thread, with zero business/Skill-body/Memory/external-data reads.
- Every model Tool has a Core semantic ID/schema even when MCP-backed; upstream names remain dispatch/audit evidence. A configured shell, filesystem or generic browser/harness MCP cannot become reachable; an unknown capability or mismatched adapter schema fails before provider dispatch.
- Selected Skill metadata is visible before reading; exact admitted text is loaded on demand; traversal, symlinks, changed digest, oversize, removed version and instructions to install/execute code cannot widen access.
- A private Assistant discovers a Light App schema, performs an authorized record mutation and publishes a native UI with the actual owner receipt. Stale schema/revision and revoked membership cause no new write; headless use remains possible.
- A completed MCP observation from an owner-admitted adapter and current generated response can each render through the UI owner without creating a Kernel app; restart renders retained source/presentation content without generation or effect replay.
- Two users and two runs in one Workspace cannot reuse SDK sessions or stdio processes with each other or the Worker pool; shared remote-account identity remains accurately disclosed and attributed locally.
- Approval-required MCP contact count is zero before grant, the loop exits promptly, the exact Gate is actionable only with complete stop/no-contact evidence, grant starts no hidden run, and one later exact call consumes one approval. Duplicate, stale, expired, changed-input, different-capability and changed-adapter claims perform no upstream effect.
- Cancellation during a contacted MCP call returns within the loop bound, records the owner outcome or unknown, cleans up under bounded supervision and cannot silently resubmit or append late output. A failure between effect and conversation result retains the effect evidence and returns honest replay or recovery-required behavior.
- Private Memory remains private; save/update/delete map to their exact owner rules, inferred changes follow explicit notebook maintenance authority or required Review, human Review is absent from the model Tool set, and ordinary resources cannot expose administration Tools.

## Related Docs

- `docs/specs/20260813-internal_agent_runtime.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260907-mcp_catalog_management.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`
- `docs/specs/20260908-generative_kernel_data_operations.md`
- `docs/specs/20260908-generative_ui_interaction.md`
- `docs/specs/20260909-personal_memory_and_knowledge_learning.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260704-workspace_backup_export_import.md`

## Community Design Reference

Pi's [progressive Skill index](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/agent/src/harness/system-prompt.ts#L3) supplies the useful metadata-first pattern. [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) supplies exact server Tool names, JSON Schema and result blocks; it does not supply OpenKit authorization, private-session isolation, durable business settlement or Skill execution authority. Native A2UI and MCP Apps UI resource semantics remain with the Generative UI owner, without an additional AG-UI state store or loop event bus.
