# Product Policy Bridge

This directory owns NanoCore's product-level permission-decision projection and approval-gate integration.

## Boundaries

- `permission-decisions.ts` maps policy-kernel outcomes into redacted, scope-owned decision and audit records.
- `approval-gates.ts` turns an approval-required decision into the existing approval, item, and turn state model.
- Configuration reload policy belongs in `packages/config-schema`; boot policy-kernel loading belongs in `../bootstrap/`.
- Keep subject, resource, and context summaries redacted and write them only to the database for their declared owner scope.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/policy` and the affected route or workflow tests, then the NanoCore package gates.

See [Policy Enforcement Mapping](../../../../docs/specs/20260703-policy_enforcement_mapping.md).

For `repo.push`, `approval-gates.ts` also records deployment-selected automatic grants using the same Approval and Item ownership. Automatic grants record an audited `allow` without a human Gate and never impersonate a human response. App requests retain Turn completion; selected repository Worker requests explicitly keep the active Turn running and preserve the policy grant across reload through a system-authored approval-decision Item. Human Worker Gate decisions require the exact Approval and Item owner, original command receipt, source AgentSession and package, denied MCP call, and terminal audit before the existing cleanup/checkpoint path can make them actionable. Other gated actions remain human-required.
