---
status: Accepted
implementation: Not Started
---
# Personal Memory And Scoped Knowledge Learning

## Owns

This specification owns the User/Workspace/Server projections of the existing Knowledge Store, personal Memory retrieval, conversation-source intake, bounded automatic extraction and consolidation, exact single-page replacement, forgetting, and optional candidate-specific AI assessment. It extends the existing Knowledge Page, Source, Proposal, Review and maintenance records; it creates no separate Memory engine or generic learning framework.

## Does Not Own

It does not own Thread history, permission policy, model transport, a new Agent runtime, background scheduler, Skill versions, A/B experiment orchestration, multi-page transactions, formal proof, or autonomous promotion. `docs/specs/20260711-skill_catalog_versioning_pinning.md` continues to own procedural Skill candidates, exact version selection, comparisons and rollback.

## Core References

- `docs/core/knowledge.md`
- `docs/core/permissions.md`
- `docs/core/identity.md`
- `docs/core/storage.md`
- `docs/core/agent-supply.md`

## Summary

Memory is the user-facing name for personally owned reusable understanding; Knowledge is the name for Workspace- or Server-owned reusable understanding. Both use the same OKF-backed governed pages, sources, candidate review and retrieval implementation. Skill stores reusable procedures and optional supporting code under its own catalog. Automatic learning creates inspectable candidates and evidence, never hidden facts or self-authorized behavior.

## Goals / Non-goals

Give Personal Assistant continuity across private conversations and authorized project contexts; let users inspect, correct and forget saved material; preserve provenance and current source restrictions; reuse bounded work and existing governance. Exclude personality inferred as a privileged system prompt, unconditional history ingestion, a second vector database, a new Dreaming service, cross-scope copying by default, automatic Skill promotion, and a universal evaluator.

## Decision

The existing Knowledge model is extended to one `ownerScope`: `{ kind: user, userId }`, `{ kind: workspace, workspaceId }`, or `{ kind: server }` for the current deployment. Scope-qualified identity, not title or page id alone, identifies a page and every associated record. There is one implementation parameterized by a trusted resolved owner, not three engines or a globally searchable shared corpus.

User ownership is independent of Quick Chat or a project Workspace. Personal Memory remains private when the user joins, leaves or changes Workspaces. A project-derived fact keeps its source restriction; private ownership never grants permission to import it into another Workspace or keep using a revoked source. Workspace Knowledge serves authorized work in that Workspace. Server Knowledge initially serves deployment administration; publishing any subset for ordinary member use requires an explicit authorized promotion into that member's Workspace, not a blanket Server read grant.

## Contract / Expected Behavior

### Scope, storage and API projection

The storage layout owner assigns the following roots; this is its projection, not a second path authority. Reuse the existing notebook tree, OKF v0.2 envelope and governed record families under these trusted storage roots: `users/<userId>/memory/`, `workspaces/<workspaceId>/knowledge/`, and `server/knowledge/`. Each root contains `pages/`, `schema/`, `proposals/`, `reviews/` and the existing maintenance families. Source material remains a separately owned sibling family: `users/<userId>/sources/`, `workspaces/<workspaceId>/sources/`, or `server/sources/`. Rebuildable indexes live in the same ownership scope. No new SQLite database is required and no Workspace tree moves under a user.

The existing Knowledge Store implementation owns path containment, encoding, validation, registered sources, review and page writes. This extension changes its workspace-only resolver to a scope resolver and extends its profile to `openkit-knowledge-profile-v3`: `scope` contains the exact owner above, and every newly created page starts with `openkit_revision: 1`. Every accepted replacement or direct user edit increments this server-owned positive integer; a caller cannot choose it. Preserve the existing complete-file content digest, which includes the revision. The applicable scoped schema is resolved at `schema/scope-schema.yaml` under the storage owner; the Workspace Schema rules become scope-schema rules and do not permit one scope to edit another's schema.

App API, Core Client and the agent-facing interface reuse the existing page/source/proposal/review operations. Workspace routes retain their existing scope. User routes use `/api/app/users/me/memory/...` and resolve `me` from current authentication; Server routes use `/api/app/server/knowledge/...` and current deployment-administrator authority. The existing Workspace operation suffixes and strict payload validation apply without a second CRUD implementation. Exact route schemas are projections of these scoped operations, not permission to accept arbitrary filesystem roots or user ids.

Page/source/candidate reads, writes, exports and derived retrieval require current scope authority. User Memory requires the exact user; Workspace Knowledge requires active membership and existing operation checks; Server Knowledge requires deployment administration. Restricted source evidence adds its own current read/disclosure conditions. Administrator authority alone cannot read another user's Memory. The Notebook UI labels User pages Memory and Workspace/Server pages Knowledge, shows source and applicable scope, and offers saved entries and pending changes separately.

The envelope owner must register `openkit.knowledge-owner-scope.v1` and `openkit.knowledge-exact-revision.v1` before this extension becomes writable/importable. Emit them in `requiredFeatures` on scoped pages, governed mutation records and export manifests carrying these semantics. Unsupported readers reject before retrieval, mutation or import; an omitted capability cannot downgrade User ownership or discard a replacement base assertion.

### History, explicit saving and personalization

Private Thread history remains history; a transient prompt, provider cache or inferred preference is not a saved Memory. An explicit instruction such as "remember that I prefer concise Chinese reports" may create a direct user-authored page through the current owner. A model's interpretation that materially expands or changes that instruction is a candidate requiring review. A one-task exception does not silently rewrite a standing preference.

Personal Assistant queries relevant active personal pages through Knowledge Manager with the current user and output audience. It also queries current eligible Workspace Knowledge when relevant; it does not read every notebook on entering a Workspace. Personal preference can influence a private reply across Workspaces, but cannot override the current instruction, policy, tool admission, target schema or required decision. Personal Memory is not ambient input to shared Task/Goal work. A selected preference may cross that boundary only through the explicit handoff/promotion contract.

The private project Thread's physical placement does not transfer its extracted Memory to the Workspace notebook. A user may explicitly publish selected understanding as Workspace Knowledge, using destination validation and disclosure checks plus a new destination-owned candidate. The same rule applies to Workspace-to-Server promotion; generalization, paraphrase or generated Skill packaging is not declassification.

### Deterministic retrieval and conflicts

The caller supplies an ordered, explicit allowed-scope list to the existing governed retrieval owner, resolved by trusted assembly. A private Personal Assistant request may name only the current User and the one currently selected authorized Workspace; management may separately request current Server Knowledge under administrator authority. No scope is added because an index happens to contain a matching title. Shared Task/Goal retrieval starts with its Workspace only; deliberately promoted input is carried in its explicit Context Package rather than opening the User store.

Apply source and audience admission inside each scope before returning even candidate metadata. Run the existing deterministic tokenizer/scorer against the authorized candidate union; use score descending, caller-declared scope order, then bytewise page id and revision as stable tie-breaks. Scope order is a ranking tie-break, not an authority or truth precedence. Traces record the ordered scopes and exact page owner/id/revision/digest for selected and excluded eligible candidates; inaccessible scopes contribute a bounded unavailable result without private candidate metadata. The same admitted inputs and source revisions must reproduce the same order and trace.

Current explicit instructions govern the current task; a personal preference may override a broader presentation default. Contradictory factual pages remain source-attributed conflicts and cannot be resolved merely by choosing User over Workspace or Server. Existing conflict/freshness filters apply before selection; unresolved content returns uncertainty or is excluded under the current retrieval policy. Protected-source revocation invalidates the corresponding candidate even if a personally owned snapshot remains stored.

### Conversation-source intake

Selected completed Assistant or human conversation Items are captured through the existing Knowledge Source registration owner before drafting. The source stores exact Item identities/digests, cutoff, originating Thread/Workspace/user attribution, source audience, capture time and restrictions with the captured bytes. The proposal cites the existing `source:<sourceId>@<digest>` form. This is conversation evidence, not worker-output evidence, and it MUST NOT fabricate an AgentSession, S39 Context Package or completed Worker Turn.

At capture, draft, evaluation, apply and later retrieval, reauthorize the source and destination. An inaccessible private source must not appear in another scope's candidate title, rationale, preview, index or evaluation prompt. If an ordinary raw conversation is deleted, separately and explicitly saved user-authored Memory follows its own retention choice; the UI explains that deleting a chat does not itself forget saved entries. Revocation of a protected source prevents derived reuse regardless of whether a historical snapshot remains stored for evidence.

### Bounded extraction and consolidation

Dreaming is a descriptive name for extracting reusable observations and reconciling them with existing saved material. It is an operation of the existing Knowledge Manager and internal runtime, not another Agent, persistent hidden session or scheduler.

Personal automatic capture is an explicit user preference, initially off; manual save and inspection work without it. When enabled, the next private Personal Assistant interaction may process at most eight eligible completed prior Turns and up to four proposals in one bounded invocation. It excludes the active Turn, ephemeral/no-memory conversations, prior consolidation/evaluation output, pending proposals and unreviewed generated text as factual evidence. Workspace/Server consolidation is explicitly invoked by a currently authorized user over selected sources in this first slice. Unattended recurring jobs may be added only through an owning trigger/execution contract; the five-second Worker scheduler is not silently repurposed.

Use the existing observation/maintenance records to retain scope, exact selected source versions, existing target page revision/digest, producer, model/configuration identity, candidate ids, usage/evaluation references and outcome. Source-set identity permits skipping unchanged inputs; unchanged/no-useful-output is a successful no-op. One scope's material never enters another's invocation. Recheck admission at each read and write and stop on cancellation, source loss or existing runtime limits.

Extraction first registers bounded source snapshots and produces source-linked observations/candidates. Consolidation then compares them with eligible active pages and proposes either a new page or a replacement of one existing page. Existing generated pages may be comparison targets, but cannot alone establish a new factual claim: follow the retained approved source lineage or require new authorized evidence. Repetition, usage frequency and a prior model's confidence are selection signals, not truth or permission to activate.

Failed work records a bounded outcome through existing capability/maintenance owners. A later invocation reconstructs from current sources and skips already recorded candidates; it never replays a hidden AgentSession. No-op, failure, candidate creation and activation are distinct outcomes. A source removed during a run makes affected outputs ineligible; it does not trigger a compensating cross-scope operation.

### Proposal, replacement and direct edits

Keep the existing `KnowledgeProposal` and human `KnowledgeReview` owners. Extend the proposal operation to `create | replace`. Both freeze exact target scope/id, full candidate bytes/digest, exact source versions, producer and rationale. Create requires absence and revision 1. Replace additionally fixes `expectedRevision`, `expectedDigest` and `baseSourceRef` to the exact prior full page bytes registered through the existing Knowledge Source owner; candidate revision is exactly the base plus one. The accepting review carries `targetStateAtDecision` with that exact base revision/digest (or explicit absence for create). The base source is captured and verified before the candidate can be reviewed; missing bytes fail without replacement. A changed target, source, candidate, rubric or scope requires a new proposal/assessment. Review cannot substitute bytes.

Applying an accepted proposal rechecks current authority, source validity, schema and exact base under the existing store's exclusive mutation boundary. Record the exact accepting review, then publish the validated page through one atomic same-filesystem replacement. Do not claim the Review file, page and SQLite audit/receipt are one transaction. Success requires the exact review/page/evidence tuple; identical retry inspects that tuple. If the exact review exists and the page is still the exact base (or absent for create), the same command may finish only its frozen page effect. If the candidate and full accepting business tuple are already present, return success only when the original Audit and receipt already verify. Missing command evidence returns `recovery_required`; do not synthesize it or reconstruct a successful command from the page. Any later revision, conflicting review or unverifiable state returns `recovery_required` without overwrite. Live direct edits and proposal application must share the same per-scope writer fence, including across processes; an unsupported second writer is rejected rather than relying on an in-process mutex alone.

Explicit user editing uses the same revision/base guard, retains the exact prior bytes through the existing Knowledge Source owner before replacement, writes `review_state: user-authored`, and invalidates prior content-bound assessments. It never preserves an accepted generated label over different bytes. Candidate review may accept, reject or defer; the accepting user is recorded independently of the producing model. Automatic extraction and positive AI assessment never stand in for that decision.

The retained base source lets the user inspect the earlier content and explicitly propose it as a new revision through the same replace operation. It never rewinds revision numbers or rewrites old reviews, and no separate restoration owner is created. Multi-page merge, split, rename, reference repair, generated deletion and arbitrary historical rollback remain outside this contract. A consolidation candidate may replace one page using several admitted sources, but cannot atomically modify its source pages. Skill rollback remains with the Skill catalog; the existing unchanged-page create reversal is retained for its exact original tuple and is not generalized to replacement history.

### Forgetting and deletion

User `forget` is a direct authorized operation over an exact page revision, distinct from deleting its source chat. Before application, the existing Item-backed confirmation gate displays the exact owner/page/revision/digest, content being removed, suppression effect and separately retained source/evidence/backup scope. Confirmation binds that payload and request identity; the model cannot confirm it. Apply rechecks current authority and the exact revision/digest, rejects stale targets, and returns the same inspected outcome on identical replay rather than deleting a later page. This operation does not promise restoration of removed active content. Mark the page unavailable before derived index cleanup, remove its content from active pages and derived summaries/caches, and prevent pending candidates based on the forgotten material from applying. Retain only minimal scope/id/last-revision/digest and source-fingerprint suppression metadata in the existing maintenance records; a forgotten page id remains reserved and an explicit later save creates a new page id at revision 1, never revives the forgotten identity; do not retain forgotten prose as a tombstone. Existing Proposal, Source and evidence bytes containing that material follow the owning deletion/redaction rules and must be excluded from future model retrieval immediately. Physical evidence retention and backup retention remain separately disclosed; no promise is made to erase an already published external copy.

Suppression rejects automatic re-extraction from the same source versions. It is not a semantic ban on every future similar sentence. Only an explicit user save or user removal of the suppression can re-admit that material; an index rebuild, restart, repeated observation or generated paraphrase cannot. New observations with different source identity remain candidates and cannot self-activate. Forgetting personally saved material does not delete independently owned Workspace/Server Knowledge or shared work.

### Evaluation, optional AI prove and Skills

Optional AI prove means evidence assessment, not formal proof or approval. An authorized user may request it for an exact candidate/page revision; a scope's authored policy may require it before generated activation of designated critical content. Default is optional. Reuse an existing bounded model/work invocation and an Observation in the existing maintenance ledger to retain assessed digest, authorized sources and observations, explicit rubric, assessor/model identity, outcome `supported | contradicted | insufficient_evidence`, limitations and time. No new evaluator role or approval service is created. Where required, unavailable/failed/insufficient assessment leaves the candidate pending; positive assessment still requires the existing human Review. Advisory assessment has no veto: absent an explicit authored requirement, an authorized user may accept despite `contradicted` or `insufficient_evidence`, with that disagreement retained as evidence. If the user changes a required-assessment policy, that is a separate currently authorized policy decision, not an AI override. A direct user edit remains possible and invalidates the assessment; designation as assessed or worker-use eligibility follows the current authored policy, not the user's ability to edit.

Claims must be checked against independent source evidence or observed checks, not justified only by the author model's own statement. Conflicting sources remain visible as uncertainty. Assessment cannot repair missing disclosure authority or authorize a write. Ordinary user-authored preferences need no truth-proof ritual; they are records of the user's expressed preference.

If learning produces a reusable procedure, submit an existing SkillCandidate with exact base/candidate digests and permitted source/work evidence. Do not store executable behavior as a privileged Memory page or introduce OKF as a substitute Skill package format. Skill comparison, A/B trials and rollback use existing version pins and attributable work outcomes; experiment scheduling/statistical evaluation remain separately scoped. A better-looking score is evidence for a decision, never automatic promotion or a claim that the A/B platform is already implemented.

### Portability and deletion of an owner

An ordinary Workspace bundle contains Workspace Knowledge and shared admissible sources, not User Memory or Server Knowledge. The current user may separately export their Memory as OKF pages; import binds to that importing user, validates content and source restrictions, and leaves unavailable references inactive. Server Knowledge export/import is administrator-scoped. Raw private conversations, credentials, prior users' review authority and automatic capture settings are not silently imported with pages. The existing User `disabled` state immediately blocks Memory reads, extraction and publication and invalidates in-flight admission; retained pages, Sources, candidates and reviews remain owned by that user and are not transferred to administrators or Workspace members. No re-enable transition is introduced; if Identity later owns one, Memory admission must reconstruct current source permissions rather than replay old grants. User hard deletion and account-closure export are excluded until Identity owns those transitions; they are not invented by this feature. Unavailable storage fails without creating an empty replacement store. Deleting Server Knowledge requires current administration and never deletes Workspace or User material; Workspace deletion cannot delete independent personal preferences. Restricted project-derived material remains unusable when its source permission is lost.

## Current Implementation Projection

The existing Workspace Knowledge store supports OKF pages, registered sources, create-only reviewed proposals, bounded create reversal and governed retrieval. The existing Skill catalog supplies independent candidate/version design and partial implementation. User/Server Knowledge ownership, project-private Memory extraction, single-page replacement, automatic consolidation and AI assessment described here are Not Started. Existing direct user page edits are reused; old workspace `memory` aliases remain retired and are not restored by the intentional User Memory product name.

## Rollout / Migration Plan

Implement personal scope, explicit save/read/edit/forget and visibility enforcement first; then bounded source registration and candidate creation; then exact replacement and optional assessment. Enable automatic capture only after the same operations work explicitly and their source/audience checks pass. Convert existing owned Workspace pages to revisioned profile v3 under the Knowledge schema migration owner, preserving bytes/source lineage and reporting invalid pages rather than silently making them active. A separate implementation plan must retain these stages; acceptance of the full design does not claim every stage ships in the first release.

## Testing Strategy / Acceptance Criteria

- Two users' Memory remains isolated across direct APIs, search, indexes, exports and model context; a server admin cannot read the other's Memory. User preferences survive switching Workspace without importing business data from one Workspace into another.
- Exact explicit saving is user-authored; a model inference remains pending; a temporary instruction changes no standing Memory. Users can see source, edit a page and invalidate a prior assessment.
- A completed private conversation yields a registered source and pending proposal without fabricated Worker/S39 evidence. Disabled/ephemeral/private-inaccessible input produces no automatic source or candidate. Unchanged/no-useful input is a no-op; consolidation output never feeds itself.
- Concurrent direct edit versus reviewed replacement preserves the winner and returns conflict for the stale base, including an ABA case with repeated body text but a later revision. Faults between review, atomic page replacement and evidence writes yield only exact replay completion or `recovery_required`.
- Forget without exact target confirmation or with a stale revision changes nothing; identical replay cannot delete a later save. Unsupported required features reject reads/imports before exposing content or weakening base checks.
- Forget immediately stops retrieval and stale candidate application, survives restart/index rebuild, and suppresses re-extraction from the same sources without deleting independent shared resources.
- Required AI assessment failure blocks candidate activation; a positive assessment does not self-approve; candidate/source changes invalidate assessment. A Skill candidate changes no current version until its catalog owner accepts promotion.

## Reference And Limits

Codex source at commit `44918ea10c0f99151c6710411b4322c2f5c96bea`, particularly `codex-rs/memories/README.md` and `memories/write/src/phase2.rs`, demonstrates bounded extraction followed by serialized consolidation, changed-input selection and exclusion of consolidation output from recursive learning. This is a pinned implementation reference, not a claim about every current hosted Codex feature. OpenKit reuses the pattern with its own source permissions, review authority and scope boundaries; it does not copy automatic publication or a global personal filesystem scope.

## Links

- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260909-thread_visibility_and_sharing.md`
