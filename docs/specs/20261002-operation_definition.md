---
status: Accepted
implementation: Partial
kind: boundary
aspect: mediation
---
# Operation Definition

This specification is the single owner of the declarative operation definition contract, the non-API mediation registry extension, the typed implementation join, trusted target resolvers and invocation inputs, canonical operation and agent-facing Tool naming, operation lifecycle, and the derivation of HTTP, Core Client, CLI, remote MCP, and internal/worker Tool projections.

## Scope

Owns the declarative operation descriptor tables (`OPERATION_DEFINITIONS` and `OPERATION_REGISTRY` in `@openkit/app-api-schemas`), the internal-only `skill.read` definition, the typed implementation join, closed trusted resolvers, the native invocation seam, canonical operation and Tool naming (`<namespace>.<segment>` and 40-character model projection), operation lifecycle, and projection rules for HTTP JSON, remote MCP, CLI, and internal/worker Tools.

Does not own:
- Authentication procedures, bootstrap secrets, or deployment-administrator proof ([Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md)).
- Policy evaluation, policy statements, or Pending Request capture and execution ([Policy](../core/policy.md), [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md), [OpenKit Policy Model](20260629-openkit_policy_model.md), [Pending Requests](20260930-pending_requests.md)).
- Capability and entry admission or non-JSON transports ([Mediation](../core/mediation.md), [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md), [Worker Agent Capability](20260703-worker_agent_capability.md), [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md), [LLM Gateway](20260526-llm_gateway_responses_api.md)).
- Domain record lifecycles, durable replay receipts, or offline host procedures ([Agent Operator Skill](20260910-agent_operator_skill.md), [Workspace Backup, Export, And Import](20260704-workspace_backup_export_import.md)).
- Post-launch stability classes ([Contract Evolution](../core/contract-evolution.md), [Contract Stability Baseline](20260715-contract_stability_baseline.md)).

Core: [Doctrine](../core/doctrine.md), [Contract Evolution](../core/contract-evolution.md), [Identity](../core/identity.md), [Policy](../core/policy.md), [Protocol](../core/protocol.md), [Communication](../core/communication.md), [Mediation](../core/mediation.md).

## Declarative Definition

Each cohesive resource family defines its descriptors in `packages/app-api-schemas/src/*-operations.ts`, statically composed into `OPERATION_DEFINITIONS` and `OPERATION_REGISTRY` in `packages/app-api-schemas/src/operation-definitions.ts` under the closed descriptor contract in `packages/app-api-schemas/src/operation-contract.ts`. The table is keyed by the canonical dotted operation id. NanoCore imports that table at process start and MUST NOT accept a caller-supplied descriptor or a caller-supplied authorization result.

The family definition declares the operation's success status or allowed success statuses (`200`, `201`, `202`, or `204`), any owner-required invalid-input code that differs from the common code, its JSON (`binding: 'json'`) or retained streaming (`binding: 'streaming'`) binding kind, its operation `stability` classification (`OperationStability` in `packages/app-api-schemas/src/operation-contract.ts`), and whether its result contains a one-time secret. MCP result eligibility derives from these facts and does not replace trusted entry or worker supply selection. A projection MUST consume these facts without testing a family id, id prefix, output-schema identity, or owner error class. Trusted entry assembly selects the bound fields and delivery context; neither caller input nor a schema field's presence establishes authority or changes a delivery channel.

The table holds every public contract fact of the operation and only those facts: description, complete logical input and output schemas, input sensitivity, credential eligibility (`OperationCredential` in `packages/app-api-schemas/src/operation-contract.ts`), closed typed scope (`OperationScope`), target and mutation-target descriptors (`OperationTarget` and `OperationMutationTarget`), primary policy operation (`OperationPolicy`), mutation posture, stability (`OperationStability`), projection framing (`OperationProjectionFacts`, including binary request framing), Policy insertion points, exposure-switch metadata, and, when first needed, lifecycle. Credential eligibility names which trusted authentication procedures and which actor kinds may invoke the operation. Gateway transport authentication stays with its separate owner. A currently usable administrator credential is eligible for every operation through one authorizer rule; a descriptor does not exclude that credential and does not replace the rule.

Core record and command schemas stay in `@openkit/protocol`. The declaration modules express operation schemas in Zod and keep a browser-safe dependency closure that does not import NanoCore. The table MUST NOT hold private executable configuration, the policy graph, memberships, credentials, deployment paths, or any other live authority fact.

There is no runtime registration API, no plugin mechanism inside the NanoCore process, no durable operation-registry state, no new permission engine, no generic RPC dependency, no alias for an old id, and no second effect-risk taxonomy. The mutation posture remains separate from the Policy-owned crossing attributes.

Connection metadata at `GET /api/meta`, health at `GET /health` and `GET /api/health`, raw deployment diagnostics at `GET /api/diagnostics`, and diagnostic OpenAPI serving at `GET /api/openapi.json` are support bindings outside `OPERATION_DEFINITIONS`. Their owners retain authentication, disclosure, response, and availability semantics (including unauthenticated connection metadata and administrator-only raw diagnostics), while named product diagnostics operations (`diagnostics.app` and `diagnostics.setup`) remain in `OPERATION_DEFINITIONS`.

### Common API Conventions

These conventions constrain declarations and their projections without transferring domain records, replay, effect commitment, or retained formats from their owners. The App API remains release-coupled under [Contract Evolution](../core/contract-evolution.md).

#### Pagination

A cursor is an owner-validated continuation position, not authority. Clients return it unchanged with the same selectors and filters. Each paged operation owns its cursor grammar, order and tie-break, limit omission and bounds, completion marker, and behavior under concurrent change. Each invocation requires current authority and audience checks. No cursor registry, generic snapshot, default limit, or global cap is introduced.

`thread.items` retains chronological forward traversal with its decimal positional cursor; omitted limit remains unlimited, `nextCursor: null` marks completion, positions do not promise a stable snapshot after insertion, deletion, or trimming, and numeric `since` gains no filtering meaning from this convention. `audit.workspace-list` retains its descending keyset traversal toward older events without reversing retained or portable Audit readers. The two independent `usage.read` arrays (`capabilityCalls` and `usageRecords`) acquire no common cursor. Existing offset-based reads and the Core Turn stream keep their separate contracts.

#### Errors

Classified operation failures use the transport-neutral typed error in [Invocation](#invocation) below. Owner codes and exceptions stay intact, including HTTP `403` for bound-input conflict (`bound_input_conflict`). HTTP carries the semantic status; operation-error MCP data preserves it in its own framing. Messages and optional details MUST be safe for their admitted audience; causes and stacks remain private. A status alone establishes neither rollback nor safe retry, and HTTP `202` admission does not prove completion.

#### Request Identity And Replay

The definition-derived client supplies a request identity only for a mutating operation whose schema declares that field. It preserves a supplied identity and uses `x-openkit-request-id`; HTTP rejects a conflicting body identity and validates through the declared schema. Trusted native and model identities remain invocation-context inputs. A second client call without a supplied identity creates a new command rather than a retry.

Where an owner provides idempotent execution, a logical retry keeps the original command, owner scope, request identity, and admitted input. The owner's receipt and input comparison decide replay or conflict. Replay may return a current resource view rather than the first response bytes. A mutation declaration alone promises no receipt, exactly-once effect, or automatic retry.

#### Identifier And Time Formats

Named entity fields reuse [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids) and their kind-specific schemas (`<kind>_<lowercase UUID>`). Selectors, native identifiers, and command or correlation identities retain their own validators; not every field named `requestId` is a Protocol UUID. Encoded identity time grants no authority.

New instant producers use the owning timestamp contract and canonical UTC ISO serialization where declared. Numeric clocks and durations state their units. Existing retained readers and accepted representations remain unchanged; in particular, shared `TimestampSchema` accepts a nonempty string.

#### Declaration Checks And Behavioral Evidence

The `check:repo` pipeline builds the cached Protocol, Worker Protocol, config-schema, and app-api-schemas TypeScript closure and runs the schema package's operation-definition checks. Public API framing uses JSON or streaming binding, secret-result and mutation facts, and success statuses `200`, `201`, `202`, or `204`. An explicit allowed-status set MUST be nonempty, unique, and contain its default status; an invalid-input code override MUST be nonempty. A JSON binding that declares HTTP `204` admits logical `null`, while HTTP emits no body.

### Mediation Registry Extension

`OPERATION_REGISTRY` in `packages/app-api-schemas/src/operation-definitions.ts` extends the operation registry to Core-mediated non-API operations: tool dispatch, model requests, context delivery, and result ingress. A mediation point combines the canonical operation id with `propose`, `decide`, `commit`, or `completed` as `<operation>@<stage>` under [Mediation](../core/mediation.md#enforcement-points) and [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md).

An operation descriptor carries its Policy-owned crossing attributes: `admission`, `disclosure`, `dispatch`, `ingress`, `mutation`, `administration`, and `decision`. A non-API descriptor (`policy.write`, `mcp.call-tool`) is included in `OPERATION_REGISTRY` and excluded from `OPERATION_DEFINITIONS`, so it creates no HTTP, CLI, or MCP projection. A nested operation reaches its own point rather than inheriting its wrapper's approval.

JSON-bound operations declare their Policy crossings through `insertionPoints`: stage, participant mode and kind, supported gate results, and gate-failure behavior. The shared interception key is the operation id and stage:
- The Vault family's `vault.binding-deliver`, `vault.binding-replace`, `vault.binding-revoke`, `vault.injection-plan-list`, and `vault.injection-receipt-list` use `insertionPoints` and uniform projections. Inspection retains `vault.admin` as its primary action; binding effects use `vault.use`. Initial delivery pins the prepared material generation before any audited resolution. Their deciding subset is deterministic gate with allow/deny and error on failure; completed deterministic observation is non-decisive. Agent callers use the same operation admission; agent gate participants, advice, and transformation are unavailable for these operations.
- The personal harness Login inventory and quarantine/release operations retain fixed User scope and target, the `vault.admin` primary action, and definition-derived deterministic gate and completed observation stages using the caller's User PermissionDecision and Audit home, with list read posture and state-changing mutation posture under [Vault Secret Injection](20260703-vault_secret_injection.md#private-login-metadata-operations).
- `vault.grant-issue` retains body-Workspace and addressed-Thread primary admission while declaring `propose`, `decide`, `commit`, and `completed` crossings for every supported issuer branch; the effect owner selects the User or Workspace Policy resource and decision home from the trusted reference independently of primary destination admission.

### Exposure Switch Descriptors

Every externally reachable route group MUST declare its exact operation family, accountable owner, and administrator-scoped Policy deny selector in `packages/app-api-schemas/src/operation-definitions.ts`. Non-API descriptors cover external surfaces outside the JSON interface. Source-authored metadata owns the mapping without creating a persisted registry or dynamic registration API. Consumers MUST resolve exact registered operations rather than infer permission from a name prefix.

[Runtime Security](20261109-runtime_security.md) owns switch state, current admission enforcement, response authority, and human recovery. [Development Security](20261109-development_security.md#exposure-switch-coverage) requires mounted-route and projection coverage in the repository gate. A missing or invalid mapping blocks new exposure.

## Implementation Join

Each family exposes one exact-key implementation map for static composition of its JSON-bound operations (`binding: 'json'`). Streaming definitions (`binding: 'streaming'`) use their retained streaming routes exclusively, and the native invocation engine MUST refuse them with typed `unsupported_operation` before admission or effects. A handler receives parsed input and the invocation's admitted context, and returns its logical output without a transport object. Common invocation and projection algorithms MUST NOT contain family dispatch.

NanoCore holds, per family, an exact-key map from the JSON-bound operation ids to transport-free handlers (`apps/nanocore/src/operation-composition.ts`). A missing handler, an extra handler, or a signature mismatch MUST fail TypeScript compilation. A declaration that does not match the handler's behavior is a defect, not authority to perform the effect.

## Trusted Resolvers

Descriptor selection uses only the closed declared scope, target, mutation-target, and child-owner strategies in `packages/app-api-schemas/src/operation-contract.ts` and `apps/nanocore/src/operation-resolvers.ts`. An unknown resolver kind MUST fail closed. Resolved lineage does not replace current effect authority, audience, approval, capability, or mutation-fencing checks:

- **Server targets**: select the `administration`, `mcp`, or `knowledge` resource family through optional `target.family` (omission selects `administration`). After administrator credential eligibility, the Policy Kernel evaluates that family and the registered primary operation with the current User. Unknown families deny; identity and storage read errors remain errors rather than Policy denials.
- **User credential consent withdrawal (`vault.grant-withdraw`)**: combines fixed User scope with an explicit body-Workspace mutation target and definition-derived deterministic gate and completed observation stages under [Vault Secret Injection](20260703-vault_secret_injection.md#harness-subscription-logins), so a departed reference owner can withdraw consent without Workspace membership.
- **Explicit Workspace (`path-workspace` and `workspace-child-lineage`)**: authorized before content access under [Multi-User Workspace System](20260715-multi_user_workspace_system.md). A Workspace derived from an inconsistent child never replaces it. When the child owner can distinguish a globally missing child without scanning another Workspace, a missing child uses that owner's not-found result; otherwise a missing child and mismatched lineage return the same access denial.
- **Body selector (`body-workspace`)**: read only from the field the operation declares, and only after the operation's complete logical schema has parsed.
- **Opaque-child lineage (`opaque-child-workspace`)**: reads only the minimum Workspace id and eligibility context before authorization without loading full child content or mutating. Missing child, contradictory lineage, and unauthorized Workspace return the same access denial. Native invocation resolves `turn.feedback` through minimal opaque Turn-map lineage before Workspace and Thread admission, and resolves approval ids from minimal canonical or Approval-map lineage after selected-Workspace admission; question answers and Pending Request withdrawals use body-Workspace and addressed-Thread admission.
- **Collection authorization (`authorized-workspace-set`)**: candidate-first from active membership, or from active registered Workspaces for a currently usable administrator credential under [Policy](../core/policy.md), then intersected with token scope and the declared operation. Closed Workspaces are excluded before the handler runs.
- **Personal Workspace (`actor-quick-chat-workspace`)**: derived from the actor without allowing a caller Workspace override, requiring the user to be the Workspace's current owner under [Multi-User Workspace System](20260715-multi_user_workspace_system.md).
- **Addressed Thread**: enforces Thread audience under [Thread Visibility And Sharing](20260909-thread_visibility_and_sharing.md); an inaccessible Thread returns a uniform not-found and discloses no protected content.
- **Gateway attribution (`gateway-metadata-workspace`)**: reads only optional `metadata.openkit.workspaceId` under [LLM Gateway](20260526-llm_gateway_responses_api.md); absence and malformed input produce distinct outcomes.
- **Mutation targets outside Workspace membership**: leave, Workspace access recovery, invitation response, and deletion fencing target the Workspace for mutation admission independently of authorization scope under [Multi-User Workspace System](20260715-multi_user_workspace_system.md).
- **Bootstrap versus deployment administration**: `bootstrap-secret` selects the exclusive actorless trusted HTTP entry after secure-transport admission and bearer/session refusal; native admission rejects either direction of credential/context mismatch, and bootstrap consumption is never deployment administration ([Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md)).

## Trusted Invocation Inputs

A selector is caller input only where the operation lets the caller choose it. Trusted actor, execution lineage, entry scope, the private Turn, and owner-derived command identities come from the invocation context; the caller and the model MUST NOT supply or override them.

Model-facing schemas derive from the logical input schema and omit bound fields. The assembled invocation MUST reject a conflict between a caller argument and a bound value before any effect.

## Invocation

A classified operation failure uses one transport-neutral typed error carrying a semantic status, code, safe message, and optional safe details; causal errors and stacks remain private. The boundary that owns a failure classifies its known failures, and each family translates its known domain failures inside its execution boundary. An unclassified exception remains unclassified. For classified operation failures, HTTP, remote MCP, and built-in worker MCP MUST preserve the same safe code, message, semantic status, and optional details using their respective transport framing, without family-specific class, cause, or id tests. HTTP carries the status as its response status and uses the protocol error body; MCP carries the semantic status in its operation-error data. Authentication, MCP protocol, and worker capability or transport failures retain their owning projections. HTTP rethrows an unclassified exception to its error handler instead of converting it to a family fallback. A dependency failure of NanoCore, the policy owner, or a domain owner remains that owner's failure.

One native invocation function (`apps/nanocore/src/operation-invocation.ts`) is the seam every derived projection uses. It parses input against the definition's schema, resolves the target without disclosing an inaccessible child, performs primary admission through the operation's primary policy operation, invokes the handler, and validates the logical output. Capability admission, source and audience checks, mutation fencing, effect-specific checks, and Pending approval execution stay with their owning boundaries. Invocation persists no invocation receipt and never claims that an unknown outcome after a committed effect rolled back.

## Names

Every release-owned agent-facing operation and Tool MUST have one canonical ID of the form `<namespace>.<segment>(.<segment>)*`. Each segment begins with a lowercase ASCII letter and contains lowercase ASCII letters or digits, with single hyphens joining words. Empty words, uppercase letters, colons, and underscores are invalid. The first segment identifies the owning Core aspect or its governed resource family; the Agent Interface's own Tools use `openkit`. This rule covers public and internal-only operations, internal-role Tools, built-in Worker MCP Tools, Server MCP Tools, and the three built-in `mcp.*` capability route IDs. It does not rename third-party Tools, MCP protocol methods, native opaque identifiers, or accounting-only labels.

The model-visible name replaces every dot with an underscore and changes nothing else; hyphens remain hyphens. The same canonical Tool has the same model-visible name on every supplied surface. A Tool that projects an operation uses that operation's canonical ID with no alias. One canonical ID MUST NOT name different input, output, authority, or effect contracts.

The projected name MUST be at most 40 ASCII characters (contract constant). The complete release-owned set MUST be unique after model projection and after additionally folding hyphens to underscores. Repeated appearances of the same canonical contract across surfaces are permitted. A repository check enumerates the current composed definitions and actual owned Tool declarations, including newly added entries (`packages/app-api-schemas/src/operation-definitions.ts`), rather than a frozen name list or count. Provider dispatch also checks the supplied canonical set before inference. A third-party name forwarded as private execution evidence stays opaque and is not a new release-owned canonical ID.

Internal execution, usage, and evidence use the canonical ID. Transport dispatch retains an exact name-to-ID map; parsing a name never grants authority. The projection is reversible as a spelling transformation because canonical IDs contain no underscores: replacing underscores with dots recovers the ID. This does not recover a contract, actor, or permission. The extra hyphen folding is only a collision check, never the actual transport projection or its inverse.

The Agent Interface's discovery, description, guidance, and invocation Tools have canonical IDs `openkit.search`, `openkit.describe`, `openkit.guide`, and `openkit.call` (`openkit_search`, `openkit_describe`, `openkit_guide`, `openkit_call`). Worker's Work-owned built-ins use `work.input.request`, `work.peer.list`, `work.peer.read`, `work.source.read`, `work.source.search`, `work.source.view`, and `work.artifact.submit`. The standalone directory-bound Retrieval Kernel MCP search uses `retrieval.search`. The Coordinator's Goal-constrained Task admission closure is `goal.task.dispatch`, distinct from the Assistant's human-confirmed `task.start`. The private finite delegated configuration Tool is `administration.configuration.dispatch`, distinct from the human-confirmed public `administration.configuration-apply`. An unadmitted canonical spelling or invalid function spelling on the Gateway returns through the reserved `openkit_unavailable_tool` correction path without fuzzy dispatch or automatic retry.

Existing settled IDs stay unless this rule requires a rename. Before `v0.1.0`, old retained references are disposed of through the authorized reset under [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md); no alias or legacy reader is added. After that continuity boundary, any affected retained reference follows its owner's accepted continuity design. Names never manufacture authority from old evidence.

### Compatibility details and limits

These are external reference observations checked on 2026-10-17, not OpenKit runtime constants; only the 40-character projected name limit above is enforced by OpenKit:

| Surface | Verified documented name rule | Limit or qualification |
| --- | --- | --- |
| OpenAI Chat Completions function Tool | ASCII letters, digits, underscores and hyphens, at most 64 characters. | Dots and colons are excluded. [API reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). |
| Anthropic user-defined client Tool | Pattern `^[a-zA-Z0-9_-]{1,128}$`. | Dots and colons are excluded. [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools). |
| xAI function Tool | Documented named function Tools. | Normative character pattern and maximum length not specified in the guide. [Function calling](https://docs.x.ai/developers/tools/function-calling). |
| Gemini on Vertex AI | Starts with a letter or underscore; ASCII letters, digits, underscores, dots and hyphens; at most 64 characters. | Vertex AI surface. [Function calling reference](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/function-calling). |
| Amazon Bedrock Runtime Converse ToolSpecification | Pattern `[a-zA-Z0-9_-]+`, length 1 to 64. | Separate Bedrock Agent ToolSpecification admits `[a-zA-Z][a-zA-Z0-9_]*` without hyphens. [Runtime reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html), [Agent reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent_ToolSpecification.html). |
| MCP Tool names | Recommends 1 to 128 ASCII letters, digits, underscores, hyphens or dots. | MCP SHOULD guidance; colons are excluded. [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names). |

Harnesses may prefix or sanitize names (for example [Claude Code MCP guidance](https://code.claude.com/docs/en/mcp) prefixes `mcp__<server>__<tool>` and drops names exceeding 128 characters), and code-execution wrappers ([Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)) may transform hyphens because hyphens are not [Python](https://docs.python.org/3/reference/lexical_analysis.html#names-identifiers-and-keywords) or [ECMAScript](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-names-and-keywords) identifier characters. OpenKit's hyphen-to-underscore collision check guards against that folding without changing wire spelling.

## Lifecycle

After the launch boundary ([Contract Evolution](../core/contract-evolution.md)), an operation's semantic contract freezes. New semantics require a new id, and an id is never reused. Deprecation keeps the operation callable, records its reason and optional replacement in discovery and guidance, and never redirects a call. Retirement in a later release removes the operation from discovery and execution; any call, including through a captured Pending approval binding, returns a typed retired error naming the optional replacement. Retained records citing a retired id remain readable. The lifecycle field and retirement mechanism are deferred until the first post-launch deprecation or retirement requires them.

Blocking is a deployment decision rather than an operation-definition lifecycle transition. Server route-group prohibitions are enforced through [Exposure Switch Descriptors](#exposure-switch-descriptors) above; general per-operation Policy blocking is tracked separately.

## Data-Defined Sources

A data-defined operation source is reserved and is not built. No dynamic source, registry state, or generic execution engine is added.

A future admitted source may project this specification's browser-safe operation vocabulary from records and immutable component versions that an existing domain already owns. The first candidate is the Generative Kernel's fixed operation. [Generative Kernel Data And Operations](20260908-generative_kernel_data_operations.md) keeps that operation's proposal, validation, activation, retirement, immutable versions, and execution classes. [Agent Plugin Packaging And Worker Supply](20260907-agent_plugin_packaging_and_worker_supply.md) keeps binding admission. This specification does not restate those classes.

Publication of such an operation MUST validate the exact executable binding and the authority, scope, and effect requirements of that binding. The data definition cannot weaken them. It cannot declare itself read-only, choose a weaker credential, substitute a target, or supply code or credentials. Invocation pins the selected revision and checks current authorization. A stale or unsupported binding fails explicitly. There is no generic prompt fallback and no shell fallback.

Discovery of a data-defined operation is an authorized current projection, not an execution grant. Its public descriptor is permission-filtered and never exposes the owner's private executable configuration. Its ids are scoped so they cannot collide with release-authored ids.

Deferred execution classes stay unavailable until their own contracts are accepted and implemented. Entry admission and worker admission continue to select immutable Tool bindings. An operation's existence does not make it a model-visible Tool. Unknown resolver, effect, authority, or required-feature values fail closed.

## Remote MCP Projection

`openkit_search`, `openkit_describe`, and `openkit_guide` are side-effect free with truthful read-only hints. Invocation uses `openkit_call` with conservative annotations (`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`), while `openkit_describe` reports the selected operation's exact mutation posture.

Search tokenizes ids and descriptions, ranks multi-term matches, tolerates word order, and returns a bounded page of operation metadata (current default bound in the implementation). Search is not a permission decision.

An operation that returns a one-time secret (access-token issuance, access-token rotation, and bootstrap responses under [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md)) MUST be omitted from MCP search and MUST fail direct MCP calls before effects with `mcp_secret_returning_operation`. NanoHost sink-writing operations write secrets only to local secret-safe sinks, return metadata only, and remain callable through remote MCP under deployment-administrator authorization and mutation-readiness checks.

Streaming-only operations (`binding: 'streaming'`, including Workspace archive and snapshot downloads under [Workspace Backup, Export, And Import](20260704-workspace_backup_export_import.md), `artifact.import`, `artifact.version-file-commit`, and `artifact.download` under [Work Resource Interaction](20260713-work_resource_interaction_model.md), and the two Knowledge package operations under [File Storage And Knowledge Packages](20261018-file_storage_and_knowledge_packages.md)) MUST be omitted from remote MCP search and describe, and `openkit_call` MUST refuse them before file processing with `mcp_streaming_operation`. Their bytes never enter a JSON MCP argument or result.

A client's own approval prompt is never an OpenKit human decision and never substitutes for server-side approval checks. Guidance for an external Codex installation recommends setting `default_tools_approval_mode` to `approve` for the OpenKit server, matching [Codex Worker Adapter](20260716-codex_worker_adapter.md) inside the Sandbox. [Remote MCP Interface](20261002-remote_mcp_interface.md) owns the endpoint and transport authentication.

## Other Projections

Classified failures from definition-derived JSON operations use the common protocol error envelope, without family-specific plaintext responses. Unclassified exceptions remain the HTTP error handler's responsibility. A dynamic success status is request-local and MUST be one of the operation's declared allowed success statuses. A deliberate domain fallback remains only where the domain owner requires it, is classified at that owner's execution boundary, and exposes a safe message. It MUST NOT wrap shared parsing, primary admission, resolver execution, or invocation output validation; otherwise unclassified exceptions propagate. Every response from the HTTP JSON operation projection MUST include `Cache-Control: no-store`, including successes, typed refusals, unclassified HTTP errors, and bodyless `204` responses.

JSON product operations use one HTTP route per canonical operation id: `POST /api/app/operations/<id>`. For a mutating JSON operation that declares `requestId`, the HTTP binding reads `x-openkit-request-id` and rejects a conflicting body `requestId` with `bound_input_conflict` (`403`) before effects. `automation.delete`, `runtime.file-delete`, and `provider-subscription.account-delete` return logical `null` and emit HTTP `204` with no body and no `Content-Type`; derived clients, MCP, and CLI map that empty success to logical `null`.

Internal Tools, built-in worker MCP Tools, and CLI commands derive from the operation definitions and execute through native invocation:
- For Material operations, trusted model delivery MUST refuse restricted content before accessing bytes or entering the command owner, while human JSON exact read and edit remain available.
- For App update operations, `app-update.status` keeps its host-owned receipt id as a read selector while mutable commands use header-carried request identity; model-mediated App update MUST refuse before effects until its exact approval adapter exists.
- The internal administration Tool derives `nanohost.runtime-target` from `ADMINISTRATION_OPERATION_DEFINITIONS` without publishing other administration operations to the internal Tool surface.
- For Vault operations, request material remains sensitive input and every output remains redacted.
- For the selected-Skills family under [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md), `skill.read` is a release-authored internal-only Operation Definition excluded from `JsonOperationId`, HTTP, OpenAPI, Core Client, CLI, remote MCP, and Worker projections. Only trusted assembly for a command-initiated Assistant Turn admitted by `conversation.submit` can bind it, verifying the retained actor, Workspace, Thread, private Turn, entry scope, and command request closure before reading `{skillId, versionId, contentDigest, path}` (defaulting `path` to `SKILL.md`) with `workspace.read` primary admission and returning `{skillId, versionId, path, fileDigest, text}`.
- Knowledge answer and Task/public Knowledge preparation share `knowledge.read` primary admission under [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md), [Knowledge Store Implementation](20260703-knowledge_store_implementation.md), and [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md).
- The operator CLI ([Agent Operator Skill](20260910-agent_operator_skill.md)) derives online product commands from `OPERATION_DEFINITIONS`, retains secret-input handling for invitation creation, writes one-time secrets to local secret-safe sinks, and keeps bootstrap and offline host procedures separately authorized.
- Under Administrator Eligibility ([Policy](../core/policy.md)), a currently usable administrator session or bearer credential is eligible for operations across other users' resources without impersonation, preserving truthful actor attribution, original resource ownership on recovery, per-effect approval and Vault grant checks, read-only/revocation/expiry credential limits, and Sandbox boundaries.

## Identity

Future independent agent identities enter through the same invocation boundary. Authentication, membership, audience, attribution, and gate implementations remain with their owning specifications.

## Acceptance

- Classified operation failures preserve their code, message, semantic status, and safe details across HTTP, remote MCP, and built-in worker MCP projections without exposing causes, stacks, or secret-bearing inputs, while injected unclassified failures in handler or resolver execution reach the HTTP error handler without conversion to family not-found or invalid-input results.
- Authorized results and stored records match across HTTP/Core Client, remote MCP, worker MCP, internal Tool assembly, Web readback, and the operator CLI; replay follows the effect owner's receipt rule, conflicting input is rejected before any effect, read-only or revoked credentials are denied before protected effects, and one real Claude Code loop and one real Codex loop complete against the remote MCP projection.

## Implementation

- `packages/app-api-schemas/src/`
- `packages/protocol/src/`
- `apps/nanocore/src/`

## Implementation Gaps

- Exposure-switch coverage gate - The exposure-owner and route-group switch coverage suite in `apps/nanocore/src/policy/operation-exposure-coverage.test.ts` is not executed by `check:repo` in CI - #747
- General per-operation Policy blocking - Invocation enforces primary operation admission and Server route-group switches, but user-configurable per-operation Policy blocking is not implemented - #153

## Decisions

- [Operation Definition Rulings](../decisions/20261002-operation_definition_rulings.md)
- [Administrator Authority](../decisions/20261002-administrator_authority.md)
- [Interface Unification Rulings](../decisions/20261002-interface_unification_rulings.md)
- [Operation Family Modules And Error Projection](../decisions/20261003-operation_family_modules_and_error_projection.md)
- [Streaming Archives Use Web And Administrator CLI](../decisions/20261003-streaming_archives_use_web_and_admin_cli.md)
- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Skill Read Operation Invocation](../decisions/20261015-skill_read_operation_invocation.md)
- [Agent-Facing Naming](../decisions/20261017-agent_facing_naming.md)
- [Unified Mediation And Policy](../decisions/20261018-unified_mediation_and_policy.md)
- [Workspace Export Requires Administrator Authority](../decisions/20261027-workspace_export_administrator_only.md)
- [Online Workspace Snapshots And Scoped Recovery](../decisions/20261027-online_workspace_snapshots_and_recovery.md)
