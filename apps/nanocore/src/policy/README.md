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

Server targets may declare `family: administration | mcp | knowledge`; omission selects administration and unknown families deny. The current administrator maps to `ua:server-administrator`, and each selected family has its own object and object attribute under `pc:server`. Administration retains existing registered rights; MCP uses `api.call`; Knowledge uses its existing read, write, Review and Thread/Turn rights. These transient associations reuse `PolicyState`, `evaluateAccess` and `PolicyDecision`, with no saved assignment or operator setup. Native invocation performs the current credential read before the Kernel call: unexpected storage errors propagate to the error handler, while a Kernel deny or evaluation failure refuses admission. Server MCP operations declare their family in the shared table; prepared Server Knowledge registration remains with its operation owner.


`interception.ts` resolves versioned statements from the existing Policy/config owner and runs admitted transform, advice and gate stages before the final current native Policy check. It retains only a process-local bounded circuit per scoped binding version. Required typed invocation evidence goes to existing Audit through the caller; no provider registry, binding store or effect retry exists. The I16 MCP caller dispatches synchronously after current authority and required evidence. Unavailable participants and evaluator errors are distinct from a valid refusal. Run the complete Policy directory and the specialized Worker MCP route regressions.
