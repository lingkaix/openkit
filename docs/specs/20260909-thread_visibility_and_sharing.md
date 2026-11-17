---
status: Accepted
kind: concept
implementation: Partial
aspect: policy
---
# Thread Visibility And Explicit Sharing

This specification owns private versus Workspace-shared Thread visibility, server-authored `Thread.entryPath` classification, discovery and publication audience enforcement, explicit private-snapshot sharing (`thread.share`), and the disclosure boundary for Assistant-to-Task/Goal handoff and shared Sandboxes.

## Scope

### Owns

- Private versus Workspace-shared Thread defaults, durable visibility and entry-path metadata (`ThreadSchema`, `ThreadEntryPathSchema`, `THREAD_REQUIRED_FEATURES`), audience resolution across reads, search, widgets, Artifacts, and exports, explicit snapshot sharing (`thread.share`), and the disclosure boundary of Assistant-to-Task/Goal handoff.

### Does Not Own

- User identity, Workspace membership, Personal Workspace provisioning, and administrator authority in `docs/specs/20260715-multi_user_workspace_system.md` and `docs/core/policy.md`.
- Chat Mode Assistant routing and Composer submission in `docs/specs/20260704-chat_mode_assistant.md` and `docs/specs/20260831-unified_conversation_composer.md`.
- Knowledge Manager runtime mechanics in `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`, or Persistent Worker Volume source admission in `docs/specs/20260910-persistent_worker_volumes.md`.
- Work-data retention and backup/export archive mechanics in `docs/specs/20260921-work_data_retention_format.md` and `docs/specs/20260704-workspace_backup_export_import.md`.

### Core

- `docs/core/core-concepts.md`
- `docs/core/work-model.md`
- `docs/core/policy.md`
- `docs/core/storage.md`

## Contract / Expected Behavior

### Entry Path And Visibility Model

A Workspace Thread remains inside one Workspace under its explicit Workspace owner (`ThreadSchema` in `packages/protocol/src/models/thread.ts`; see [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#canonical-enums)). Server Threads use the same `ThreadSchema` family with a Server owner (`owner.kind === "server"`) and no Workspace membership; Workspace audience rules grant no Server access. A Workspace Thread's durable record carries creation-fixed `visibility` (scoped to the two Workspace visibility values in `ThreadSchema`) and `privateOwnerUserId` (required if and only if `visibility === "private"`, bound by NanoCore to the authenticated requesting user and never to a model-supplied ID), plus optional immutable `parentThreadId` (for a separate receiving-Thread handoff, distinct from `id`), `threadSource`, and reserved optional `segment`/`segmentation` fields (`docs/specs/20260921-work_data_retention_format.md`). Existing Thread revision and concurrency rules apply with no separate audience database, per-message ACLs, custom recipient groups, public links, private Task mode, or mode-based reclassification of historical messages.

`Thread.entryPath` (`ThreadEntryPathSchema` in `packages/protocol/src/models/thread.ts`) is the server-authored immutable discriminator selecting a routing and Tool-set contract, not authorization:

- **Administration (`entryPath: "administration"`)**: Created only by the dedicated administration command in the current user's personal Workspace; `administration` requires `visibility: "private"` (and any future project placement must preserve that invariant). Ordinary conversation submission rejects an `administration` Thread, and administration submission rejects a `conversation` Thread; neither endpoint silently changes entry or Tool set, and every administration request and Tool call checks current administrator authority and exact source/target audience. Imported administration history is not a live management entry and requires a new locally admitted private administration Thread for further operations.
- **Knowledge Manager (`entryPath: "knowledge-manager"`)**: Records scope-bound query and maintenance runs under [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md#query-and-maintenance-execution) without granting scope or disclosure authority. Workspace maintenance has the Workspace audience; User maintenance is private in the User's personal Workspace; Server maintenance has the Server owner and audience; query runs retain the admitted query audience and never turn private inputs into shared maintenance context.
- **Conversation (`entryPath: "conversation"`)**: Each `(User, Workspace)` has exactly one private Assistant Timeline bound to that User ([Private Assistant Timeline And Rolling Context](../decisions/20261015-private_assistant_timeline_and_rolling_context.md)); users cannot create additional private chat Threads, personal Workspaces cannot add members, and Task, Goal, and their execution Threads retain the Workspace audience (direct Task/Goal admission rejects private history rather than converting it).
- **Shared conversation deferral**: Creating Workspace-shared conversation Threads (`entryPath: "conversation"`, `visibility: "workspace"`) is gated off in `v0.1.0` (`#752`) and deferred until after `v0.1.0` (`#247`; [Shared Conversation And Single-Agent Threads](../decisions/20261015-shared_conversation_and_single_agent_threads.md)). When enabled after `v0.1.0` in eligible team Workspaces (never in personal Workspaces), shared conversation Threads run Chat Mode with the Core Assistant as the sole agent acting as a Workspace role without personal Memory, private Timeline input, or administration Tools, requiring sources eligible for the whole current audience, executing actions under the addressing member's current authority, maintaining a per-Thread rolling window and Thread/Turn-bound query traces, and allowing at most one active Turn (`docs/specs/20260704-chat_mode_assistant.md`).

### Admission, read and publication

For a private project Thread, an ordinary caller needs both current Workspace access and exact private ownership. A personal Workspace retains its owner-only Workspace rule for an ordinary caller. A currently usable administrator credential is eligible under the administrator eligibility rule in [Core Policy](../core/policy.md). A shared Thread requires current Workspace access; dynamic membership supplies the audience without copying a fixed member list.

Resolve audience before any source discovery or model input assembly. Apply the same guard to direct Thread/Turn/Item fetches, lists, previews, titles, search, subscriptions, events, attention, notifications, attachments, generated widgets (which check both target and retained Item-source audience and refuse private Item publication into shared Threads), Artifact communication, exported history, and agent context retrieval, as well as addressed Thread paths, conversation-target queries, Turn submission bodies, and opaque feedback and approval lineage. An inaccessible parent or source link exposes neither its private title nor its content. Indexes and caches are projections and cannot authorize a read. Private results MUST NOT be written to Workspace-wide Knowledge, search entries, or shared Artifact bytes as an intermediate publication step.

An Artifact produced only in a private Thread is private to that Thread's audience even though its bytes reside in the Workspace tree. Standalone Artifact reads and file delivery must resolve that audience through immutable origin lineage; a private Artifact does not become shared because a shared Item references its ID. Existing shared Kernel data, Workspace files, configurations, or external records keep their resource authority when discussed privately; a private conversation does not privatize their mutations.

Before every effect and publication, recheck the current requesting user, presented Token usability, source restrictions, and destination audience. Another participant's earlier administrator Tool result or approval supplies no authority to a later caller. Restricted information is excluded before generation, including when another user's shared follow-up requests an expansion of a previously posted answer.

### Explicit sharing

The first sharing operation (`thread.share`, `#297`) publishes a selected snapshot, leaving the original Thread private. Sharing grants no Tool, approval, credential, or external-effect authority. Sharing the whole conversation means the complete selected history through an explicit Item cutoff, not future messages. Live conversion of an existing private Thread, arbitrary recipient lists, and public anonymous links are excluded.

`thread.share` carries the existing command `requestId`, source Thread and revision, ordered selected Item identities and digests, destination Workspace, exact proposed public text and selected attachments, and a confirmation bound to that payload. The service computes the source digests and rejects invented or stale values. It displays exactly what will be published and who can receive it. An ordinary sharing caller must be the source owner and must have current source read and disclosure authority plus destination write authority. A currently usable administrator credential is eligible for that disclosure under the administrator eligibility rule in [Core Policy](../core/policy.md). Source authorship, private ownership, or summarization alone cannot declassify restricted material.

The accepting command creates one new Workspace-shared Thread and its shared snapshot Items using existing Thread/Item creation owners. It retains source lineage behind the source visibility boundary, creates a private receipt Item linking the destination, and copies only explicitly admitted attachment bytes into destination-owned Artifacts. Destination displays the selected author's attribution and snapshot cutoff, not an apparent original live transcript. Sharing an inaccessible dependency fails before publication; a reference to it cannot substitute for a required copy. Follow-up discussion uses the new shared Thread and its own audience.

Publication uses one destination-side barrier owned by the existing Thread/Item command: preflight current authority and all selected source bytes, stage the complete destination Thread/Items/Artifact copies as inaccessible, then recheck admission and atomically make the complete tuple discoverable. Lists, direct reads, subscriptions, and Artifact delivery exclude staged objects. Source records are read dependencies, not a cross-Workspace transaction participant. A pre-barrier failure exposes nothing and may discard staging through the existing owner. The private receipt can follow publication; its absence never authorizes another publication.

The command receipt binds the normalized input and resulting Thread/Item/Artifact identities. Identical replay inspects and returns that same tuple without republishing; changed input conflicts. An uncertain barrier outcome is inspected through the destination command identity; missing or contradictory committed members return `recovery_required` rather than repeating publication. Incomplete staging stays inaccessible. A source mutation or authorization change before the barrier invalidates the proposal; a later change does not pretend an already committed publication never occurred. Sharing is not a cross-Workspace transaction or a promise to retract copies after recipients have read them.

### Private-to-shared work handoff

Existing Assistant-to-Task/Goal confirmation presents the receiving Workspace and the exact work brief, relevant constraints, and selected inputs that will enter shared work (`apps/nanocore/src/internal-agents/assistant-handoff-source.ts`). That same confirmation covers disclosure and handoff; do not add a second generic approval dialog. Start only after both current execution authority and disclosure admission succeed. Under [Assistant Task Proposals Exclude Private Files](../decisions/20261016-assistant_task_proposals_exclude_private_files.md), a later Assistant Task proposal remains brief-only (stating in one line that private files are excluded and the user can attach files explicitly when selecting a Worker under [Unified Conversation Composer](20260831-unified_conversation_composer.md#audience-at-submission)), keeping earlier private originals on their accepted Assistant Turn without silent forwarding.

The Worker, Coordinator, and Goal input receive only this admitted payload, not the original private transcript, warm provider context, personal Memory, hidden diagnostic results, or unrestricted source links. A task brief may include a deliberately selected personal preference only if its disclosure is authorized. Origin retains the private handoff Item; receiving work stores shared lineage with inaccessible source details omitted. Existing handoff idempotency and downstream completion tuples remain authoritative.

### Shared Sandbox Destination

Sandbox sharing does not broaden private Thread records or implicitly publish their retained native history. Delivery from a private source into a shared Sandbox requires the source owner's explicit authorized destination scope; source read permission and acknowledgement of a Sandbox notice are insufficient. Existing selected-material handoff and publication admit only their confirmed payload, never the remainder of a private native home or transcript. Task and Goal execution Threads retain their existing Workspace-shared audience. [Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns whole-volume source admission and existing private-association disposition; no volume declassification shortcut, classifier, scrubber, per-file ACL, or share-all-history action is added. [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md) records the shared-files ruling.

### Membership loss, archive, deletion and restart

Loss of current Workspace access eligibility immediately removes project Thread and derived content eligibility for an ordinary caller, including its private owner's access. Membership is the ordinary eligibility source. A currently usable administrator credential is eligible under the administrator eligibility rule in [Core Policy](../core/policy.md). Archive prevents new work under the existing Thread owner but is not deletion or permission revocation. Deletion and cache invalidation use existing retention owners. Previously shared copies are separately owned published material and are not silently rewritten when the private source is deleted; their reuse still respects retained source restrictions.

Restart reconstructs audience from durable Thread and current identity facts. The canonical retained envelope (`apps/nanocore/src/storage/retained-work-events-v1.ts`) uses `schemaVersion: 1` with known-field validation under [Contract Evolution](../core/contract-evolution.md#closed-core-open-extension) (ignoring unknown descriptive additions while requiring explicit owner and entry fields), and native Thread publication, private Workspace initialization, and dependent export manifests emit `THREAD_REQUIRED_FEATURES` (`ThreadRequiredFeaturesV1Schema` in `apps/nanocore/src/storage/retained-work-events-v1.ts`). Readers lacking any required feature in `THREAD_REQUIRED_FEATURES` reject the record before discovery or projection, and missing or contradictory visibility or private-owner fields fail closed without an audience classifier, rewrite, or implicit shared fallback ([Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)). No prefix, title, trigger-summary text, expired command receipt, or model input can classify a Thread as `administration`, and the normal create/update API cannot set or mutate `entryPath`.

### Audit and portability

Audit of a shared-resource mutation follows the effect's owner, even when the request conversation is private. Retain actor, operation, target, request, changed revision, and outcome without copying private dialogue or secret Tool output. Workspace members may inspect eligible Workspace effects; deployment evidence retains administrator access checks.

Workspace export is administrator-only at creation and download through the common Kernel authorizer ([Workspace Export Is Administrator-Only](../decisions/20261027-workspace_export_administrator_only.md)). It includes the complete Workspace closure, including private Threads and private-derived bytes, under Administrator Eligibility in [Core Policy](../core/policy.md). Workspace membership, ownership, and own-private-history access supply no export grant. The export is outward-only; OpenKit-to-OpenKit portability uses operational backup, restore, and MOVE ([Online Workspace Snapshots And Recovery](../decisions/20261027-online_workspace_snapshots_and_recovery.md)). Ordinary portable import is removed. Deleted recovery restores the original Workspace identity and each private Thread's original `privateOwnerUserId` through scoped operational restore. The exact deleted registry row determines Workspace ownership; neither the recovery caller nor Workspace owner replaces a private Thread owner. MOVE preserves private ownership through its explicit injective account map. Restricted-source references remain inert until target authorization is established. Operational backup grants no ordinary content access or permission to search private conversations. Local-only destinations and freeze/privacy requirements follow [Workspace Backup](20260704-workspace_backup_export_import.md#scoped-freeze-and-blockers).

## Acceptance

- Two members can read the same Task/Goal work; neither can enumerate, search, subscribe to, or fetch the other's private Assistant Thread, attachment, or widget through a guessed ID, while a currently usable administrator credential is eligible under Administrator Eligibility in [Core Policy](../core/policy.md).
- A private Assistant conversation can create shared work with exactly the confirmed brief and attachments; a private-only marker is absent from receiving Items, Worker context, notifications, Knowledge, and independent Artifact fetches.
- Full-history snapshot sharing (`#297`) excludes subsequent private messages, exact replay creates no duplicate Thread or output, stale input or lost eligibility creates no shared result, and failure before the publication barrier exposes no staged Thread, Item, or Artifact.
- Private administration updates an authorized shared resource and emits eligible effect Audit without publishing the conversation, and a non-admin reader cannot execute an admin action from a shared card.
- Unsupported `THREAD_REQUIRED_FEATURES` fail before import or discovery, export/restore and index rebuild preserve private/shared decisions, and restart never restores revoked access or silently completes an uncertain disclosure.

## Implementation

- Thread audience resolution and route admission: `apps/nanocore/src/auth/`, `apps/nanocore/src/`.
- Retained Thread v1 envelope, required features, and export/restore: `apps/nanocore/src/storage/`, `apps/nanocore/src/lib/`.
- Assistant handoff source verification: `apps/nanocore/src/internal-agents/`.
- Thread models and operation schemas: `packages/protocol/src/`, `packages/app-api-schemas/src/`.

## Implementation Gaps

- Explicit private-Thread snapshot sharing (`thread.share`) and destination publication barrier - `thread.share` is not implemented - #297
- Post-`v0.1.0` shared conversation Threads in team Workspaces - Deferred beyond `v0.1.0` - #247
- Creation of Workspace-shared conversation Threads is gated off - New Assistant admission on an unestablished shared conversation refuses, but public `thread.create` still persists `entryPath: "conversation"` with `visibility: "workspace"` - #752

## Decisions

- [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md)
- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Private Assistant Timeline And Rolling Context](../decisions/20261015-private_assistant_timeline_and_rolling_context.md)
- [Shared Conversation And Single-Agent Threads](../decisions/20261015-shared_conversation_and_single_agent_threads.md)
- [Assistant Task Proposals Exclude Private Files](../decisions/20261016-assistant_task_proposals_exclude_private_files.md)
- [Online Workspace Snapshots And Recovery](../decisions/20261027-online_workspace_snapshots_and_recovery.md)
- [Workspace Export Is Administrator-Only](../decisions/20261027-workspace_export_administrator_only.md)
