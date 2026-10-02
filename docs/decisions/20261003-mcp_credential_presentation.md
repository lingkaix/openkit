---
status: Accepted
date: "2026-10-03"
decider: Engineer
---
# Gateway MCP Credentials Use A Closed Raw Or Bearer Presentation

## Decision

The engineer approved on 2026-10-03 the coordinator's and advisor's plan for how the Gateway delivers Vault credentials to upstream MCP servers. Each Workspace catalog credential binding may declare a closed `presentation` of `raw` or `bearer`. Bearer is valid only on an HTTP header sink named `Authorization` and hands the unchanged Vault credential to the MCP SDK's minimal `AuthProvider`, so the header is exactly `Bearer` and the credential; raw keeps exact injection for vendor-specific headers, stdio environment and query sinks, and omission means raw. The existing immutable MCP configuration version and mutable Workspace binding are the proxy-layer configuration format; no separate proxy file, template language or vendor adapter is added. Vault headers replace ordinary headers case-insensitively, and the Gateway redacts both the raw material and every complete injected value. NanoCore-owned upstream OAuth and a non-secret HTTP query map are deferred, with an integration that needs either reported as unsupported rather than silently degraded. [MCP Catalog Management](../specs/20260907-mcp_catalog_management.md) owns the binding format and the deferrals, and [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md) owns the injection semantics. The engineer also approved removing the proof Agent's runtime-env GitHub credential binding on the A2 test deployment, so the Gateway is the only GitHub credential path there.

## Reason

The engineer asked for one uniform mechanism derived from first principles, first checking whether the MCP protocol and the SDK's standard implementation specify credential delivery, then surveying what third-party MCP servers need, and accepting a proxy-layer configuration format if servers need configuration. Translated, the engineer's approval: "I agree with this plan, and I agree with removing the binding." The MCP specification carries HTTP credentials as `Authorization: Bearer` access tokens and stdio credentials in the environment, and the pinned SDK's `AuthProvider` is the standard seam for a static bearer token and the seam a future OAuth provider would use. A survey of the 80 MCP servers shipped under `cursor/plugins/third_party` found 69 OAuth-primary, 4 static bearer, 2 custom-header, 1 stdio-environment, 3 unauthenticated and 1 host-linked path with no disclosed credential protocol, so bearer and raw cover every static class without a template language. The research and advisor reports are `temp/research/2026-10-03-mcp-upstream-credentials/research.md` and `temp/interface-unification/reports/consult-mcp-header-scheme/consult-r2.md`.

## Rejected Alternatives

- Store the complete `Bearer <PAT>` value in Vault with no code change: it makes Vault hold protocol-shaped values and is an operational workaround rather than a uniform mechanism.
- Run the vendor's local stdio server on the NanoCore host: it adds host executable provisioning and supervision to solve a formatting problem.
- A binding value template with one `${vault}` slot: the surveyed static classes need only bearer and raw shapes, and the one composite case can be stored as a single Vault credential, so a template language across all sinks is not justified.
- NanoCore-owned upstream OAuth now: it brings registration, consent, token, refresh and recovery lifecycles that the first release does not need for its GitHub path.

## Revisit When

An admitted integration requires upstream OAuth, a non-secret query option, or a credential shape that neither raw nor bearer presentation can carry.

## Affected Owners

- `docs/specs/20260907-mcp_catalog_management.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
