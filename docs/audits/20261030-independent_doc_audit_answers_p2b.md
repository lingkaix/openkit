---
date: "2026-10-30"
---
# Independent Documentation Audit: Answers For Identity And Policy

This non-authorizing record answers the identity and policy questions from the [independent documentation audit](20261023-independent_doc_audit.md) and its [supplement](20261025-independent_doc_audit_supplement.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records evidence and documentation corrections, and authorizes no new design.

## Scope

The comparison base is current main `0be853326bbd8575e5448b65759c269d67691328`. This independent consultant draft awaits coordinator confirmation or amendment before landing. Its requested consensus designation is: **Answered by coordinator and consultant consensus under the engineer's delegation of 2026-10-30**. That designation becomes effective only after coordinator confirmation; this draft does not claim that review occurred.

The batch covers 28 questions: Q-47 through Q-72, Q-192 and Q-193. Markers D, D* and O mean open delegated question, settled consensus, and settled owner, respectively. Each question has one fix type. DOC follow-up issue drafts identify implementation gaps exposed by a documentation correction; they are not additional question classifications. No code, held document, other group's document, prior audit, product vision or AGENTS.md is changed. No GitHub write is performed.

Fix counts: DOC 21, CODE 2, HELD 0, NONE 5, ESCALATE-E 0. Q-49's code issue is already #542. Q-50 and Q-51 retain existing #466 and #470; no duplicate issue is drafted. Q-58 and Q-71 remain with the assigned cross-cutting sweeps. Q-64 retains accepted personal Task/Goal work; the audit recommendation to reject all personal Workspace creation is not applied.

Document abbreviations:

- ID: [identity.md](../core/identity.md).
- CFG: [20260628-nanocore_config_identity_contract.md](../specs/20260628-nanocore_config_identity_contract.md).
- RA: [20260704-remote_auth_credential_bootstrap.md](../specs/20260704-remote_auth_credential_bootstrap.md).
- MU: [20260715-multi_user_workspace_system.md](../specs/20260715-multi_user_workspace_system.md).
- PM: [20260629-openkit_policy_model.md](../specs/20260629-openkit_policy_model.md).
- PEM: [20260703-policy_enforcement_mapping.md](../specs/20260703-policy_enforcement_mapping.md).
- TVS: [20260909-thread_visibility_and_sharing.md](../specs/20260909-thread_visibility_and_sharing.md).
- PR: [20260930-pending_requests.md](../specs/20260930-pending_requests.md).

All file:line evidence below refers to the comparison base, before these edits.

## Answers

| Question | Answer and current-main evidence | Fix type | Documents changed |
| --- | --- | --- | --- |
| Q-47 (O) | The accepted administrator rule permits accepting or declining another user's invitation, with the administrator recorded as actor. The invitation reference retains the bound invitee; no own-invitation restriction is added. Evidence: `docs/decisions/20261002-administrator_authority.md:12`; `docs/specs/20260715-multi_user_workspace_system.md:207`; `apps/nanocore/src/workspace-sharing-operations.ts:950`. | NONE | None |
| Q-48 (D*) | Keep the settled rule: acceptance requires the inviter's current admission authority, without a sweeper. The claim that existing checks suffice is false: they check the invitee, not the inviter; the documentation and issue draft record this gap. Evidence: `apps/nanocore/src/workspace-sharing.ts:418`; `apps/nanocore/src/auth/operation-authorizer.ts:772`; `docs/specs/20260715-multi_user_workspace_system.md:471`. | DOC | MU |
| Q-49 (D*) | Sign-up stays closed until retained bootstrap completion, then follows auth.signup.enabled. Later administrator-Token loss is not a bootstrap predicate; the implementation fix already belongs to #542. Evidence: `apps/nanocore/src/auth/bootstrap-token.ts:221`; `apps/nanocore/src/auth/better-auth.ts:114`; `docs/specs/20260704-remote_auth_credential_bootstrap.md:111`. | DOC | CFG, RA |
| Q-50 (D*) | Keep loopback trust and define TLS termination plus the private backend path in existing deployment configuration, with no new trust key. A public origin or forwarded header alone proves nothing; the bundled public plaintext path remains covered by #466. Evidence: `apps/nanocore/src/auth/middleware.ts:259`; `Caddyfile:8`; `containers/app/entrypoint.sh:23`; `docs/specs/20260704-remote_auth_credential_bootstrap.md:168`. | DOC | CFG, RA; CROSS-PART deployment guide |
| Q-51 (D) | Include schedule.enabled as the independent, default-off daily-run switch; outer enabled remains publication delegation. The Knowledge owner already accepts that separation, while strict parsing remains the separate #470 defect. Evidence: `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md:147`; `packages/config-schema/src/knowledge-maintenance.ts:16`. | DOC | CFG |
| Q-52 (D) | Server configuration holds deployment settings and fields explicitly placed there by their accepted owners, not an obsolete closed list. Include user.jsonc in the authored version-header rule. Evidence: `packages/config-schema/src/server.ts:264`; `packages/config-schema/src/user.ts:30`; `docs/specs/20260628-nanocore_config_identity_contract.md:113`. | DOC | CFG |
| Q-53 (D) | Authentication and browser CORS must use server.cors.origins. Correct the implementation projection to disclose the unsupported environment replacement, and draft its removal without adding a key. Evidence: `docs/specs/20260628-nanocore_config_identity_contract.md:92`; `docs/specs/20260628-nanocore_config_identity_contract.md:201`; `apps/nanocore/src/auth/better-auth.ts:162`. | DOC | CFG |
| Q-54 (D*) | Keep explicit Token expiry without a global lifetime cap. Document per-verification expiry, revocation, current ownership, scoped issuance, ceremony-specific bounds, and the absence of a NanoCore-wide rate limiter. Evidence: `packages/app-api-schemas/src/auth.ts:38`; `packages/app-api-schemas/src/auth.ts:117`; `apps/nanocore/src/auth/access-token-store.ts:197`; `apps/nanocore/src/auth/better-auth.ts:73`. | DOC | RA |
| Q-55 (D) | The last-used update is synchronous and a failed write fails authentication closed. Correct the risk text; no asynchronous writer is needed. Evidence: `apps/nanocore/src/auth/access-token-store.ts:215`; `docs/specs/20260704-remote_auth_credential_bootstrap.md:260`. | DOC | RA |
| Q-56 (D) | Derive the request identity from the exact output path and the Token identity from that request. Only the secret is freshly generated; retry and file-first durability rules stay unchanged. Evidence: `apps/nanocore/src/auth/admin-recovery.ts:243`; `apps/nanocore/src/auth/admin-recovery.ts:614`; `docs/specs/20260704-remote_auth_credential_bootstrap.md:159`. | DOC | RA |
| Q-57 (O) | The central private-Thread administrator gap is closed on main. Remove MU's remaining stale private-audience-isolation claim; keep truthful attribution and other implementation limits. Evidence: `apps/nanocore/src/auth/operation-authorizer.ts:1081`; `docs/specs/20260704-remote_auth_credential_bootstrap.md:205`; `docs/specs/20260715-multi_user_workspace_system.md:673`. | DOC | MU |
| Q-58 (O) | Leave numeric-default and undefined-label cleanup to the assigned Q-23/Q-28 sweeps. This batch changes no untouched number or label. Evidence: `docs/writing.md:27`; `docs/audits/20261024-independent_doc_audit_identity.md:167`. | NONE | None |
| Q-59 (D) | Use policy attributes in the current membership descriptions and describe ownership as lifecycle and recovery responsibility. Keep the policy-owned Role concept without implying a current membership tier. Evidence: `docs/decisions/20260924-member_permissions_await_policy_kernel.md:11`; `docs/specs/20260715-multi_user_workspace_system.md:180`; `docs/core/identity.md:157`. | DOC | ID |
| Q-192 (D*) | Require authenticated Web-session administrator derivation, reuse authentication-owned email normalization and uniqueness, and preserve a presented bearer's identity and scope in local mode. The local App fallback still violates the settled rule; /mcp already verifies its bearer. Evidence: `docs/specs/20260704-remote_auth_credential_bootstrap.md:109`; `docs/specs/20260704-remote_auth_credential_bootstrap.md:179`; `apps/nanocore/src/auth/bootstrap-token.ts:195`; `apps/nanocore/src/storage/schema/better-auth/index.ts:7`; `apps/nanocore/src/auth/middleware.ts:122`. | DOC | CFG, RA, MU |
| Q-193 (D) | There is no separate Workspace-administrator tier: current workspace.configure authority admits Workspace Policy changes with the existing confirmation. Define the member association from the existing rights registry and its explicit exclusions, including administrator-only export. Evidence: `docs/core/policy.md:36`; `apps/nanocore/src/policy/workspace-access.ts:8`; `apps/nanocore/src/policy/resource-policy-requests.ts:243`; `docs/specs/20260703-policy_enforcement_mapping.md:373`. | DOC | MU, PEM |
| Q-60 (D) | Keep missing-privilege and restriction in Kernel traces and not_granted and prohibited as product reasons. The adapter already supplies this distinction; rename no code. Evidence: `packages/policy-kernel/src/index.ts:152`; `apps/nanocore/src/policy/interception.ts:307`; `docs/specs/20260629-openkit_policy_model.md:227`. | DOC | PM |
| Q-61 (D) | Goal-domain publication, current readback, bounded Coordinator administration and the Task admission join exist on main. Correct Policy implementation status without claiming complete Goal acceptance or editing the held Goal owner. Evidence: `apps/nanocore/src/policy/goal-domains.ts:510`; `apps/nanocore/src/runtime/task-admission.ts:135`; `apps/nanocore/src/runtime/goal-owner.ts:2037`; `docs/specs/20260703-policy_enforcement_mapping.md:500`. | DOC | PM |
| Q-62 (D) | Replace future-tense family landing claims with the bounded consumers that exist: agent gate, Goal domain and human storage-lease projection. General agent grants, delegated/finite-use leases and live Storage joins are not implied. Evidence: `apps/nanocore/src/policy/statements.ts:518`; `apps/nanocore/src/policy/interception.ts:392`; `apps/nanocore/src/policy/goal-domains.ts:669`; `apps/nanocore/src/policy/configuration.ts:335`; `docs/specs/20260703-policy_enforcement_mapping.md:19`. | DOC | PM, PEM |
| Q-63 (D) | knowledge-manager is a valid immutable entry that selects the Knowledge Manager contract, not authority. Its current audiences are scope-specific: Workspace maintenance is shared, User maintenance is private, Server maintenance is Server-owned, and queries retain admitted audiences. Evidence: `packages/protocol/src/models/thread.ts:8`; `apps/nanocore/src/knowledge/knowledge-agent-maintenance.ts:288`; `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md:133`. | DOC | TVS |
| Q-64 (D) | Keep explicit Workspace Thread creation for formal work, including personal Task/Goal work; the current owners already settle that scope. Shared Chat remains post-v0.1.0 and forbidden in personal Workspaces, so blanket refusal of formal creation would incorrectly remove accepted personal capability. Evidence: `docs/decisions/20261015-private_assistant_timeline_and_rolling_context.md:10`; `docs/decisions/20261015-shared_conversation_and_single_agent_threads.md:13`; `docs/specs/20260909-thread_visibility_and_sharing.md:39`; `docs/specs/20260909-thread_visibility_and_sharing.md:93`; `apps/nanocore/src/thread-routes.ts:217`. | NONE | None |
| Q-65 (D) | Use the first selected outcome in readiness order and its actual deciding or human ending actor, with system attribution when no human ended it. This changes attribution, not authority; code still uses creation order and falls back to the responsible user. Evidence: `docs/specs/20260930-pending_requests.md:197`; `docs/specs/20260930-pending_requests.md:108`; `apps/nanocore/src/runtime/pending-request-flow.ts:1145`; `apps/nanocore/src/runtime/pending-requests.ts:1121`. | DOC | PR |
| Q-66 (D) | The old policy-grant actor clause is validation of retained completed records only. It does not activate a producer or rewrite a historical actor. Evidence: `docs/specs/20260930-pending_requests.md:147`; `apps/nanocore/src/runtime/pending-requests.ts:1562`. | DOC | PR |
| Q-67 (D) | Name each target request ID and the approval's raising turnId separately from the command requestId. Preserve the current admitted approval scope-mismatch result, 400 invalid_request. Evidence: `packages/protocol/src/requests/pending-request.ts:5`; `packages/protocol/src/requests/approval.ts:14`; `apps/nanocore/src/pending-request-operations.ts:152`. | DOC | PR |
| Q-68 (D) | After generic envelope parsing and scoped loading, check current decision authority, then state/replay, then record-dependent answer and secret rules. The existing non-enumerating authorization rule forbids exposing question-specific failures to an ineligible actor. Evidence: `docs/specs/20260930-pending_requests.md:155`; `apps/nanocore/src/runtime/pending-request-flow.ts:536`; `apps/nanocore/src/runtime/pending-request-flow.ts:1399`. | CODE | None |
| Q-69 (D) | An unreadable row cannot disappear from the pending bound or archive census. Account for it conservatively and refuse archive with recovery_required while its relevant state cannot be proved; retain inspect-only failure and usable unrelated history. Evidence: `docs/specs/20260930-pending_requests.md:143`; `docs/specs/20260930-pending_requests.md:244`; `docs/specs/20260930-pending_requests.md:276`; `apps/nanocore/src/runtime/pending-requests.ts:636`. | CODE | None |
| Q-70 (D) | Implementation status belongs in PM/PEM and must distinguish the active bounded agent gate from unimplemented general grants. Remove the stale activation sentence from Core Doctrine through its owning part; the exact cross-part deletion is below. Evidence: `docs/core/doctrine.md:25`; `docs/specs/20260703-policy_enforcement_mapping.md:209`; `apps/nanocore/src/policy/statements.ts:518`. | DOC | PM, PEM; CROSS-PART Core Doctrine |
| Q-71 (O) | Leave numeric-default and undefined-label cleanup to the assigned Q-23/Q-28 sweeps. No separate policy sweep is applied here. Evidence: `docs/writing.md:27`; `docs/audits/20261024-independent_doc_audit_policy.md:156`. | NONE | None |
| Q-72 (O) | Channel pairing grants no administrator eligibility in either mode, including for the local User. Current channel actors lack the authenticated Web-session administrator projection, so no downstream correction remains. Evidence: `docs/specs/20260704-remote_auth_credential_bootstrap.md:109`; `apps/nanocore/src/channel-services.ts:54`; `apps/nanocore/src/channels/discord.ts:423`; `apps/nanocore/src/auth/operation-authorizer.ts:188`. | NONE | None |

## Code Issues

These are drafts only. The four DOC follow-ups preserve the settled or clarified rule while identifying a remaining implementation gap.

### Q-48 (DOC follow-up): [workspace-sharing] Recheck inviter authority before invitation acceptance

- The settled rule rejects a pending invitation when its inviter no longer has authority to admit members; no sweeper is needed.
- `apps/nanocore/src/workspace-sharing.ts:418` checks only the invitee, expiry, revision and active Workspace before inserting membership.
- `apps/nanocore/src/auth/operation-authorizer.ts:772` supplies only invitee facts, so current response authorization does not cover the inviter.
- Reuse the existing current-authority evaluator at acceptance before the conditional membership effect; reject removed, disabled or otherwise unauthorized inviters without creating another lifecycle.
- Cover inviter removal, disable, lost Policy authority and an ordinary authorized invitation; retain current administrator response attribution.

### Q-53 (DOC follow-up): [auth] Use the configured browser origins for Better Auth

- The Config And Identity owner requires authentication and browser CORS to use `server.cors.origins`.
- `apps/nanocore/src/auth/better-auth.ts:162` instead lets `BETTER_AUTH_TRUSTED_ORIGINS` replace the authentication list.
- Remove the unsupported override and use the validated configuration list; add no replacement key.
- Check that the environment value cannot alter auth admission and that configured origins still work.

### Q-65 (DOC follow-up): [pending-requests] Bind outcome trigger attribution to the selected ready outcome

- The first outcome means the first selected outcome in the existing freeze readiness order; withdrawal attribution uses its actual ending actor.
- `apps/nanocore/src/runtime/pending-request-flow.ts:1145` selects from creation order and line 1160 falls back to the responsible user.
- `apps/nanocore/src/runtime/pending-requests.ts:1121` instead freezes by `compareReadiness`, so trigger and delivered batch can disagree.
- Use that same selection and retained deciding/ending ActorRef, or system attribution for an ending without a human; preserve current execution admission.
- Check reversed creation/readiness order, administrator withdrawal, system invalidation and a bounded batch excluding an older-created outcome.

### Q-68 (CODE): [pending-requests] Authorize answers before request-dependent validation

- The Pending Requests owner requires an ineligible actor to receive `workspace_access_denied`.
- `apps/nanocore/src/runtime/pending-request-flow.ts:536` validates question/secret shape before the actor check and pending-state check.
- Keep generic command parsing, then check current responsible-user/administrator authority, state and replay before record-dependent answer validation.
- Check identical denial for ineligible actors across valid, mismatched and secret answers, plus unchanged authorized replay and validation behavior.

### Q-69 (CODE): [pending-requests] Preserve unreadable rows in admission and archive censuses

- The existing pending bound and archive closeout cannot treat an unreadable retained request as absent.
- `apps/nanocore/src/runtime/pending-requests.ts:636` drops decode failures before the bound at line 716; archive consumes that list at `apps/nanocore/src/runtime/pending-request-flow.ts:974`, and its association check also drops unreadable rows at line 1650.
- Use the existing raw row identity/state to account conservatively for the bound, and return `recovery_required` before archive effects when its census is incomplete.
- Preserve inspect-only errors and unrelated readable history; add no repair, fabricated request, scanner or store.
- Check malformed retained rows at the pending bound and during archive, with no mutation or silent success.

### Q-192 (DOC follow-up): [auth] Prevent local bearer requests from becoming the implicit administrator

- The settled account rule preserves a presented credential's identity and scope; authentication failure cannot select a stronger implicit actor.
- `apps/nanocore/src/auth/middleware.ts:122` returns an implicit local actor before bearer verification at line 150, except for `/mcp`.
- Verify a presented bearer before considering implicit-local admission; retain its owner, read-only and Workspace bounds, and reject malformed or unusable bearer input.
- Keep the loopback boundary and credential-free local path; add no credential kind or fallback identity.
- Check valid scoped, read-only, expired, revoked and malformed bearers against local App routes, and retain `/mcp` bearer-only behavior.

## Held Fixes

None. Q-61 changes only Policy status projections; it neither edits the held Goal specification nor declares its acceptance complete.

## Cross-Part Fixes

- Q-50, `containers/app/README.md`, deployment/periphery owner: add this exact paragraph beside the listener configuration: "For a non-loopback deployment, terminate HTTPS at the declared fronting proxy and keep the App's plaintext listener on its private backend path. The public-origin setting and forwarded headers do not prove TLS. Do not expose the plaintext App listener directly to remote clients carrying credentials. Remote Auth Credential Bootstrap owns this transport boundary." Link the last sentence to `../../docs/specs/20260704-remote_auth_credential_bootstrap.md#transport-requirements`. This is an operator projection, not a new configuration key or a substitute for #466.
- Q-70, `docs/core/doctrine.md:25`, foundation owner: delete exactly "The accepted design is not a claim that agent-principal activation is implemented; activation remains unclaimed." Keep the surrounding principal, finite-chain, no-inheritance, human-only and on-behalf-of requirements unchanged. PM and PEM now state bounded implementation status; add no downward specification link to Core.

## Escalated

None. The answers retain accepted authority, release scope, data continuity, durability and security boundaries. The D* corrections follow the supplied settled answers. The claim that Q-48's current code already reauthorizes the inviter is contradicted by the cited implementation; the rule itself is retained.

## Criterion Preservation

- ID Purpose and Workspace Membership keep membership, ownership and attribution semantics while removing implications of a current role tier.
- CFG Configuration Scope And Files keeps field ownership, strict authority validation, revision/reload, no cross-scope inheritance and version headers; it adds the already-owned daily switch and User header.
- RA bootstrap, transport, Token, recovery and session sections keep their existing ceremonies and effect boundaries. Request/Token derivation is clarified in place; file-first order, exclusive file creation, fsync, transaction, exact replay and refusal predicates remain unchanged.
- MU Access Matrix and Policy Kernel Projection use the existing rights registry and accepted administrator-only export rule. Invitation acceptance uses the existing authority boundary; the implementation gap is explicit.
- PM/PEM retain the pure Kernel, product reason distinction, general-grant limits and Goal acceptance boundary; only obsolete implementation status changes.
- TVS retains immutable server-authored entry selection, current authority and audience checks; Knowledge Manager behavior stays with its owner.
- PR Resolve and End retain pending-only decisions, replay/conflict, secret refusal and exact lineage while naming current selectors. Deliver retains one frozen batch and its executor/trigger rules, and Parties retains historical actors without activating a producer.

## Checks

Passed with pinned Node v24.18.0: index generation, specification lifecycle validation, story schema validation (10 stories), documentation model validation (687 documents), and `git diff --check`. The initial index attempt lacked `yaml`; the existing `yaml` and `zod` packages were copied into this clone before the successful checks. No full build or test suite was run. Coordinator confirmation remains separate from these structural checks.
