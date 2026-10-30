---
date: "2026-10-24"
---
# Independent Documentation Audit: Identity Group

This non-authorizing record holds the identity group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `05140a42f8b6aef63b399c259677ff2873307e6b` (`main` on 2026-10-24). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/identity.md`.
- Specifications: `20260628-nanocore_config_identity_contract.md` (CFG), `20260704-remote_auth_credential_bootstrap.md` (RA), and `20260715-multi_user_workspace_system.md` (MU).
- Cited decisions read: `20260924-member_permissions_await_policy_kernel.md`, `20261016-retire_stateless_quick_chat.md`, and `20261014-one_identifier_mechanism.md`.
- G3 inspection: two read-only inspector contexts (ID-CA for CFG and RA; ID-MU for MU). They read code only and ran no tests. The auditor verified each kept finding against the code.

## G2 Core Against Specifications

- ID-G2-01: `identity.md` listed "access level or policy attributes" as `WorkspaceMember` and `Invitation` record areas. MU has no access-level field, and [the member permissions decision](../decisions/20260924-member_permissions_await_policy_kernel.md) removes access levels until the Policy Kernel owns member permissions. Corrected in Core to "policy attributes"; the policy-attribute area stays because the decision keeps future policy attributes open.
- ID-G2-02: `identity.md` names "roles" in its purpose sentence and asks "which roles or attributes they have". MU has equal members and no role field. The text does not require a role, so it is not a conflict; the wording is Question Q-59.
- ID-G2-03: CFG and RA said that local mode resolves its User "through `LOCAL_USER_ID`". `identity.md` (Implicit Local Human) says that a fixed textual singleton supplies no identity authority, and the code resolves the single recorded `kind = local` row. Corrected in both projections (ID-CFG-03).
- ID-G2-04: CFG says that unsupported proxy trust is rejected; RA requires a fronting proxy that the deployment declares, and its Risks section calls the proxy posture explicit configuration. Two accepted specifications disagree on whether a proxy declaration exists: Question Q-50.
- ID-G2-05: `identity.md` calls Workspace ownership a distinguished authority relationship, and MU says the owner is not a higher operation-permission tier. Both keep ownership as a lifecycle and recovery relationship; this is wording tension only, recorded with Q-59.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| ID-RA-01 | RA Transport: tokens on non-loopback addresses need TLS, natively or through a declared fronting proxy | `apps/nanocore/src/auth/middleware.ts:243` accepts any loopback peer as secure; the shipped Caddy configuration serves plain HTTP on `:8080` and proxies to NanoCore on `127.0.0.1`, so a public plaintext request passes the gate | Code differs from a current accepted document | Issue #466 (blocking candidate: credentials); the declaration conflict is Question Q-50 |
| ID-CFG-01 | CFG Current Contract: a desktop-embedded Core binds only to loopback and startup rejects a non-loopback address | `apps/nanocore/src/config/bind-host.ts:27-31` returns the configured host unchecked; `apps/nanocore/src/auth/middleware.ts:122-132` makes every local-mode caller the local administrator | Code differs from a current accepted document; the CFG projection already states the gap | Issue #467 (blocking candidate: authorization) |
| ID-RA-07 | RA: the bootstrap notice states one-time, expiry, and no recovery from NanoCore | `apps/nanocore/src/index.ts:577-579` omits "cannot be recovered"; `apps/nanocore/src/auth/bootstrap-token.ts:123` writes a false "never stored in plaintext" header into the token file, which stays after consumption | Code differs from a current accepted document | Issue #468 |
| ID-MU-06, 07 | MU: the equal-member cutover removes access-changing surfaces; one closed App API projection | `apps/nanocore/src/lib/store.ts:387` and `apps/nanocore/src/workspace-sharing-operations.ts:990` keep `workspace.member.access.change`; `WorkspaceReadResponseSchema` (`packages/app-api-schemas/src/workspace-sharing.ts:37-39`) uses `safeExtend` with no `.strict()` | Code differs from a current accepted document | Issue #469 |
| ID-MU-03 | MU error list: `quick_chat_not_shareable` | `apps/nanocore/src/workspace-sharing-operations.ts:1072` throws `personal_workspace_not_shareable`; the schema enum has `quick_chat_not_shareable` | Already filed by the foundation group (FND-PW-01) | Existing issue #454; the specification value stays until the engineer chooses the code |
| ID-CFG-02 | CFG: Better Auth owns `auth.signup.enabled`; RA: no bootstrap after the first User | `apps/nanocore/src/auth/better-auth.ts:114` enables sign-up when the value is absent; `/api/auth/*` is public; a sign-up before bootstrap makes bootstrap return `bootstrap_unavailable` | No record decides the default; denial of the bootstrap ceremony, no privilege gain | Question Q-49 (high priority) |
| ID-MU-01 | MU Accept Or Decline: an administrator may accept or decline, and the recorded actor is the deciding actor | `apps/nanocore/src/workspace-sharing-operations.ts:1474-1482` resolves any invitation for an administrator; the accept and decline audit rows set no subject | No record decides whether an administrator decides another user's invitation | Question Q-47 |
| ID-MU-02 | MU Remove Or Leave: removal blocks new requests and decisions | `acceptWorkspaceInvitation` in `apps/nanocore/src/workspace-sharing.ts` never checks that the inviter is still an active member | No record decides it | Question Q-48 |
| ID-CFG-03 | CFG and RA projections: local mode resolves its User "through `LOCAL_USER_ID`" | `LOCAL_USER_ID` occurs only in tests; production uses `ensureLocalUser` and `getLocalUserId` (`apps/nanocore/src/auth/identity.ts:97,111`) | Projection drift; Core forbids identity authority from a textual singleton | Corrected in both specifications |
| ID-CFG-04 | CFG: `assistant.resources` and `knowledgeMaintenance` "remain Not Started" | `packages/config-schema/src/workspace.ts:112-123`, `packages/config-schema/src/knowledge-maintenance.ts`, `apps/nanocore/src/config/runtime-config-files.ts`, `apps/nanocore/src/knowledge/knowledge-maintenance-command.ts` | Projection drift | Corrected to implemented, with the paths |
| ID-CFG-05 | CFG: `knowledgeMaintenance` strict shape `{enabled, reviewRequiredPageIds}` | `packages/config-schema/src/knowledge-maintenance.ts:16-29` adds `schedule: {enabled}` and ends in `.strip()` | The non-strict parsing differs from a current accepted document; no record decides the `schedule` member | Issue #470 for the strictness; Question Q-51 for `schedule` |
| ID-CFG-08 | CFG projection: Core owns fixed `owner`, `editor`, and `viewer` access, and member access changes are implemented | No `editor` or `viewer` literal outside tests; MU and [Member Permissions Stay Open Until The Policy Kernel Governs Them](../decisions/20260924-member_permissions_await_policy_kernel.md) remove access levels | Document outdated by a later accepted decision | Corrected to active-member eligibility with the decision cited; the code residue is issue #469 |
| ID-CFG-06 | CFG: Server configuration holds only deployment settings and `defaults.defaultAgentId` | `packages/config-schema/src/server.ts:262-292` also has `channels`, `knowledgeMounts`, `defaultKnowledgeBaseId`, `appUpdate`, `server.fileReserveBytes`, and `policy.workDataCapture`; `user.jsonc` requires `schemaVersion` | Several later owners added the fields; no record states the closed list | Question Q-52 |
| ID-CFG-07 | CFG projection: Better Auth shares `server.cors.origins` with browser CORS | `apps/nanocore/src/auth/better-auth.ts:163-171` lets `BETTER_AUTH_TRUSTED_ORIGINS` replace the list, while CORS reads only the configuration | No record decides it | Question Q-53 |
| ID-RA-03 | RA: the administrator credential is not excluded from another user's private Thread | `apps/nanocore/src/auth/operation-authorizer.ts:896` passes `administratorEligible = false`; the RA projection states the gap; the result fails closed. MU line 656 says migrated addressed-Thread operations use administrator audience eligibility, which the central check contradicts | Known gap; the two projections disagree | Question Q-57 |
| ID-RA-04 | RA projection: an administrator Web session is not yet eligible across Workspaces | `apps/nanocore/src/auth/operation-authorizer.ts:168-186,856-868` treats a session whose User holds a usable `server-admin` Token as a current administrator | Projection drift | Corrected |
| ID-RA-05 | RA projection: remote MCP admission is not implemented | `apps/nanocore/src/app.ts:1928-1929,2561` and `apps/nanocore/src/remote-mcp-routes.ts` | Projection drift; [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md) owns the admission | Corrected to a reference to that owner |
| ID-RA-06 | RA projection: read-only Tokens fail mutation with `core.auth.scope_forbidden` | `apps/nanocore/src/auth/operation-authorizer.ts:688-689` refuses with `workspace_access_denied`, built as 403 at line 1111; `scope_forbidden` occurs only in Token creation | Projection drift; the typed non-enumerating refusal holds | Corrected |
| ID-RA-08 | RA Risks: asynchronous last-used update | `apps/nanocore/src/auth/access-token-store.ts:218-224` updates in the request; a failed write fails the request closed | No record decides it | Question Q-55 |
| ID-RA-09 | RA is silent on Token expiry bounds and rate limits | `packages/app-api-schemas/src/auth.ts:112-120` accepts any owner id and expiry at bootstrap; no rate limit outside Better Auth defaults | No record decides it | Question Q-54 |
| ID-RA-10 | RA recovery: the command generates the request id, and the next sentence derives it from the output path | RA lines 159, 160, and 199; `apps/nanocore/src/auth/admin-recovery.ts:614` derives it from the path | Inside-document conflict | Question Q-56 |
| ID-MU-04 | MU: the rebuilt Web multi-user projection is deferred to S10 and has no obligation | `apps/web/src/screens/account/MembersScreen.tsx`, `InvitationsPanel.tsx`, and `apps/web/e2e/account-sharing.spec.ts` implement membership and invitation management; [Contract Stability Baseline](../specs/20260715-contract_stability_baseline.md) lines 193 and 242 state it and keep the remaining Web work with S10 | Document outdated by a later accepted specification | Corrected at MU lines 690, 692, 709, 779, and 864; S10 keeps the remaining multi-user Web work and its browser acceptance, and the table row keeps every acceptance item |
| ID-MU-05 | MU: Quick Chat uses the definition table, and the resolver makes Quick Chat a Workspace-scoped `turn.run` operation | No `chat.quick` definition; `packages/app-api-schemas/src/administration-operations.ts:19,32` are the only users of `actor-quick-chat-workspace` | Document outdated by [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md) | Corrected at lines 269 and 654; "eleven" removed as in PR-OAS-03 and CM-CCB |
| ID matches | Token format, hash and constant-time check, scopes, revocation and rotation, bootstrap transaction and TTL, stopped-server recovery, membership resolver, invitation lifecycle, remove and leave, ownership transfer, recovery, fifteen sharing and deletion operations, error payloads | `apps/nanocore/src/auth/`, `apps/nanocore/src/workspace-membership.ts`, `apps/nanocore/src/workspace-sharing*.ts`, `packages/config-schema` | Match | None |

## G4 Organization

No move, merge, or split is applied. MU is 990 lines and mixes the current contract, a historical build plan (for example "Build the Core DB migration that adds access levels"), and test layers; it is a split-review candidate for the engineer. The remaining "Quick Chat" names in MU (lines 667, 672, 706, 799, and 846) name the personal Workspace and its error code; their naming is already open as Questions Q-03 and Q-04 and issue #454.

## G5 Writing

- Experience-chosen numbers without a current-default marking: RA recovery expiry "no later than 24 hours" and the 64-character name pattern. The rule is the one in Q-23: Question Q-58.
- Undefined labels: S56, S10, and "Stage 4" to "Stage 8" (MU), R033 (CFG), as in Q-28: Question Q-58.
- MU `### Projection And Supersession Boundary` describes what the cutover replaced; it holds current criteria too, so it is kept and recorded, not rewritten.
- MU lines 556 and 595 hold sentences over 80 words; a rewrite would touch deletion and recovery criteria, so it is left for the split review.

## Semantic Preservation

The table gives the inventory counts. A normative sentence is one that holds a requirement keyword; the other changed sentences are listed after the table.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `docs/core/identity.md` | 37 unchanged | 0 | 47 unchanged | 10 unchanged | 2 unchanged |
| `20260628-nanocore_config_identity_contract.md` | 59 unchanged | 0 | 175 unchanged, 4 removed (`LOCAL_USER_ID`, `owner`, `editor`, `viewer`), 8 added (paths and function names) | 21 unchanged | 23 unchanged, 1 added |
| `20260704-remote_auth_credential_bootstrap.md` | 125 unchanged | 3 unchanged | 248 unchanged, 2 removed (`LOCAL_USER_ID`, `core.auth.scope_forbidden`), 5 added | 32 unchanged | 19 unchanged |
| `20260715-multi_user_workspace_system.md` | 228 unchanged, 4 changed (lines 269, 692, 709, 779) | 0 | 575 unchanged, 1 removed (`turn.run`), 2 added (operation ids) | 88 unchanged, 1 changed (L4 heading) | 51 unchanged, 2 added |

Other changed sentences: two record-area lists in `identity.md` (access level removed), two status sentences and two projection sentences in CFG (ID-CFG-03, ID-CFG-08), four projection sentences in RA, and MU lines 654 (Quick Chat and "eleven" removed) and 690. The RA private-audience sentence now names only the central private-Thread check instead of all private-audience checks; the narrowing is correct because other callers pass the administrator flag (`apps/nanocore/src/runtime/pending-request-disclosure.ts:48`).

No acceptance item was removed. The MU surfaces row keeps member and invitation management, uniform eligibility, actor labels, conflict UX, and owner-transfer safeguards as S10 acceptance. The removed MU clause "no temporary Solid implementation is required" stated a non-obligation for a Web stack that is no longer in the repository. The CFG `knowledgeMaintenance` sentence keeps its strict shape, revision, and no-new-store criteria. No heading anchor that another document links was changed, and no file moved.

## Issues Opened

- #466 `[auth] Plaintext transport gate trusts the TCP peer, so the bundled App image accepts bearer tokens over public plaintext HTTP`, blocking candidate (credentials).
- #467 `[config] Local mode accepts a non-loopback bind host and then grants every caller local administrator authority`, blocking candidate (authorization).
- #468 `[auth] Bootstrap notice omits that the credential cannot be recovered, and the token file stays after consumption`, low.
- #469 `[workspace-sharing] Access-change residue remains after the equal-member cutover, and the Workspace summary is not closed`, low.
- #470 `[config] knowledgeMaintenance parsing strips unknown keys although the contract gives it a strict shape`, ordinary.
- Existing #454 covers ID-MU-03.

## Questions For The Engineer

### Q-47. May an administrator accept or decline another user's invitation?

- Context: list returns only the administrator's own invitations, but accept and decline resolve any invitation for an administrator, and the audit row does not name the invitee. Core gives the administrator every operation, including other users' resources.
- Options: (A) Limit administrator accept and decline to the administrator's own invitations. (B) Keep the behavior and record the invitee as the audit subject.
- Recommendation: A. Acceptance is the invitee's consent, and an administrator has the recovery path for access repair.
- Meanwhile: no change.

### Q-48. Does a pending invitation survive the removal or disabling of its inviter?

- Context: acceptance never checks the inviter, so the invitation stays acceptable for up to seven days.
- Options: (A) Revoke pending invitations when the inviter loses membership. (B) Keep them and state it.
- Recommendation: A. The right to admit others comes from membership.
- Meanwhile: no change.

### Q-49. Should sign-up stay closed until bootstrap completes? (high priority)

- Context: an absent `auth.signup.enabled` enables sign-up. A sign-up before the operator consumes the bootstrap token makes bootstrap unavailable until stopped-server recovery. The attacker gains only an ordinary User.
- Options: (A) Refuse sign-up while no `server-admin` Token exists. (B) Default `auth.signup.enabled` to false in server mode. (C) Keep the default and document it.
- Recommendation: A. It protects the bootstrap ceremony and keeps the setting's meaning.
- Meanwhile: no change.

### Q-50. Does a deployment declare its fronting proxy?

- Context: CFG rejects unsupported proxy trust; RA requires a declared fronting proxy. The code trusts a loopback peer, which issue #466 records.
- Options: (A) Add one explicit declaration for a TLS-terminating proxy and amend CFG. (B) Remove the declaration from RA and require that a same-host proxy terminates TLS.
- Recommendation: A. It serves container deployments and makes the posture explicit, as RA's Risks section asks.
- Meanwhile: no change.

### Q-51. Is the `knowledgeMaintenance.schedule` member part of the strict shape?

- Context: the schema adds `schedule: {enabled}`; CFG states a two-field shape. The strictness gap is issue #470.
- Options: (A) Amend CFG to name `schedule`. (B) Remove `schedule`.
- Recommendation: A, if the knowledge group confirms an owner for the schedule.
- Meanwhile: no change.

### Q-52. Which fields does the Server configuration file own?

- Context: CFG says only deployment settings and `defaults.defaultAgentId`; the schema also holds six fields that later specifications added, and `user.jsonc` requires `schemaVersion`.
- Options: (A) Replace the closed list with a reference rule ("deployment settings and the fields their owning specifications place here") and list `user.jsonc` with the versioned files. (B) Keep a closed list and add the fields.
- Recommendation: A.
- Meanwhile: no change.

### Q-53. May `BETTER_AUTH_TRUSTED_ORIGINS` replace `server.cors.origins`?

- Context: the environment value replaces the Better Auth list, while CORS reads only the configuration, so the two can differ.
- Options: (A) Remove the override and use the configuration. (B) State the override.
- Recommendation: A. CFG gives environment values no authority beyond the contract.
- Meanwhile: no change.

### Q-54. Should bootstrap and Token creation bound the expiry and the request rate?

- Context: the bootstrap caller chooses the owner id and any expiry, and no rate limit exists outside the Better Auth defaults. A 256-bit secret is not guessable.
- Options: (A) Add a maximum Token lifetime as a current default and state the sign-in rate limit. (B) Keep the specification silent.
- Recommendation: A, low priority.
- Meanwhile: no change.

### Q-55. Is the last-used update synchronous or asynchronous?

- Context: RA Risks says asynchronous; the code writes in the request and fails closed.
- Options: (A) Amend the Risks text to the synchronous fail-closed write. (B) Change the code.
- Recommendation: A.
- Meanwhile: no change.

### Q-56. Who creates the stopped-server recovery request id?

- Context: RA line 159 says the command generates it; line 160 and the projection derive it from the output path.
- Options: (A) State the path derivation in line 159. (B) State generation everywhere.
- Recommendation: A. The code derives the request id and the Token id from the output path (`apps/nanocore/src/auth/admin-recovery.ts:243,614-620`).
- Meanwhile: no change.

### Q-57. Should the private-Thread administrator gap become an issue?

- Context: the central check passes `administratorEligible = false`, so an administrator receives 404 on another user's private Thread. RA states the gap, and the result fails closed. MU line 656 says migrated addressed-Thread operations use administrator audience eligibility; the MU text is left unchanged until this question is answered.
- Options: (A) Open a low issue to pass the flag, and correct MU line 656 if the gap stays. (B) Keep the documented gap and correct MU line 656.
- Recommendation: A, so the gap has a traceable task.
- Meanwhile: no change.

### Q-58. How should the identity numbers and labels be marked?

- Context: the RA 24-hour recovery bound and 64-character name limit; the labels S56, S10, Stage 4 to 8, and R033.
- Options and recommendation: as Q-23 and Q-28.
- Meanwhile: no change.

### Q-59. Should Identity Core drop "roles" from its purpose and record text?

- Context: `identity.md` names roles, and MU has equal members with no role field. Core also calls ownership a distinguished authority relationship.
- Options: (A) Replace "roles" with "policy attributes" and call ownership a lifecycle and recovery relationship. (B) Keep the text for the future Policy Kernel.
- Recommendation: A, with the Policy Kernel owner able to add roles back.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code itself. Verdict: accept with changes. Dispositions:

1. CFG line 197 still named fixed `owner`, `editor`, and `viewer` access and member access changes. Accepted; corrected as ID-CFG-08 with the decision cited.
2. The MU line 779 edit dropped "before its release". Accepted; the sentence now ends "before the S10 release".
3. MU line 656 claims administrator audience eligibility for migrated addressed-Thread operations, which the central check contradicts. Accepted; added to ID-RA-03 and Q-57, and the MU text stays until the question is answered.
4. The non-strict `knowledgeMaintenance` parsing differs from a current accepted document. Accepted; issue #470, and Q-51 keeps only the `schedule` member.
5. The internal profile `limits` schema is in `packages/config-schema/src/internal-role.ts`. Accepted; the path is added.
6. The ID-RA-06 line citation was wrong. Accepted.
7. The ID-MU-06, 07 schema citation was wrong. Accepted; it names `WorkspaceReadResponseSchema` at lines 37-39.
8. The titles of #466 and #467 differed from GitHub. Accepted; the exact titles are copied.
9. The narrowed RA private-audience sentence was not listed. Accepted; it is listed under Semantic Preservation with its evidence.

The Reviewer confirmed the remaining evidence, the inventory counts, that Q-47 to Q-59 change no text, that Core gained no specification reference, and that the diff has no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (667 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
