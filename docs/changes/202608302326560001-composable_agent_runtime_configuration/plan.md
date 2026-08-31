---
type: change-plan
status: verified
started: 2026-08-30
branch: main
---
# Composable Agent Runtime Configuration

## Intent Epochs

### Intent Epoch 1 — 2026-08-30 — Engineer's consolidated configuration direction

- **Outcome:** Replace the current fragmented provider, agent, Workspace-default, internal-role, Gateway, and worker-runtime configuration behavior with one comprehensible Server, Workspace, User, Agent, Gateway, Sandbox, Harness, and AgentSession composition model.
- **Non-negotiables:** Server supplies shared resources and baseline defaults; Workspace configuration may reference, override, and extend Server-supplied configuration; User preference has the highest ordinary selection precedence; internal roles and worker agents have separate runtime models; concrete secrets remain outside authored manifests; multiple runtime families and AgentSessions may coexist in one Sandbox; and no compatibility preservation is required during this internal-development change.
- **Acceptance:** The owning Core and specification set defines each configuration scope, source, precedence, composition operation, lifecycle, reload behavior, model-routing boundary, secret-binding path, AgentSession/Harness/Sandbox relationship, and observable failure condition without relying on this change record for authority.
- **Exclusions:** This plan does not authorize production implementation, deployment, publication, provider-account mutation, Vault-secret mutation, a generic plugin or hook framework, speculative fleet scheduling, or complete load-balancing and failover behavior.
- **Effect boundary:** Repository change records and accepted design documents first; implementation and generated projections require a later accepted execution checkpoint after the design owners converge.

### Intent Epoch 2 — 2026-08-30 — Engineer's scope, concurrency, isolation, Gateway, and reload corrections

- **Outcome:** Treat Server as the provider of resources and baseline configuration rather than the product-level ceiling on Workspace or User composition; preserve broad User and Workspace freedom within the resources, runtime capabilities, ordinary authorization, and reasonable-use mechanisms available to them.
- **Configuration precedence:** Explicit request selection remains most specific when present; persistent ordinary preference resolves User first, then Workspace, then Server. A Server `defaultAgentId` is the final worker-Agent fallback for a new or existing Workspace whose User and Workspace configuration make no selection.
- **Concurrency clarification:** One AgentSession belongs to one Thread, one Turn belongs to one Thread, and one Thread has at most one active Turn. A Harness may supervise AgentSessions for multiple Threads, and those AgentSessions may communicate and work concurrently when the Harness and scheduler support concurrent active Turns; no design should describe concurrent work as parallel Turns inside one AgentSession.
- **Isolation clarification:** Sandbox is the selected containment and compromise boundary. Agents placed in the same Sandbox may receive different runtime configuration and secrets, but OpenKit adds no stronger mandatory intra-Sandbox secret or trust isolation mechanism. A User or scheduler that requires different trust or account isolation places the work in different Sandboxes.
- **Gateway clarification:** Worker-visible model IDs are logical IDs. The provider, provider-native model, account, and concrete Gateway route remain hidden from the worker and may change per inference call through Gateway routing, load balancing, account-pool selection, quota exhaustion handling, or explicit failover policy.
- **Reload clarification:** Reload applies new configuration without interrupting active work where practical. Existing work continues under natural Thread, Turn, runtime, container, and external-policy behavior. Skills may be materialized immediately and become visible when the native runtime naturally reloads them; externally enforced policy and existing-secret replacement take effect through their external owner; Gateway model routing changes require no worker or Sandbox restart; adding a new secret or another process-static model choice may mark the native process for replacement after its active Turn, then resume the same Thread and AgentSession on the next Turn.
- **Design proportionality:** Use the natural Workspace, Thread, Turn, Item, AgentSession, Harness, process, Sandbox, container, and Gateway lifecycles. Do not add a second workflow, configuration transaction protocol, intra-Sandbox security domain, or generic recovery framework solely to model configuration changes.
- **Core documentation requirement:** The stable Server, Workspace, and User roles, scopes, resource-provision relationship, shared-versus-personal posture, and User → Workspace → Server preference precedence must be recorded in the relevant Core owners rather than remaining only in this plan or implementation documentation.

### Intent Epoch 3 — 2026-08-30 — Complete delivery through a runnable system

- **Outcome:** Carry the accepted configuration and runtime direction through design consolidation, authority-bearing documentation, independent falsification and governance audit, a dedicated documentation commit, production implementation, runtime verification, independent implementation acceptance, and final repository closeout so the discussion becomes a working system rather than a documentation-only proposal.
- **Mandatory stage gate:** Implementation begins only after the complete affected Core and specification set has passed an independent FalseFire-style verifier review and an independent repository-governance audit, all material findings have been resolved or returned to the engineer, documentation checks pass, and the documentation change has been committed as its own durable baseline.
- **Implementation scope:** Replace the affected schemas, files, loaders, persistence records, protocol types, APIs, Web configuration surfaces, selectors, resolvers, Gateway routing, AEP projection, NanoCore scheduling, NanoHost and Integration behavior, worker runtime materialization, reload paths, fixtures, tests, generated projections, and manuals needed to make the accepted design executable end to end.
- **Implementation acceptance:** A real configuration can resolve User → Workspace → Server preferences, launch the selected Agent and profile, expose the allowed logical models, route inference through the Gateway without revealing concrete routes, bind Workspace credentials, preserve Thread-bound AgentSession continuity, host the supported Harness topology, and apply documented reload behavior with focused and end-to-end evidence.
- **Commit boundary:** The authority-bearing documentation commit precedes every production implementation edit. Implementation and its directly owned tests and projections form later coherent commits whose evidence is recorded in this plan.
- **Exclusions retained:** The delivery does not add speculative routing algorithms, a generic plugin framework, an intra-Sandbox security domain, a second configuration transaction protocol, or fleet scheduling beyond behavior required by the accepted runnable slice.

### Intent Epoch 4 — 2026-08-30 — Unified conversation Composer, target selection, and task handoff

- **Outcome:** Replace the current text-and-send-only Composer with the supplied chat-box interaction: one large auto-growing input area above one bottom action row whose left side contains Artifact or attachment input and conversation-Agent selection and whose right side contains logical-model selection and Send.
- **Input behavior:** The input initially accommodates approximately two and one-half lines, grows with entered text until a fixed maximum height, then scrolls internally without moving the bottom action row out of reach.
- **Attachment behavior:** The leading plus action lets the User reference an existing Artifact or upload an attachment through the existing Artifact, file-input, and Workspace resource owners rather than inventing a second attachment store.
- **Agent choices:** The Agent selector presents applicable NanoCore roles such as Assistant, a running Orchestrator, and the Workspace Knowledge Manager; pinned warm workers; currently running workers; and an action to start a new Shard and Worker.
- **Task transition:** Selecting the new-Shard-and-Worker action changes the submission to Task Mode and invokes the accepted Task Mode placement and worker-start path. The design must determine whether the requested Shard is a projection over an existing Thread or Task execution owner or needs a separately accepted concept; the UI label alone does not authorize a duplicate durable task entity.
- **Model choices:** The Model selector displays only logical model IDs allowed for the selected target under the accepted preference and Agent-profile rules. Provider profile IDs, provider-native model IDs, account IDs, Gateway route IDs, and routing-pool IDs remain invisible to the Composer.
- **Submission contract:** One submission carries the message, referenced Artifact or uploaded attachment identities, selected conversation target, selected logical model preference when present, mode transition when present, current Workspace, current or newly created Thread, and one request identity through the existing command and idempotency owners.
- **Implementation acceptance:** The same Composer works on starter and active-Thread surfaces, remains keyboard and screen-reader operable, preserves pending input and selections on failure, disables only invalid or unavailable actions with a reason, and reaches the selected internal role, existing worker, or new Task worker through NanoCore without exposing infrastructure routing identifiers.

### Intent Epoch 5 — 2026-08-30 — Evidence-driven reconciliation after independent consultation

- **Outcome:** Preserve the engineer's functional direction while correcting owner placement, reusing accepted mechanisms, closing implementation gaps that would make acceptance unreachable, and deleting speculative entities identified by the independent consultant.
- **Scope ownership:** Core Concepts owns the Server, Workspace, and User configuration-scope relationship; Identity continues to own User identity and membership; Architecture owns only layer and internal-role boundaries. Workspace override and extension are authored composition that produces one composed setup before the one-way resolver, so resolution remains non-authoring.
- **Internal roles:** Reuse the accepted Internal Role Execution Profile instead of introducing an Internal Role Catalog. One Server `internal-role-profiles.jsonc` supplies the profiles and fallback logical model, while Workspace and User configuration select or compose allowed role settings.
- **Logical-model pinning:** A logical model's effective capabilities and `modelFamilyId` are derived from the pinned models.dev catalog and Provider endpoint matrix rather than authored as free strings. One internal-role run or worker Turn is pinned to that logical contract, while the Gateway may choose a different eligible private route for each Provider call without crossing it.
- **Gateway fallback:** Supersede the former blanket provider/account-fallback non-goal. The current slice supports only ordered route members and bounded pre-output failover for explicitly classified unavailability, authentication, quota, rate-limit, or provider-start failure; it records every attempted route and usage. Weighted balancing, active health scoring, and generalized strategy plugins remain deferred.
- **Account rotation:** One route member references one Provider profile, and one subscription-backed Provider profile continues to bind at most one account slot. Rotation therefore moves among Provider-profile route members rather than adding multiple accounts to one profile.
- **Pi disposition:** Gateway-private relay support is a dispatch-readiness requirement for every worker runtime in the clean target. The current direct-provider-only Pi route is removed from dispatchable supply until the pinned Pi adapter or a later accepted replacement can consume the relay without worker-visible provider credentials.
- **Credential delivery:** Worker credential materialization is part of this plan because Workspace Secret binding cannot otherwise reach the runnable acceptance predicate. The implementation must carry resolved credentials through NanoHost and OpenShell materialization and prove the documented dynamic or process-static behavior in that effect domain.
- **Existing and missing seams:** Multi-Harness support extends the existing compatibility-key and adapter-registry owners. Runtime-config planning does not emit `staleWhenPackageChanges`; the unused AEP field with that name has no production reader. The current Codex adapter already launches one child per Turn and resumes the exact native handle from AgentSession-private state, so a later AEP naturally enters the next Turn without a resident-process replacement mechanism. Stage E removes the unused field and proves natural next-Turn activation rather than manufacturing a consumer.
- **Workspace rename:** No compatibility reader remains, but boot and every Workspace reader fail loudly when an old `workspace.json` exists instead of silently skipping the Workspace.
- **Composer scope:** Intent Epoch 4 remains in this complete delivery plan as the engineer requested. `New Shard + Worker` is a product label for creating a new Task execution Thread and worker; OpenKit adds no Shard record, identifier, API, or lifecycle.

### Intent Epoch 6 — 2026-08-31 — Independent documentation falsification corrections

- **Outcome:** Resolve both independent documentation reviews before the documentation commit while preserving the engineer's functional direction and removing claims that current source disproves.
- **Gateway contract:** `gateway.jsonc` authors logical IDs, display names, and ordered route members only. NanoCore derives effective capabilities and `modelFamilyId` from `@openkit/models-dev-catalog` plus the endpoint matrix, requires one family across a route list, and uses the capability intersection; no free-form capability or independence authority is added.
- **Wildcard timing:** Manifest `models: all` remains supported but expands once into the exact current Workspace-visible logical-model set when a composed setup and immutable AEP are created. A Gateway catalog addition does not mutate a running worker and enters only a later AEP.
- **Schema evolution:** Keep the implemented `session.concurrent-turns` feature identifier and correct only its meaning. Renaming a functioning registry entry has no present value and is removed from this change.
- **Workspace projection:** `workspace-record.json` loses editable fields, `workspace.jsonc` owns `name` and `defaultAgentId`, the public Workspace projection retains only a config-derived `name` and deletes its `defaults` object, and invalid config publishes no partial projection.
- **Composer ownership:** The unified Composer specification owns observable sizing, action order, keyboard behavior, stable target references, branch replay, starter-Thread half-state, and receiving-Workspace projection. Web specifications project that contract, and `DESIGN.md` is visual guidance rather than behavior authority.
- **Implementation truth:** Exact post-Turn Codex native-handle resume, multi-Harness placement, logical-model admission, credential materialization, the Workspace split, and the Composer cutover remain Stage E work. Documentation must describe current divergences explicitly until the implementation lands.

## Accepted Owners

- `docs/core/core-concepts.md` owns the stable Server and Workspace configuration scopes and their relationship to the User scope owned by Identity; `docs/core/identity.md` owns User identity, membership, and the personal-preference subject.
- `docs/core/foundation.md` owns useful human and Workspace agency, proportionality, one owner per responsibility, and the prohibition on speculative future machinery; it does not redefine the three scopes.
- `docs/core/architecture.md` owns App/Core/Agent layers, internal Core role boundaries, and the distinction between product selection and runtime placement; it does not own Harness, Sandbox, Server, Workspace, or User definitions.
- `docs/core/agent-supply.md` owns Agent catalogs, one Agent Manifest plus nested profile, authored composition into one setup, Workspace-visible supply, and the one-way boundary from authored setup to resolved setup.
- `docs/core/agent-session.md` owns one-Thread continuity, AgentSession replacement, and the boundary between a current AgentSession and its sequential Turns.
- `docs/core/runtime-model.md` and `docs/core/sandbox.md` own runtime placement, Harness/Sandbox topology, containment, co-residency, and process lifecycle.
- `docs/core/vault.md` owns secret references and grants; `docs/specs/20260703-vault_secret_injection.md` owns concrete binding, injection, replacement, and receipt behavior.
- `docs/core/agent-capability.md` owns governed Skills, MCP, and Gateway-mediated capability projection.
- `docs/core/work-model.md`, `docs/core/agent-workflow.md`, `docs/specs/20260704-chat_mode_assistant.md`, and `docs/specs/20260704-task_mode_worker_delegation.md` own Chat-versus-Task meaning, internal-role routing, worker delegation, and the transition produced by choosing a new worker.
- `docs/specs/20260831-unified_conversation_composer.md` owns observable Composer behavior, the target catalog, structured submission, dispatch branch, exact replay boundary, and failure recovery; `docs/specs/20260628-web_product_surface_projection.md` owns publication through Web, and `docs/specs/20260710-web_ui_rebuild_stack.md` owns component and client-state placement and Core Client integration. Root `DESIGN.md` is a non-authoritative visual projection.
- `docs/specs/20260713-work_resource_interaction_model.md` and the existing Artifact owners govern reference selection and upload rather than the Composer creating another resource authority.
- `docs/specs/20260813-internal_agent_runtime.md` owns the existing Internal Role Execution Profile and its logical-model, derived capability, model-family independence, fallback, fuse, prompt, Tool, and reload projection; role-specific Assistant, Goal Orchestrator, Workflow Coordinator, and Knowledge Manager specifications own role assembly.
- `docs/specs/20260628-nanocore_config_identity_contract.md` owns the concrete Server, Workspace, User, Gateway, and internal-role configuration files, scopes, load order, edit boundary, reload snapshot, and strict failure behavior.
- `docs/specs/20260703-agent_manifest_aep_resolution.md` owns the concrete Agent Manifest, profile, Workspace composition, resolved-setup, and immutable AEP resolution contract.
- `docs/specs/20260616-agent_environment_package.md` owns the AEP envelope and its per-Turn runtime, route, credential, policy, and control projections.
- `docs/specs/20260526-llm_gateway_responses_api.md` owns public and worker inference Gateway routing, logical model projection, ordered route selection, bounded fallback, usage, and failure semantics; `docs/specs/20260721-provider_subscription_accounts.md` owns one account slot per subscription-backed Provider profile.
- `docs/specs/20260802-nanohost_runtime_and_transport.md`, `docs/specs/20260703-runtime_scheduling_scale.md`, `docs/specs/20260703-durable_scheduler_design.md`, `docs/specs/20260703-worker_control_protocol.md`, and `docs/specs/20260704-session_static_workspace_materialization.md` own NanoHost, capacity, Sandbox Integration, Harness multiplicity, concurrent AgentSessions, AgentSession binding, process replacement, resume, and compatibility behavior.
- `docs/specs/20260703-agent_manifest_aep_resolution.md` owns authored credential requirements and Workspace bindings; `docs/specs/20260709-worker_credential_access_declarations.md` and `docs/specs/20260703-vault_secret_injection.md` own resolved declarations, materialization, replacement, and receipts.
- `docs/specs/20260716-pi_worker_adapter.md` owns Pi readiness and the removal of its direct-provider-only dispatchability under the Gateway-private target.
- `docs/specs/20260703-storage_layout_record_ownership.md` owns canonical file names and Server, User, and Workspace configuration storage locations.
- `docs/specs/20260704-workspace_backup_export_import.md` owns portable Workspace file inventory and the `workspace-record.json` export and import projection.
- `docs/specs/20260528-core_client_boundary.md` owns the protocol-to-App-API-to-Core-Client-to-Web projection affected by Workspace-default deletion and structured Composer submission.
- `docs/specs/20260703-schema_evolution_record_envelope.md` owns additive evolution and explicit extension behavior for authored JSONC surfaces.
- `docs/specs/20260629-openkit_policy_model.md`, `docs/specs/20260703-policy_enforcement_mapping.md`, and `docs/specs/20260709-worker_sandbox_freedom_policy.md` own OpenKit policy input, enforcement mapping, and the worker-freedom projection affected by composed policy and credential separation.
- `docs/specs/20260629-worker_runtime_communication_model.md` owns worker-visible logical-model admission and the inference relay boundary; `docs/specs/20260721-worker_execution_environment_images.md` owns image projection and image-generation vocabulary.
- `docs/specs/20260703-openshell_mechanism_internalization.md` owns the OpenShell mechanism projection, while `docs/specs/20260704-git_write_workflow.md` owns governed Git materialization and writeback vocabulary.
- `docs/specs/20260704-agent_session_continuity.md` owns exact same-Thread AgentSession continuity, native-handle reuse, and successor behavior.
- `docs/specs/20260704-workflow_coordinator_internal_agent.md` and `docs/specs/20260709-quick_chat_workspace.md` own the affected internal-role and Quick Chat selection projections.
- `docs/specs/20260715-multi_user_workspace_system.md` owns the multi-user Workspace storage, membership, and joined public Workspace projection boundary.

## Current Facts

- `server.jsonc.defaults` currently contains `coreProviderId`, `coreModel`, `gatewayProviderId`, and `gatewayModel`; Quick Chat directly consumes the Core pair, while the public Gateway directly consumes the Gateway provider and requires the request model to belong to that provider.
- Current `workspace.jsonc` contains Assistant repository-inspection settings and Workspace roots only. It has no Agent, internal-role, model, Skill, Gateway, policy, Secret, or manifest-binding composition surface.
- Canonical `workspace.json` stores the editable Workspace `name` plus `defaultAgentId`, `defaultModelId`, and `defaultSkillIds`. `defaultAgentId` participates in worker selection; `defaultModelId` and `defaultSkillIds` are persisted and projected to Web but do not affect ordinary worker launch.
- Current worker selection is request-internal agent override, then Workspace-record `defaultAgentId`, then lexically first loaded manifest. Ordinary public Turn input exposes `modelId` but no `agentId`, `profileId`, or logical Gateway model selection object.
- Current Agent Manifest has one runtime, one optional provider reference and model, one default profile ID, and a permissive profile payload whose behavior fields are not yet resolved into launch behavior.
- Current AEP contains one selected Agent, one runtime, one shim target runtime, and exactly one LLM route. Worker inference authenticates the AEP and replaces the request model with that one resolved route model.
- Current shared-Sandbox topology supports one declared Harness with multiple open AgentSession bindings for distinct Threads and `maxActiveTurns = 1`. The accepted runtime owner defers concurrent active AgentSessions and multiple Harness Instances to later phases.
- Current worker shim constructs one fixed Codex Harness, but a static AEP-selected adapter registry for Codex, OpenCode, and Pi already exists elsewhere in the shim and must be reused rather than recreated.
- Current Agent Manifest credential declarations name concrete VaultGrant IDs. Provider profile secret references resolve under Server scope, while Workspace grants are validated against Workspace, Agent, AgentSession, visibility, and injection path.
- Current worker execution resolves and receipts provider, runtime-environment, and runtime-file credentials, but the production NanoHost governance backend does not consume those arrays during materialization, so no worker credential currently reaches a Sandbox through that path.
- Current configuration schemas are strict and the configuration service supports validated file reads, writes, revision conflict detection, draft validation, and runtime reload planning. Agent and provider configuration is currently restart-required.
- Current Workspace portable export preserves `config/workspace.jsonc`, and canonical Workspace record storage and exports use the name `workspace.json` in multiple owned contracts.
- Current Web `Composer` owns only local text state, optional chips, disabled reason, and a text-only submit callback. It renders the Send button beside the textarea, has no auto-height ceiling, attachment action, target catalog, Agent selector, model selector, pending-selection preservation, or structured submission.
- Current Chat starter creates one Thread from only `workspaceId` and `firstMessage`; Task Mode has an existing explicit App API path, but the repository has no accepted or implemented `Shard` entity or public Shard contract.
- Current public `modelId` is not an independent model preference: it finds an Agent Manifest by provider-native model equality and then rejects an explicit Agent whose manifest model differs.
- Current `GET /v1/models` advertises models from all allowed Provider profiles and exposes each Provider profile ID through `owned_by`, while inference dispatch selects only one default Provider profile and may reject a model it advertised.

## Accepted Design Decisions

### Server, Workspace, And User Roles

- Server is the shared resource and baseline-configuration provider. It owns deployment capabilities, Provider profiles, Gateway services, Server Agent supply, internal-role supply, Sandbox and runtime supply, shared catalogs, and final fallback defaults.
- Workspace is the durable shared team configuration and composition scope. It may directly consume Server resources, reference Server Agent Manifests, override ordinary defaults, extend manifests with Workspace configuration and Workspace-owned resources, bind Workspace Secrets, add logical model choices, and configure the shared behavior experienced by all Workspace members.
- User is the lightest and most specific persistent preference scope. A User may choose among resources and configurations available in the current Workspace and Server, and User preference wins over Workspace and Server defaults without rewriting either shared scope.
- Server is not the generic maximum-capability envelope for Workspace configuration. Product configuration should expose the available resource set and reject only unsupported resources, unavailable runtime mechanisms, ordinary authorization failures, incompatible composition, or unreasonable resource use under an owning mechanism.
- Security Kernel and ordinary authorization decisions remain enforced by their owners, but they are not used to turn Server defaults into a general-purpose product configuration ceiling.

### Selection Precedence

- Explicit request or current orchestration selection is the most specific input for that work when the public contract permits it.
- Persistent preference order is User → Workspace → Server.
- Worker Agent fallback is request/Orchestrator `agentId`, User preference for the Workspace, `workspace.jsonc.defaultAgentId`, then `server.jsonc.defaults.defaultAgentId`.
- The lexical first-manifest fallback is removed. A missing or unavailable Server fallback is a typed configuration/readiness error, not an implicit file-order decision.
- Internal-role selection resolves request-specific role choice, User preference where the role permits it, Workspace role binding, then the Server Internal Role Execution Profile default.
- Gateway routing resolves the logical model requested by the caller or runtime, then the Agent or role preference, then applicable User, Workspace, and Server preference. Ordered route members may change the concrete Provider profile, provider-native model, or account only while preserving the logical model's catalog-derived effective capabilities and `modelFamilyId`.

### Internal Core Roles

- Internal Core roles do not use worker Agent Manifests, AEPs, NanoHost Sandboxes, Harnesses, or Core AgentSessions.
- The existing Internal Role Execution Profile is the sole role-runtime configuration concept. `internal-role-profiles.jsonc` supplies Server profiles and a default logical model preference for roles that do not name one; it does not create an Agent catalog or worker supply.
- `server.jsonc.defaults.coreProviderId` and `coreModel` are deleted immediately in the design and implementation change; all callers, fixtures, diagnostics, schemas, and documentation move in the same coherent slice without compatibility behavior.
- Workspace configuration may select or extend internal-role configuration with Workspace context, role preferences, model preferences, and Workspace resources. Role code and owning specifications continue to own the role's semantic purpose, input/output contract, and Core side effects.
- A role run is pinned to one logical model ID, derived effective capability set, and `modelFamilyId`. Each model call inside that run may use a different private route member that satisfies the same logical contract, so concrete Provider or account replacement is not a role-level model substitution.
- Deterministic roles such as the current Workflow Coordinator remain deterministic unless their owning specification explicitly introduces model-backed behavior.

### Workspace Record And Configuration

- Canonical `DATA_ROOT/workspaces/<workspaceId>/workspace.json` becomes `workspace-record.json`; no compatibility alias or dual read is retained.
- A Workspace directory that contains the removed `workspace.json` name is rejected explicitly during boot, rebuild, direct access, export, and import; it is never skipped as an incomplete directory and never read through a compatibility path.
- The system Workspace record loses editable `name` and every execution default. The public protocol projection deletes `WorkspaceDefaultsSchema` and its `defaults` member but retains a required `name` joined from the accepted Workspace configuration snapshot; it never treats that projection as record authority.
- Shared editable Workspace `name` moves to `config/workspace.jsonc`; `workspace-record.json` retains only system-owned identity, ownership, lifecycle, revision, and timestamp facts.
- Shared `defaultAgentId` moves to `config/workspace.jsonc`. The Server fallback is added as `server.jsonc.defaults.defaultAgentId`.
- Workspace-specific model and Skill choices live in internal-role or Agent bindings rather than one ambiguous Workspace-global default model or default Skill list.
- Ordinary Web controls that update Workspace configuration must use the existing revision-aware configuration service or an equally explicit field-preserving JSONC update path so manual edits and comments are not silently overwritten.
- `DATA_ROOT/users/<userId>/config/user.jsonc` owns personal per-Workspace Agent, profile, logical-model, and applicable internal-role preferences when they differ from Workspace-shared defaults.
- `defaultAgentId` selects default Agent supply only. Warm Sandbox creation, retention, draining, and capacity remain runtime behavior and may use the selection as a hint without making it lifecycle authority.

### Agent Manifest, Profiles, And Logical Models

- One Agent Manifest continues to represent one schedulable Agent supply unit. One selected nested profile represents one behavior variant within that unit.
- A manifest does not become a multi-Agent Sandbox topology document. Multiple independent Agent Manifests may be placed in the same compatible Sandbox through the existing compatibility key without a shared authored environment file in the current slice.
- A behavior profile may override or extend the manifest's model preference, Skills, MCP supply, instructions, context, resources, and runtime-compatible behavior settings once concrete profile resolution is implemented.
- Worker-visible model IDs are logical IDs such as `fast`, `reasoning`, or a stable product model name. An Agent Manifest declares a preferred logical model ID and the logical model IDs the worker may select.
- A manifest may use `all` to expose every logical model currently available through the applicable Gateway projection. Resolution expands `all` once into the exact current inventory recorded in the composed setup and immutable AEP; later Gateway catalog additions require a later composition and never mutate a running worker.
- Every resolved logical model carries effective capabilities and `modelFamilyId` derived from the pinned models.dev catalog and Provider endpoint matrix, and an Agent or internal role may require either or both when selecting it. They are not free-form authored Gateway fields.
- The concrete route, Provider profile, provider-native model, subscription account, API account, ordered member, and fallback member remain Gateway-private.
- Model preference does not promise a fixed Provider or account. The Gateway may select a different concrete route on every inference call only from members that preserve the logical model's derived effective capabilities and `modelFamilyId`.
- A worker runtime that cannot consume the Gateway relay without concrete Provider credentials is not dispatch-ready under this target. The direct-provider Pi route is removed from dispatchable supply rather than preserved as an exception.

### Sandbox, Harness, AgentSession, Thread, And Turn

- Sandbox is the natural containment, shared configuration, Secret injection, and compromise boundary selected for co-resident Agents.
- One Thread has at most one current AgentSession and one active Turn. One AgentSession belongs to one Thread, and one Turn belongs to one Thread.
- A Harness may retain or supervise AgentSessions for multiple Threads. When `maxActiveTurns` is greater than one and the Harness supports it, different AgentSessions may execute their respective active Turns concurrently.
- A Harness may start a distinct native Agent process for each AgentSession and may replace that process between Turns while preserving the same AgentSession and native conversation through resume.
- Multiple runtime families such as Codex and OpenCode in one Sandbox are multiple Harness Instances, not multiple RuntimeTargets and not multiple Agents embedded in one manifest.
- Web and Orchestrator select `agentId`, `profileId`, logical `modelId`, and the target Thread or child Thread. They do not select a Sandbox, Harness Instance, native process, or AgentSession ID directly.
- NanoCore resolves or replaces the current AgentSession and places it on a compatible Harness and Sandbox through the existing natural lifecycle and scheduling owners.
- Runtime-native subagents remain inside their outer AgentSession unless a separate Core Thread and AgentSession are deliberately created for independently governed work.

### Secrets

- A Server Agent Manifest that directly references one concrete Secret or grant may reference only Server-scope material.
- A reusable manifest may instead declare a stable credential requirement. `workspace.jsonc` binds that requirement to one Workspace-scope Secret or VaultGrant, allowing different Workspaces to use the same manifest with different accounts and permissions.
- Missing required binding fails before worker start. Existing validation and injection receipts preserve the effective Workspace, Agent, AgentSession, visibility, target, and use lineage.
- Agents in one Sandbox may receive different Secrets and process configuration. OpenKit does not create a stronger mandatory intra-Sandbox Secret-isolation mechanism; separate Sandboxes are the configuration strategy when stronger isolation is required.
- Replacing the value of an existing OpenShell-managed Secret uses OpenShell's dynamic replacement behavior. Adding a new process-static Secret schedules native process replacement after the current Turn and resumes the same AgentSession and Thread on the next Turn only when the adapter proves the exact native handle; otherwise ordinary successor AgentSession replacement preserves the Thread.

### Workspace Manifest Composition

- `workspace.jsonc` may reference one Server Agent Manifest by ID and provide an authored Agent binding that overrides scalar preferences and extends list- or map-shaped configuration using the natural meaning of the field.
- Server Manifest, Workspace binding, selected profile, and User preference are composed before launch into one composed authored setup. The existing resolver then validates and projects that one setup into one ResolvedAgentSetup and immutable AEP; catalogs, grants, runtime adaptation, and materialization remain non-authoring.
- Scalar defaults use nearest-scope replacement under request/User/Workspace/Server precedence.
- Lists of logical models, Skills, MCP supply, Workspace inputs, network entries, and other additive resources use stable IDs so Workspace additions and removals are deterministic.
- Map entries use stable keys and nearest-scope replacement for the same key. Deletion or disablement uses an explicit field rather than null-shape inference where absence and disablement differ.
- Resource quantities use the applicable resource owner's normal validation and capacity behavior rather than a generic config-merge rule.
- Runtime image, adapter, Integration protocol, and binary configuration may be overridden or extended only when the resulting Sandbox and Harness can actually materialize the combination; incompatibility selects another Sandbox/Harness or returns readiness failure.
- Configuration composition must remain explainable through source provenance, but it does not require a new durable merge transaction, generic authority lattice, or parallel configuration owner.
- Workspace Agent binding and extension is ordinary authored composition under Workspace authority and normal validation; it is distinct from defining an unrelated full Workspace-local Agent Manifest, so it does not require a separate proposal lifecycle.

### Gateway

- Gateway configuration moves from the small `server.jsonc.gateway` projection into a dedicated Server-scope `gateway.jsonc` file. Server config references or enables the Gateway but does not duplicate its route catalog.
- Every dispatchable Server Provider and model may enter the Gateway resource inventory. User, Workspace, internal-role, and worker model catalogs project the logical models relevant to their context rather than Provider-native inventory.
- A logical model authors a stable ID, user-facing name, and an ordered non-empty route-member list. Each member resolves one Provider profile and one provider-native model; NanoCore derives the effective capability intersection and requires one catalog-derived `modelFamilyId` across all members, while a subscription-backed Provider profile continues to bind exactly one account slot.
- Current routing begins with the first eligible member and may advance in order only when the attempt produced no output and terminated with an explicitly classified unavailable, authentication, quota-exhausted, rate-limited, or provider-start failure. It never retries after response bytes or stream events have been delivered.
- Every attempted member records logical model, private concrete route, selection reason, usage when known, failure class, and terminal result. Exhaustion returns one stable logical-model failure and does not imply that another route must succeed.
- Weighted balancing, randomized balancing, active health scoring, generalized strategy selection, and plugin algorithms remain deferred. Existing `schemaVersion`, `requiredFeatures`, and namespaced `extensions` are sufficient future-evolution seams; this change adds no new extension framework or inert future fields.
- The former blanket Gateway non-goal forbidding Provider or account fallback is superseded by this bounded ordered pre-output behavior. Any wider fallback requires a later accepted amendment.
- Every inference call records the logical model, concrete selected route, Provider/model/account identity where safe, selection reason, retry/failover lineage, usage, and terminal result through existing audit and usage owners.

### Reload And Natural Activation

- A successful Server reload makes the new configuration snapshot available immediately for new resolution work.
- Active Turns are not proactively interrupted merely because ordinary configuration changed.
- Each admitted worker Turn remains pinned to its immutable AEP snapshot and compatibility key. A reload affects that worker only when NanoCore mints a later AEP. The current Codex adapter launches one child per Turn, reads the later AEP on the next Turn, and resumes the exact native handle from AgentSession-private state; Stage E removes the unused AEP `staleWhenPackageChanges` field and proves this natural activation path.
- Additive Skills may be materialized into an existing Sandbox and runtime configuration location immediately; the native runtime observes them according to its own reload behavior.
- External policy changes and externally owned Secret-value replacement take effect through those mechanisms without rebuilding OpenKit workflow state. A later operation denied by the new policy fails through its ordinary owner.
- Private route-member changes for an existing logical model take effect in the Gateway without restarting the worker process or Sandbox because the concrete route is worker-invisible.
- Adding or removing a logical model does not mutate a running worker's immutable AEP, including one created from `models: all`. The changed set enters a later composed setup and AEP and therefore the next per-Turn Codex child. An implemented adapter that retains a native process between Turns must prove in-place application or refuse reuse under its own accepted runtime contract.
- Adding a new process-static Secret never rewrites the active process. The later declaration enters the next AEP and therefore the next per-Turn Codex child. Existing-secret replacement may take effect immediately only when the realized OpenShell provider path proves dynamic replacement; a future resident-process adapter must define and prove any post-Turn replacement it requires before dispatch.
- Removing or changing process-static runtime, image, binary, mount, or Harness configuration follows ordinary compatibility, AgentSession expiry/replacement, Sandbox drain, and creation behavior. No additional universal reload state machine is introduced.
- Security-sensitive revocation, destructive policy change, or runtime failure retains the behavior of its existing owner; this plan does not weaken an already accepted immediate enforcement requirement.

### Configuration Evolution

- Internal development permits direct breaking replacement of current fields, files, schemas, fixtures, generated contracts, and implementation consumers in one coherent change.
- Future additive configuration should be easy without making unknown behavior silently active. Stable IDs, explicit `schemaVersion`, additive optional fields, and namespaced `extensions` are the preferred seams.
- A future field absent from an older config receives the current documented default. An unknown authority-bearing top-level field remains invalid until its owning schema supports it.
- Gateway pools, account strategies, runtime adapters, Skills, model mappings, and Agent bindings use catalog-style identities so adding a supported entry does not require redesigning the surrounding file.

### Conversation Composer And Dispatch Selection

- The supplied hand-drawn chat-box image is the visual reference for information hierarchy: the input owns the full upper region, and one fixed bottom row contains `+`, Agent, Model, and Send in that order with the Model control aligned near the right edge.
- The Composer uses the platform textarea and measured scroll height for auto-growth, starts at an approximately two-and-one-half-line minimum, stops at one documented maximum, and enables internal vertical scrolling beyond that maximum.
- The bottom row remains visually and semantically separate from message text. The plus and Agent controls form the left group; the logical Model control and circular Send action form the right group.
- The plus action opens one chooser that can select an existing Workspace-visible Artifact or invoke the native file input for a new upload. A submission references durable accepted resource identities; an unfinished or failed upload remains visible and cannot be silently omitted from Send.
- NanoCore exposes one context-scoped conversation-target catalog rather than requiring Web to join internal-role, Orchestrator, worker-runtime, and warm-placement tables. Each entry has a stable opaque target reference, user-facing label, category, availability, optional current Thread relationship, supported modes, and logical-model choices; it exposes no Sandbox, Harness, native process, Provider account, or Gateway route identity.
- Internal-role entries address the built-in Assistant, a currently running Orchestrator when one exists for the relevant work, the Workspace Knowledge Manager, and later catalogued roles through the same role owner.
- Worker entries distinguish a pinned warm worker supply from a currently running Thread-bound worker presentation while retaining the existing Thread and AgentSession lifecycle as authority. Selecting an existing running worker routes to its owning Thread or creates only the continuation permitted by the accepted AgentSession contract; the UI does not rebind one AgentSession across Threads.
- The `New Shard + Worker` entry is an action rather than a reusable runtime identity. `Shard` is the product label for the new Task execution Thread and its bounded worker placement; NanoCore creates no Shard record, identifier, API, storage path, or lifecycle.
- The target catalog returns the effective logical-model set for each target after manifest or role capability, User preference, Workspace composition, Server resource, and current Gateway availability are resolved. Changing Agent selection updates the Model choices and preserves the current model only when it remains valid.
- A selected logical model is one per-submission preference. NanoCore validates it against the current target catalog and passes the logical ID to the internal role or worker Gateway call; Gateway independently resolves the private concrete route on every inference call.
- When the User makes no explicit Agent or Model selection, the existing User → Workspace → Server defaults and role or Agent preferences resolve the effective target and model. The Composer displays the resolved choice so an implicit fallback is not hidden from the User.
- Submission replaces the misleading public `chat.start` name with one strict `conversation.submit` command carrying the message, opaque `targetRef`, optional logical `modelId`, and exact Artifact-version references. The selected target may already encode an Agent profile. NanoCore branches synchronously into existing internal-role, existing-worker, or new-Task owners; request identity, Workspace, Thread, Turn, Item, Artifact, and Task Mode owners remain unchanged, and direct `task.start`, Goal, and Knowledge commands remain for non-Composer callers.
- The context-scoped catalog and `conversation.submit` are the only new public mechanism. The old `/chat` route, Chat request and response schemas, Core Client method, and Skill operation are removed in the same internal-development cutover, with no compatibility alias or second dispatcher.
- Send is enabled only when non-whitespace input or an accepted attachment shape is present, required upload work is complete, the selected target remains available, the logical model remains allowed, and no identical request is pending. Transport or command failure retains the exact draft, resources, target, model, and request identity for truthful retry.
- Keyboard operation includes ordinary textarea editing, `Shift+Enter` newline, the accepted send shortcut, reachable chooser buttons, visible focus, accessible names and expanded states, focus return after chooser dismissal, and no pointer-only target or attachment path.

## Target Configuration Surface

```text
DATA_ROOT/config/
  server.jsonc
  gateway.jsonc
  providers/*.provider.jsonc
  internal-role-profiles.jsonc
  agents/*.agent.jsonc

DATA_ROOT/users/<userId>/
  config/user.jsonc

DATA_ROOT/workspaces/<workspaceId>/
  workspace-record.json
  config/workspace.jsonc
  config/data-sources.jsonc
```

No shared environment configuration file is added in the current slice. Existing compatibility-key resolution already derives co-residency, and a future reusable environment catalog would require a present need and one accepted non-authoring reference contract.

## Configuration Resolution Sketch

```text
Server resources and defaults
  Provider Catalog
  Gateway logical models and ordered route members
  Internal Role Execution Profiles
  Agent Manifests and profiles
  defaultAgentId
        ↓
Workspace shared composition
  name
  internal-role bindings
  Agent bindings and manifest extensions
  logical model and Skill additions
  Secret requirement bindings
  Workspace roots, data, policy, and runtime preferences
  defaultAgentId
        ↓
User preferences
  per-Workspace Agent/profile/model choices
        ↓
Request or Orchestrator selection
        ↓
Resolved internal-role execution profile or ResolvedAgentSetup
        ↓
per-Turn immutable AEP for worker execution
        ↓
NanoCore scheduling and AgentSession continuity
        ↓
Harness and Sandbox materialization
```

## Authority Conflicts To Reconcile

- `docs/core/agent-supply.md` and `docs/specs/20260703-agent_manifest_aep_resolution.md` currently say lower-priority resolution layers select or restrict and cannot supply launch authority. That invariant remains: the documents must distinguish pre-resolution authored Workspace composition and Secret requirement binding from the later one-way resolver.
- `docs/specs/20260802-nanohost_runtime_and_transport.md` currently authorizes one Harness and `maxActiveTurns = 1`, with concurrent Sessions and multiple Harnesses deferred. The accepted target must activate the requested topology in ordered implementable stages without describing multiple Turns inside one AgentSession.
- `docs/specs/20260616-agent_environment_package.md` and the current schema require one Agent, one runtime, one target runtime, and one LLM route. The design must decide which static Sandbox/Harness configuration remains outside the per-Turn AEP and how an AEP authorizes one AgentSession while the Gateway presents multiple logical models.
- `docs/specs/20260526-llm_gateway_responses_api.md` and current code use a request model plus one default Provider and explicitly reject Provider or account fallback. They must adopt logical model identity, declared contract classes, ordered route members, bounded pre-output fallback, account selection, and per-call private routing while preserving OpenAI-compatible input and output.
- `docs/specs/20260813-internal_agent_runtime.md` pins a concrete provider and model and forbids mid-dispatch substitution. It must instead pin the logical model contract and allow concrete per-call rerouting only inside that contract.
- `docs/specs/20260531-worker_turn_reliability_envelope.md` pins Quick Chat to removed Core defaults and must resolve through the Internal Role Execution Profile.
- `docs/specs/20260703-storage_layout_record_ownership.md` names `workspace.json` and no `gateway.jsonc`, internal-role profile file, or implemented User config loader. The target tree and fail-closed old-name detection must be updated coherently with backup, export, and import.
- `docs/specs/20260703-runtime_scheduling_scale.md`, `docs/specs/20260703-durable_scheduler_design.md`, and `docs/specs/20260802-nanohost_runtime_and_transport.md` must jointly activate Harness multiplicity and concurrent active Turns across distinct AgentSessions without weakening one active Turn per AgentSession or Thread.
- `docs/specs/20260709-worker_credential_access_declarations.md` and the NanoHost materialization owners must close the current credential-drop gap before Secret acceptance can be claimed.
- `docs/specs/20260716-pi_worker_adapter.md` currently requires a direct provider and worker-visible credentials; it must remove that route from dispatchable target supply until Gateway relay readiness is real.
- `docs/core/sandbox.md` already states the accepted compromise-boundary behavior; this change updates only stale credential vocabulary and multi-Harness co-residency wording without changing that boundary.
- Existing strict `schemaVersion`, `requiredFeatures`, and `extensions` seams remain sufficient; generic passthrough fields and speculative routing strategy fields must not activate unimplemented behavior.

## Delivery Stages And Task Inventory

### Stage A — Consolidate And Falsify The Design

- Preserve all engineer decisions in the Intent Epochs and reconcile the proposed model against current accepted owners, source, schemas, generated projections, tests, and runtime behavior.
- Commission one independent Claude Code consultant through Herdr to test necessity, sufficiency, cardinality, ownership, failure semantics, reload behavior, and the smallest coherent design.
- Record every material consultant finding and its disposition before authority-bearing documents are edited; preferences without repository evidence do not change engineer intent.
- The consultant returned `Continue` for Intent Epochs 1–3 with five design defects and recommended splitting Epoch 4. The plan accepts the evidence-backed owner, composition, routing-class, credential, rename, concurrency, and minimality findings but retains Epoch 4 here because the engineer explicitly required one complete delivery plan.

### Stage B — Revise The Authority-Bearing Documentation

- Record the stable Server-resource-provider, Workspace-shared-composition, User-specific-preference principle and User → Workspace → Server persistent-preference order in the owning Core documents.
- Update Core Concepts, Identity, Agent Supply, AgentSession, Runtime Model, Sandbox, Vault, and capability owners only where their stable definitions, authority boundaries, topology, lifecycle, or shared vocabulary change.
- Update the concrete configuration, storage, schema-evolution, internal-role, Gateway, AEP, NanoHost, worker-control, materialization, Vault-injection, and worker-turn specifications named under Accepted Owners.
- Define exact configuration file names, schemas, identifiers, precedence, replace/extend semantics, missing and incompatible behavior, reload timing, process replacement and resume, observability, and acceptance predicates without relying on this plan for authority.
- Remove or supersede stale accepted language that treats Server configuration as a generic Workspace ceiling, assumes a lexical Agent fallback, pins one concrete worker model route, or makes `workspace.json` own execution defaults.
- Update `docs/INDEX.md` and any generated or manual projection required by documentation governance after the accepted owners converge.
- Define the Composer target catalog, structured submission, attachment or Artifact reference path, internal-role and worker target categories, new-Task action, logical-model filtering, failure retention, and accessible interaction in the Web, Chat Mode, Task Mode, work-resource, and Gateway owners.
- Reconcile the requested `Shard` wording with existing Thread, Turn, command, Task Mode, scheduler, and worker-placement authority; introduce no new durable entity unless those owners cannot express the required observable lifecycle.

### Stage C — Independently Accept The Documentation

- Start a fresh independent Claude Code Agent through Herdr as a FalseFire-style verifier. It derives expectations from accepted owners, inspects the actual documentation diff, and attempts to falsify completeness, necessity, owner alignment, cardinality, failure behavior, reload behavior, and implementability without editing the audited files.
- Start a separate fresh independent Claude Code Agent through Herdr as the repository-governance auditor. It traces engineer intent through Core, specifications, projections, current implementation facts, and the change record, then reports missing, stale, conflicting, or wrongly owned decisions without editing the audited files.
- Reconcile verifier and auditor findings locally, repeat the relevant independent check when a material revision invalidates its reviewed basis, and return only genuine intent or authority conflicts to the engineer.
- Run the documentation model, specification lifecycle, generated-index, link, formatting, and diff checks applicable to the final owner set.

### Stage D — Commit The Documentation Baseline

- Read the repository contribution and commit guidance, inspect the complete staged documentation diff, confirm the completion gate, and create one documentation commit containing the plan and accepted owner changes only.
- Record the documentation commit identity, exact checks, independent outcomes, resolved findings, and remaining implementation frontier in the Working Checkpoint before production implementation starts.

### Stage E — Implement The Committed Contracts

- Replace Server, Workspace, User, Gateway, Provider, Internal Role Execution Profile, Agent Manifest, profile, and Workspace-record schemas and canonical storage paths without compatibility aliases or a shared environment file.
- Replace `workspace.json` with `workspace-record.json`, remove editable `name` and execution defaults from the Workspace record, move shared `name` and `defaultAgentId` to `workspace.jsonc`, add the Server fallback, add the User preference owner, and update persistence, export, import, protocol, API, Core Client, Web, fixtures, and tests.
- Implement explicit request or Orchestrator → User → Workspace → Server Agent and profile resolution, remove lexical manifest fallback, and return typed configuration or readiness failures.
- Implement Internal Role Execution Profile resolution and migrate Quick Chat and every internal role caller away from `coreProviderId/coreModel` to the accepted logical-model preference and Gateway contract.
- Implement Agent Manifest profile composition, preferred and allowed logical model IDs including documented `all` expansion, stable-ID resource extension, Workspace credential requirement binding, and provenance-rich ResolvedAgentSetup generation.
- Replace the one-route AEP contract with the smallest per-Turn projection that authorizes the selected logical-model set while keeping concrete Gateway routes private, and update the worker inference path so each call preserves the logical model request for Gateway resolution.
- Introduce the dedicated `gateway.jsonc` loader and editor contract, logical-model catalog, models.dev-derived capability intersection and `modelFamilyId`, ordered route members, default preference resolution, bounded pre-output fallback, typed failures, usage lineage, and reload behavior while deferring weights, active health scoring, randomized balancing, and generic strategy plugins.
- Remove model-to-Agent inversion so explicit Agent or profile selection and logical-model preference resolve independently, and make model discovery and dispatch use the same logical catalog without exposing Provider profile IDs.
- Complete credential requirement binding and the currently missing NanoHost and OpenShell credential materialization path, including truthful dynamic existing-secret replacement and process-static addition behavior.
- Remove the direct-provider-only Pi route from dispatchable supply until the selected Pi adapter proves Gateway relay compatibility without concrete Provider credentials.
- Generalize the fixed worker Harness path only as far as required to support multiple compatible Harness Instances per Sandbox and multiple Thread-bound AgentSessions per Harness, preserving one active Turn per Thread and the accepted concurrency limit or configured capability.
- Update NanoCore, NanoHost, worker shim, Sandbox Integration, control protocol, scheduling, runtime materialization, and Web or Orchestrator selection so product callers choose Agent, profile, logical model, and Thread while infrastructure placement remains internal.
- Implement natural activation behavior for Skills, policy, existing-secret replacement, Gateway route changes, and static runtime configuration; remove the unused AEP `staleWhenPackageChanges` field, preserve the implemented Codex native-handle resume path, and prove that a later composed setup and AEP enter the next per-Turn launch without interrupting the active Turn.
- Update configuration revision handling, diagnostics, generated schemas and clients, user and operator manuals, examples, local guides, and every directly affected test or fixture in the same owning slice.
- Replace the shared Web Composer with the supplied two-region layout, auto-growing bounded textarea, Artifact or upload chooser, Agent target selector, logical Model selector, and Send behavior on starter and active-Thread surfaces.
- Add the smallest Core Client and NanoCore target-catalog and structured-submit surfaces needed to enumerate internal roles, running Orchestrator, Workspace Knowledge Manager, pinned reusable workers with warm availability, running workers, and the new Task worker action without exposing placement or Gateway-private IDs. Derive stable target references from existing product owner tuples, include the receiving Workspace and Thread in responses, and implement exact branch replay without a dispatcher lifecycle.
- Wire target selection to current Thread and AgentSession continuity, wire the `New Shard + Worker` label to a new Task execution Thread without a Shard entity, wire model selection to logical Gateway model validation, and preserve the complete Composer draft across upload, transport, validation, and command failures.

### Stage F — Verify, Audit, Commit, And Close

- Run lowest-sufficient schema, resolver, storage, API, Gateway, AEP, worker-shim, NanoCore, NanoHost, Integration, Web, reload, and migration tests plus the narrowest real OpenShell-backed and end-to-end runtime checks that prove the accepted observable behavior.
- Inspect the implementation diff for duplicate ownership, unused compatibility paths, speculative extension machinery, stale fields and file names, incomplete consumers, and missing documentation or local-guide updates.
- Commission independent implementation verification and repository-governance review at the durable implementation boundary; reconcile findings and repeat affected checks after material corrections.
- Commit coherent implementation slices only after their focused evidence and independent acceptance are recorded, then run the final proportional repository gates.
- Update the Working Checkpoint with commit identities, exact observed outputs, runtime evidence, remaining exclusions, and the terminal close decision; mark this plan complete only when the accepted runnable system and required documentation are both present.

## Consultant And Verifier Commission

An independent Claude Code Agent will inspect this plan, current accepted owners, and current implementation without editing repository files. Its review must challenge rather than merely restate the plan and answer:

1. Does the Server-resource-provider, Workspace-shared-composition, User-specific-preference model have a coherent boundary with identity, authorization, storage, and reload owners without turning Server defaults into a product-level ceiling?
2. Is any proposed configuration entity unnecessary because current Provider, Agent Manifest, profile, Workspace config, AEP, Sandbox, Harness, AgentSession, or Gateway mechanisms already express the need?
3. Does one-manifest-per-Agent plus shared environment references support the desired same-Sandbox multi-Agent topology more cleanly than a multi-Agent manifest bundle?
4. Are Thread, Turn, AgentSession, Harness, process, Sandbox, and RuntimeTarget cardinalities stated correctly for concurrent work and resume?
5. Can logical model IDs, hidden per-call routes, load balancing, account rotation, and failover evolve from the proposed Gateway identities without prematurely implementing a routing framework?
6. Are the Secret rules minimal and implementable with OpenShell dynamic replacement plus natural next-Turn activation for new process-static values on the current per-Turn runtime?
7. Does the natural reload policy have an unhandled contradiction for removal, failure, active Turn behavior, config snapshot identity, or process resume?
8. Which accepted Core and specifications must change, and which proposed edits would duplicate or invert an existing owner?
9. Is the target too simple to meet the user's functional goals, or does any part introduce mechanisms without a demonstrated present need?
10. What is the smallest coherent design-document update set that makes later implementation unambiguous?
11. Can the proposed unified Composer and target catalog reuse current Chat, Task Mode, Thread, Artifact, internal-role, worker, AgentSession, and Gateway owners without inventing a durable Shard or a second dispatch layer, and what exact structured request is the minimum end-to-end contract?

## Current Method

- Preserve all Intent Epochs above and reconcile current facts against the live repository before every durable design or implementation update.
- Obtain one independent Claude Code consultant/verifier review through Herdr before editing accepted owners.
- Convert evidence-backed consultant findings into plan corrections or explicit dispositions; consultant preferences do not override engineer intent.
- Keep `findings.md` as the material finding and disposition record and close each item only after its accepted owner or implementation evidence settles it.
- Update the smallest complete owner chain rather than every document that mentions a term. Core receives stable principles and identities; specifications receive concrete file, schema, resolution, lifecycle, failure, and acceptance contracts.
- Run documentation model, specification lifecycle, generated index, formatting, and direct diff checks after owner updates. Use separate FalseFire-style verifier and repository-governance auditor Agents because the primary agent produces the authority-bearing documentation change.
- Commit the independently accepted documentation baseline before editing production implementation or implementation tests.
- Implement only behavior owned by the committed documents, starting at existing schema, resolver, configuration-service, Gateway, AEP, AgentSession, Harness, and storage seams rather than adding parallel owners.
- Verify the runnable path in proportion to each slice, obtain independent implementation acceptance at its durable boundary, commit the coherent implementation, and close only with direct runtime evidence.

## Working Checkpoint

- **Current facts:** The implementation now loads distinct Server, Workspace, User, Gateway, Provider, internal-role, and Agent configuration owners; resolves ordinary Agent preference User → Workspace → Server after any explicit request; stores machine Workspace state in `workspace-record.json` and editable `name` plus `defaultAgentId` in `workspace.jsonc`; resolves logical models through eligible Gateway-private routes; emits strict AEP version 4 without a Provider section; materializes Workspace credentials through the NanoHost and OpenShell effect before recording receipts; admits multiple compatibility-keyed Harness Instances per Sandbox while retaining one active Turn per Harness; and exposes one structured `conversation.submit` path through the shared two-region Composer.
- **Accepted direction:** Intent Epochs 5 and 6 remain the implemented boundary. Server supplies resources and final defaults without acting as a generic Workspace ceiling; authored Workspace composition precedes non-authoring resolution; User → Workspace → Server is the persistent preference order; logical-model routing remains Gateway-private and pinned to catalog-derived effective capabilities and `modelFamilyId`; Sandbox remains the containment boundary; and `New Shard + Worker` creates a Task execution Thread without a Shard entity.
- **Delivery boundary:** The independently accepted documentation baseline commits `d3fe95d3261a12153dc37ee4dbc8e857d14d4ceb` and `6d4dafbf` precede every production edit. The current coherent implementation slice includes its code, tests, generated schemas, OpenAPI, CLI projection, local guides, manuals, and implementation-truth updates to accepted specifications.
- **Resolved unknowns:** The implementation uses one `internal-role-profiles.jsonc`, no shared environment file, `users/<userId>/config/user.jsonc`, the existing `session.concurrent-turns` feature ID, models.dev-derived logical-model capability and family, immutable AEP-time expansion of manifest `all`, ordered Provider-profile route members, explicit Pi non-readiness, natural next-Turn activation, and no compatibility reader for retired configuration paths.
- **Documentation state:** Every consultant and documentation-review finding is closed, all eight Stage E findings are closed from direct implementation evidence, affected local guides are current, and accepted implementation projections state AEP version 4, multi-Harness multiplicity, per-Harness sequencing, and the still-deferred concurrent-active-Turn scheduler grant truthfully.
- **Independent review state:** The first implementation FalseFire and repository-governance reviews returned `FAIL` and drove credential-sink, Pi-readiness, logical-model eligibility, Workspace-name ownership, independent selection, runtime-truth, local-guide, stale-comment, and fixture corrections. The second reviews found no remaining behavior defect but returned stale accepted projections and closeout records for correction. The final FalseFire verifier and repository-governance auditor each returned `PASS` on the corrected bytes with zero unresolved implementation, governance, or commit blockers.
- **Verification state:** On Node 24.18.0, `pnpm run test:unit` passed every package test and 527 of 527 root Node tests; `pnpm run test:coverage` passed, including NanoCore 2465 passed with one declared skip and Web 856 of 856; `pnpm build` completed 11 of 11 build tasks; Nano E2E passed 20 of 20; both NanoCore and Web built-artifact smoke checks passed; Web Playwright E2E passed 14 of 14; `pnpm fmt`, `pnpm run check:repo`, `pnpm lint`, and `pnpm typecheck` passed; and `git diff --check` is clean. The independent reviewers additionally forced the package tests, static gates, 527 root tests, and Rust checks on their reviewed snapshot with zero failures.
- **Documentation baseline:** Commit `d3fe95d3261a12153dc37ee4dbc8e857d14d4ceb` (`docs: define composable agent runtime configuration`) contains the authority-bearing documentation baseline, and commit `6d4dafbf` records its accepted gate before production implementation begins.
- **Implementation commit:** Commit `3de4ac98` (`feat: implement composable agent runtime configuration`) contains the coherent 239-file implementation, regression, generated-projection, manual, local-guide, accepted-spec projection, findings, and pre-commit checkpoint slice. The staged Biome and Conventional Commit hooks passed.
- **Close decision:** Verified. The accepted runnable slice is implemented, every finding is closed, the complete proportional gates pass, and independent FalseFire plus repository-governance reviews report zero unresolved blockers. Deferred worker-control version 2 envelopes, bounded concurrent active Turns, real two-runtime acceptance, relay-capable Pi dispatch, sandbox-provider credential materialization, direct-external AEP dispatch, broader internal-agent runtime fields, and generic schema-evolution adoption remain explicitly outside this close decision.
- **Frontier:** No required implementation or verification work remains inside the accepted slice. Future work begins only from one of the explicitly deferred owners and does not reopen this plan implicitly.
- **Predicted Next Action:** None for this closed lifecycle. A future engineer may start a new owned change for one deferred exclusion when a present product need authorizes it.

## Acceptance Observations

- Core states the Server, Workspace, and User roles and User → Workspace → Server persistent preference precedence without depending on this plan.
- Agent Supply and the concrete resolver distinguish one Agent supply unit from shared Sandbox/environment composition and permit Workspace override and extension through owned configuration.
- Internal roles resolve through the existing Internal Role Execution Profile and no live caller depends on `coreProviderId/coreModel` in the target design.
- Worker selection has explicit request/User/Workspace/Server precedence and no lexical manifest fallback.
- Workspace record and config file names, scopes, defaults, export behavior, and Web mutation path are unambiguous.
- Gateway logical models hide concrete Provider, model, and account routes, derive effective capabilities and `modelFamilyId` from the pinned catalog, use bounded ordered pre-output fallback, and retain existing schema-evolution seams for later balancing strategies without changing worker-visible model IDs.
- The design supports one Thread-bound AgentSession, multiple AgentSessions per Harness, concurrent active Sessions when supported, and multiple Harness Instances per Sandbox without exposing infrastructure identity to product selection.
- Direct Server Secrets and Workspace credential requirement bindings have complete missing, replacement, addition, reload, resume, and failure behavior.
- Reload behavior states when configuration applies immediately, naturally at runtime reload, after the active Turn through process replacement/resume, or through ordinary AgentSession/Sandbox replacement.
- Documentation validators and generated index checks pass on the final owner set, and independent review finds no unresolved authority, simplicity, or completeness defect.
- The accepted documentation exists in a dedicated commit that predates all production implementation changes.
- Configuration schemas and canonical files expose the documented Server, Workspace, User, Gateway, Provider, internal-role, Agent, profile, and Workspace-record scopes without retaining removed compatibility fields or paths.
- Focused and end-to-end runtime evidence proves Agent and model preference resolution, logical Gateway routing, Workspace credential binding, Thread-bound AgentSession continuity, supported multi-Harness placement, and documented reload or post-Turn resume behavior.
- Independent implementation verification and repository-governance audit find no unresolved contract divergence, duplicate owner, stale projection, missing consumer, or speculative mechanism in the final implementation.
- The final commits, exact checks, runtime observations, and retained exclusions are recorded in this plan before it is marked complete.
- The shared Composer matches the supplied two-region visual hierarchy, grows from approximately two and one-half lines to a bounded maximum, and exposes Artifact or upload, Agent target, logical Model, and Send actions in the required bottom-row order.
- The target selector can reach applicable internal roles, running Orchestrator, Workspace Knowledge Manager, pinned warm workers, running workers, and the new Task worker action while preserving Thread and AgentSession ownership and hiding Sandbox, Harness, process, provider-account, and route identifiers.
- Composer-focused and end-to-end tests prove logical-model filtering, structured submission, Task Mode transition, Artifact or upload retention, unavailable-target behavior, exact failure retry, keyboard use, accessible naming, and no concrete Gateway route leakage.

## Closeout Summary

The accepted Server, Workspace, User, Gateway, Provider, internal-role, Agent, Sandbox, Harness, AgentSession, credential, and Composer configuration slice is implemented and verified. Documentation baseline commits `d3fe95d3261a12153dc37ee4dbc8e857d14d4ceb` and `6d4dafbf` preceded production work, and implementation commit `3de4ac98` contains the coherent runnable system, regression coverage, generated projections, manuals, local guides, accepted-spec truth updates, and resolved findings. Independent FalseFire verification and repository-governance audit each returned `PASS` with zero unresolved blockers. The explicitly deferred worker-control version 2 envelope, bounded concurrent active Turns, real two-runtime acceptance, relay-capable Pi dispatch, sandbox-provider credentials, direct-external AEP dispatch, broader internal-agent runtime fields, and generic schema-evolution adoption remain outside this closed lifecycle.

## Verification Evidence

- **Commit evidence:** Documentation authority and its pre-implementation gate are recorded in `d3fe95d3261a12153dc37ee4dbc8e857d14d4ceb` and `6d4dafbf`; implementation and its pre-commit checkpoint are recorded in `3de4ac98`.
- **Test evidence:** `pnpm run test:unit` passed every package suite and 527 of 527 root tests; `pnpm run test:coverage` passed with NanoCore at 2465 passed and one declared skip and Web at 856 of 856; Nano E2E passed 20 of 20; and Web Playwright passed 14 of 14.
- **Build and static evidence:** `pnpm build` completed 11 of 11 tasks; NanoCore and Web built-artifact smoke checks passed; and `pnpm fmt`, `pnpm run check:repo`, `pnpm lint`, `pnpm typecheck`, and `git diff --check` passed on the implementation bytes.
- **Independent acceptance evidence:** The final independent FalseFire verifier and repository-governance auditor inspected the corrected implementation and owning documentation, repeated proportional tests and static checks, and each returned `PASS` with no unresolved implementation, authority, governance, or commit blocker.
- **Runtime evidence:** The verified path resolves persistent Agent preference User to Workspace to Server after explicit or Orchestrator selection, keeps logical-model routes Gateway-private, materializes Workspace-bound credentials before receipt, supports multiple compatibility-keyed Harness Instances per Sandbox, preserves Thread-bound AgentSession continuity, and submits Composer selections through the structured conversation contract.
