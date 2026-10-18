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
- `pnpm --filter @openkit/protocol test:coverage`
- `pnpm --filter @openkit/protocol typecheck`
- `pnpm --filter @openkit/protocol build`

Thread visibility is explicit and immutable. Private Threads require `privateOwnerUserId`; shared Threads omit it. Public creation defaults to private and binds ownership to the requesting user; formal Task/Goal callers request `visibility: workspace` at creation. Quick Chat and administration stay private.

Approval-decision Items permit human decisions and narrowly identified `nanocore-repo-push-policy` system grants. The system actor is retained only to validate historical completed Items; no host-push grant producer or executor remains. Canonical Zod validation enforces that system actor’s permitted decision.

`src/requests/pending-request.ts` owns the user-input answer and pending-request withdrawal command schemas, inferred types and shared outcome schema alongside the approval response command. These Core payloads strip additive envelope fields while retaining their existing closed lifecycle values.

This version starts from a new data root and does not read earlier-version data ([Earlier-Version Data And Sessions Are Not Carried](../../docs/decisions/20260930-earlier_version_data_not_carried.md)). [Protocol](../../docs/core/protocol.md) owns the live approval-decision rule, and [Pending Requests](../../docs/specs/20260930-pending_requests.md) owns pending requests.

Agent catalog `kind` is a role, with null for supply that does not declare one. Product surfaces display that absence as Worker without inferring a role from the runtime. Catalog entries remain summaries and carry no private launch configuration.

`TurnErrorSchema.explanation` preserves a closed normalized Git fetch observation through Turn read/list and terminal-event projections. `GitFailureExplanationSchema` permits only fixed categories, a bounded UTC timestamp and typed completeness/status fields; authoritative Zod validation rejects contradictory code/status/subprocess combinations that generated JSON Schema cannot fully express. Worker policy-denial claims and arbitrary diagnostic text are not admitted.

`src/common/reasoning-effort.ts` exports `REASONING_EFFORT_LEVELS` and `ReasoningEffort` as the single Core effort vocabulary in ascending fitting order. Metadata and inference consumers use this export rather than authoring another level set.

`ReasoningEffortSchema` validates explicit Turn preferences using the canonical vocabulary. `turn.start`, canonical Turns, terminal events, and product Turn projections preserve optional `reasoningEffort`; retained absence stays absent. Turn admission freezes the preference and command identity includes the supplied field.

CapabilityCall admits optional namespaced extensions. `openkit.gateway/routeLineage` defines unavailable members and reached attempts with closed failure and terminal-result values; unknown extension namespaces are ignored, while unknown values in the recognized core fail validation. The canonical system-prompt digest restriction remains unchanged.

`GitFailureExplanationReaderSchema` strips descriptive additions, including nested evidence, while preserving code/status/subprocess relationships. `GitFailureExplanationSchema` remains the exact producer assertion.

`src/common/object-reference.ts` owns local `{scopeId,objectId}` references and the sole canonical `openkit:` URI codec. Knowledge page/raw scopes include the exact `kb` identity; `KnowledgeBaseIdSchema` admits independent UUIDv7 only. Skill catalog targets use `skill/server` or `skill/workspace/<workspaceId>` and the existing catalog entry selector, with a required exact SHA-256 version pin in URI form. The shared parser also admits Artifact, Material, Turn input and retrieval-trace targets. It validates identity and encoding without resolving bytes or granting access. [Core Protocol](../../docs/core/protocol.md#scope-qualified-object-references) owns the grammar. `src/common/content-reference.ts` provides the shared captured-original projection and explicit range schemas; Storage validates current owner/base/mount bindings.

`src/common/entity-id.ts` owns shared independent entity allocation and canonical identifier checks under [Core Protocol](../../docs/core/protocol.md#ids). Independent IDs use prefixed UUIDv7; declared derivations use the fixed per-kind UUIDv5 namespace and complete immutable JCS name. The synchronous codec works in Node and browsers. It rejects invalid timestamps, entropy failures and non-JSON name values before returning an identity. Named-kind boundaries use its checks; excluded request IDs, authored selectors, Light App app/record UUIDs and native references retain their owners. The UUID shape supplies no permission, replay proof or record chronology.

Core identifier schemas include `AutomationIdSchema` because Protocol owns the `auto` entity kind. This adds no Automation lifecycle or App runtime configuration schema to the Core package. Conformance fixtures use current canonical identities; explicit malformed and wrong-kind regressions remain separate from positive fixtures.

A retained Task-to-Goal status Item keeps its immutable `goalId` separately from its opaque Item identity. Ordinary status Items omit this field. The [Task Mode owner](../../docs/specs/20260704-task_mode_worker_delegation.md#retained-task-to-goal-identifier-projection) owns exact replay admission and derived names.

`Turn.fileInputs` is the optional ordered inventory of exact original conversation files. Its immutable array position is the input ordinal; names are display metadata and never path segments. Canonical original bytes remain under the receiving Turn outside its JSON record. Retained absence means no file inputs. New request validation and current admission belong to the conversation and storage owners; this inventory grants no access or Worker delivery.

`context-summary` is an additive known Item variant with completed continuation text, required `strategy: rolling | compaction` and producing `logicalModelId`, an environment digest and an exact source range. Rolling covers admitted continuity history; compaction covers only committed Items in one bounded run. It preserves the closed Item discriminator and required source/evidence digests; unknown descriptive additions remain ignorable. Original Items remain canonical. [Context Management](../../docs/specs/20260902-agent_runtime_context_compaction.md#source-bound-summary-items) owns production and current-source validation.

`Turn.internalExecution` retains the internal role, logical model, context strategy and threshold, with the selected `profileId` (null for caller defaults) and effective initial model-turn, Tool-call and deadline limits. The new descriptive fields are optional on reads; absence stays absent and supplies no execution authority. Knowledge Manager inputs also retain notebook owner/base, trigger, instructions and the processed Item ranges. The existing Status Item may retain a native Knowledge maintenance outcome; model prose cannot replace that outcome. `CapabilityCall.extensions` admits `openkit.knowledge/delivery` for the exact delivered answer string. These additions create no execution or delivery store.

Knowledge list items project the exact canonical page contentDigest at the response notebookRevision. This read field supports explicit confirmed removal without adding a second digest or revision authority to durable KnowledgeEntry records.

`src/common/retained-format.ts` owns the shared retained version 1 marker writer and check-before-decode helper. Family owners keep their retained decoders separate from current wire schemas.
`ServerThreadSchema`, `ServerTurnSchema`, `ServerItemSchema` and `ServerTurnEventEnvelopeSchema` preserve the same narrative, lifecycle, Item vocabulary and transcript event families for the immutable `{ kind: 'server' }` owner. Server records prohibit a Workspace anchor and use Server visibility. The existing Workspace schemas retain required Workspace placement and their current audiences. Current Server administration authority governs admission outside these record schemas.

`ServerCapabilityCallSchema` and `ServerUsageRecordSchema` add Server attribution to the existing call and measurement families. They require `owner: { kind: 'server' }`, forbid `workspaceId`, and retain the same call lifecycle and measurement fields. Existing Workspace schemas and types stay unchanged.

`models/policy-v1.ts` holds schema-only retained Policy contracts: statements and lifetime, subject, mediated PermissionDecision, safe invocation evidence, and Policy candidate/outcome. Native configuration and Policy owners supply writers and validators; this package owns no store, evaluator or activation. `schemaVersion: 1` identifies retained shape, while exact content digests identify Policy and statement revisions. Unsupported authority declarations cannot become active through schema acceptance.
