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
