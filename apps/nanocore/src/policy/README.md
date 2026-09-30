# Product Policy Bridge

This directory owns NanoCore's product-level permission-decision projection and pending-request admission.

## Boundaries

- `permission-decisions.ts` maps policy-kernel outcomes into redacted, scope-owned decision and audit records.
- `approval-gates.ts` records approval-required intent as a pending-request record and its request Item, without pausing the raising Turn.
- Configuration reload policy belongs in `packages/config-schema`; boot policy-kernel loading belongs in `../bootstrap/`.
- Keep subject, resource, and context summaries redacted and write them only to the database for their declared owner scope.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/policy` and the affected route or workflow tests, then the NanoCore package gates.

See [Policy Enforcement Mapping](../../../../docs/specs/20260703-policy_enforcement_mapping.md).

For `repo.push`, deployment-selected automatic grants execute in the tool call and retain a system-authored policy decision. Human approval raises a pending request. A captured Worker push executes after synchronous reauthorization and claim inside the response command; a host push publishes its decision on a Core-local Turn and retains the separate explicit execute command. The record owns approval state across reload.

The accepted design replaces the Turn-pausing approval gate and the closed-source-AgentSession actionability rule with a pending request whose captured call executes after grant; [Policy Enforcement Mapping](../../../../docs/specs/20260703-policy_enforcement_mapping.md) and [Pending Requests](../../../../docs/specs/20260930-pending_requests.md) own that rule.
