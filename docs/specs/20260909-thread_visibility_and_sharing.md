---
status: Accepted
implementation: Not Started
---
# Thread Visibility And Explicit Sharing

## Owns

This specification owns private versus Workspace-shared Thread defaults, durable visibility metadata, discovery and publication enforcement, explicit sharing, and the disclosure boundary of Assistant-to-Task/Goal handoff.

## Does Not Own

It does not own user identity, Workspace membership, administrator authority, work execution, Artifact storage, Knowledge activation, retention policy, or a new collaboration protocol. Sharing grants no Tool, approval, credential, or external-effect authority.

## Core References

- `docs/core/core-concepts.md`
- `docs/core/work-model.md`
- `docs/core/permissions.md`
- `docs/core/storage.md`

## Summary

Personal Assistant and administration conversations are private by default, including inside a project Workspace. Task and Goal execution narratives are shared with the owning Workspace. Workspace placement and Thread audience are separate facts; an active member's ordinary Workspace eligibility does not include another user's private conversation.

## Goals / Non-goals

Provide predictable private conversation and shared formal work without per-message ACLs, custom recipient groups, public links, a private Task mode, or silent mode-based reclassification of historical messages. Team discovery and attention may summarize shared work instead of broadcasting every Item.

## Decision

One Thread remains inside exactly one Workspace. Its durable record adds `visibility: private | workspace` and `privateOwnerUserId`, which is required exactly for `private`. NanoCore binds the private owner to the authenticated requesting user, never to a model-supplied id. Visibility is fixed at creation in this first contract. Existing Thread revision/concurrency rules continue to apply; no separate audience database is introduced.

Quick Chat accepts only private Threads owned by that Workspace's user. Project Assistant and administration entry paths create private Threads. Task, Goal Main and their execution Threads create Workspace-shared Threads. A shared conversational continuation may address Assistant after explicit sharing, but receives the shared audience from inception and cannot use the private administration entry path. Subsequent selection of another counterpart never changes historical visibility or bypasses the owning handoff contract.

## Contract / Expected Behavior

### Admission, read and publication

For a private project Thread, both current Workspace access and exact private ownership are required. Quick Chat uses its existing owner-only Workspace rule. A deployment administrator gains no private Thread access by holding an administrator token. A shared Thread requires current Workspace access; dynamic membership supplies the audience without copying a fixed member list.

Resolve audience before any source discovery or model input assembly. Apply the same guard to direct Thread/Turn/Item fetches, lists, previews, titles, search, subscriptions, events, attention, notifications, attachments, generated widgets, Artifact communication, exported history, and agent context retrieval. An inaccessible parent or source link exposes neither its private title nor its content. Indexes and caches are projections and cannot authorize a read. Private results MUST NOT be written to Workspace-wide Knowledge, search entries or shared Artifact bytes as an intermediate publication step.

An Artifact produced only in a private Thread is private to that Thread's audience even though its bytes reside in the Workspace tree. Standalone Artifact reads and file delivery must resolve that audience through immutable origin lineage; a private Artifact does not become shared because a shared Item references its id. Existing shared Kernel data, Workspace files, configurations or external records keep their resource authority when discussed privately; a private conversation does not privatize their mutations.

Before every effect and publication, recheck the current requesting user, source restrictions and destination audience. Another participant's earlier administrator Tool result or approval supplies no authority to a later caller. Restricted information is excluded before generation, including when another user's shared follow-up requests an expansion of a previously posted answer.

### Explicit sharing

The first sharing operation publishes a selected snapshot, leaving the original Thread private. Sharing the whole conversation means the complete selected history through an explicit Item cutoff, not future messages. Live conversion of an existing private Thread, arbitrary recipient lists and public anonymous links are excluded.

`thread.share` carries the existing command `requestId`, source Thread and revision, ordered selected Item identities and digests, destination Workspace, exact proposed public text and selected attachments, and a confirmation bound to that payload. The service computes the source digests and rejects invented or stale values. It displays exactly what will be published and who can receive it. The source owner must have current source read and disclosure authority plus destination write authority. Source authorship, private ownership or summarization alone cannot declassify restricted material.

The accepting command creates one new Workspace-shared Thread and its shared snapshot Items using existing Thread/Item creation owners. It retains source lineage behind the source visibility boundary, creates a private receipt Item linking the destination, and copies only explicitly admitted attachment bytes into destination-owned Artifacts. Destination displays the selected author's attribution and snapshot cutoff, not an apparent original live transcript. Sharing an inaccessible dependency fails before publication; a reference to it cannot substitute for a required copy. Follow-up discussion uses the new shared Thread and its own audience.

Publication uses one destination-side barrier owned by the existing Thread/Item command: preflight current authority and all selected source bytes, stage the complete destination Thread/Items/Artifact copies as inaccessible, then recheck admission and atomically make the complete tuple discoverable. Lists, direct reads, subscriptions and Artifact delivery exclude staged objects. Source records are read dependencies, not a cross-Workspace transaction participant. A pre-barrier failure exposes nothing and may discard staging through the existing owner. The private receipt can follow publication; its absence never authorizes another publication.

The command receipt binds the normalized input and resulting Thread/Item/Artifact identities. Identical replay inspects and returns that same tuple without republishing; changed input conflicts. An uncertain barrier outcome is inspected through the destination command identity; missing or contradictory committed members return `recovery_required` rather than repeating publication. Incomplete staging stays inaccessible. A source mutation or authorization change before the barrier invalidates the proposal; a later change does not pretend an already committed publication never occurred. Sharing is not a cross-Workspace transaction or a promise to retract copies after recipients have read them.

### Private-to-shared work handoff

Existing Assistant-to-Task/Goal confirmation presents the receiving Workspace and the exact work brief, relevant constraints and selected inputs that will enter shared work. That same confirmation covers disclosure and handoff; do not add a second generic approval dialog. Start only after both current execution authority and disclosure admission succeed.

The Worker, Coordinator and Goal input receive only this admitted payload, not the original private transcript, warm provider context, personal Memory, hidden diagnostic results or unrestricted source links. A task brief may include a deliberately selected personal preference only if its disclosure is authorized. Origin retains the private handoff Item; receiving work stores shared lineage with inaccessible source details omitted. Existing handoff idempotency and downstream completion tuples remain authoritative.

### Membership loss, archive, deletion and restart

Membership loss immediately removes project Thread and derived content eligibility, including its private owner's access while membership is absent. Archive prevents new work under the existing Thread owner but is not deletion or permission revocation. Deletion and cache invalidation use existing retention owners. Previously shared copies are separately owned published material and are not silently rewritten when the private source is deleted; their reuse still respects retained source restrictions.

Restart reconstructs audience from durable Thread and current identity facts. Missing visibility or a contradictory private owner fails closed; implementation must explicitly classify existing records during cutover, with Quick Chat private and formal Task/Goal work shared. Ambiguous project conversations are not automatically published. No backward-compatible implicit shared default is allowed. Before records are writable or importable, register and emit `openkit.thread-visibility.v1` in the existing envelope `requiredFeatures` on Thread records and exported dependent content. Readers lacking that feature reject the record before discovery or access; this is a fail-closed cutover requirement, not support for old readers.

### Audit and portability

Audit of a shared-resource mutation follows the effect's owner, even when the request conversation is private. Retain actor, operation, target, request, changed revision and outcome without copying private dialogue or secret Tool output. Workspace members may inspect eligible Workspace effects; deployment evidence retains administrator access checks.

Ordinary Workspace export includes shared Threads and admitted shared outputs. Another member's private Threads and private-derived bytes are excluded, including when the exporter is a deployment administrator. A user may explicitly export their own eligible private history through the same audience check; it remains private on import and is bound to the importing user, never a claimed remote owner. Restricted-source references remain inert until target authorization is established. Disaster-recovery backup is a separate encrypted operational effect, not an ordinary content API or a grant to search private conversations.

## Current Implementation Projection

Quick Chat is already owner-only and Core already specifies request read scope and output audience. This specification adds project-Thread private visibility and exact sharing contracts; those additions are Not Started. File-backed Thread records remain canonical under the storage owner; App API, Core Client, CLI, Web and streaming project the same guards.

## Testing Strategy / Acceptance Criteria

- Two members can read the same Task/Goal work; neither can enumerate, search, subscribe to or fetch the other's private Assistant Thread, attachment or widget through a guessed id. An administrator token changes none of those results.
- A private Assistant conversation can create shared work with exactly the confirmed brief and attachments; a private-only marker is absent from receiving Items, Worker context, notifications, Knowledge and independent Artifact fetches.
- Full-history snapshot sharing excludes subsequent private messages; exact replay creates no duplicate Thread or output. Stale input, removed membership or forbidden source disclosure creates no shared result.
- Private administration updates an authorized shared resource and emits eligible effect audit without publishing the conversation. A non-admin reader cannot execute an admin action from a shared card.
- Failure before the publication barrier exposes no staged Thread, Item or Artifact; an uncertain barrier outcome never duplicates disclosure. Unsupported required features fail before import or discovery.
- Export/import and index rebuild preserve the same private/shared decisions; restart never restores revoked access or silently completes an uncertain disclosure.

## Links

- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260831-unified_conversation_composer.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
