---
status: Accepted
kind: concept
implementation: Partial
aspect: knowledge
---
# Knowledge Store Governance Rules

This specification defines the governance rules that make the canonical Knowledge model enforceable across Open Knowledge Format (OKF) files, the OpenKit Knowledge Profile, Scope Schemas, save-time validation, Source and Derived Representation lineage, Observations and Claims, delegated editing and required human Review, and Knowledge-selection traces.

## Scope

### Owns

- The three-layer Knowledge Store schema contract (OKF-compatible Markdown, OpenKit Knowledge Profile, and Scope Schema), conformance levels, required governance fields, and save-time enforcement.
- Scope Schema lifecycle, validation, reviewed migration flow, and failure behavior.
- Source identity, versioned `SourceSummary` pointers, immutability, and Derived Representation lineage.
- Reusable Observation, Claim, conflict-assessment, delegated-publication, required Proposal/Review, and history/restoration governance rules.
- Knowledge-selection trace contributions and boundaries against Worker Context Package delivery proof.

### Does Not Own

- Canonical Knowledge semantics in `docs/core/knowledge.md`.
- Concrete file paths, record encodings, digest derivations, SQLite tables, routes, or retrieval-pipeline mechanics in `docs/specs/20260703-knowledge_store_implementation.md`, or fixed-base multi-page editing in `docs/specs/20260909-knowledge_notebook_editing.md`.
- Knowledge Manager operation names, callers, and request lifecycles in `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`, or Personal Memory, scoped learning, and completed-work reflection in `docs/specs/20260909-personal_memory_and_knowledge_learning.md`.
- Worker Context Package identity, materialization, and delivery proof in `docs/specs/20260703-worker_context_package.md`.
- Permission-policy semantics, Audit schemas, Vault storage, Worker capability transport, workspace synchronization, UI design, or external domain schemas.

### Core

- `docs/core/knowledge.md`
- `docs/core/policy.md`
- `docs/core/evidence.md`
- `docs/core/storage.md`

## Format And Schema Contract

The governed Knowledge Store has three layers:

```text
OKF-compatible files
  -> OpenKit Knowledge Profile
    -> Scope Schema
```

- OKF-compatible files provide Markdown, YAML frontmatter, links, citations, index files, and log files as the portable envelope.
- The OpenKit Knowledge Profile (`OPENKIT_KNOWLEDGE_PROFILE_VERSION` in `apps/nanocore/src/knowledge/okf.ts`) defines mandatory governance fields and base rules that every owner scope preserves.
- The Scope Schema (`DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION` by default in `apps/nanocore/src/knowledge/okf.ts`) defines allowed page, source, observation, and claim types plus field constraints, views, proposal rules, review rules, and lint rules for one User, Workspace, or Server owner.
- Only active `scope-schema-valid` pages that pass authorization, sensitivity, freshness, conflict, and retrieval policy may enter default Worker Knowledge selection; `restricted` pages and non-Memory `confidential` pages are excluded as `sensitive_content`, and `stale` or `expired` pages are excluded as `freshness_expired`.
- Each owner scope MUST have one active machine-checkable Scope Schema in YAML or JSON identifying its version, owner or maintainer, active status, timestamps, allowed extension points, validation rules, and review requirements.
- Scope Schemas MAY strengthen OpenKit rules and add domain types, but MUST NOT remove or weaken required governance fields.

Schema changes MUST use a reviewable migration flow:

1. Draft and validate the schema change.
2. Dry-run it against existing pages, sources, maintenance records, proposals, indexes, and trace references.
3. Produce a validation report identifying valid, migrated, invalid-draft, and needs-review records.
4. Require human review when active retrieval, required fields, sensitivity, source-reference shape, or review rules change.
5. Apply the change only after authorization and preserve the previous valid schema plus the report.

If migration cannot repair a record safely, that record becomes an invalid or needs-review draft excluded from active retrieval. If schema migration cannot prove a complete valid result, OpenKit MUST retain the previous valid schema and MUST NOT publish a partially migrated active schema. Reviewed Workspace schema application (`knowledge.schema.apply`) uses [Durable Execution And Control Store](20261019-durable_execution_and_control_store.md#reviewed-workspace-schema-application) without an idle requirement or lifecycle freeze: activation commits byte-identical reviewed candidate content with Audit and original receipt when reviewed impact classes bound actual impact, refusing on a changed base or new impact class for re-review while pending schema-dependent writes revalidate their schema head and immutable traces remain history.

## Conformance And Required Fields

OpenKit distinguishes portable format compatibility from active Knowledge validity:

| Level | Meaning | Permitted use |
| --- | --- | --- |
| `OKF-compatible` | Follows the pinned portable Markdown and frontmatter envelope. | Import, inspection, source retention, or transformation. |
| `OpenKit-profile-valid` | Satisfies OpenKit-required fields and base rules. | Drafts, proposals, generic tooling, and validation workflows. |
| `scope-schema-valid` | Satisfies the active Scope Schema. | Active Knowledge after review and policy eligibility. |

External material MAY remain a source or lower-conformance draft until transformed and reviewed; format compatibility alone never authorizes active retrieval.

Every active Knowledge Page and every draft Knowledge Page validated for possible activation MUST carry the required profile fields defined by `REQUIRED_PROFILE_FIELDS` and `REQUIRED_SCOPED_KNOWLEDGE_FEATURES` in `apps/nanocore/src/knowledge/okf.ts` (Proposals, Reviews, Source records, operational `WorkObservation`, User suppression, retrieval traces, indexes, Audit, and Usage records use their own schemas):

- `type`: an OpenKit base type (`OPENKIT_BASE_TYPES`) or an allowed Scope Schema domain extension (`OPENKIT_DOMAIN_TYPES` in `apps/nanocore/src/knowledge/okf.ts`). Under [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md), Skills own reusable procedures, so governed ScopeSchema and page admission refuse `Procedure` (while generic external OKF parsing remains permissive for `Procedure`, and descriptive Topic/context pages or references to selected Skill versions remain valid).
- `title`: human-readable, non-empty string; `schema_version`: identifies the validating Scope Schema; `created_at` and `updated_at`: machine-readable ISO 8601 offset timestamps.
- `openkit_status`: the unique OpenKit lifecycle authority (`DEFAULT_STATUS_VALUES` in `apps/nanocore/src/knowledge/okf.ts`). Standard OKF `status` is a deterministic projection (`STANDARD_STATUS_BY_OPENKIT_STATUS`: `draft` -> `draft`, `active` -> `stable`, and the remaining states -> `deprecated`; missing standard `status` means `stable`, and a conflicting projection is invalid). Standard `status` alone never activates an external page.
- `scope`: identifies the exact User, Workspace, or current Server owner (`KnowledgeOwnerScopeSchema` in `packages/protocol/src/models/knowledge-notebook.ts` under `docs/specs/20260909-personal_memory_and_knowledge_learning.md`); narrower source restrictions remain additional constraints, never scope substitution.
- `source_refs`: string list that MUST exist even when empty; empty references are allowed only for direct user-authored notes, indexes, or policy-approved seed pages.
- `review_state` (`DEFAULT_REVIEW_STATE_VALUES` in `apps/nanocore/src/knowledge/okf.ts`; there is no provisional active state), explicit `sensitivity` (`DEFAULT_SENSITIVITY_VALUES` and `KNOWN_SENSITIVITY_VALUES`, explicit even when `public` or `internal`), and `freshness` (`DEFAULT_FRESHNESS_VALUES`).

Notebook revision is the service-resolved Git commit ID outside page frontmatter (exact identity is owner scope, notebook revision, page path, and SHA-256 content digest). Consumers MUST preserve base governance fields even when they do not understand a domain extension. Unknown nested YAML metadata (including provenance, trust, and Attested Computation fields) is retained as data without executing code, performing attestation, accessing a network, or granting authority. Secret-like field-name rejection (`SECRET_FIELD_PATTERN`) applies recursively including arrays, and cyclic or excessive YAML alias expansion is rejected before traversal; frontmatter values are ordinary content and are not rejected by credential patterns ([No Credential-Pattern Rejection Of Ordinary Content](../decisions/20261006-no_credential_pattern_rejection_of_ordinary_content.md)).

## Save-Time Enforcement

- All governed writes MUST pass through the Knowledge Store validation boundary, covering malformed frontmatter, missing fields, disallowed types, invalid `openkit_status`, conflicting standard `status` projection, invalid `review_state` or `source_refs`, forbidden secret-like field names, missing `sensitivity`, invalid `freshness`, and attempts to weaken required fields.
- Code MUST reject an invalid active write or retain it only as an invalid draft excluded from active retrieval; an invalid edit MUST NOT overwrite the latest valid active page.
- Imports, rough notes, integrations, and drafts MAY be retained as invalid drafts with inspectable validation errors.
- Repairing an invalid draft produces a valid active page only under current explicit maintenance authority or an exact required human Review through the notebook publisher; structural validity alone never authorizes activation.

## Versioned Source Pointers And Lineage

- [File Storage And Knowledge Packages](20261018-file_storage_and_knowledge_packages.md) replaces the external Source registry with Notebook-owned OKF `SourceSummary` pointers at `sources/<sourceId>.md`; raw bytes stay outside Git, and summaries are interpretation rather than independent corroboration.
- A changed original updates the same Source pointer in one commit; historical digest-qualified citations MUST match their exact original bytes or report unavailable, and deletion retains the unavailable pointer.
- Every Knowledge Source has stable identity across changes to derived representations, summaries, or Knowledge Pages, recording source identity, type, original location when available, capture time, producer, integrity digest, access and sensitivity, derived-representation links, and retention policy.
- Captured source evidence is immutable by default, and every Derived Representation MUST retain lineage to the exact Knowledge Source ID and content digest from which it was produced ([Work Resource Interaction](20260713-work_resource_interaction_model.md#bounded-media-processors) owns bounded PDF text-layer and explicit vision derivatives, which never constitute Knowledge publication or human review).
- An external locator without captured identity MAY support review, but MUST NOT be presented as immutable captured evidence.

## Maintenance Records, Proposals, And Human Review

Reusable Claims, Observations, and conflict analysis belong to the canonical OKF Notebook (`WorkObservation`, Audit, actual decisions, transient lint/health projections, and User suppression retain their separate owners; no standalone Claim, Observation, or conflict JSONL family exists):

- An Observation is not active knowledge by default. Observation capture MUST be selective, and the owning scope policy SHOULD bound allowed types, producers, required sources, retention, expiration, aggregation, promotion criteria, and high-impact review requirements. An Observation MAY be ignored, retained, summarized, aggregated, attached to a pending proposal, or expired without automatic promotion from repetition.
- A Claim is a reusable assertion that MUST carry sources, finite numeric `confidence` in `[0, 1]`, `freshness`, `scope`, and `review_state`; Claims MAY guide source-grounded editing, but never grant publication authority.
- A recorded conflict assessment (`conflict_status`) is only `unresolved` or `resolved`; absence is not a resolution, and low confidence alone MUST NOT create a conflict or weak-evidence assessment.
- Active Claim or Observation pages marked `unresolved` are withheld from retrieval. A current draft or active Observation with `conflict_status: unresolved` also withholds its `subject_refs` pages from active retrieval and refuses relevant target/source Proposal acceptance before a human Review is appended (`source_refs` never substitutes for `subject_refs`; unpinned subjects apply to the object, and exact digest pins apply only to those bytes). Knowledge selection MUST surface unresolved conflicts and never present one side as uncontested truth when competing views are preserved.

Under `docs/specs/20260909-knowledge_notebook_editing.md` and `docs/specs/20260909-personal_memory_and_knowledge_learning.md`:

- Ordinary authorized maintenance publishes a validated fixed-base Git revision (`review_state: delegated`) without manufacturing a synthetic human Review; direct human edits use the same publisher (`review_state: user-authored`), and changed content invalidates earlier content-bound Review or assessment labels.
- Designated critical content and sensitive effects require the exact Knowledge Proposal and human Review path, freezing owner scope, base and candidate commits, candidate digest, source references, producer, rationale, and current assessment/critical-content requirements; the human accepts, rejects, or defers those exact bytes, and no model may accept its own candidate.
- Optional AI evidence assessment (`prove`) is a digest-, source-, and rubric-bound Observation with result and limitations; it is never a Review or authorization source, and an advisory assessment cannot veto an authorized human decision, while an explicitly authored critical-content policy may require assessment evidence before generated activation.
- For Workspace Knowledge, publication commits the expected-head check, admitted head, applicable original Review, required Audit, and original command receipt in one native SQL transaction; for User Memory and Server Knowledge, the compare-and-set published Git ref is the content publication decision and Audit/receipts complete the command. Incomplete or contradictory publication/receipt evidence returns `recovery_required` without inference or automatic missing-page repair.
- Generated knowledge MUST retain exact registered Source references or the strict completed-Worker Turn / final `assistant-message` Item / [Worker Context Package](20260703-worker_context_package.md) trio when claiming Worker output; generated pages are not independent factual corroboration, and imported, workspace-only, reconstructed, or standalone retrieval history MUST NOT claim Worker output.
- Archive, supersede, multi-page merge/split, link repair, confirmed removal, and restore are final-tree edits through the same fixed-base publisher; explicit forgetting suppresses current and normal historical retrieval and automatic re-extraction while retaining Git, Source, evidence, and backup bytes under disclosed retention rules.
- Explicit maintenance, the accepted personal capture composition, and the default-off daily maintenance schedule in `docs/specs/20260909-personal_memory_and_knowledge_learning.md` may invoke Knowledge Manager; any other recurring or event trigger requires its own accepted owner, and no citation-based confirmation or TTL promotion is authorized.
- Health inspection (`health-check` in `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`) MUST remain explicit and report-only, never applying repairs, drafting proposals, scheduling work, or mutating knowledge.

## Knowledge Selection Trace And Capability Conformance

Knowledge retrieval MUST produce a deterministic selection result for identical authoritative inputs, index state, and policy state. Its trace contribution identifies selected Page IDs and content digests, selected Source or Derived Representation references, excluded candidate identifiers and reasons, and applicable freshness, sensitivity, conflict, policy, and budget decisions. The retrieval trace proves only that selection ran; only the owning Worker-Turn [Context Package](20260703-worker_context_package.md) delivery trace (which may project a bounded body, excerpt, or descriptor with a separate delivered digest) proves which selected Knowledge reached a Worker. Restricted trace evidence remains redacted or access-controlled under current policy and audit contracts.

| Surface | Minimum governance |
| --- | --- |
| Import or capture | Portable source material or lower-conformance draft. |
| Draft create or rough note | OpenKit required fields when governed; invalid material may remain an invalid draft. |
| Proposal creation | `OpenKit-profile-valid` target shape or an invalid draft with attached errors. |
| Active Knowledge save | Human-authored, delegated, or human-reviewed, policy-eligible, `scope-schema-valid` page with complete content and actor lineage. |
| Default notebook view | Active valid pages plus pending proposals and user-selected maintenance views. |
| Default worker Knowledge selection | Active, authorized, non-expired, policy-eligible `scope-schema-valid` pages. |
| Lower-conformance source snippet | Explicit policy authorization plus traceable source identity and exclusion reasoning. |
| Health inspection | Any conformance level, report only. |

## Acceptance

- Under [OpenKit Test Strategy](20260529-test_strategy.md), L1 governance checks verify active-write validation, secret-field rejection, source identity, delegated publication and required human-review authority, direct-mutation lineage, multi-page publication and history restoration, and fail-closed partial evidence; L2 contract checks verify that Proposal, Review, Page, command, actor, Source, digest, and Audit lineage remains resolvable across boundaries without exposing `restricted` evidence or adding a second lifecycle owner.

## Implementation

- OKF parser, profile/Scope Schema validation, conflict reader, and schema application: `apps/nanocore/src/knowledge/`.
- Governed retrieval, index rebuild, and Proposal/Review codecs: `apps/nanocore/src/storage/`, `apps/nanocore/src/`.
- Shared protocol models and operation schemas: `packages/protocol/src/`, `packages/app-api-schemas/src/`.

## Implementation Gaps

- Date-derived freshness expiry in default retrieval - Default retrieval evaluates freshness labels only; automatic date-based expiry is not implemented - #259
- Citation-based confirmation and TTL promotion - Citation-driven confirmation and TTL promotion are not implemented - #259
- Incompatible imported Notebook schema migration tools - Rich imported Notebook migration is not implemented; unsupported required semantics fail closed - #404

## Decisions

- [No Credential-Pattern Rejection Of Ordinary Content](../decisions/20261006-no_credential_pattern_rejection_of_ordinary_content.md)
