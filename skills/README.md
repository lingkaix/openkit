# OpenKit Skills

OpenKit maintains two complementary packages. The [public `openkit` Skill](openkit/SKILL.md) operates running NanoCore through the bundled public CLI under [Agent Skill Interface](../docs/specs/20260713-openkit_agent_skill_interface.md). The independent [`openkit-ops` Skill](openkit-ops/SKILL.md) packages installation, configuration, upgrade, diagnosis and offline recovery guidance under [Agent Operator Skill](../docs/specs/20260910-agent_operator_skill.md). [Remote MCP Interface](../docs/specs/20261002-remote_mcp_interface.md) defines the accepted user-facing agent channel over the same operations. [Agent Skill Interface](../docs/specs/20260713-openkit_agent_skill_interface.md) owns retirement of the user-facing Skill once that endpoint covers it. [Agent Operator Skill](../docs/specs/20260910-agent_operator_skill.md) owns retention and relocation of the bundled CLI as the administrator channel.

## Public Product Interface

The public package contains its concise entrypoint, generated Agent-host metadata, bundled `scripts/openkit` executable and progressively loaded references. The CLI exposes supported public end-user and operator capabilities through operation search, description and invocation. Workflow truth, authorization, approvals and durable records remain in NanoCore. It has no arbitrary HTTP, source-editing, SSH or generic shell mode.

Public response redaction removes credentials and secret material while preserving authorized path text, quoting, and standalone slash punctuation. NanoCore operation projections own path confidentiality. Its focused regression is `node --test tests/openkit-public-redaction.test.mjs`.

Current-user Workspace invitation list, accept, and decline are exposed as `workspace.my-invitation-*` through implicit local identity. Owner-scoped `workspace.invitation-*` operations remain distinct. Ordinary server-mode bearer credentials, including `workspace` and `workspace-readonly`, do not authorize current-user invitation operations. A currently usable administrator credential is eligible under the administrator eligibility rule in [Core Permissions](../docs/core/permissions.md), and the recorded actor is that administrator. Use the Web Account Invitations panel for the ordinary session path.

Workspace leave is exposed as `workspace.leave` through implicit local identity. Ordinary server-mode bearer credentials remain unsupported. A currently usable administrator credential is eligible under the administrator eligibility rule in [Core Permissions](../docs/core/permissions.md). Use Web Account for the ordinary session-based leave path.

Personal admin-token list and default selection are exposed as `token.my-admin-list` and `token.my-admin-default` through implicit local identity, and a currently usable administrator credential is eligible for them under the administrator eligibility rule in [Core Permissions](../docs/core/permissions.md). Both return redacted records and the effective default token ID. An ordinary server-mode bearer remains unsupported. Use Web **My admin access** for the ordinary session path.

Generic access-token creation and rotation are exposed as `token.create` and `token.rotate` with server-admin bearer authority in server mode and an explicit safe local `destination`. Named slots have separate keychain and encrypted fallback identities from the endpoint administration credential, with persisted backend selection to prevent stale reads after replacement, deletion or restart. Responses contain only redacted records, destination and storage metadata; normal authentication keeps using the endpoint credential. `skills/openkit-secrets.mjs` owns named preflight/write/read/delete and backend isolation. Run `node --test tests/openkit-skill-interface.test.mjs` after `pnpm build:openkit` to verify the source and regenerated executable together.

Conversation submission can forward the existing explicit retained Worker storage choice for new Task work. The public loop reference and Web Advanced settings share the same selection, authority and send-time admission rules; omitting the choice keeps the default new environment.

The migrated Kernel CLI entries derive their canonical ids, descriptions, input schemas and mutation posture from `KERNEL_OPERATION_DEFINITIONS`. Their handlers use `client.operations[id]`, reaching native invocation through the canonical JSON binding. The source catalog retains no old alias for those entries. Regenerate `openkit/scripts/openkit` with `pnpm build:openkit`; the interface tests exercise both the catalog and bundled executable. Other online operations keep their existing client projection until cutover.

## Operations Interface

The operations package contains its entrypoint, directly linked canonical operator references and any bounded support scripts required by an accepted operation owner. It works from outside the source checkout and can guide recovery while NanoCore is unavailable. Procedures name required host tools and explicitly acquire source when needed. Credentials and host authority come from the user's Agent environment, not the Skill. NanoCore/Web updates and separately authorized NanoHost work remain distinct.

## Maintenance And Packaging

Keep one maintained source per topic. `docs/manual/` points to the operations package; release packaging includes each complete Skill tree and license with matching checksums. Changes to supported behavior update the affected reference in the same slice. Skill metadata and package checks do not replace a real-use proof. Packaging of the public Skill tree continues until the remote MCP endpoint covers that Skill.

Worker-side MCP and Skill supply retain their Agent Capability and catalog owners. Neither package introduces the deleted user-facing stdio MCP server, and neither introduces a developer-mode product client, fleet, daemon or self-improvement harness. That stdio prohibition does not forbid the remote MCP endpoint named above.

Worker publication uses the selected Gateway vendor MCP. The Skill CLI does not acquire a worker App API tunnel or bearer credential.

`workspace.dashboard`, `thread.dashboard`, `conversation.navigation`, `app.search`, and `worker.list` use existing public Core Client reads. `worker.list` maps `listWorkspaceWorkers` through `client.app.listWorkspaceWorkers` for one Workspace id and is distinct from configured `agent.list`. NanoCore filters Thread and Artifact-origin visibility before discovery. A currently usable administrator credential is eligible for other users' private Threads and private-derived Artifacts under the administrator eligibility rule in [Core Permissions](../docs/core/permissions.md). Last-used Worker usage requires `audit.read` or is omitted as restricted. Public `thread.create` defaults to private; use explicit `visibility: workspace` when creating formal Task/Goal work.

Public Vault secret administration exposes `vault.secret-create`, `vault.secret-rotate`, `vault.secret-revoke`, `vault.grant-create`, and `vault.grant-revoke`. Creation and rotation consume secret stdin JSON. Validation failures for secret-input operations return a fixed error without request-derived schema issues, which may themselves contain secret keys or values. The public issuer creates an ordinary gateway-only grant with no capability target, and the selected MCP consumer accepts it under the existing authority check. A runtime-env `github-token` remains the separate user-space credential path. The accepted hosting target is described in the Vault and Worker MCP owners; local fixture checks do not establish live vendor acceptance.

`catalog.mcp-binding` carries optional Vault `credentialBindings` with `slot`, `vaultGrantId`, `sink` and optional raw/bearer `presentation`. A supplied array replaces the current bindings; omission preserves them. The CLI parser and HTTP operation share the App API schema, and NanoCore validates transport and destination rules before publication.

The public administration reference distinguishes current implementation diagnostics from the accepted catalog-only Git source target. Future Worker source selection uses a remote URL and pinned commit. Web and Skill use the same public configuration/reload operations; neither grants host privileges.

The ten Goal CLI operations derive from `GOAL_OPERATION_DEFINITIONS` and invoke `client.operations[id]`: `goal.create`, `goal.intent.revise`, `goal.card.create`, `goal.card.edit`, `goal.card.cancel`, `goal.plan.propose`, `goal.plan.approve`, `goal.cancel`, `goal.completion.accept`, and `goal.read`. Plan and completion decisions resolve exact shared Pending Requests; the Goal Coordinator consumes eligible grants and admits ordinary Tasks separately. The source catalog retains no old Goal aliases, steering, pause, resume, start or step operations.

The recovery reference explains normalized Git HTTP-refusal evidence from the existing Turn read surface: unavailable attribution remains explicit, and a new Task still requires current authority and cleanup/storage admission. It does not promise delegated policy writes or whole-service recovery.

Public native environment administration uses `runtime.agent-environment-read` and `runtime.agent-environment-update` through the existing revision-checked Core Client. These deployment-admin operations inspect admitted defaults and application status or edit ordinary overrides for later Turns; they do not expose host environment, credential values, or live process dumps.

`question.answer` and `pending-request.withdraw` project the existing Core pending-request commands with their protocol schemas. Answer or withdraw only with explicit direction from the responsible user or from the user of a currently usable administrator credential under the administrator eligibility rule in [Core Permissions](../docs/core/permissions.md). The recorded actor is the person who decided. A secret question cannot be answered. NanoCore owns response authority and later-Turn delivery.

`runtime.file-delete` projects deployment-admin Provider profile removal through `client.runtimeConfig.deleteFile`. It requires the exact file ID, `kind: provider` and current revision. Subscription account removal remains a separate operation. Both preserve configuration references; Provider activation follows the existing reload and restart workflow.

The Workspace, Thread and Turn JSON operations are derived from `OPERATION_DEFINITIONS`, including their strict inputs, output codecs and `client.operations[id]` handlers. Their settled CLI ids are unchanged; no handwritten catalog entries, old SDK method aliases or lower-fidelity Workspace list exclusion remain. Turn streaming remains a transport exclusion.

Knowledge CLI discovery and invocation derive all 19 Knowledge and four retained entry operations from the shared definition tables. Canonical dotted ids replace the former hyphenated CLI spellings without aliases; `knowledge.retrieval` retains its settled semantic id.

Artifact CLI discovery and execution derive the six entries from `ARTIFACT_OPERATION_DEFINITIONS`. `artifact.review-list` retains its settled semantic id; `artifact.review.decide` uses the existing domain command id instead of the former CLI spelling `artifact.review-decide`, with no alias.

The Conversation, Task, Attention and Pending Request CLI entries derive from the shared product tables. Semantic ids remain `question.answer` and `pending-request.withdraw`; durable command receipt spellings remain `user_input.answer` and `pending_request.withdraw`.

The NanoHost, backup and storage-report rows derive from the same composed table as product operations. Their access text is deployment-administrator authority; `strictShared` preserves complete input refinements and the generic client handler. NanoHost credential writes remain Core-owned exclusive sinks with redacted CLI and MCP results.

The four Automation, three Scheduler and two Recovery CLI entries derive from the composed product definitions and call `client.operations[id]`; their literal catalog rows are removed. Automation deletion returns logical JSON `null` after its bodyless HTTP 204 success. Recovery retry retains full Workspace, Thread, Turn and request lineage. Rebuild the bundled executable with `pnpm build:openkit`.

The three server-managed JSON transfer CLI operations derive from the Workspace transfer definition family and use `strictShared` input validation. The local-file archive download, dry-run and import paths retain their existing stream and file ownership rules.

All Kernel and Generative UI CLI entries derive from the shared operation tables through `strictShared`. Canonical dotted ids replace the former literal CLI spellings without aliases; rebuild the bundle with `pnpm build:openkit`.

All fifteen `sync.*` CLI entries derive their contracts and execution from the shared synchronization definitions, including strict inputs and header request identities. The hand-written synchronization catalog rows are removed.

The sixteen Workspace sharing and lifecycle operations derive their canonical IDs, complete strict inputs and `client.operations` handlers from the composed definitions. Invitation creation preserves secret stdin handling. Canonical-user invitation, leave and deleted-recovery operations accept the implicit local actor or a currently usable administrator bearer; ordinary Workspace bearers do not become session credentials. The old literal catalog rows and client method mappings are removed.

The eleven ordinary core commands and Quick Chat rows derive from `CORE_COMMAND_OPERATION_DEFINITIONS` through `strictShared` in `openkit-operations.mjs`. Their literal rows and former Core Client mappings are removed; `pnpm build:openkit` rebuilds the bundled CLI.
