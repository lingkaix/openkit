---
status: Accepted
date: "2026-10-12"
decider: Engineer
---
# Requested MCP Tool Schema At Grant

## Decision

For a tracking entry, grant-time schema comparison uses the requested tool name and complete retained `inputSchema` from captured and current snapshots. Compare canonical JSON, including nested descriptions and annotations. Other tools and top-level tool metadata outside that schema do not refuse the call. Pinned entries retain whole-snapshot refusal. Catalog revision, eligibility, authority, Policy, credential, and at-most-once claim checks remain unchanged. No durable field is added.

## Reason

The engineer accepted option 2 in [#117, comment 6117121174](https://github.com/lingkaix/openkit/issues/117#issuecomment-6117121174), verified directly on 2026-10-15. An unrelated upstream change must not invalidate the exact requested effect. Complete retained schema comparison preserves the accepted effect boundary.

The accepted placement was after RC4 with owner and code changes together. The later rc.8 P11 dispatch explicitly requests early owner-supplier commits for the dependent builders. This record supplies no implementation or regression claim.

## Rejected Alternatives

- Whole-snapshot refusal for tracking entries rejects an unchanged requested effect after an unrelated tool change.
- Comparing only selected schema fields drops part of the retained effect contract.
- Dropping catalog, authority, Policy, credential, or claim checks exceeds the ruling.

## Revisit When

Revisit when an accepted upstream effect requires an authority-bearing property outside the complete input schema. Pinned entries keep their stricter whole-snapshot rule meanwhile.

## Affected Owners

- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
- [Pending Requests](../specs/20260930-pending_requests.md)
