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

## Governed Effects

`effect-policy.ts` maps current owner-validated subject, concrete target, registered operation/right and effect eligibility into the existing NGAC evaluator. It combines mandatory product outcomes under Core Permissions and returns the evaluated graph digest through the existing snapshot helper. It does not load a new grant configuration or own effect state. Only a final `allow` admits dispatch; credentials, current resource authority and existing human decisions remain the effect owner's responsibility.

Worker launch retains the actual trigger actor, command, Thread and Turn in its existing PermissionDecision and linked Audit. The existing launch snapshot label remains bound to AgentSession/AEP consumers; the decision context retains the evaluated content digest. Removed Workspace authority still refuses before any decision write. Run the complete `src/policy/effect-policy.test.ts`, `src/policy/permission-decisions.test.ts` and `src/runtime/worker-turn-loop.test.ts` files for this boundary.

Reviewed Vault issuance evaluates the actual issuer and exact reference after the current issuer/decider and intent checks. Its immutable decision and linked Audit exist before Core grant creation. Only final `allow` issues a grant; a known refusal returns403 without a Core attempt and settles the existing request as `execution-error`. An actual Core attempt retains its existing unknown-result handling. The decision keeps the exact evaluated digest, actual issuer and deciding actor, request and reference; its context contains bounded kernel effect/reason codes and no full trace. Run the complete `src/vault/vault-grant-requests.test.ts` file with the effect adapter tests.
