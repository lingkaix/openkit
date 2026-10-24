---
date: "2026-10-24"
---
# Independent Documentation Audit: Protocol Group

This non-authorizing record holds the protocol group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `05140a42f8b6aef63b399c259677ff2873307e6b` (`main` on 2026-10-24). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/protocol.md`.
- Specifications: `20261021-protocol_identifiers_and_enums.md` and `20260704-app_api_openapi_projection.md`.
- Cited decisions read: `20261014-one_identifier_mechanism.md` (through the specification), `20261016-identifier_derivation_and_import_allocations.md` (through the specification), `20261016-retire_stateless_quick_chat.md`, `20260921-four_turn_terminal_states.md` (through the Core text), and `20260928-compatibility_rests_on_data.md` (through the Core text).
- G3 inspection: two read-only inspector contexts (PR-IDE for identifiers, enums, and the concrete Core protocol claims; PR-OAS for the OpenAPI projection). They read code only and ran no tests. The auditor verified each kept finding against the code.

## G2 Core Against Specifications

- PR-G2-01: `protocol.md` said that Core Concepts "owns `TriggerSource` as a Turn sub-field", while `core-concepts.md` says that Protocol owns the concrete trigger-source values and field shape (carried from FND-G2-03). Disposition: the sentence now says that Core Concepts defines the sub-field and Protocol owns the values, which Turn Semantics and Pending Request Semantics name, and the field shape. Listing the seven code values is part of Question Q-32.
- PR-G2-02: `protocol.md` requires namespaced error codes and itself uses the flat codes `recovery_required` and `idempotency_key_conflict`. Question Q-31.
- PR-G2-03: `protocol.md` lists the item type `context-injection`, and the identifiers specification lists the delta kind `context-injection-updated`, while `20260703-knowledge_store_implementation.md` names `knowledge-injection`. Question Q-29.
- PR-G2-04: `protocol.md` lists a `KnowledgePage` record; the protocol package has `KnowledgeNotebookPageSchema`. The record name belongs to the knowledge group; noted there.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| PR-IDE-01 | Delta kind `context-injection-updated` and item type `context-injection` | `packages/protocol/src/common/item-delta.ts:15` and `packages/protocol/src/models/item.ts:43` use `knowledge-injection-updated` and `knowledge-injection`; `apps/nanocore/src/storage/retained-work-events-v1.ts:36,310,329` retains them | Two accepted documents conflict (PRECEDENCE-003); the code value is retained data | Question Q-29; the projection states the code names |
| PR-IDE-02 | Each item type declares its delta kinds | `item.ts:27-45` adds `generative-ui-reference` (with `snapshot-updated`) and `context-summary` (with none); their owners are `20260908-generative_ui_interaction.md` and `20260902-agent_runtime_context_compaction.md` | The table lacks two accepted item types | Question Q-30; the projection states both |
| PR-IDE-03 | Delta validation, audit of a violation, and a `core.protocol.*` code | Schemas in `packages/protocol/src/events/envelope.ts` reject undeclared combinations at parse; no `core.protocol.` code in `apps` or `packages` | The MUST holds at parse; the SHOULD parts are not built and `implementation: Partial` covers them | Projection now states it |
| PR-IDE-04 | Correlation: an indexed delta names a part that was introduced earlier; a resolution names the same request | Schemas check field presence only | No owner is named for the cross-event check | Question Q-33 |
| PR-IDE-05 | Core: error codes MUST be namespaced | Most NanoCore codes are flat (`recovery_required`, `invalid_request`, `workspace_access_denied`); `core.auth.*` is used and not reserved; most reserved namespaces are unused | Core conflicts with itself | Question Q-31 |
| PR-IDE-06 | Core Records list `KnowledgePage` | `packages/protocol/src/models/knowledge.ts:4` defines `KnowledgeNotebookPageSchema` | Naming drift | Carried to the knowledge group (PR-G2-04) |
| PR-IDE-07 | Projection names no file | `entity-id.ts`, `item-delta.ts`, `envelope.ts`, and `conformance/` exist | Projection drift | Corrected |
| PR-IDE matches | Prefix registry (43 kinds), 16 namespace constants (recomputed), validator version and variant rules, JCS encoding, derived producers, item-to-delta rows, four enum lists, Event Families, discovery response, seven-day receipt default | `packages/protocol/src/common/entity-id.ts`, `apps/nanocore/src/lib/store.ts:351,1241,1252` | Match | None |
| PR-OAS-01 | Non-goals: worker-plane routes are "accepted but unimplemented" | `apps/nanocore/src/runtime/worker-control-routes.ts:62`, `apps/nanocore/src/llm/gateway-routes.ts:2482`, `apps/nanocore/src/worker-mcp-routes.ts:230` | Projection drift | "accepted but unimplemented" removed; NanoCore mounts the families under `/api/worker-control/`, `/api/worker-inference/`, and `/api/worker-capabilities/`, and the bare names follow the NanoHost transport hop, so the names are kept |
| PR-OAS-02 | "all nine JSON operation bindings" | `binding: 'json'` counts 5, 3, and 2 in `packages/app-api-schemas/src/{automation,scheduler,recovery}-operations.ts` | Projection drift | Corrected to ten |
| PR-OAS-03 | "The eleven ordinary Workspace, Thread and Turn commands" | No grouping of the current definitions gives eleven | Projection drift | Count removed |
| PR-OAS-04 | Quick Chat uses a canonical operation id | No `chat.quick` definition; `apps/nanocore/src/openapi.test.ts:433` asserts its absence | Document outdated by [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md) | Corrected, with the decision cited |
| PR-OAS-05 | Closed list of routes outside the projection | `openapi.test.ts:44-62` also classifies `/internal`, the Discord interactions ingress, and NanoHost transport routes as non-App; no test-support route exists | No record decides the list | Question Q-34 |
| PR-OAS-06 | Serving route uses the diagnostics auth posture | `apps/nanocore/src/app.ts:2011` serves `/api/openapi.json` to any authenticated actor; `/api/diagnostics` (line 1954) requires an administrator | Ambiguous phrase | Question Q-35 |
| PR-OAS-07 | Digest "over its version, paths, and components" | `apps/nanocore/src/openapi.ts:793-808` hashes components, info, OpenAPI version, paths, and protocol version | Projection drift | Corrected |
| PR-OAS-08 | First-party packages MUST NOT consume the document for types, validation, or client generation | `apps/nanocore/src/auth/operation-authorizer.ts:1065` reads the in-process document for route identity | Not forbidden by the text; against the stated direction | Question Q-36 |
| PR-OAS matches | Document fields, security schemes, one `ApiError` component, cached serving, SSE exclusion, sync and transfer counts, scripts and checks, no codegen import, `registerAppApiRoute`, `implementation: Implemented` | `apps/nanocore/src/openapi.ts`, `apps/nanocore/openapi/app-api.openapi.json` | Match | None |

## G4 Organization

No move, merge, or split is proposed.

## G5 Writing

- The item delta kind table in the identifiers specification had a three-column header with a two-column separator. The separator now has three columns.
- The identifiers specification's Rollout section narrated the relocation that created it, and its last acceptance bullet checked that relocation. The Rollout section now says that the specification adds no migration and keeps the cutover boundary; the relocation bullet is removed because Git holds that history (`docs/writing.md`, no revision sections).
- The OpenAPI specification called the excluded stream "the current turn-scoped SSE route"; the route is the Thread event stream (`apps/nanocore/src/turn-event-routes.ts:31`), as its own Does Not Own section says. The sentence now names the Thread event stream; the MUST NOT is unchanged.
- `protocol.md` sets receipt expiry at "exactly seven days" without the property it protects. Question Q-37.
- Remaining candidates noted only: the empty `## Contract / Expected Behavior` heading of the identifiers specification, and migration wording ("now derive", "former ... are absent") in the OpenAPI projection, which states current absence and so is kept.

## Semantic Preservation

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `docs/core/protocol.md` | 201 unchanged; 1 descriptive sentence changed (PR-G2-01) | 0 | 252 unchanged | 35 unchanged | 15 unchanged |
| `20260704-app_api_openapi_projection.md` | 41 unchanged, 1 reworded (Thread event stream; the MUST NOT is unchanged) | 0 | 109 unchanged, 1 added (`chat.quick`) | 28 unchanged | 6 unchanged, 1 added |
| `20261021-protocol_identifiers_and_enums.md` | 61 unchanged | 0 | 184 unchanged, 10 added (projection file names and code values) | 21 unchanged | 11 unchanged |

The Rollout sentence "It changes no identifier, enum value, retained record, wire shape, capture implementation, or runtime behavior" described the relocation change and is replaced by "This specification adds no migration"; the cutover boundary sentence is kept. The removed acceptance bullet ("Check inbound links and regenerate the documentation index after relocating these inventories") applied only to the completed relocation, and no remaining criterion depends on it. No heading anchor or file moved.

## Issues Opened

None. Every divergence in this group is either projection drift or a conflict between accepted texts.

## Questions For The Engineer

### Q-29. Is the context Item named `context-injection` or `knowledge-injection`?

- Context: Core Protocol, Core Mediation, the identifiers specification, and the Worker capability specification use `context-injection` and `context-injection-updated`. The Knowledge store specification and the code use `knowledge-injection` and `knowledge-injection-updated`, and retained work events hold those values.
- Options: (A) Change the documents to `knowledge-injection`. (B) Rename the code and migrate retained events one way.
- Recommendation: A. The code value is retained data, and Contract Evolution asks not to churn a settled mechanism without a design need.
- Meanwhile: the projection states the code names.

### Q-30. Should the item-to-delta table list `generative-ui-reference` and `context-summary`?

- Context: both item types are accepted by later specifications and exist in the schema, but the table that "MUST declare" each type's delta kinds omits them.
- Options: (A) Add `generative-ui-reference` with `snapshot-updated` and `context-summary` with no delta kind. (B) Leave the table as initial guidance.
- Recommendation: A.
- Meanwhile: the projection states both.

### Q-31. What does the error-code rule require?

- Context: Core Protocol says error codes MUST be stable namespaced strings and reserves namespaces, but Core itself uses flat `recovery_required` and `idempotency_key_conflict`, most NanoCore codes are flat, `core.auth.*` is used and not reserved, and most reserved namespaces have no code.
- Options: (A) Amend Core: codes are stable machine-readable strings; the reserved namespaces apply to namespaced codes; flat Core command codes are allowed. (B) Rename the codes into namespaces before `v0.1.0`.
- Recommendation: A. Clients already branch on stable codes, and B renames hundreds of call sites with no behavior gain.
- Meanwhile: no change.

### Q-32. Should the identifiers specification list the remaining closed enums?

- Context: the specification calls itself the human-readable source for core closed enum families, but it does not list Workspace status (`active`, `archived`), Thread status (`active`, `archived`), Item status (`in_progress`, `completed`, `failed`, `declined`), `stopReason` (`completed`, `error`, `aborted`, `length`, `budget_exhausted`), or the Turn trigger source kind (seven values in `packages/protocol/src/models/turn.ts:105-113`, of which Core Protocol spells only `approval-resolution` and `user-input`). This is part of G1-CR-T2 and Q-01.
- Options: (A) Add the five lists from the schemas. (B) Narrow the claim to the listed families.
- Recommendation: A, with the decision on Q-01.
- Meanwhile: no change.

### Q-33. Who checks delta correlation across events?

- Context: the specification requires that an indexed delta names a part introduced earlier and that a resolution names the same request. A stateless schema checks only presence.
- Options: (A) State that the relation is a producer obligation proved by conformance fixtures. (B) Add a stateful ingest check in Core.
- Recommendation: A.
- Meanwhile: no change.

### Q-34. Should the closed exclusion list match the coverage test?

- Context: the list omits `/internal`, the Discord interactions ingress, and NanoHost transport routes, which the test classifies as non-App, and it names test-support routes that do not exist.
- Options: (A) Add the three surfaces with their owners and drop test-support. (B) Keep the list.
- Recommendation: A. A closed list that the gate does not match invites silent additions.
- Meanwhile: no change.

### Q-35. Which actor may read `/api/openapi.json`?

- Context: the specification says the same posture as diagnostics read models. Diagnostics require an administrator; the document is served to any authenticated actor.
- Options: (A) State "authenticated". (B) Require an administrator.
- Recommendation: A. The document holds no secret and describes the release that the actor already uses.
- Meanwhile: no change.

### Q-36. May NanoCore read the generated document for route identity?

- Context: the operation authorizer builds its route table from the in-process document. The text forbids types, validation, and client generation from it, and its stated direction is that the projection never feeds back.
- Options: (A) Derive the route table from the catalog and the definition tables directly. (B) Permit in-process route identity from the pure projection.
- Recommendation: A, as a small follow-up. It keeps the direction and has the same source.
- Meanwhile: no change.

### Q-37. Which property does the seven-day receipt expiry protect?

- Context: Core Protocol sets `expiresAt` at exactly seven days after `createdAt`. `docs/writing.md` requires an experience-chosen number to be a current default with the property it protects.
- Options: (A) State the property (for example the longest client retry window) and mark the value as the current default. (B) Keep it as a fixed rule.
- Recommendation: A, with the engineer's statement of the property.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code itself. Verdict: accept with changes. Dispositions:

1. The rewritten Rollout sentence said that the cutover boundary "performs no data reset", while the IDs section deletes the old identifier data before the change ships. Accepted; the clause is removed, and the sentence now says only that the boundary remains binding.
2. The added trigger-source list made five code spellings canonical that Core does not spell, and it partly decided Q-32. Accepted; the list is removed and the trigger source kind is now part of Q-32.
3. The Core sentence said that Turn Semantics names the field shape. Accepted; it now says that Turn Semantics and Pending Request Semantics name the values, and that Protocol also owns the field shape.
4. The PR-OAS-01 citation for the inference route pointed at an error throw. Accepted; it now cites line 2482.
5. The removed acceptance bullet was not listed in Semantic Preservation. Accepted.
6. The finding IDs skipped PR-IDE-06. Accepted; the row is added.

The Reviewer confirmed the remaining evidence cells, the OpenAPI projection fixes, the table separator fix, that the projection paragraph decides no question, and that the diff has no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (665 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
