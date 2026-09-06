---
status: Accepted
implementation: Partial
---
# Knowledge Store Governance Rules

Implementation note: the accepted V1 validation, source, maintenance-record, create-only proposal review and application, unchanged-page reversal, and S39-only worker-delivery boundaries are implemented. Governed retrieval remains Partial because it does not yet surface or exclude relevant unresolved conflict-ledger authority.

## Summary

This specification defines the concrete governance rules that make the canonical Knowledge model enforceable in portable files, schemas, validation, proposals, human review, content lineage, retrieval, and bounded maintenance.

OpenKit uses OKF-compatible Markdown as the portable envelope, an OpenKit Knowledge Profile for system-wide governance, and one Workspace Schema for workspace-specific constraints.

Programmatic validation protects structural correctness, the Knowledge Manager supports semantic maintenance through separately owned explicit operations, and authorized human Knowledge Review preserves authority.

Generated learning may become a source-linked pending Knowledge Proposal, but it never self-promotes, self-confirms, or bypasses human review.

## Owns

- OKF-compatible Markdown as the portable knowledge envelope.
- The OpenKit Knowledge Profile and Workspace Schema governance layers.
- Workspace schema lifecycle, validation, migration, conformance levels, and failure behavior.
- Save-time enforcement for governed knowledge records.
- Source identity, source immutability expectations, derived-representation lineage, and source-reference health.
- Observation, claim, conflict, proposal, human-review, create-only proposal-application, content-lineage, and unchanged-page reversal governance.
- Knowledge-selection trace requirements contributed to a separately owned Context Package.

## Does Not Own

- Canonical Knowledge semantics, which `docs/core/knowledge.md` owns.
- Concrete file paths, record encodings, content-digest encoding, database tables, routes, protocol fields, or migration implementation, which the Knowledge Store implementation contract owns.
- Knowledge Manager operation names, callers, typed outputs, or request lifecycle, which the Knowledge Manager service contract owns.
- Context Package identity, files, delivery trace, replay, worker materialization, or final prompt composition, which their owning workflow and Context Package contracts own.
- Permission-policy semantics, audit record schemas, Vault storage, worker capability transport, workspace synchronization, or UI design.
- Domain-specific schemas or raw source-of-truth records owned by external systems.

## Core References

- `docs/core/knowledge.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/storage.md`

## Goals / Non-goals

Goals:

- Keep knowledge user-readable and portable while making active records machine-checkable.
- Keep invalid, stale, conflicting, sensitive, or unreviewed material from silently influencing workers.
- Preserve human authority and exact source, proposal, review, page-content, actor, request, and audit lineage.
- Make accepted proposal application and reversal bounded, idempotent, restart-safe, and fail-closed without another workflow.
- Keep Knowledge selection explainable without duplicating Context Package delivery ownership.

Non-goals:

- Do not define concrete routes, tables, paths, protocol payloads, UI components, or worker prompt assembly.
- Do not create a persistent Knowledge Manager agent, hook system, maintenance runner, retry queue, settlement workflow, or rollback service.
- Do not auto-promote generated learning or use citations, elapsed time, schedules, or absence of rejection as review authority.
- Do not require a specific editor, renderer, search engine, vector store, or graph database.
- Do not define domain-specific HR, marketing, finance, analytics, or engineering schemas.

## Decision

The governed Knowledge Store has three layers:

```text
OKF-compatible files
  -> OpenKit Knowledge Profile
    -> Workspace Schema
```

Only active `Workspace-schema-valid` pages that pass authorization, sensitivity, freshness, conflict, and retrieval policy may enter default worker Knowledge selection.

Every generated Knowledge change remains pending until an authorized human Knowledge Review accepts it.

An accepted review authorizes one Knowledge Store application, but active knowledge changes only when the exact fixed proposal-created page and its complete lineage become durable.

V1 reversal is an explicit authorized Knowledge command that removes only the unchanged page created by that accepted proposal while retaining the proposal, review, request, actor, source, and audit evidence.

## Format And Schema Contract

OKF-compatible files provide Markdown, YAML frontmatter, links, citations, index files, and log files as the portable envelope.

The OpenKit Knowledge Profile defines mandatory governance fields and base rules that every workspace preserves.

The Workspace Schema defines allowed page, source, observation, and claim types plus field constraints, views, proposal rules, review rules, and lint rules for one workspace.

Each workspace MUST have one active machine-checkable Workspace Schema in YAML or JSON.

The schema MUST identify its version, owner or maintainer, active status, timestamps, allowed extension points, validation rules, and review requirements.

Workspace schemas MAY strengthen OpenKit rules but MUST NOT remove or weaken required governance fields.

Schema changes MUST use a reviewable migration flow:

1. Draft and validate the schema change.
2. Dry-run it against existing pages, sources, maintenance records, proposals, indexes, and trace references.
3. Produce a validation report identifying valid, migrated, invalid-draft, and needs-review records.
4. Require human review when active retrieval, required fields, sensitivity, source-reference shape, or review rules change.
5. Apply the change only after authorization and preserve the previous valid schema plus the report.

If migration cannot repair a record safely, that record becomes an invalid or needs-review draft excluded from active retrieval.

If schema migration cannot prove a complete valid result, OpenKit MUST retain the previous valid schema and MUST NOT publish a partially migrated active schema.

## Conformance And Required Fields

OpenKit distinguishes portable format compatibility from active Knowledge validity.

| Level | Meaning | Permitted use |
| --- | --- | --- |
| `OKF-compatible` | The material follows the pinned portable Markdown and frontmatter envelope. | Import, inspection, source retention, or transformation. |
| `OpenKit-profile-valid` | The record satisfies OpenKit-required fields and base rules. | Drafts, proposals, generic tooling, and validation workflows. |
| `Workspace-schema-valid` | The record satisfies the active Workspace Schema. | Active Knowledge after review and policy eligibility. |

External material MAY remain a source or lower-conformance draft until transformed and reviewed; format compatibility alone never authorizes active retrieval.

Every active Knowledge Page and every draft Knowledge Page validated for possible activation MUST carry these fields or equivalent structured metadata. Proposals, reviews, source-registry rows, maintenance ledgers, retrieval traces, indexes, audit records, and usage records use their separately owned exact schemas and are not active Knowledge Pages:

- `type`
- `title`
- `schema_version`
- `openkit_status`
- `scope`
- `source_refs`
- `review_state`
- `sensitivity`
- `freshness`
- `created_at`
- `updated_at`

Field behavior:

- `type` MUST be an OpenKit base type or an allowed Workspace Schema extension.
- `title` MUST be human-readable and non-empty.
- `schema_version` MUST identify the validating Workspace Schema.
- `openkit_status` is the unique OpenKit lifecycle authority and MUST distinguish draft, active, archived, superseded, invalid, and deleted records. Standard OKF `status` is a deterministic projection: draft maps to `draft`, active maps to `stable`, and the other four states map to `deprecated`. A missing standard status means `stable`; a conflicting projection is invalid. Standard status alone never activates an external page.
- `scope` MUST identify the Workspace and any narrower authorized scope.
- `source_refs` MUST exist even when empty; empty references are allowed only for direct user-authored notes, indexes, or policy-approved seed pages.
- `review_state` MUST distinguish unreviewed, user-authored, accepted, rejected, deferred, and needs-review records; there is no provisional active state.
- `sensitivity` MUST be explicit even when material is public or internal.
- `freshness` MUST distinguish evergreen, time-bound, stale, expired, and unknown material.
- `created_at` and `updated_at` MUST be machine-readable timestamps.

Reusable base types are `SourceSummary`, `KnowledgePage`, `Entity`, `Topic`, `Observation`, `Claim`, `Procedure`, `Decision`, `Lesson`, `Proposal`, `Index`, and `Log`.

Workspace Schemas MAY add domain types, but consumers MUST preserve the base governance fields even when they do not understand an extension. OpenKit Knowledge Profile v2 uses `openkit_status`; the standard OKF lifecycle does not add a second state machine, retry policy, or recovery owner. Unknown nested YAML metadata is retained as data, including provenance, trust, and Attested Computation fields; reading or saving it never executes code, performs attestation, accesses a network, or grants authority. Secret-like field and value rejection applies recursively, including arrays; cyclic or excessive alias expansion is rejected before traversal.

## Save-Time Enforcement

All governed writes MUST pass through the Knowledge Store validation boundary.

Code MUST reject an invalid active write or retain it only as an invalid draft excluded from active retrieval.

Validation MUST cover malformed frontmatter, missing fields, disallowed types, invalid `openkit_status`, conflicting standard OKF `status` projection, invalid review state or source references, forbidden secret-like fields, missing sensitivity, invalid freshness or expiration metadata, and attempts to weaken OpenKit-required fields.

An invalid edit MUST NOT overwrite the latest valid active page.

Imports, rough notes, integrations, and drafts MAY be retained as invalid drafts when preserving the material is useful, and their validation errors MUST remain inspectable.

Repairing an invalid draft creates a valid draft or pending proposal according to Workspace policy; it does not silently activate knowledge.

## Source Identity And Lineage

Every Knowledge Source MUST have stable identity across changes to derived representations, summaries, or Knowledge Pages.

Source metadata SHOULD record source identity, type, original location when available, capture time, producer, integrity digest when practical, access and sensitivity, derived-representation links, and retention policy when relevant.

Captured source evidence is immutable by default.

Replacing or recapturing evidence creates a new Knowledge Source id and registry record rather than silently mutating old captured evidence.

Every Derived Representation MUST retain lineage to the exact Knowledge Source id and content digest from which it was produced.

An external locator without captured identity MAY support review, but it MUST NOT be presented as immutable captured evidence.

## Maintenance Records

Observations, candidate claims, conflicts, stale signals, lint findings, and health reports belong to the maintenance layer rather than the default notebook view.

Observation capture MUST be selective and Workspace policy SHOULD bound allowed types, producers, required sources, retention, expiration, aggregation, promotion criteria, and high-impact review requirements.

An Observation MAY be ignored, retained, summarized, aggregated, attached to a pending proposal, or expired; repetition does not promote it automatically.

A Claim is a reusable assertion that may influence future work and therefore MUST carry sources, confidence, freshness, scope, review state, and conflict status.

Accepted claims MAY support a pending Knowledge Proposal, but they MUST NOT become active page content without human Knowledge Review.

Conflict states SHOULD distinguish conflicting, needs-review, weak-evidence, stale, resolved, superseded, and partially superseded material.

Knowledge selection MUST surface unresolved conflicts and MUST NOT present one side as uncontested truth when the Workspace intentionally preserves competing views.

Maintenance records SHOULD use bounded append-only ledgers or equivalent history-preserving records; they MUST NOT create another Knowledge source of truth.

## Proposal And Human Review Rules

A V1 generated Knowledge Proposal MUST request creation of one absent Knowledge Page whose id has never received an accepted generated proposal. The retained accepted Proposal and Review permanently reserve that page id against later generated proposals even after bounded reversal; a later generated lesson uses a new page id. This is the V1 compromise that prevents an old proposal from claiming or reversing a later byte-identical generated page without adding a tombstone, page revision, or application owner. Generated update, replacement, merge, split, patch, supersede, archive, and delete operations are not authorized by this contract and remain deferred.

Before review, the proposal MUST fix its exact target Knowledge Page id, complete canonical page bytes, content digest, source references, rationale, confidence, freshness, sensitivity, scope, producer, creation time, and whether it was generated from completed work history. S61 encodes proposal creation time and the server-owned producer directly, derives freshness, sensitivity and scope from the digested candidate page bytes, and derives the completed-work fact only from the closed immutable Turn, Item and strict live S39 source-reference tuple, so imported history cannot masquerade as a new worker result and no duplicate field can disagree. Review input or response-only content cannot replace those durable candidate bytes.

V1 generated proposals may cite exact registered Sources, directly `user-authored` Knowledge Pages, or the one strict completed-work trio. They MUST NOT cite another `accepted` generated Page as proposal evidence. This bounded compromise avoids a transitive proposal-authority graph; a user may restate the needed fact in a reviewed user-authored Page or register the underlying material as a Source.

Every generated proposal begins pending and remains excluded from active retrieval.

Only an authorized human Knowledge Review may accept, reject, or defer a generated proposal. Changing the fixed candidate requires a new proposal in V1; there is no combined edit-and-accept transition.

Policy MAY validate, route, batch, or prioritize proposals, but it MUST NOT substitute for human acceptance.

An authorized human MAY create or edit knowledge directly with `review_state: user-authored`; that write MUST pass current validation and creates no synthetic proposal or review identifier. The accepted Knowledge scope does not expand the existing direct-mutation concurrency, command, or Audit contract and does not create a historical-content record family.

Rejecting a proposal closes it without an active Knowledge mutation.

Deferring a proposal keeps it non-active and reviewable without authorizing application. A later review decision appends to the same proposal's review history.

Accepting a proposal creates durable application authorization; it does not itself prove that the fixed page was published. Acceptance and rejection are terminal, while one or more deferred decisions may precede the terminal decision.

## Accepted Proposal Application

The existing Knowledge Store mutation owner applies an accepted create-only proposal exactly once; this specification introduces no application runner, queue, application record, settlement record, or recovery workflow.

The application MUST validate the accepted proposal, human review, target absence, fixed bytes and digest, sources, Workspace scope, authorization, schema, sensitivity, freshness, and conflict state immediately before publication. A latest conflict row is unresolved exactly while its status is `conflicting`, `needs_review`, `weak_evidence`, or `stale`; `resolved`, `superseded`, and `partially_superseded` do not block publication. An unresolved row is relevant exactly when one of its `subjectReferences` names the target as `knowledge:<knowledgePageId>`, exactly equals a fixed proposal source reference, or equals the digest-free owner form of a qualified `source:` or `knowledge:` proposal source. The conflict row's own `sourceReferences` are evidence for that conflict and do not make it relevant. A relevant unresolved conflict returns `409 conflict` before the accepted Review or Page write; no conflict workflow or derived state is created.

The existing proposal, review, page, command-idempotency, and audit owners MUST make the business activation tuple and separate command-completion evidence verifiable without a new record family:

- proposal identifier
- accepting review identifier
- target Knowledge Page identifier
- an accepted review row whose `targetAbsentAtDecision` is true after the exact safe target path was checked
- created page content digest
- source references
- producer and authorized reviewer actor references
- decision request identifier and application time as command-completion evidence

The exact proposal, accepted human review, fixed proposal-created page and digest, sources, producer, reviewer, and Workspace form the business activation tuple. The active read projection MUST expose those exact authorized bytes or no applied page; it MUST NOT expose different, unreviewed, unlineaged, or partially validated bytes. Audit and receipt evidence gate the decision command's success and replay projection, not activation of an otherwise complete business tuple.

Application uses the existing request-idempotency owner:

- An exact replay with a completed command receipt returns the same page identity, content digest, and current projection.
- Reusing a request identifier with changed input returns `409 idempotency_key_conflict`.
- If the exact accepted review is durable and the fixed target page is absent, the same authorized decision request MAY complete that one deterministic page write from the proposal's fixed bytes and digest.
- If the complete business activation tuple exists but Audit or the completed receipt is absent, the page remains active, while the operation returns `409 recovery_required` and does not synthesize the missing command evidence or reconstruct success.
- If the target already existed before the authorized effect, carries different bytes, or any required proposal, review, page, digest, source, producer, reviewer, or Workspace lineage is missing or contradictory, the operation returns `409 conflict` or `409 recovery_required` as specified by S61 and performs no inference, reconstruction, second application, or repair.

After restart, replay and inspection use only the durable proposal, review, page, request-idempotency, and audit owners.

Process memory, current page content, a generated summary, or an S61 retrieval trace MUST NOT reconstruct missing application authority.

## Bounded Reversal

V1 reversal is an explicit authorized Knowledge command naming the original proposal, accepting review, fixed Knowledge Page id, expected content digest, and reversal request id. The original decision request id resolves through the named immutable review row rather than being duplicated in the reversal request.

Exact replay with matching completed reversal command and audit evidence returns the same completed reversal without another page effect. Otherwise, the command MAY remove only the page created by that proposal and only while its current bytes still match the fixed digest. The retained accepted Proposal and Review continue to reserve the page id after removal, so another proposal targeting that id returns `409 conflict`. A changed target returns `409 conflict` with zero mutation; a missing page without matching completed reversal evidence, or contradictory proposal, review, page, command, source, actor, digest, or audit authority, returns `409 recovery_required`.

The original proposal, review, decision request, sources, actors, created-page digest, reversal request, and audit evidence remain durable.

Reversal creates no second proposal, review, revision, tombstone, rollback record, recovery state, or workflow and does not claim to undo worker or external effects that occurred before reversal.

## Generated Learning Governance

V1 permits only an explicit agent-driven composition of existing work-history reads and the existing Knowledge Proposal draft operation; it creates no reflection operation or private lifecycle.

A V1 generated-learning proposal may cite only the closed exact source-reference forms defined by S61. A proposal derived from completed worker work MUST cite one terminal same-Workspace direct-Task worker Turn, the final completed `assistant-message` Item projected by that Turn, and that Turn's exact accepted S39 Context Package trace and digest. Other Artifacts, reviews, evidence, audit, usage, or external material may guide agent or human judgment, but they become proposal evidence in V1 only after explicit capture through the existing registered Knowledge Source owner.

The Context Package contract exclusively decides whether a trace proves worker delivery; this specification consumes that proof and does not redefine it.

Workspace-only work, imported history, replay reconstruction, standalone Knowledge selection or materialization, and records without accepted delivery proof MUST NOT be labelled as worker output.

Generated learning always remains pending until human Knowledge Review accepts it.

There is no provisional active state, auto-promotion, TTL confirmation, citation counter, citation-based acceptance, expiry sweep, or scheduled confirmation path.

Later citations MAY be observations about usefulness, but they are never review authority.

Passive, event-triggered, or scheduled learning generation remains deferred until real usage proves a need and a separately accepted trigger scope exists; any future automation may draft pending proposals only.

## Knowledge Manager Boundary

The Knowledge Manager service specification exclusively owns V1 operation names, callers, typed outputs, errors, and request lifecycle.

This governance contract requires only that Knowledge Manager writes create pending proposals through the existing Knowledge Store owner and never apply repairs, promote learning, schedule maintenance, or create private lifecycle state.

## Health And Repair

The Knowledge Manager service contract exclusively owns the V1 health operation and report shape.

This governance contract requires that health inspection remain explicit and report-only.

It MUST NOT apply repairs, draft proposals, schedule work, or mutate knowledge.

Future repair application requires separately accepted scope and MUST use the same proposal and human-review path whenever meaning, authority, sensitivity, scope, freshness, retrieval eligibility, or future worker behavior may change.

## Knowledge Selection Trace Boundary

Knowledge retrieval MUST produce a deterministic selection result for identical authoritative inputs, index state, and policy state.

Its trace contribution MUST identify selected Knowledge Page ids and content digests, selected source or derived-representation references, excluded candidate identifiers and reasons, and applicable freshness, sensitivity, conflict, policy, and budget decisions.

The concrete Context Package owner decides package identity, trace shape, file inventory, delivery proof, replay, materialization, and product-versus-audit visibility.

The governed Knowledge retrieval trace proves only that selection ran; it does not prove worker delivery or use.

Only the owning worker-Turn delivery trace may prove which selected Knowledge reached a worker.

Restricted trace evidence MUST remain redacted or access-controlled under the owning policy and audit contracts.

## Capability Conformance

| Surface | Minimum governance |
| --- | --- |
| Import or capture | Portable source material or lower-conformance draft. |
| Draft create or rough note | OpenKit required fields when governed; invalid material may remain an invalid draft. |
| Proposal creation | `OpenKit-profile-valid` target shape or an invalid draft with attached errors. |
| Active Knowledge save | Human-authored or human-reviewed, policy-eligible, `Workspace-schema-valid` page with complete content and actor lineage. |
| Default notebook view | Active valid pages plus pending proposals and user-selected maintenance views. |
| Default worker Knowledge selection | Active, authorized, non-expired, policy-eligible `Workspace-schema-valid` pages. |
| Lower-conformance source snippet | Explicit policy authorization plus traceable source identity and exclusion reasoning. |
| Health inspection | Any conformance level, report only. |

## Current Implementation Projection

The current V1 implements portable governed page projection, the default Workspace Schema, pre-write validation and secret-like-field rejection, source identity and first text-derived metadata, observation and claim ledgers, conflict recording and resolution, derived indexes, deterministic retrieval traces, proposal review and application, and explicit Knowledge context preparation. The retrieval path does not yet consume the latest conflict ledger, so it cannot satisfy the required unresolved-conflict selection and trace decision; this bounded implementation defect remains scheduled under S60/S61 before the next generated-Knowledge release claim.

The transport-neutral operation catalog, bundled CLI, and public App API project those existing owners; no user-facing MCP facade remains.

Worker-facing Knowledge capability routes remain disabled and are not current product behavior.

The accepted-proposal path freezes exact create-only page bytes and digest, preserves proposal-to-review-to-page lineage, applies the one deterministic missing-page effect only for its matching accepted decision, and otherwise returns `recovery_required` for incomplete or contradictory authority. Bounded reversal removes only the unchanged proposal-created page and retains its durable evidence.

Context preparation references the single governed retrieval trace and exposes no standalone worker-context trace or materialization. Only S39 materializes and proves worker delivery.

No provisional auto-promotion, citation confirmation, TTL expiry, scheduled Knowledge maintenance, or passive Knowledge Manager trigger is implemented or accepted.

Concrete implementation detail remains in the Knowledge Store implementation, Knowledge Manager service, and Context Package specifications rather than being duplicated here.

## Testing Strategy / Acceptance Criteria

Use existing package and NanoCore suites; this specification authorizes no new runner, harness, or fixture framework.

- L1 governance tests cover active-write validation, secret rejection, source identity, generated-pending and human-review authority, direct-mutation lineage, create-only application, bounded reversal, and fail-closed partial evidence.
- L2 contract tests prove proposal, review, page, command, actor, source, digest, and audit lineage remains resolvable without exposing restricted evidence or adding another lifecycle owner.
- S61 owns implementation and interruption tests, S17 owns caller and error tests, S39 owns direct-Task delivery tests, and S18 owns the single real L6 composition; this governance spec does not duplicate them.

Acceptance requires all of these predicates:

- Generated learning never becomes active without human Knowledge Review.
- One accepted V1 generated proposal creates at most one exact active page.
- Every active proposal-created page has the complete business activation tuple; every claimed successful or replayed application additionally has its request, Audit, and receipt evidence.
- Missing or contradictory application evidence fails `recovery_required` without inference or repair.
- Workspace-only, imported, reconstructed, or standalone Knowledge provenance cannot claim worker output.
- Only the owning worker delivery trace proves later Knowledge use.

## Risks & Mitigations

- Risk: human review becomes noisy before real proposal volume exists. Mitigation: allow bounded batching and prioritization without changing acceptance authority; automate only after real-use evidence.
- Risk: separate review and page writes leave a bounded interrupted state. Mitigation: report success only after both verify, allow only the same authorized command to complete its one deterministic missing page effect, and return `recovery_required` for every contradictory state.
- Risk: reversal is mistaken for undoing downstream effects. Mitigation: reversal changes future active Knowledge only and preserves prior use evidence.
- Risk: Knowledge selection trace duplicates Context Package authority. Mitigation: retain only the Knowledge contribution and defer package identity, delivery, and replay to the owning contract.

## Resolved Decisions

- OKF-compatible Markdown is the portable envelope; the OpenKit Knowledge Profile and Workspace Schema decide active validity.
- Programmatic validation enforces structure, Knowledge Manager operations support bounded maintenance, and authorized humans own Knowledge Review.
- Invalid material may remain a draft but never silently enters active retrieval.
- Raw captured sources are immutable by default and Derived Representations retain exact source-version lineage.
- Observations and claims remain maintenance evidence until human-reviewed proposals promote reusable interpretation.
- Generated learning is always a pending source-linked proposal; provisional auto-promotion and self-confirmation do not exist.
- Accepted generated-proposal application is one idempotent create-only Knowledge Store mutation with exact page-content lineage and fail-closed partial-state handling.
- Reversal names the original accepted proposal and review, removes only their unchanged created page through one authorized command, retains command and audit evidence, and never creates another proposal, review, content-history family, or claim of undoing prior external effects.
- Knowledge selection contributes traceable page ids, content digests, and exclusions, while the separately owned worker delivery trace alone proves worker receipt.

## Deferred / Future Work

- Richer source conversion, binary capture, semantic retrieval, and broader source-reference validation remain deferred until current retrieval evidence justifies them.
- Broader health and repair classes remain deferred; meaning-changing repair always requires a proposal and human review.
- Passive, event-triggered, or scheduled proposal drafting requires real-use evidence plus a separately accepted trigger contract and may never authorize promotion.
- Richer imported notebook migration tools remain deferred until real incompatible bundles require them.

## Links

- `docs/core/knowledge.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
