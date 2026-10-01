---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Reasoning Effort Rulings

## Decision

Build reasoning effort now so Users and Workers can choose the effort of reasoning models. Advertise the intersection of available logical-model members' levels; when the serving member still lacks the requested level, use the nearest lower supported level and record both requested and effective effort. Core Protocol owns the closed effort vocabulary and admitted Turn value; Gateway owns metadata, advertised levels, fitting, and private lineage; Agent Manifest/AEP owns defaults and delivery; Composer and Web own their projections.

## Reason

The engineer's 2026-10-01 ruling 7 was: “Advertise the intersection of members' levels; when the serving member still lacks the requested level, use the nearest lower one and record both.” The engineer also requested that effort be built now for Users and Workers. Intersection makes a displayed level valid for every current candidate, while fitting handles a remaining serving-member mismatch without rewriting the admitted choice or hiding what actually served.

Source: Gateway routing proposal rev 4, Intent item 6, Proposed Design section 5, Engineer Ruling 7, and the engineer's same-day request to build effort now. The owning specifications state the detailed contract; this record does not attribute coordinator-settled metadata interpretation or the no-lower-level edge case to the engineer.

## Rejected Alternatives

Advertising the union of members' levels. The Consultant rejected it because a shown level could then be invalid for a candidate. The engineer accepted intersection with nearest-lower fitting and requested/effective lineage instead.

## Revisit When

Representative Provider or pinned-runtime evidence shows the common ordered vocabulary cannot express a required effort choice; availability changes make advertised intersection inadequate for truthful selection; or fitting repeatedly produces an effort materially different from the User's or Worker's intent. Reopening requires an owner amendment and renewed decision rather than another enum, hidden adapter default, or unrecorded fitting policy.

## Affected Owners

- [Core Protocol](../core/protocol.md)
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md)
- [NanoCore Config And Identity Contract](../specs/20260628-nanocore_config_identity_contract.md)
- [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [Agent Environment Package](../specs/20260616-agent_environment_package.md)
- [Unified Conversation Composer](../specs/20260831-unified_conversation_composer.md)
- [Web Product Surface Projection](../specs/20260628-web_product_surface_projection.md)
- [Web UI Rebuild Stack](../specs/20260710-web_ui_rebuild_stack.md)
