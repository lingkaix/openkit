---
status: Accepted
implementation: Implemented
---
# Web Product Surface Projection

## Summary

The Web UI is an important OpenKit product surface, but it must be a projection of stable NanoCore contracts rather than the place where kernel semantics are invented.

Ordinary-user Web work projects every currently supported canonical-user or Workspace-authorized NanoCore operation through product workflows, with one explicit disposition for each included operation. Web must not become a raw API console, must not absorb Core semantics, and must not present a callable-but-not-release-ready capability as a working feature.

The superseded Web UI slice specs are retained as historical reference only. They may be mined for useful interaction details, but they do not define active product requirements.

## Owns

- The Web UI posture as a product surface over NanoCore and App API contracts.
- The ordinary-user inclusion rule over `PUBLIC_OPERATION_ACCESS`, generated App API OpenAPI, and `@openkit/core-client`.
- The closed `live`, `workflow`, and `roadmap` disposition vocabulary for every included operation, and the requirement for a complete disposition guard.
- The workflow-level projection rule that groups operations into product workflows instead of endpoint pages.
- The requirement that a callable included operation whose owning capability is not release-ready stays unpublished and names an existing Roadmap owner.
- The release-coupled Web account gate over the existing protected authorized-Workspace read, and the account-level **My invitations** projection over the existing sharing client.
- The release-coupled selected-Workspace **Repositories** projection, including its approval-response state boundary, consumed-record suppression, authoritative post-execution settlement, and Workspace navigation placement.
- The bounded deployment-admin **Configuration** projection over the existing runtime-config file, validation, revision, and reload contracts.
- The current implementation projection of the Web app.
- The status of older Web UI slice specs as historical reference.

## Does Not Own

- The `PUBLIC_OPERATION_ACCESS` catalog, App API route design, OpenAPI generation, protocol schemas, Core Client methods, storage tables, worker-control routes, or capability gateway semantics.
- Core workflow semantics, Goal Mode mechanisms, worker execution, AgentSessions, runtime placement, or scheduling.
- Knowledge Store governance, vault semantics, permission policy, audit storage, or workspace synchronization records.
- Whether a Core capability is release-ready. That remains with the owning Core document or specification and `docs/roadmap.md`.
- The per-operation disposition table bytes. The committed coverage check is the executable inventory; this specification owns the inclusion and disposition rules that check must project.
- Detailed Web UI interaction design, component architecture, copy, route structure, or visual design beyond the bounded Repositories placement defined below.
- Authentication, session, user, Workspace membership, invitation, authorization, or App API lifecycle and error semantics. Those remain owned by the identity, NanoCore config and identity, multi-user Workspace, permission, and Core Client contracts.
- Release readiness gates.
- The broader deployment-admin Web surface for health, Telemetry, server Audit, Policy decisions, secrets, providers, backup, and recovery owned by roadmap R048.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/architecture.md`
- `docs/core/identity.md`
- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/knowledge.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/vault.md`

## Goals

- Keep the Web UI subordinate to stable NanoCore behavior, not the starting point for kernel semantics.
- Project every included ordinary-user NanoCore operation through a reachable product workflow or an explicit `roadmap` disposition.
- Preserve useful historical UI details without keeping old slice specs active.
- Keep Web features traceable to App API, protocol, core docs, or active specs.
- Avoid UI-only concepts that bypass item-backed work history, Action Center, review, audit, or evidence records.
- Give deployment administrators direct visibility and a controlled manual escape hatch over authored runtime configuration while future Agent management uses the same NanoCore contract.

## Non-goals

- Do not treat superseded Web slice specs as accepted current UX requirements.
- Do not define detailed UI layouts, component APIs, visual design, or copy.
- Do not use Web UI work as the default starting point for new kernel semantics.
- Do not make Web UI route or state shape the canonical product model.
- Do not add a generic API console, operation-id catalog, or one published route per operation.
- Do not present a callable-but-not-release-ready capability as a working product feature.
- Do not fold deployment-admin, bootstrap, Gateway-actor, or Worker-private operations into the ordinary-user Web surface.
- Do not persist a server-admin bearer credential in browser storage or treat a valid Better Auth session as deployment-admin authority.

## Background

Earlier Web projection text described minimum product areas that would land as underlying contracts stabilized. The accepted ordinary-user intent is now completeness over the current public catalog: every in-scope operation receives a disposition, release-ready operations become truthful product workflows, and not-release-ready callables stay unpublished with a named Roadmap owner.

## Decision

Web is the product projection for every currently supported canonical-user or Workspace-authorized NanoCore operation. Page names and mockups are not the inventory authority. The included universe is the 139 `PUBLIC_OPERATION_ACCESS` entries whose scope is `user` or `workspace`, excluding the two Gateway-actor compatibility operations. That 139 equals the 186 catalog entries minus 45 server-scoped deployment-admin or bootstrap operations minus those two Gateway-actor operations.

One product workflow MAY project several operations. Web MUST consume existing Core and App API contracts through `@openkit/core-client` and MUST NOT invent runtime, Policy, Knowledge, Workspace Sync, portability, scheduling, or recovery semantics.

The four `listAutomations`, `createAutomation`, `updateAutomation`, and `deleteAutomation` operations remain unpublished. The current in-memory definition store is not a truthful recurring-workflow product, and roadmap R092 owns the real capability. `draftKnowledgeProposal` and `reverseKnowledgeProposal` also remain unpublished under R070 and R072 because ordinary-user reads cannot recover their exact candidate, accepted-review, and applied-page lineage after refresh or restart. The bounded Configuration editor implements only the runtime-config slice of R048; that roadmap item continues to own the broader deployment-admin Web surface.

## Contract / Expected Behavior

### Inclusion and exclusions

An ordinary-user Web operation is included when it is a `PUBLIC_OPERATION_ACCESS` key whose `scope` is `user` or `workspace` and whose `authentication` is not `gateway-actor`. The count of that set is 139. Inventory derivation MUST use `PUBLIC_OPERATION_ACCESS` together with generated App API OpenAPI and `@openkit/core-client`; it MUST NOT use screen titles as the source list.

The following are excluded from ordinary-user Web and MUST NOT appear on a published ordinary-user route:

- Server-scoped catalog operations, including deployment-admin and bootstrap-secret authentication, currently 45 keys. Roadmap R048 owns their future separate admin surface.
- Gateway-actor operations `POST /v1/chat/completions` and `POST /v1/responses`.
- Worker-private routes that are not public catalog operations, including `/api/worker-control/*`.

Better Auth sign-in, sign-up, and sign-out plus `GET /api/meta` are already-live admission and connection plumbing. They remain acceptance prerequisites and MAY be called from ordinary Web, but they are not catalog operations and do not receive `live` / `workflow` / `roadmap` dispositions.

### Authority and projection boundary

This specification owns Web inclusion, disposition vocabulary, workflow grouping, and ordinary-user publication rules. NanoCore owns the catalog and route behavior. `@openkit/core-client` owns typed client methods. Owning Core documents and specifications own product semantics. `docs/roadmap.md` owns not-yet-release-ready outcomes. Web routes, local component state, UI-only filters, and browser storage remain presentation projections, not canonical product records.

Live and workflow dispositions MUST consume the composed Core Client. A missing typed client method is a Core Client gap that blocks `live` or `workflow` until that package owns the method. Web MUST NOT bypass the composed client with a parallel HTTP helper.

### Workflow-level projection

Web MUST project included operations through product workflows such as account and sharing, conversation, Goal, Material, Action Center, Knowledge, repositories, Workspace Sync review-to-apply, portability, agents and recovery, and Workspace-authorized settings.

A workflow MAY satisfy several operations when each operation's user-visible behavior, authoritative state, or named supporting read is reachable through that workflow. The coverage check records that mapping. Web MUST NOT add a generic operation runner, an operation-id index as a product destination, or a dedicated published page whose only purpose is to expose one catalog key.

Conversation surfaces expose only continuing the current Thread or creating a new Thread. AgentSession is a hidden runtime-continuity item and MUST NOT appear in Web or ordinary App API as a picker, creation or restart action, navigation object, identifier, history, active-session object, or native handle.

### Disposition lifecycle

Every included operation MUST have exactly one of the following dispositions:

- `live`: a published Tier-A product control or exact Core Client call on a reachable ordinary-user surface.
- `workflow`: no dedicated control, but a named published workflow already projects the operation's user-visible behavior or authoritative state.
- `roadmap`: the endpoint is callable and in-scope, but the owning capability is not release-ready as a truthful product feature. The gap stays unpublished and MUST name an existing Roadmap item.

The disposition guard is inventory and admission evidence. It MUST prove inclusion of the 139-operation set, uniqueness of each key's disposition, closed disposition shape, and that a `live` or `workflow` disposition names a surface that is currently Tier A. It cannot by itself detect a false workflow behavior claim.

Creation: when the included catalog gains a key, the disposition guard MUST fail until exactly one disposition is recorded. Update: shipping a truthful published projection moves `roadmap` to `live` or `workflow`. Termination: when a key leaves the included set, its disposition MUST be removed; leftover dispositions MUST fail the guard. Retry of a Core operation follows that operation's existing Core and client error contract. Dispositions are repository artifacts and have no session retry of their own. Recovery of a false `live` or `workflow` behavior claim is not a guard verdict: focused UI tests plus independent review of the actual diff decide whether the named workflow is reachable and truthful, and a false claim MUST NOT become silent repair or a browser-owned success.

Conflict: two dispositions for one included key MUST fail the guard. Missing: an included key with no disposition MUST fail the guard. Stale admission: a `live` or `workflow` disposition whose named surface is not currently Tier A MUST fail the guard. Restart: UI restart MUST reread Core truth and MUST NOT reconstruct workflow state from browser storage. Dependency failure: a not-release-ready owning capability MUST use `roadmap` rather than a fake working UI; Automations use R092, Knowledge proposal drafting uses R070, and Knowledge proposal reversal uses R072 for this reason.

A `roadmap` disposition MUST name an existing item in `docs/roadmap.md`. Web MUST NOT invent a new Roadmap item inside this specification.

### Truthful unpublished capability

A callable included operation whose owning capability is not release-ready MUST NOT be presented as a working feature. Its exact gap remains unpublished. Automations stay unpublished while they only persist in-memory definitions and do not operate recurring work; R092 remains the owner. Knowledge proposal drafting and reversal stay unpublished until ordinary-user reads can recover the exact candidate and accepted application lineage after restart; R070 and R072 remain their owners. Channels and Generative UI remain unpublished internal review shells because they have no included catalog operations to project.

No published ordinary-user route MAY call a server-scoped API or require a deployment-admin token. General Settings MUST NOT call deployment diagnostics or runtime-config routes. The distinct `/settings/configuration` deployment-admin route MAY call only `client.runtimeConfig` and MUST first use the current client so local mode remains credential-free; after a typed `401` or `403`, it MAY accept one explicit `server-admin` bearer token for the lifetime of the mounted page. That token MUST remain only in the Core Client transport held in React component memory and MUST NOT enter TanStack Query keys or data, Zustand, browser storage, routes, logs, rendered values, diagnostics, or error copy. Provider-subscription administration remains off the ordinary-user surface under R048.

### Deployment Configuration Projection

The published Tier-A **Configuration** screen is a separately authorized deployment-admin workflow inside the Settings shell. It lists the existing runtime-config documents as one relative-path tree, reads one exact JSONC source at a time, preserves comments and formatting while editing, validates the complete draft through `client.runtimeConfig.validate`, and writes the complete source through `client.runtimeConfig.updateFile` with the exact last-read revision. A conflict keeps the local draft and requires an explicit reload; Web MUST NOT overwrite, merge, or claim success.

Saving changes only the authored file. Applying saved configuration is a separate explicit `client.runtimeConfig.reload({ mode: "safe" })` action, and Web projects the returned applied, deferred, restart-required, rejected, warning, and runtime-version truth without inventing hot-reload success. The screen does not expose arbitrary filesystem paths, create unsupported file kinds, or bypass the NanoCore file allowlist and schema boundary.

The tree contains exactly the existing files NanoCore returns: server, Provider, Agent, Workspace, and data-source documents. Policy-bearing settings remain visible in their current owning documents. Web MUST NOT fabricate a standalone Policy file until an accepted Policy owner gives that file a current runtime consumer, schema, lifecycle, and enforcement semantics. Future Agent-authored configuration uses the same runtime-config routes rather than a hidden parallel management path.

### Observable acceptance

Acceptance of this completeness contract requires all of the following:

- A committed coverage check accounts for every included catalog operation and fails when an operation is added, removed, or reclassified without exactly one valid Web disposition, or when a `live` or `workflow` disposition names a surface that is not currently Tier A.
- Every `live` or `workflow` operation has a reachable, accessible published projection with truthful loading, empty, denied, failure, stale, success, and retry behavior where that operation can produce those states. Focused UI tests plus independent review of the actual diff decide that reachable truthful behavior. The guard is necessary inventory and admission evidence and is not that behavior verdict.
- No published ordinary-user route calls a server-scoped API or requires a deployment-admin token; the separately gated Configuration route is excluded from the ordinary-user operation inventory and calls only the accepted runtime-config admin client.
- Every `roadmap` disposition names an existing Roadmap item. Automations name R092, Knowledge proposal drafting names R070, and Knowledge proposal reversal names R072. Server-scoped operations are excluded rather than given ordinary-user dispositions, and R048 remains their Web owner.
- Current Implementation Projection MUST NOT claim a missing UI is implemented.

The disposition guard is necessary inventory and admission evidence and is not sufficient for acceptance. A green guard without focused UI tests and actual-diff independent review for each `live` and `workflow` claim is not acceptance.

## Projection Contract

The Web UI should expose the same product semantics already proven through NanoCore and agent-facing public APIs, grouped into workflows rather than raw routes:

- workspace, repository, and source readiness
- thread and item history
- Agent Workflow surfaces such as Goal Mode plan, step, review, steering, redo, handoff, and closeout state
- Action Center rows and the decisions those rows already authorize
- artifact inventory, content, import, introduction, and review
- workspace synchronization reviews and apply results
- Knowledge Store pages, proposals, source references, ledger records, retrieval, and Knowledge Manager actions
- Agent catalog, health refresh, interrupted-worker recovery, and scheduler admission actions
- Workspace-authorized audit, permission, vault, metering, usage, evidence, and redacted Agent Environment Package readback
- Workspace export, import dry-run, import, and vault-reference rebind

Product surfaces may group, filter, summarize, or visualize these records, but the underlying source of truth remains NanoCore state and App API responses. Included operations that are not yet release-ready stay on `roadmap` dispositions instead of appearing as working UI.

Authorized operator diagnostics may project redacted runtime lineage through a separately protected diagnostic surface owned by R048, but that lineage is not a conversation action and cannot be used to choose or replace AgentSession.

## Account Gate And My Invitations Projection

This section owns only the release-coupled Web behavior that composes existing authentication and sharing contracts. It does not redefine their identity, session, membership, invitation, authorization, route, or error semantics.

At application bootstrap and every account-state refetch, Web calls the existing protected `client.app.listAuthorizedWorkspaces()` read. Any successful response enters the product, including an empty authorized-Workspace list. Only an `ApiCallError` with HTTP `401` and code `core.auth.unauthenticated` opens the account gate. Network failures, malformed responses, every other HTTP status, and every other error code remain failures with retry; Web must not translate them to unauthenticated or create a browser-owned session fact.

The account gate offers the existing email/password sign-in and sign-up operations without claiming whether sign-up is enabled. Web must not read `server.mode`, call setup or deployment-administrator diagnostics for account admission, infer `auth.signup.enabled`, invent a deployment or server label, expose host internals, or derive authentication state from capability shape or error text. Account copy states only what the protected read proves: authentication is required, the product is available, or the read failed.

After successful sign-in or sign-up, Web refetches `listAuthorizedWorkspaces()` and enters the product only when that protected read succeeds. After sign-out, Web refetches the same read and opens the account gate only after the typed `401 core.auth.unauthenticated` result; a different result remains its actual success or failure. An auth failure retains no password and creates no browser-owned session truth. Exact email and password values remain live-form/request inputs only; neither may enter TanStack Query data, Zustand, browser storage, logs, status text, or errors.

Authenticated **My invitations** is an account-level destination and remains reachable without a selected Workspace or active Workspace membership. It reads `client.app.listMyWorkspaceInvitations()` directly rather than deriving invitations from the authorized-Workspace list. Pending rows offer the existing accept and decline operations with their exact revision; accepted, declined, revoked, and expired rows are terminal read-only projections. Workspace-owner member and invitation administration remains a separate selected-Workspace surface, and self-leave remains a separate membership action.

My invitations preserves the sharing owner's typed outcomes. `invitation_not_pending` and invitation `revision_conflict` replace the affected row with the returned safe current invitation. `workspace_access_denied`, `idempotency_key_conflict`, and `recovery_required` remain typed failures and trigger a refetch before any new-request retry; Web does not infer membership, repeat an uncertain mutation, or synthesize success. Returned invitation rows, status and terminal copy, error projections, durable identifiers, stored client state, and logs must never contain an email address. An exact email may exist transiently only in an explicit auth or invitation input and its immediate request; email is neither a credential nor a secret role and must not be presented as one.

## Repositories Projection Contract

- **Definition and authority:** The live Tier-A board-19 **Repositories** screen projects selected-Workspace repository resources, diagnostics, default-repository setup, durable push records, and the existing approval-gated Git push workflow through `client.repositories`. It requests approval for one exact repository/ref/commit target and owns only the Web projection; Git, approval, policy, repository-lifecycle, API, and external-effect semantics remain with their existing owners.
- **Consumed-record lifecycle:** A terminal `GitPushRecord` consumes the current granted approval only when Workspace, repository, approval Item, policy decision, source ref, target branch, and the exact ordered commit cardinality and content all match. That match suppresses both the Execute affordance and its handler. When the current approval response is granted and matches the selected Workspace, repository, and frozen request, no terminal record or any materially nonmatching listed record leaves only that granted positive execution path available; a nonmatching listed record is not consumption or recovery by itself.
- **Authoritative settlement and failures:** After execution, Web must read the exact authoritative `GitPushRecord` before presenting success. A matching same-id authoritative record replaces stale list bytes at that row's existing index; when the matching record is absent from the refetched list, Web inserts it exactly at the head. Settlement never reorders the other rows or duplicates the id. A materially mismatching authoritative response preserves the refetched list, presents recovery-required state, and hides Execute. A missing or failed authoritative read retains the existing typed failure and recovery semantics and cannot become success. Neither approval nor execution is replayed automatically, including after remount or restart.
- **Navigation and server state:** After successful Workspace discovery validates the selected Workspace, Repositories appears once under a Workspace navigation section labeled with that Workspace's authoritative name and never as global primary navigation; without a validated Workspace, that nested destination is absent. TanStack mutation data is the sole server-state owner for the current approval response; React state, Zustand, browser storage, and list-row inference must not copy or reconstruct it.
- **Exclusions and acceptance:** Worker-proposed-file Workspace Sync review-to-apply is not part of the Repositories surface. Those operations remain in the ordinary-user inclusion set and MUST receive a `live`, `workflow`, or `roadmap` disposition under this specification; Core review and apply semantics remain owned by `docs/specs/20260703-workspace_synchronization.md`. Default-repository setup is a selected-Workspace control that validates one repository path, preserves failed input, and rereads the authoritative repository projection before presenting success. The missing full collapsible Workspace/thread tree is not authorized by this Repositories contract. Observable acceptance of this screen requires exact-tuple positive and negative cases, matching-terminal suppression at both UI and handler boundaries, authoritative-read-before-success, same-id replacement at its existing index or exactly-at-head insertion when absent, mismatch recovery with the refetched list preserved, selected-Workspace-only navigation, one TanStack approval-response owner, and zero automatic replay. This contract does not assert browser proof or execution of a real external push.

## Current Implementation Projection

The current Web implementation is a React and Vite SPA whose route catalog, app shell, and sidebar project NanoCore state through `@openkit/core-client`. TanStack Query owns server-state access, while Zustand remains limited to UI-only state. Implementation is `Implemented` against this completeness contract: all 139 included operations have valid dispositions, every release-ready operation has a reachable product projection, and only the six explicitly not-release-ready operations remain unpublished under their accepted Roadmap owners.

- Live surfaces currently cover Workspace overview and Action Center rows, Chat and Task Threads, Goal planning and steering, Artifact Review, Artifact inventory/import/introduction, Knowledge page CRUD and the release-ready Knowledge Manager workflows, Agent catalog/detail/health, recovery and scheduler admission, Workspace Sync review-to-apply and recovery evidence, user-scoped import plus project-Workspace portability, first-run and Workspace creation, appearance and Workspace-authorized general settings, the Settings Debug component catalog and inspection reads, and selected-Workspace Usage and audit reads.
- Goal plan approval and revision, steering input, Artifact Review decisions, Knowledge creation, Workspace creation, and Workspace rename use current Core Client operations. The selected Workspace navigation exposes a direct Workspace settings entry, and failed mutations preserve the last authoritative server projection rather than creating browser-owned workflow truth.
- General Settings never calls deployment diagnostics or runtime-config routes. The AI interface remains an internal unpublished review screen because provider-subscription routes require server-admin credentials and Web has no accepted server-admin credential path; roadmap R048 owns the future separate deployment-admin surface.
- Automations remain unpublished because the current API owns in-memory definition CRUD and does not execute recurring work; publishing that screen as an operating automation feature would be false, and R092 owns the real capability. Channels remain an internal unpublished review screen, and Generative UI remains an internal unpublished render shell. They are absent from Web navigation and routing, do not imply kernel support, and create no product truth.
- The live Tier-A board-19 **Repositories** screen currently projects selected-Workspace repository resources, diagnostics, default-repository setup, durable push records, and the existing approval-gated Git push workflow through `client.repositories`. Its consumed-record tuple and authoritative settlement behavior are implemented; navigation places it exactly once under the validated Workspace's authoritative name, and TanStack mutation data is the sole server-state owner for the current approval response.
- The live Tier-A board-17 **Usage & audit** screen currently projects selected-Workspace `client.app.getCapabilityUsage()`, `client.app.listWorkspaceAuditEvents()`, and `client.app.listWorkspacePermissionDecisions()`. Settings Debug projects Workspace evidence-bundle and runtime-evidence reads plus Agent Environment Package snapshots. Neither surface calls or projects `client.app.listServerAuditEvents()`; deployment-admin server audit remains excluded under R048.
- The current ordinary Workspace Vault screen reads references, grants, injection plans, injection receipts, and use records for the selected Workspace. Project-Workspace rebind is projected by Portability with ephemeral credential handling and independent confirmation. Neither surface requests or projects deployment-admin backend status.
- The live Tier-A Configuration screen projects the existing runtime-config file tree, exact JSONC read and edit, server validation diagnostics, optimistic revision save, and explicit safe reload. Local mode uses its implicit authority; server mode accepts a `server-admin` token only after the current Better Auth session is denied and keeps that credential only in mounted component memory.
- The disposition guard accounts for all 139 included operations. The four Automation CRUD operations remain unpublished under R092 because the current backend does not execute recurring work. `draftKnowledgeProposal` and `reverseKnowledgeProposal` remain unpublished under R070 and R072 because the ordinary-user API cannot reread the exact candidate or reversal authority after restart. No other included operation remains roadmap-only.
- Action Center currently lists unified attention rows and inline-decides only approval grant or deny and Artifact Review accept or request-refinement. Other row kinds that the read model already returns are not claimed as fully executable from Overview.
- Focused Vitest coverage and the L4 Playwright entrypoint exercise the Web package. Real-worker and restart proofs remain at their owning process boundaries and do not imply browser coverage.
- The bounded live Work Resource Class 1 route implements Material identity, creation, authoring, immutable revisions, client-side comparison, Thread binding, inclusion and queue state, active-turn delivery, and worker proposal review. Selected-Workspace owner member administration, owner-issued invitation administration, the membership-independent account-level My invitations direct read with pending accept and decline decisions plus terminal rows, and selected active non-owner self-leave are focused-test-backed implementations through the existing Account route and the isolated server-mode browser journey; real-use and program-exit proof remain pending.
- Work Resource Class 2 and Work Resource Class 3 resources, grounded annotation, text-range patching, and generalized locator controls remain deferred under their owning specification and are not implied by the 139-operation catalog. The React app remains a projection and is not the canonical source of Core semantics.

## Alternatives Considered

A raw API console or operation-id catalog was rejected because it would make Web a second route browser rather than a product projection. One published page per operation was rejected for the same reason. Leaving the previous "exactly these reads" ceilings as accepted scope was rejected because those ceilings contradicted ordinary-user completeness. Publishing Automations from the current in-memory definition store was rejected as a false recurring-workflow product; R092 remains the owner. Treating an ordinary Better Auth session as deployment-admin authority was rejected; the bounded Configuration screen remains an explicitly credentialed admin workflow, and R048 retains the broader administration outcome.

## Consequences

The coverage check, not this document's prose, is the per-operation inventory and Tier-A admission evidence. This specification is `Implemented` because every included operation has a valid disposition and every `live` or `workflow` claim has reachable truthful UI backed by focused tests and independent actual-diff review. Later Web slices may publish a roadmap operation only after its owning capability becomes release-ready; they do not add kernel semantics or a generic renderer.

## Testing Strategy / Acceptance Criteria

- The committed disposition guard MUST enumerate the included 139-operation set from `PUBLIC_OPERATION_ACCESS` after excluding server scope and Gateway-actor keys, and MUST fail on a missing disposition, a duplicate disposition, a disposition outside the closed `live` / `workflow` / `roadmap` shape, or a `live` or `workflow` disposition whose named surface is not currently Tier A.
- Adding a new in-scope catalog operation without a Web disposition MUST fail that guard before the corresponding UI slice is accepted.
- Focused Web tests plus independent review of the actual diff MUST decide whether each `live` or `workflow` claim is reachable and truthful, including loading, empty, denied, failure, stale, success, and retry states that the workflow can actually produce, using Core Client calls rather than invented oracles. The guard MUST NOT be treated as that behavior verdict.
- Package checks MUST show that no published ordinary-user route calls a server-scoped API or requires a deployment-admin token, and focused Configuration checks MUST prove its distinct denied credential gate, in-memory-only token handling, file-tree read, validation, revision-protected save, and explicit safe reload.
- Automations MUST remain unpublished in routing and navigation while R092 owns the real capability.
- This specification's Current Implementation Projection MUST remain reconcilable with the actual Web diff, including the six deliberately unpublished roadmap operations.

## Resolved Decisions

- Web UI work follows stable NanoCore, App API, protocol, and core docs.
- Ordinary-user Web completeness is catalog-derived: 139 included operations, each with exactly one `live`, `workflow`, or `roadmap` disposition.
- Superseded Web UI slice specs are historical references, not active requirements.
- Web-specific read models may exist, but they must be traceable to canonical workspace, thread, turn, item, artifact, knowledge, review, audit, permission, vault, agent, and runtime records.
- Web UI must not expose backend-private runtime state, raw secrets, raw OpenShell internals, or hidden agent-private task graphs as normal product concepts.
- Web and ordinary App API MUST NOT expose AgentSession identity, history, selection, creation, or restart; conversation behavior is continue Thread or create Thread.
- New user-facing Web behavior that requires kernel semantics must first update the relevant protocol, NanoCore, core doc, or spec contract.
- Automations stay unpublished under R092 until a truthful recurring-workflow product exists.
- Deployment-admin Web remains separately authorized; the Configuration slice is live and R048 retains the broader administration surface.

## Deferred / Future Work

- Publish a roadmap disposition only after its owning capability becomes release-ready and the same guard, focused-test, and independent-review requirements are satisfied.
- Refine navigation, including the collapsible Workspace and Thread tree owned as a workbench outcome by R044, without making route shape canonical.
- Keep Automations unpublished until R092's recurring-workflow product exists.
- Complete the remaining R048 deployment-admin workflows without widening the bounded Configuration route into an ordinary-user API console.
- Mine superseded Web specs for useful interaction details during bounded design work for genuinely missing Web surfaces.
- Work Resource Class 2 and Class 3, grounded annotation, and locator controls remain with `docs/specs/20260713-work_resource_interaction_model.md`.

## Superseded Web Specs

The previous Web UI MVP slice specs have been moved under `docs/specs/retired/web-ui-pre-rebuild/` because the old module was deliberately removed and the current product surface is a clean-slate rebuild rather than a contract-preserving successor.

They are retained to recover useful copy, interaction details, and edge-case notes during future Web product work, but they no longer represent active release gates.

## Links

- [Work Model](../core/work-model.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Core Architecture](../core/architecture.md)
- [Knowledge Model](../core/knowledge.md)
- [Agent Capability](../core/agent-capability.md)
- [Core Client Boundary](./20260528-core_client_boundary.md)
- [App API OpenAPI Projection](./20260704-app_api_openapi_projection.md)
- [Audit, Usage, And Evidence Records](./20260703-audit_usage_evidence_records.md)
- [Single-Deployment Multi-User Workspace System](./20260715-multi_user_workspace_system.md)
- [Human Attention Intervention Model](./20260531-human_attention_intervention_model.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
- [Provider Subscription Accounts](./20260721-provider_subscription_accounts.md)
- [Workspace Synchronization](./20260703-workspace_synchronization.md)
- [Workspace Backup, Export, And Import](./20260704-workspace_backup_export_import.md)
- [Work Resource Interaction Model](./20260713-work_resource_interaction_model.md)
- [Product Roadmap](../roadmap.md)
