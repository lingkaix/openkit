---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Researcher's analysis and Consultant's recommendation, implementing the engineer's deep-module directive
---
# Operation Family Modules And One Error Projection

## Decision

The Coordinator adopted the strengthened shared-contract sequence owned by [Operation Definition](../specs/20261002-operation_definition.md): one transport-neutral `OperationError` carries code, safe message, semantic status, optional safe details and private cause, with one safe semantic projection consumed by HTTP, remote MCP and built-in worker MCP through their respective framing. Families classify known domain failures inside their execution boundaries; unclassified exceptions reach the HTTP error handler rather than a generic Thread or family fallback. Each family exposes an exact-key implementation map for static composition, with duplicate operation ids rejected and request-local facts separate from stable dependencies. Closed declared resolver strategies use family-owned minimum-lineage readers while preserving current effect authority. Closed declaration facts cover default or allowed success statuses, owner-required invalid-input codes, JSON or retained streaming binding kind and one-time-secret results; MCP result eligibility derives from these facts without replacing trusted entry or worker supply selection. No `expected` field, runtime registry, retry state or durable record is introduced; directory layout and per-family factories remain implementation choices.

## Reason

The queue's evening-rulings entry records the engineer's direction that the remaining migration is a refactor, with every feature family organized as a deep module, redundancy removed inside each module and coupling removed between modules. The engineer's directive from the coordinator's record of the conversation, translated from Chinese: "Keep moving fast and finish the migration first. Remember that this migration is also a refactor and an optimization and should be redesigned according to the optimized code architecture; in particular every feature family should be organized by the idea and structure of a deep module, removing redundancy within a module and removing coupling between modules."

Independent research identified parallel central domain-exception lists that lost different safe error fields, broad fallbacks that converted unknown failures into family 404s, and redundant boundary wrappers. The Consultant recommended settling a bounded but complete shared contract before wave-3 families begin, including the already-needed context, resolver and projection facts rather than only error and composition helpers. This removes the recurring semantic defect without putting every older-family file move on the release's critical path. The Coordinator adopted that strengthened sequence, with wave-3 migration and older-family extraction proceeding under disjoint write ownership and one shared-path integration writer. The remaining extraction stays assigned first-release work rather than an indefinite backlog. The amendment changes no retained data and creates no durable error, module or retry lifecycle.

Source decision: temp/comm-redesign/engineer-queue.md, entries "Engineer rulings 2026-10-03 evening" and "Operation family modules and one error projection", dated 2026-10-03. Source research: temp/interface-unification/reports/family-modules/research-report.md, sections 2–5 and Recommendation. Source consultation: temp/interface-unification/reports/family-modules-consult/consult-report.md. These are provenance references, not behavioral authority.

## Rejected Alternatives

- Refactor every landed family's files before wave 3: broad adapter and test relocation would block roughly 100 remaining census entries and mix mechanical moves with semantic review, without evidence that all moves are prerequisites.
- Land only error and composition helpers before parallel migration: known context, eligibility, status and resolver requirements would still cause builders to invent competing solutions; every reached domain error producer needs conversion.
- Require an `expected` boolean, per-family factory or fixed directory layout: the boolean has no present consumer, direct maps suffice where construction needs no factory, and mandatory layout or wrapper layers add ceremony without strengthening the boundary.
- Runtime registration, plugin discovery, dependency-injection containers or universal family hooks: release-authored static composition already supplies the needed wiring; these alternatives add lifecycle, indirection or hidden coupling without a present need.
- Duck-typed errors, arbitrary JSON details or generic cause inspection: these bypass nominal classification and risk publishing unsafe exception content. New durable registries or generic receipt/transaction mechanisms would compete with existing authority and suggest false cross-domain atomicity.
- Land B1's known admission-to-404 defect or delay B1 for broad colocation: the Consultant instead recommended a temporary exact-operation-set rethrow with an explicit removal condition in the immediately following shared change, which removes all central family rethrow branches and the generic fallback.

## Revisit When

Implementing a known wave-3 family requires a new family-specific branch in a common algorithm. That falsifies the shared contract's completeness: correct the actual missing descriptor or boundary before the dependent batch lands rather than adding universal hooks. A genuinely new authority strategy returns to its owning design while unaffected family work continues.

## Affected Owners

- [Operation Definition](../specs/20261002-operation_definition.md)
- [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
