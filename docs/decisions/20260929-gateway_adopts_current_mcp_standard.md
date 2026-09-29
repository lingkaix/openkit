---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# The MCP Gateway Adopts The Current Standard And Official SDK

## Decision

The NanoCore MCP Gateway fully supports the current MCP specification, including the stateless 2026-07-28 era, by adopting the official TypeScript SDK v2 (`@modelcontextprotocol/server`, `client`, and `core`). It negotiates both the modern era and the legacy `initialize` era on both faces: as a server toward workers and as a client toward upstream servers. The v1 SDK path is removed, not kept beside v2.

## Reason

The engineer stated this in Rounds 10 and 11 on 2026-09-29, translated from Chinese: the integration relies on the stateless design of the MCP standard released in July, and the Gateway should fully support that new standard, perhaps with MCP's official latest SDK. Round 11 confirmed that this redesign's implementation must integrate the latest MCP SDK and standard support into the NanoCore Gateway. Agent analysis: v2's era negotiation keeps pinned legacy-era worker clients working without an OpenKit compatibility layer, and first-party wire formats carry no compatibility obligation under NONNEG-001.

## Rejected Alternatives

- Staying on v1 1.30 or 1.31, rejected because v1 speaks only the legacy era.
- Keeping v1 and v2 side by side, rejected under NONNEG-001.

## Revisit When

A later MCP specification era is released, or the official SDK line changes.

## Affected Owners

- docs/specs/20260704-worker_mcp_tool_supply.md
