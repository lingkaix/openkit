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

`server-access.ts` projects already-established User, Server and administrator Workspace eligibility into the existing NGAC evaluator using the current actor, exact admitted scope and registered operation/right mapping. `operation-resolvers.ts` consumes the User and Server decisions; the shared `auth/operation-authorizer.ts` consumes the Workspace decision after current credential and membership or administrator eligibility. Denials and evaluation failures stop the handler through the existing access-denial result. Ordinary admission remains transient; it adds no decision ledger or workflow. The exclusive actorless bootstrap-secret entry and finite delegated-maintenance assignment keep their existing owners. Named Workspace resource restrictions use the Workspace configuration owner described below.

Server targets may declare `family: administration | mcp | knowledge`; omission selects administration and unknown families deny. The current administrator maps to `ua:server-administrator`, and each selected family has its own object and object attribute under `pc:server`. Administration retains existing registered rights; MCP uses `api.call`; Knowledge uses its existing read, write, Review and Thread/Turn rights. These transient associations reuse `PolicyState`, `evaluateAccess` and `PolicyDecision`, with no saved assignment or operator setup. Native invocation performs the current credential read before the Kernel call: unexpected storage errors propagate to the error handler, while a Kernel deny or evaluation failure refuses admission. Server MCP operations declare their family in the shared table; prepared Server Knowledge registration remains with its operation owner.

## Named Workspace Resource Access

`workspace-resource-access.ts` projects current Workspace eligibility and exact resource allocations into the existing Kernel. A managed Thread adds a resource Policy class, including when its last positive association is gone; explicit prohibitions retain deny precedence. Agent invocation maps the actual process to its responsible User and receives only its exact Agent allocation, not another Agent or human allocation for that User. The current caller still owns credentials, membership, private audiences and trusted lineage.

`resource-policy-requests.ts` captures terms in existing Pending Requests without resolving the proposed target at creation. It checks current `workspace.configure` authority, requester responsibility, shared Thread identity, allocation targets and configuration revision before confirmed application through `RuntimeConfigFileService`. Approval alone changes no assignment; saved configuration and validated reload remain distinct. The shared authored-right vocabulary is `@openkit/config-schema` product-policy metadata; the Kernel remains product-independent.

The prepared R033 bridge now joins exact admission, current discovery and source audiences, existing human request review, and portable export/import. `resource-policy-operations.ts` supplies request and distinct confirmed apply handlers; the public operation table and native composition register both handlers together. Current requester revalidation uses the captured credential or exact Worker responsibility and current request-Thread rights, including Policy activation without a file revision change. The existing Pending Request closeout consumes that same current requester predicate. Runtime source and retained-storage joins use the live Policy and exact admitted Agent/process; they retain their existing lease and contributor checks. The public definitions derive the HTTP, CLI and eligible Agent Tool projections.

The generic runtime configuration operations refuse changes to the authored Workspace Policy subtree. Unchanged Policy survives ordinary sibling edits. The confirmed resource request calls the same CAS file owner directly; missing request lineage remains inspect-only on retry.
