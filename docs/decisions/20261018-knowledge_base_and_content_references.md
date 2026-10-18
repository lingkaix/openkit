---
status: Accepted
date: "2026-10-18"
decider: Engineer; allocation and path details approved by Coordinator
---
# Knowledge Base And Content References

## Decision

The engineer approved Knowledge Base-qualified references at 06:10Z and raw-content scopes, optional SHA-256 pins, one textual serialization and URI-only retention at 06:35Z on 2026-10-18. The coordinator approved `kb_<UUIDv7>` allocated once per scope and retained as `defaultKnowledgeBaseId`. Version 0.1.0 implements one base per User Memory, Workspace or Server scope; more bases later are additive.

Core Protocol owns the exact page/raw scope grammar and `openkit:` serialization. Original content digests, delivered representation digests and Notebook revisions remain separate evidence. A URI grants no access, can become unavailable and must never silently identify other content. Models and retained content-reference fields carry URIs rather than temporary fetch URLs. Relative raw paths remain the Knowledge-local short form.

Default Knowledge Base Worker-delivered paths remain unchanged. Retained selection, deduplication, cursor and context-package identities carry the base ID. Additional bases can add delivered paths later. This avoids putting an otherwise unnecessary UUID into every model-visible default path.

The pre-stable reset decision applies. This cutover adds no converter, dual write, alias or legacy reader. The coordinator sequences reset-dependent landings after the rc.9 pre-reset cut and performs the single coordinated rc.10 reset; this decision performs no reset or host action.

## Reason

The engineer's intent, translated: references need a Knowledge Base ID now, so later support for several bases does not require another retained-format change. File references also serve Workers, internal agents, external agents, Channels and future sharing. Retained references must not depend on a temporary delivery address or grant access by themselves.

Independent allocation follows the accepted shared identifier rule. The existing scope configuration already owns the default binding; a new registry or default-specific derivation is unnecessary. Keeping default sandbox paths stable preserves useful model context without weakening retained identity.

## Rejected Alternatives

- Keep scope-only page references until several bases ship: requires a later change to retained references.
- Infer or generate a missing base ID during lookup: can silently bind old references to a new object.
- Put the default base UUID in every delivered path: unnecessary model token cost and path churn.
- Retain signed URLs, read earlier reference forms or convert pre-stable records: conflicts with the approved reference and reset boundaries.

## Revisit When

Add explicit selection and delivered paths when more bases per scope are implemented. Add cross-Server identity before remote resolution. A new Storage backend may change byte delivery without changing reference identity or access ownership.

## Affected Owners

- [Core Protocol](../core/protocol.md#scope-qualified-object-references).
- [File Storage And Knowledge Packages](../specs/20261018-file_storage_and_knowledge_packages.md).
- [Knowledge Store](../specs/20260703-knowledge_store_implementation.md), [Notebook](../specs/20260909-knowledge_notebook_editing.md) and [Context Package](../specs/20260703-worker_context_package.md).
- [Retrieval Kernel](../specs/20261014-retrieval_kernel.md) and [Backup And Export](../specs/20260704-workspace_backup_export_import.md).
