---
status: Accepted
date: "2026-10-15"
decider: Engineer, original instruction retained through the coordinator's reconciliation source
---
# Product Vision Language Exception

## Decision

The accepted Chinese text in `docs/product-vision.md` is a document-local language exception. Root LANG-001 and Documentation Model must name that existing exception. All other documentation keeps its existing English and localized-manual rules. The exception does not authorize translating or editing Product Vision; its protected-edit rule remains unchanged.

## Reason

The accepted Product Vision already declares this exact document-local exception. The coordinator's reconciliation source, Openkit-Legacy-Issues-and-Decisions-20261014/README.md, section "Items that do not need repeated review," confirms that Chinese Product Vision has the original engineer instruction. The backlog-20261015 inventory #218 and the coordinator's ordinary P11 continuation request explicitly call for meta-rule alignment without another language choice. The original instruction's date and verbatim text are not supplied by that source; this record does not reconstruct them. Its date records this reconciliation, not a new language decision.

Root LANG-001 and the manual-type projection omitted the exception, although Product Vision declares it. Naming that existing exception removes the contradictory projection without changing the protected document or broadening language policy. [Product Vision Protection](20260909-product_vision_protected.md) retains the engineer-only edit boundary.

## Rejected Alternatives

- Translate Product Vision as a documentation correction. The engineer has not requested that edit.
- Permit Chinese text in other documentation types. The accepted exception is limited to Product Vision.
- Ask the engineer to select the language again. The coordinator's source explicitly records the existing instruction and confines this work to its projections.

## Revisit When

Revisit only if the engineer changes the document-local exception or explicitly requests a Product Vision edit. A general documentation-alignment request does not satisfy that protected gate.

## Affected Owners

- [Root LANG-001](../../AGENTS.md#non-negotiables)
- [Documentation Model](../documentation-model.md#user-manuals)
