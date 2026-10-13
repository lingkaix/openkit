---
id: capture-knowledge-and-cite-it
title: Save a source and cite it in an answer
persona: User who wants an answer grounded in something they saved
entrypoint: web
default_tool: playwright
timeout_seconds: 900
requires_real_provider: true
requires_real_codex: false
contracts: docs/specs/20260702-knowledge_store_governance_rules.md, docs/specs/20260704-knowledge_manager_internal_agent_runtime.md, docs/specs/20260703-knowledge_store_implementation.md, docs/specs/20260704-chat_mode_assistant.md, docs/specs/20260909-knowledge_notebook_editing.md
---

## Intent

Persona: A user who has a source they want saved.

Ask: Save this source as knowledge and answer my question from the entry we accepted, citing that entry.

## Starting World

One workspace can hold knowledge. One synthetic source is available to the user. The source contains no secret.

## Setup

The stage manager supplies that synthetic source through the private parameter file. The stage manager supplies the provider through the same file. The stage manager does not put a credential value in the story or in the ask.

## Outcome Predicates

- Channel outside-in, tier required. The answer cites that same entry. The answer is an assistant message. `docs/specs/20260704-chat_mode_assistant.md` owns that message.
- Channel inside-out, tier required. The cited entry is in the published revision and retains a source reference to the saved source. An authorized actor published that revision. The model that produced the candidate did not publish it. The records are the published Knowledge revision and the Knowledge Source. `docs/specs/20260909-knowledge_notebook_editing.md` owns publication. `docs/specs/20260702-knowledge_store_governance_rules.md` owns the source reference.
- Channel inside-out, tier required. The completed answer's assistant-message Item is on the addressed Thread and cites that published entry. The record is that Item. `docs/specs/20260704-chat_mode_assistant.md` owns that Item. `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` owns the citation.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager keeps the public knowledge entry, its source reference, the published revision, and the answer with its citation.

## Cleanup

The stage manager does not publish a second entry after adjudication.

## Failure Triage Notes

- A product failure means the answer cites no entry, cites a different entry, or cites an entry that is not in the published revision.
- An environment failure means the workspace is missing, or the provider or quota is missing.
- A tool failure means the browser-control tool fails on its own.
- An inconclusive result means the entry or the citation was never witnessed.
- The likely lower layer is the knowledge schema test and the knowledge-manager citation test.
