---
type: change-plan
status: in-progress
---
# MCP Tool Permission Owner

## Intent Revision 1

The engineer selected OPTION A on 2026-10-19 at 10:22Z: before the rc.10 reset, move exact Workspace MCP Tool prohibition and human approval conditions into the existing common Policy owner and remove the duplicate retained binding lists. Keep allowedTools as supply and retain current baseline authority. Server-origin selectors, a new allow requirement, new stores, schema pins and conversion are outside this cut.

## Owners And Boundaries

[Policy Enforcement](../../specs/20260703-policy_enforcement_mapping.md), [Worker MCP Supply](../../specs/20260704-worker_mcp_tool_supply.md) and [MCP Catalog Management](../../specs/20260907-mcp_catalog_management.md) own the accepted behavior. L-CH owns Policy admission/projection, catalog/AEP/API producers and their generated consumers. The coordinator assigns Web removal to Composer; GPT does not edit Web. Existing Goal/Task enforcement and other lanes' operation owners remain unchanged.

## Necessity

- Current exact Tool conditions replace the two duplicate permission lists because removal alone would lose prohibition and human review.
- The common Kernel projection preserves the current authority baseline and prohibition precedence without introducing default-deny or an explicit Tool allow requirement.
- Current schema-name validation on changed conditions prevents authoring nonexistent Tools; no schema pin is needed because a renamed Tool no longer matches.
- Existing Pending capture and current mediation readback preserve human review and at-most-once response; retired list fallback supplies no authority.
- Canonical format retirement rejects old authority fields while preserving descriptive annotations; pre-stable reset supplies no converter or inferred grant.

## Evidence And Acceptance

Independent Test Author context `/root/mcp_permission_cutover_test_author` committed format and real route/candidate/evidence regressions in 9e38c405c, 6a7a509b9, 926e8dbb9 and 81642deda, then the actual captured-response regression in d3e153512. Intended RED reached real baseline call, candidate setup and captured review/preparation before active-condition admission failed. Setup failures and downstream assertions not reached remain explicit in the external author report. The builder must pass these oracles without weakening them, preserve existing built-in/captured and Goal regressions, then obtain a separate fresh whole-diff review, affected complete module checks, Native typecheck, generated output and one exact-head full branch CI before direct-main landing.
