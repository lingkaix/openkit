---
status: Accepted
implementation: Partial
---
# Web Product Surface Projection

## Summary

The Web UI is an important OpenKit product surface, but it must be a projection of stable NanoCore contracts rather than the place where kernel semantics are invented.

The Web UI should be built against stable NanoCore App API, protocol schemas, Agent Workflow, Action Center, workspace synchronization review/apply, Knowledge Store, permission, audit, vault, agent capability, runtime placement, and evidence contracts.

The superseded Web UI slice specs are retained as historical reference only. They may be mined for useful interaction details, but they do not define active product requirements.

## Owns

- The Web UI posture as a product surface over NanoCore and App API contracts.
- The minimum product areas future Web work must project when the underlying contracts stabilize.
- The boundary between user-facing Web presentation and core runtime, workflow, storage, permission, capability, and knowledge semantics.
- The release-coupled Web account gate over the existing protected authorized-Workspace read, and the account-level **My invitations** projection over the existing sharing client.
- The release-coupled selected-Workspace **Repositories** projection, including its approval-response state boundary, consumed-record suppression, authoritative post-execution settlement, and Workspace navigation placement.
- The current implementation projection of the Web app.
- The status of older Web UI slice specs as historical reference.

## Does Not Own

- Core workflow semantics, Goal Mode mechanisms, worker execution, AgentSessions, runtime placement, or scheduling.
- App API route design, protocol schemas, storage tables, worker-control routes, or capability gateway semantics.
- Knowledge Store governance, vault semantics, permission policy, audit storage, or workspace synchronization records.
- Detailed Web UI interaction design, component architecture, copy, route structure, or visual design beyond the bounded Repositories placement defined below.
- Authentication, session, user, Workspace membership, invitation, authorization, or App API lifecycle and error semantics. Those remain owned by the identity, NanoCore config and identity, multi-user Workspace, permission, and Core Client contracts.
- Release readiness gates.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/architecture.md`
- `docs/core/identity.md`
- `docs/core/agent-capability.md`
- `docs/core/knowledge.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/vault.md`

## Goals

- Keep the Web UI subordinate to stable NanoCore behavior, not the starting point for kernel semantics.
- Preserve useful historical UI details without keeping old slice specs active.
- Define the minimum contract-backed product areas for future Web UI planning.
- Keep Web features traceable to App API, protocol, core docs, or active specs.
- Avoid UI-only concepts that bypass item-backed work history, Action Center, review, audit, or evidence records.

## Non-goals

- Do not treat superseded Web slice specs as accepted current UX requirements.
- Do not define detailed UI layouts, component APIs, visual design, or copy.
- Do not use Web UI work as the default starting point for new kernel semantics.
- Do not make Web UI route or state shape the canonical product model.

## Projection Contract

The Web UI should expose the same product semantics already proven through NanoCore and agent-facing public APIs:

- workspace, repository, and source readiness
- thread and item history
- Agent Workflow surfaces such as Goal Mode plan, step, review, steering, redo, handoff, and closeout state
- Action Center rows
- artifact and evidence review
- workspace synchronization reviews and apply results
- Knowledge Store pages, proposals, source references, and context-package traces
- Agent catalog, setup readiness, product-safe runtime availability, worker readiness, and redacted operator diagnostics
- audit, permission, vault, metering, and usage views as those contracts stabilize
- provider, LLM gateway, MCP, Skill, and agent capability diagnostics

Product surfaces may group, filter, summarize, or visualize these records, but the underlying source of truth remains NanoCore state and App API responses. Web routes, local component state, UI-only filters, and browser storage are presentation projections, not canonical product records.

Conversation surfaces expose only continuing the current Thread or creating a new Thread. AgentSession is a hidden runtime-continuity item and MUST NOT appear in Web or ordinary App API as a picker, creation or restart action, navigation object, identifier, history, active-session object, or native handle. Authorized operator diagnostics may project redacted runtime lineage through a separately protected diagnostic surface, but that lineage is not a conversation action and cannot be used to choose or replace AgentSession.

## Account Gate And My Invitations Projection

This section owns only the release-coupled Web behavior that composes existing authentication and sharing contracts. It does not redefine their identity, session, membership, invitation, authorization, route, or error semantics.

At application bootstrap and every account-state refetch, Web calls the existing protected `client.app.listAuthorizedWorkspaces()` read. Any successful response enters the product, including an empty authorized-Workspace list. Only an `ApiCallError` with HTTP `401` and code `core.auth.unauthenticated` opens the account gate. Network failures, malformed responses, every other HTTP status, and every other error code remain failures with retry; Web must not translate them to unauthenticated or create a browser-owned session fact.

The account gate offers the existing email/password sign-in and sign-up operations without claiming whether sign-up is enabled. Web must not read `server.mode`, call setup or deployment-administrator diagnostics for account admission, infer `auth.signup.enabled`, invent a deployment or server label, expose host internals, or derive authentication state from capability shape or error text. Account copy states only what the protected read proves: authentication is required, the product is available, or the read failed.

After successful sign-in or sign-up, Web refetches `listAuthorizedWorkspaces()` and enters the product only when that protected read succeeds. After sign-out, Web refetches the same read and opens the account gate only after the typed `401 core.auth.unauthenticated` result; a different result remains its actual success or failure. An auth failure retains no password and creates no browser-owned session truth. Exact email and password values remain live-form/request inputs only; neither may enter TanStack Query data, Zustand, browser storage, logs, status text, or errors.

Authenticated **My invitations** is an account-level destination and remains reachable without a selected Workspace or active Workspace membership. It reads `client.app.listMyWorkspaceInvitations()` directly rather than deriving invitations from the authorized-Workspace list. Pending rows offer the existing accept and decline operations with their exact revision; accepted, declined, revoked, and expired rows are terminal read-only projections. Workspace-owner member and invitation administration remains a separate selected-Workspace surface, and self-leave remains a separate membership action.

My invitations preserves the sharing owner's typed outcomes. `invitation_not_pending` and invitation `revision_conflict` replace the affected row with the returned safe current invitation. `workspace_access_denied`, `idempotency_key_conflict`, and `recovery_required` remain typed failures and trigger a refetch before any new-request retry; Web does not infer membership, repeat an uncertain mutation, or synthesize success. Returned invitation rows, status and terminal copy, error projections, durable identifiers, stored client state, and logs must never contain an email address. An exact email may exist transiently only in an explicit auth or invitation input and its immediate request; email is neither a credential nor a secret role and must not be presented as one.

## Repositories Projection Contract

- **Definition and authority:** The live Tier-A board-19 **Repositories** screen projects selected-Workspace repository resources, diagnostics, durable push records, and the existing approval-gated Git push workflow through `client.repositories`. It requests approval for one exact repository/ref/commit target and owns only the Web projection; Git, approval, policy, repository-lifecycle, API, and external-effect semantics remain with their existing owners.
- **Consumed-record lifecycle:** A terminal `GitPushRecord` consumes the current granted approval only when Workspace, repository, approval Item, policy decision, source ref, target branch, and the exact ordered commit cardinality and content all match. That match suppresses both the Execute affordance and its handler. When the current approval response is granted and matches the selected Workspace, repository, and frozen request, no terminal record or any materially nonmatching listed record leaves only that granted positive execution path available; a nonmatching listed record is not consumption or recovery by itself.
- **Authoritative settlement and failures:** After execution, Web must read the exact authoritative `GitPushRecord` before presenting success. A matching same-id authoritative record replaces stale list bytes at that row's existing index; when the matching record is absent from the refetched list, Web inserts it exactly at the head. Settlement never reorders the other rows or duplicates the id. A materially mismatching authoritative response preserves the refetched list, presents recovery-required state, and hides Execute. A missing or failed authoritative read retains the existing typed failure and recovery semantics and cannot become success. Neither approval nor execution is replayed automatically, including after remount or restart.
- **Navigation and server state:** After successful Workspace discovery validates the selected Workspace, Repositories appears once under a Workspace navigation section labeled with that Workspace's authoritative name and never as global primary navigation; without a validated Workspace, that nested destination is absent. TanStack mutation data is the sole server-state owner for the current approval response; React state, Zustand, browser storage, and list-row inference must not copy or reconstruct it.
- **Exclusions and acceptance:** Worker-proposed-file Workspace Sync review-to-apply UX remains deferred under the Workspace Synchronization owner and is not part of this surface. The missing full collapsible Workspace/thread tree is not authorized by this projection. Observable acceptance requires exact-tuple positive and negative cases, matching-terminal suppression at both UI and handler boundaries, authoritative-read-before-success, same-id replacement at its existing index or exactly-at-head insertion when absent, mismatch recovery with the refetched list preserved, selected-Workspace-only navigation, one TanStack approval-response owner, and zero automatic replay. This contract does not assert browser proof or execution of a real external push.

## Current Implementation Projection

The current Web implementation is a React and Vite SPA whose route catalog, app shell, and sidebar project NanoCore state through `@openkit/core-client`. TanStack Query owns server-state access, while Zustand remains limited to UI-only state.

- Live surfaces cover Workspace overview and Action Center rows, Chat and Task Threads, Goal planning and steering, Artifact Review, Knowledge, Agents, first-run and Workspace creation, appearance and Workspace-authorized general settings, the Settings Debug component catalog, and selected-Workspace Usage & audit.
- Goal plan approval and revision, steering input, Artifact Review decisions, Knowledge creation, Workspace creation, and Workspace rename use current Core Client operations. The selected Workspace navigation exposes a direct Workspace settings entry, and failed mutations preserve the last authoritative server projection rather than creating browser-owned workflow truth.
- General Settings never calls deployment diagnostics or runtime-config routes. The AI interface remains an internal unpublished review screen because provider-subscription routes require server-admin credentials and Web has no accepted server-admin credential path; roadmap R048 owns the future separate deployment-admin surface.
- Automations, Channels, and AI interface remain internal unpublished review screens, and Generative UI remains an internal unpublished render shell. They are absent from Web navigation and routing, do not imply kernel support, and create no product truth.
- The live Tier-A board-19 **Repositories** screen currently projects selected-Workspace repository resources, diagnostics, durable push records, and the existing approval-gated Git push workflow through `client.repositories`. Its consumed-record tuple and authoritative settlement behavior are implemented; navigation places it exactly once under the validated Workspace's authoritative name, and TanStack mutation data is the sole server-state owner for the current approval response.
- The live Tier-A board-17 **Usage & audit** screen is implemented as a read-only projection scoped to the selected Workspace. It uses exactly the existing `client.app.getCapabilityUsage()`, `client.app.listWorkspaceAuditEvents()`, and `client.app.listWorkspacePermissionDecisions()` reads with that validated Workspace. It never calls or projects `client.app.listServerAuditEvents()`, and deployment-admin server audit is deferred to a separately accepted future admin surface.
- The accepted ordinary Workspace Vault placement is read-only and uses exactly the existing `client.app.listWorkspaceVaultReferences()`, `client.app.listWorkspaceVaultGrants()`, and `client.app.listWorkspaceVaultUseRecords()` reads for the selected Workspace. It never requests or projects deployment-admin backend status. That status is deferred to a separately accepted future server-admin Web surface. The permission and multi-user Workspace owners define the separation between ordinary Workspace authority and deployment administration; this Web projection does not duplicate their authorization rules.
- Focused Vitest coverage and the L4 Playwright entrypoint exercise the Web package. Real-worker and restart proofs remain at their owning process boundaries and do not imply browser coverage.
- The bounded live Work Resource Class 1 route implements Material identity, creation, authoring, immutable revisions, client-side comparison, Thread binding, inclusion and queue state, active-turn delivery, and worker proposal review. Selected-Workspace owner member administration, owner-issued invitation administration, the membership-independent account-level My invitations direct read with pending accept and decline decisions plus terminal rows, and selected active non-owner self-leave are focused-test-backed implementations through the existing Account route; browser, real-auth, real-use, and program-exit proof remain pending.
- Work Resource Class 2 and Work Resource Class 3 resources, grounded annotation, text-range patching, generalized locator controls, and surfaces without stable underlying contracts remain deferred. The React app remains a projection and is not the canonical source of Core semantics.

## Resolved Decisions

- Web UI work follows stable NanoCore, App API, protocol, and core docs.
- Superseded Web UI slice specs are historical references, not active requirements.
- Web-specific read models may exist, but they must be traceable to canonical workspace, thread, turn, item, artifact, knowledge, review, audit, permission, vault, agent, and runtime records.
- Web UI must not expose backend-private runtime state, raw secrets, raw OpenShell internals, or hidden agent-private task graphs as normal product concepts.
- Web and ordinary App API MUST NOT expose AgentSession identity, history, selection, creation, or restart; conversation behavior is continue Thread or create Thread.
- New user-facing Web behavior that requires kernel semantics must first update the relevant protocol, NanoCore, core doc, or spec contract.

## Deferred / Future Work

- Refine and extend the existing React shell, route catalog, and navigation only as additional contract-backed surfaces become live.
- Add worker-proposed-file Workspace Sync review-to-apply UX over the canonical review records.
- Add worker runtime diagnostics and agent capability summaries as the underlying contracts stabilize.
- Mine superseded Web specs for useful interaction details during bounded design work for genuinely missing Web surfaces.

## Superseded Web Specs

The previous Web UI MVP slice specs have been moved under `docs/specs/retired/web-ui-pre-rebuild/` because the old module was deliberately removed and the current product surface is a clean-slate rebuild rather than a contract-preserving successor.

They are retained to recover useful copy, interaction details, and edge-case notes during future Web product work, but they no longer represent active release gates.

## Links

- [Work Model](../core/work-model.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Core Architecture](../core/architecture.md)
- [Knowledge Model](../core/knowledge.md)
- [Agent Capability](../core/agent-capability.md)
- [Audit, Usage, And Evidence Records](./20260703-audit_usage_evidence_records.md)
- [Single-Deployment Multi-User Workspace System](./20260715-multi_user_workspace_system.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
- [Provider Subscription Accounts](./20260721-provider_subscription_accounts.md)
- [Workspace Synchronization](./20260703-workspace_synchronization.md)
