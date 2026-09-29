---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# External Systems Are Integrated Through Their Vendor's MCP Server

## Decision

A worker reaches an external system, such as GitHub for pull requests, merges, or repository administration, through that system's own MCP server, which the Gateway proxies through the Workspace MCP catalog. Authentication and the binding to a specific account, token, and repository are configured and enforced in NanoCore at the Gateway, and the worker uses the exposed tools without knowing about the proxy. OpenKit builds first-party MCP servers only for its own Core operations. A first-party server for an external system needs a stated reason, for example that no upstream server exists.

## Reason

The engineer stated this in Round 10 on 2026-09-29, translated from Chinese: the standard integration flow uses the MCP server that the third-party system provides, with the Gateway as proxy; all authentication and binding of the GitHub account token and repository happen at the Gateway in NanoCore. This is also how OpenKit will integrate and extend capabilities quickly, because it cannot develop its own MCP service for every external system or capability it integrates.

## Rejected Alternatives

- Building an OpenKit MCP server per external system, rejected for cost and speed of extension.
- Giving workers direct credentials to external systems, rejected because approval and audit belong at the Sandbox boundary.

## Revisit When

The comparison between `openkit-repository` and a vendor server (acting identity, repository binding, and commit transport) is taken up; the engineer deferred it in Round 11. Or when a vendor server cannot be constrained to the bound account and repository by credential scope.

## Affected Owners

- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20260907-mcp_catalog_management.md
