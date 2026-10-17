# Product Policy Bridge

This directory owns NanoCore's product-level permission-decision projection and pending-request admission.

## Boundaries

- `permission-decisions.ts` maps policy-kernel outcomes into redacted, scope-owned decision and audit records.
- Configuration reload policy belongs in `packages/config-schema`; boot policy-kernel loading belongs in `../bootstrap/`.
- Keep subject, resource, and context summaries redacted and write them only to the database for their declared owner scope.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/policy` and the affected route or workflow tests, then the NanoCore package gates.

See [Policy Enforcement Mapping](../../../../docs/specs/20260703-policy_enforcement_mapping.md).


The accepted design replaces the Turn-pausing approval gate and the closed-source-AgentSession actionability rule with a pending request whose captured call executes after grant; [Policy Enforcement Mapping](../../../../docs/specs/20260703-policy_enforcement_mapping.md) and [Pending Requests](../../../../docs/specs/20260930-pending_requests.md) own that rule.

Boot self-check decisions use independent canonical `pd` UUIDv7 identities. Their separate immutable boot/action correlation retains existing decisions and Audit across exact reopen/retry; ambiguity or missing linked evidence fails closed. Both decisions and their Audit publish within one Core SQLite transaction, without an external effect or a new boot lifecycle.

`worker-git-read-maintenance.ts` maps one loaded finite Server assignment and immutable effect facts into the existing NGAC evaluator. It owns no storage or identity lifecycle. Missing, invalid, duplicate, inactive, expired or out-of-scope assignments supply no association; Workspace fixed roles cannot grant this Server operation. The configuration command records the resulting immutable Server PermissionDecision and linked initiating-human Audit before dispatch.

`workspace-access.ts` projects one active-member association through the Policy Kernel for the closed Workspace operation set. Ownership, administrator eligibility, credential intersection, private audiences and owner-specific effects remain separate checks. No membership tier or access-changing command remains.

## Primary Admission

`server-access.ts` projects already-established User, Server and administrator Workspace eligibility into the existing NGAC evaluator using the current actor, exact admitted scope and registered operation/right mapping. `operation-resolvers.ts` consumes the User and Server decisions; the shared `auth/operation-authorizer.ts` consumes the Workspace decision after current credential and membership or administrator eligibility. Denials and evaluation failures stop the handler through the existing access-denial result. Ordinary admission remains transient; it adds no decision ledger or workflow. The exclusive actorless bootstrap-secret entry and finite delegated-maintenance assignment keep their existing owners. This baseline does not implement configurable restrictions or named-resource grant administration.

## Named Workspace Resource Access

`workspace-resource-access.ts` projects current Workspace eligibility and exact resource allocations into the existing Kernel. A managed Thread adds a resource Policy class, including when its last positive association is gone; explicit prohibitions retain deny precedence. Agent invocation maps the actual process to its responsible User and receives only its exact Agent allocation, not another Agent or human allocation for that User. The current caller still owns credentials, membership, private audiences and trusted lineage.

`resource-policy-requests.ts` captures terms in existing Pending Requests without resolving the proposed target at creation. It checks current `workspace.configure` authority, requester responsibility, shared Thread identity, allocation targets and configuration revision before confirmed application through `RuntimeConfigFileService`. Approval alone changes no assignment; saved configuration and validated reload remain distinct. The shared authored-right vocabulary is `@openkit/config-schema` product-policy metadata; the Kernel remains product-independent.

This R033 preparation is not connected to product operations or current audience reads yet. The complete increment must include those bindings, default-file-editor confirmation enforcement, and export/import of managed boundaries before landing. The existing configuration and portability owners define that boundary; unsupported or unvalidated imported restrictions must fail closed. No R033 completion or privacy acceptance is claimed for these isolated modules.
