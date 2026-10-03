# @openkit/core-client

Thread dashboard reads validate the authenticated viewer id and bounded participant display names alongside existing work state; no separate user-directory request is needed for conversation attribution.

The same dashboard preserves NanoCore's verified `taskInputs` objective summaries for Web and Skill consumers; the client does not infer summaries from message JSON.

`client.operations` exposes the ten Goal definitions with strict input and output codecs and automatic missing request-id insertion. `goal.read` returns current intent and cards, exact proposed and active Plan versions, shared request state and claim, linked ordinary Tasks and disposition. Human decision operations resolve exact Pending Requests; grant consumption belongs to the Goal owner and does not launch work. Retired Goal SDK methods and routes have no aliases.

`@openkit/core-client` is the composed typed HTTP and SSE client used by the SPA and protocol integration tests.

The package owns transport, request-id insertion, response validation, capability helpers, and turn-event iteration.

`client.operations['approval.respond']`, `client.operations['question.answer']`, and `client.operations['pending-request.withdraw']` submit request-identified pending-request commands. The commands use the definition-derived JSON routes; clients do not resubmit the raising Turn to obtain an outcome.

It does not own NanoCore App API schemas.

Core protocol payloads come from `@openkit/protocol`.

NanoCore App API payloads come from `@openkit/app-api-schemas`.

## Implementation Entry Points

[`src/transport.ts`](src/transport.ts) owns HTTP request construction, configured headers, cookie credentials, and response validation through [`src/http.ts`](src/http.ts). JSON POST, PUT, and PATCH operations share that wire policy; stream and empty-response operations retain their distinct semantics. [`src/transport.test.ts`](src/transport.test.ts) checks the wire boundary and failure propagation without a live server.

[`src/request-id.ts`](src/request-id.ts) owns missing request identity insertion. Sub-clients use `withRequestId` for body-carried command identities; explicit header-carried identities remain at the routes that own that contract.

[`src/events.ts`](src/events.ts) shares event URL construction between Fetch and EventSource while each transport retains its own streaming, cursor, and reconnect lifecycle.

[`src/operations.ts`](src/operations.ts) derives `client.operations[id](input)` from the composed shared operation tables, including request-id insertion, canonical JSON POST placement and output validation. Migrated Workspace, Thread, Turn and Goal operations have no `client.core` or `client.app` method or old route alias. `workspace.list({})` returns authorized summaries; select `entry.workspace` when a consumer needs a Workspace record. Thread creation accepts one object containing `workspaceId`, `name`, optional `visibility`, and optional `requestId`. Turn events retain their SSE transport. The mapped client type preserves each operation's input and result rather than a family-wide union. Run `pnpm --filter @openkit/core-client exec vitest run src/operations.test.ts` for this transport boundary; package typecheck also compiles the negative join probes.

## Client Shape

- `client.core`: Core protocol routes and turn SSE.
- `client.app`: dashboards, diagnostics, setup diagnostics, bootstrap-token consumption, OpenKit access-token administration including cross-user ownership plus session-user redacted admin Token inventory and default selection, vault admin status/unlock/lock/Codex auth JSON bootstrap and authored provider API-key store or replacement, authorized workspace discovery, workspace membership and invitation lifecycle, bounded access recovery, canonical user disable, owner-confirmed Workspace deletion and tombstone recovery, raw portable archive download, dry-run, and import streams, Workspace Material reads and mutations, workspace vault reference discovery and re-binding, capability usage evidence, server and workspace audit events, search, quick chat, durable Workspace Sync Review decisions, redacted Agent Environment Package snapshot readback, and feedback.
- `client.app` also exposes current-administrator Worker environment list, select, prepare, activate, status, and purge methods plus the private administration conversation entry. The client validates every payload and keeps the path and body storage reference identical for destructive purge.
- `client.runtimeConfig`: runtime config editor and reload routes.
- `client.providerSubscriptions`: fixed provider inventory plus provider-scoped account, device-code login, logout, quota, and auto-top-up routes. Quota and auto-top-up omit missing percentages and monetary fields rather than inferring zero; a successful quota with no percentage is Provider did not report usage.
- `client.auth.email`: Better Auth email sign-up, sign-in, and sign-out routes.
- `client.capabilities`: `refresh`, `snapshot`, `supports`, and `require` helpers over `/api/meta`.
- `client.agents`: Agent Catalog list, detail, and health refresh routes.
- `client.operations['attention.list']`: definition-derived unified Human Attention read model with one selector object.

`parseWorkspaceSharingError(error)` narrows a generic `ApiCallError` only when it validates as the closed Workspace sharing error family.

Deprecated flat aliases are not exported.

`client.app.prepareAppUpdate`, `startAppUpdate` and `getAppUpdateStatus` project the deployment-admin App-update contract. Keep the host-assigned request ID before starting; an uncertain response requires status for that ID, not a new update. The client does not perform host effects or infer completion from a successful HTTP submission.

`client.catalog.updateMcpBinding` sends optional Vault credential bindings through the existing Workspace binding operation. A supplied array replaces those bindings, including an empty array to clear them; omission preserves current credentials for policy-only updates. Input and response types remain derived from the shared App API schemas.

## Commands

- `pnpm --filter @openkit/core-client test`
- `pnpm --filter @openkit/core-client typecheck`
- `pnpm --filter @openkit/core-client lint`
- `pnpm --filter @openkit/core-client build`

`client.app.applyAdministrationConfiguration` submits a human-confirmed immutable catalog candidate; its response distinguishes persisted configuration from successful reload and restart requirements.

`client.app.createWorkspaceVaultSecret`, `rotateWorkspaceVaultSecret`, `revokeWorkspaceVaultSecret`, `createWorkspaceVaultGrant`, and `revokeWorkspaceVaultGrant` project deployment-admin workspace secret management. Secret material appears only in POST request bodies; result schemas contain metadata only.

`client.operations['conversation.navigation']` validates the selected-Workspace conversation activity projection; NanoCore owns ordering, current activity classification, and viewer-relative attention.

`client.app.listWorkspaceWorkers` reads the selected-Workspace current Worker projection, including exact recorded work and separately labeled package preference and last-used model. NanoCore owns Thread visibility and the additional audit permission for usage; the client validates the response without joining records or exposing hidden runtime identity.

## Native Environment Administration

`client.runtimeConfig.getAgentNativeEnvironment(fileId)` reads the private administration projection; `updateAgentNativeEnvironment` sends literal overrides/removals with the existing file revision and exact image/default identities. Both validate the shared App API contract. Persisted, reloaded and acknowledged native state remain separate; an edit applies to later Turns through a successor.

The private native environment configuration client discards inert additive response metadata, including nested status and environment identities, through the shared App API readers before returning the owned core.

`runtimeConfig.deleteFile` sends the strict Provider deletion command through the existing JSON DELETE transport. It requires an exact Provider file ID and existing revision and accepts the empty successful response. NanoCore owns revocation and restart-required activation.

`client.app.getCapabilityUsage` preserves the Workspace-authorized redacted `routeLineage` projection from the shared App schema. The Skill `usage.read` operation returns that same reader result without rebuilding private Provider lineage.

Knowledge reads, Sources, maintenance ledgers, retrieval, preparation, proposals and the four retained entry operations use `client.operations` derived from the two Knowledge definition tables. The `client.app` and `client.core` handwritten Knowledge methods are removed. Caller argument types preserve schema defaults, and command request identities travel in `x-openkit-request-id`; trace-only retrieval and preparation require no command identity. Deletion returns the definition’s JSON `null` success.

The six Artifact operations use `client.operations` with one selector-and-payload object. Artifact list/read response types derive from those definitions; hand-written Core and App Artifact methods are deleted. Request identities use the definition-derived header binding.

Conversation discovery/submission, Task start, human attention and Pending Request decisions use `client.operations` with one selector object. The former App/Core/Action Center methods and Action Center sub-client are removed.

NanoHost administration, deployment backup and layout inspection use `client.operations[id]` with logical selector objects. Enrollment, issue and rotation return only redacted metadata while NanoCore writes the configured exclusive credential sink. `backup.create({})`, `backup.verify({ backupId })` and `storage.layout-report({})` retain server-managed local handles and deployment-administrator admission.

Automation, Scheduler and Recovery use nine definition-derived `client.operations` methods with complete selector objects. Recovery retry carries Workspace, Thread, Turn and request identities. A declared empty success requires HTTP 204 with zero response bytes and maps to the output schema’s logical `null`; a different successful status or exposed bytes raise `ProtocolValidationError`; API failures still use `ApiCallError`, and other JSON responses retain schema validation. The old App methods are removed.

Server-managed JSON transfer uses `client.operations['workspace.export']({ workspaceId })`, `client.operations['workspace.import-dry-run']({ sourceWorkspaceId, exportId })`, and `client.operations['workspace.import']({ sourceWorkspaceId, exportId, requestId })`. The shared operation client preserves an explicit request id and generates one when omitted. Binary archive methods remain under `client.app`.
