---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Consultant's analysis
---
# Restricted Material Channel Boundary

## Decision

The Coordinator adopted the stricter, fail-closed interpretation of restricted Material delivery. [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md#public-material-read-models) applies the exact-content prohibition to remote MCP and the retained administrator CLI; administrator credentials do not bypass it. Authorized metadata preflight refuses restricted revision read, save, or creation before content access or mutation with sensitive_content. Restricted metadata remains available, and authorized human-facing App API exact read and edit remain available. The server-owned entry point determines the channel, which caller input and credential privilege cannot relabel. The preflight stores no record and repeats on every new attempt.

## Reason

Replacement agent channels need the Material owner's existing separation of exact content from metadata. Administrator eligibility does not settle a channel confidentiality restriction. The Consultant found no projection identity in public invocation; the server-owned MCP entry is the smallest trustworthy channel fact. It recommended metadata preflight there and the corresponding CLI guard without a duplicate content implementation or general channel field. The Consultant asked for an engineer ruling on this strict boundary; the Coordinator adopted the recommendation under the engineer's standing delegation during absence.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Migration owner gaps", gap 2, dated 2026-10-03. Source analysis: temp/interface-unification/reports/migration-owner-gaps/consult-report.md. Landing commit: c00985b79ff8ad0b7f652d15a2848e26ad542ebd. These are provenance references, not behavioral authority.

## Rejected Alternatives

- Rely on an existing public invocation channel field: the Consultant found that no such field exists.
- Restrict every bearer actor: that would also restrict human bearer API clients rather than identify model-facing delivery.
- Remove all Material operations or introduce another content handler: the Consultant found those choices broader than the required exact-content boundary.
- Enforce within shared invocation by adding a trusted projection field: the Consultant identified this as additional machinery when the server-owned entry already supplies the required fact.

## Revisit When

None recorded.

## Affected Owners

- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md)
- [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md)
