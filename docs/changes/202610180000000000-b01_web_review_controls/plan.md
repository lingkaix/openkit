---
type: change-plan
status: in-progress
date: 2026-10-18
---
# B01 Web Review Controls

## Intent Revision 1

The coordinator approved two B01 Web gaps: Workspace Gateway tool-rule editing in Catalog and read-only exact Turn-to-Skill lineage in Debug. The existing [Web projection](../../specs/20260628-web_product_surface_projection.md), [MCP catalog](../../specs/20260907-mcp_catalog_management.md) and [Agent Environment Package](../../specs/20260616-agent_environment_package.md) own behavior. No new API, durable record, proposal queue or Turn-draft Skill selection is authorized. The two evaluation landings and native-resume correction retain priority after naming lands.

## Implementation And Ablation

Reuse the existing binding mutation with observed catalog and binding revisions; add only the three editable tool lists and explicit save/error inspection. Without these fields the human can only toggle enablement. Extend the existing lazy snapshot read's field allowlist and detail display with Thread, Turn and Skill ID/digest/selection source. Without these fields the package identity cannot show which pinned Skill a Turn used. Existing authentication, current Workspace selection and Core ownership remain unchanged. Shared guide paths held by naming are not edited.

## Checkpoint And Verification

Both lowest-sufficient regressions failed on the missing controls and passed after implementation. Independent review found draft loss on binding-revision refresh and missing read-only recovery after failed enablement. Stable Workspace/server editor identity now preserves unsaved rules, current lists are shown for comparison, and explicit binding refresh resets a failed toggle after a successful read. The strengthened regression changes the actual binding revision and recovers a denied toggle without another write. The rejected-head gate was stopped and its complete owned process tree ended before correction. The exact committed head must pass the complete Web test directory and Web browser suite through local-gate, followed by independent Sol review and express landing on green main. Raw evidence stays in the lane's external B01 evidence folder. No deployed acceptance is claimed.
