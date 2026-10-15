---
status: Accepted
date: "2026-10-15"
decider: Engineer (direction; realization awaits Coordinator and Consultant review)
---
# Query Context, Sources, References And Acts

## Decision

The engineer accepted this direction on 2026-10-15: every query has one current Server, Workspace, Actor and querying Thread/Turn. Trusted context derives its eligible sources; request input may only narrow them. Workspace and Server own Knowledge bases. The Assistant's current User owns Memory. Memory recall and Knowledge retrieval are separate invocations with labelled context sections and separate budgets. Workers cannot read Memory. Scores from different indexes do not establish a common relevance order.

Pins, traces and citations use one scope-qualified reference form: `(scope id, object id)`. Current Server context resolves the reference; cross-server references later add an explicit server identity. A reference identifies an object and supplies no access grant. The existing page owner retains its stable bundle-relative path identity; this direction requires qualification, not another independently generated page identifier.

A selection trace belongs to the querying act in its existing Thread/Turn, not to any source notebook. Assistant traces live in the private Assistant Timeline; Worker traces live in the Task/Goal Thread. Traces retain source references rather than source content. Reading trace evidence rechecks the reader's current source access. A retained reference cannot preserve permission after revocation. No new ledger is selected.

Future cross-Workspace, cross-User and cross-Server retrieval uses explicit source bindings authorized by the source owner, with a grantor, source scope, destination audience and revocation checked at each query and subsequent read. Cross-server access uses a remote source binding through a server connector. A separately authorized publish/copy path may create destination-owned content with provenance. These are directions only: R2 adds no binding, connector, `sources/` mount or implicit sharing permission.

The engineer also confirmed one private Assistant Timeline per `(User, Workspace)`, no user-created private chat Threads, one durable rolling context window for all NanoCore internal roles in place of the unimplemented Gateway compactor, and that personal Workspaces cannot add members. These confirmations supply the privacy premise; this record implements no Chat Mode behavior.

## Reason

Source: engineer rulings dated 2026-10-15 in change record 202610140256550000-v0_1_0_core_experience, including the verbatim Chinese source and faithful English translations. The engineer's spelling “Nodule Core” denotes NanoCore. The engineer first asked for a first-principles design based on a query's current Workspace and Server, an Assistant's known User, the distinction between personal Memory and Knowledge bases, and future sharing from personal research Workspaces into team work. After the coordinator proposed this model, the engineer agreed with its direction and basic design and delegated details to the coordinator and Consultant under ruling 9.

The context supplies authority facts that a model request cannot select for itself. Separate Memory recall avoids treating a personal preference and a shared factual page as interchangeable ranked candidates. Source qualification removes ambiguous plain page pins without choosing the first source that happens to contain an id. The existing stable path and forgotten-identity reservation already provide a page identity under its owner; adding a UUID and path lookup is not needed for qualification. [One Identifier Mechanism](20261014-one_identifier_mechanism.md) continues to exclude authored selectors and composite keys from independent entity generation.

The querying Thread already has an audience, retention owner and durable evidence. A source notebook cannot own the disclosure boundary of a query that uses it. The confirmed private Assistant Timeline keeps Memory evidence private without a User-plus-Workspace trace ledger. Explicit future read bindings can share selected Knowledge without adding members to a personal Workspace or making a query itself an authorization mechanism. A copy is not automatic declassification.

This record preserves the engineer-approved model. Phase A realization details are exposed in the R2 change record for Consultant scrutiny; their drafting is not Consultant agreement or permission to begin Phase B.

## Rejected Alternatives

The private User-Memory-plus-Workspace ranked union is replaced: its sources have different semantics, audiences and independent lexical score scales. Plain page ids and first-scope pin resolution are replaced by explicit references. A source-owned User or Workspace combined-trace ledger is replaced by the existing querying Thread/Turn owner. Automatic cross-Workspace unions and implicit membership in personal Workspaces are excluded because a query cannot grant source access. No new page UUID is selected merely to qualify an already stable owner-defined page path.

## Revisit When

Revisit page identity if its owner permits published-path moves or identity reuse. Revisit the reference envelope when a cross-server connector is accepted. Before source bindings ship, their source and destination owners must settle grant, audience, revocation, retention, failure and copy semantics; this direction does not supply those contracts. Bring important problems, authorizations, blockers and coordinator–Consultant disagreements to the engineer under ruling 9.

## Affected Owners

- [Core Protocol](../core/protocol.md#scope-qualified-object-references): reference qualification and the exclusion of authored page selectors from independent entity generation.
- [Personal Memory And Scoped Knowledge Learning](../specs/20260909-personal_memory_and_knowledge_learning.md): contextual sources, separate recall and retrieval, budgets and privacy.
- [Knowledge Store Implementation](../specs/20260703-knowledge_store_implementation.md#retrieval-pipeline): scoped pins, one-source Knowledge requests, querying-act evidence and current-access resolution.
- [Knowledge Manager Service](../specs/20260704-knowledge_manager_internal_agent_runtime.md): qualified citation and retrieval-trace results without a second selector.
- [Worker Context Package](../specs/20260703-worker_context_package.md#knowledge-selection-input-and-delivery): the existing Task bridge consumes the qualified retrieval reference; history and delivery ownership do not change.
- [Retrieval Kernel](../specs/20261014-retrieval_kernel.md): trusted adapter context, reference mapping and separation of product source invocations.
- [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md): confirmed Timeline and rolling-context premises; its Tool binding remains separate work.
