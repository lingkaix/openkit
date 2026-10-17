---
status: Accepted
date: "2026-10-16"
decider: Engineer, through the coordinator
---
# Assistant Task Proposals Exclude Private Files

## Decision

A later Assistant Task proposal remains brief-only. Its confirmation states in one line that private files are excluded and the User can attach files explicitly when selecting a Worker. Originals remain on their accepted Assistant Turn. P19 adds no file-transfer state. Explicit Worker selection keeps the existing confirmed file-handoff contract in [Unified Conversation Composer](../specs/20260831-unified_conversation_composer.md#audience-at-submission).

## Reason

Source: Coordinator 23:35Z on 2026-10-16. The earlier Assistant Turn already owns its private originals. A later confirmation admits only its displayed payload. Keeping that proposal brief-only preserves the private source boundary without adding transfer state to P19.

## Rejected Alternatives

- Automatically forwarding earlier private originals would disclose files outside the later proposal's displayed payload.
- Adding file-transfer state to P19 would duplicate the existing explicit Worker selection and confirmed file-handoff contract.

## Revisit When

Revisit only when an accepted explicit file-selection handoff contract changes this boundary.

## Affected Owners

- [Unified Conversation Composer](../specs/20260831-unified_conversation_composer.md)
- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md)
