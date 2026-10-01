# @openkit/protocol

`@openkit/protocol` defines shared OpenKit Core schemas, request payloads, event envelopes, and JSON Schema outputs for product surfaces, public transport projections, and runtime adapters that project into stable OpenKit protocol records.

The TypeScript and Zod schemas in this package are the machine-readable source of truth for stable shared protocol records. Generated JSON Schema files are same-release projections that preserve representable structural constraints; when standard JSON Schema cannot express a Zod cross-field refinement, the generated artifact documents that boundary and consumers must use the canonical Zod schema for authoritative validation. App-specific read models, transport routes, and runtime-native payloads remain projections outside the package.

## Scope

- Core protocol records, commands, events, errors, and conformance fixtures.
- TypeScript and Zod schema sources.
- Generated JSON Schema outputs derived from the Zod source.

`Thread.entryPath` is a required immutable server-authored routing discriminator. Storage cutover explicitly stamps historical records as `conversation`; public create and update commands cannot set it.

## Commands

- `pnpm --filter @openkit/protocol test`
- `pnpm --filter @openkit/protocol typecheck`
- `pnpm --filter @openkit/protocol build`

Thread visibility is explicit and immutable. Private Threads require `privateOwnerUserId`; shared Threads omit it. Public creation defaults to private and binds ownership to the requesting user; formal Task/Goal callers request `visibility: workspace` at creation. Quick Chat and administration stay private.

Approval-decision Items permit human decisions and narrowly identified `nanocore-repo-push-policy` system grants. Policy grants preserve automatic worker repository approval across reload without impersonating a human. Canonical Zod validation enforces that system actor’s permitted decision.

`src/requests/pending-request.ts` owns the user-input answer and pending-request withdrawal command schemas, inferred types and shared outcome schema alongside the approval response command. These Core payloads strip additive envelope fields while retaining their existing closed lifecycle values.

This version starts from a new data root and does not read earlier-version data ([Earlier-Version Data And Sessions Are Not Carried](../../docs/decisions/20260930-earlier_version_data_not_carried.md)). [Protocol](../../docs/core/protocol.md) owns the live approval-decision rule, and [Pending Requests](../../docs/specs/20260930-pending_requests.md) owns pending requests.

Agent catalog `kind` is a role, with null for supply that does not declare one. Product surfaces display that absence as Worker without inferring a role from the runtime. Catalog entries remain summaries and carry no private launch configuration.

`TurnErrorSchema.explanation` preserves a closed normalized Git fetch observation through Turn read/list and terminal-event projections. `GitFailureExplanationSchema` permits only fixed categories, a bounded UTC timestamp and typed completeness/status fields; authoritative Zod validation rejects contradictory code/status/subprocess combinations that generated JSON Schema cannot fully express. Worker policy-denial claims and arbitrary diagnostic text are not admitted.

`src/common/reasoning-effort.ts` exports `REASONING_EFFORT_LEVELS` and `ReasoningEffort` as the single Core effort vocabulary in ascending fitting order. Metadata and inference consumers use this export rather than authoring another level set.

`ReasoningEffortSchema` validates explicit Turn preferences using the canonical vocabulary. `turn.start`, canonical Turns, terminal events, and product Turn projections preserve optional `reasoningEffort`; retained absence stays absent. Turn admission freezes the preference and command identity includes the supplied field.
