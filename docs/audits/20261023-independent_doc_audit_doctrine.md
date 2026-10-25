# Independent Documentation Audit: Doctrine Group

This record covers the `doctrine` group of the [independent documentation audit](20261023-independent_doc_audit.md). The engineer directed the audit, so [Change Execution](../change-execution.md) is its owning rule. The record is non-authorizing evidence.

## Scope

- Group base: `67d3e5a68453b9efd76c3313768c01dd87ae8cdb`. Issue [#440](https://github.com/lingkaix/openkit/issues/440) did not hold this group on 2026-10-23.
- Files audited: `docs/core/doctrine.md` and `docs/core/README.md`.
- File audited for proposals only: `docs/core/AGENTS.md`. Its proposals are Question Q4 in the summary record.
- Home specifications: none. No specification has a primary concept that `doctrine.md` owns. The process specifications cite `doctrine.md`, but they have no Core home, and the `process` group record covers them.
- Decision records read: [OpenKit Is Agent-Native](../decisions/20260929-agent_native_capabilities.md), [Interface Unification Rulings](../decisions/20261002-interface_unification_rulings.md), [Operation Definition Rulings](../decisions/20261002-operation_definition_rulings.md).
- Code map: none. Doctrine principles reach code only through their aspect owners, so the G3 checks of each group cover them.

## Findings

### G1: Vision To Design

The Phase 1 probes assigned no finding to this group. The vision-level questions that touch Doctrine are in the summary record.

### G2: Core Documents And Specifications

| ID | Finding | Evidence | Disposition |
| --- | --- | --- | --- |
| DOC-G2-01 | The Relationships section of `doctrine.md` omitted two of the twenty required aspects. | `doctrine.md` listed no `fault-tolerance.md` and no `generative-apps.md`, while `docs/core/README.md` lists both in the required aspect set. | Fixed: one relationship line for each document. |
| DOC-G2-02 | A Doctrine principle carried an implementation status. `docs/core/AGENTS.md` says "Keep these docs conceptual and implementation-neutral." The specification projection already states the status. | `doctrine.md` Principles: "The accepted design is not a claim that agent-principal activation is implemented; activation remains unclaimed." `docs/specs/20260629-openkit_policy_model.md` lists "Agent principal accountability" as "Planned; Not Started". | Fixed: the sentence is removed. Its receiver is that Policy model row. The principle and its MUST statements are unchanged. |
| DOC-G2-03 | The aspect file template showed an inline status line that the field contract does not allow. | `docs/core/README.md` Aspect File Standard showed `Status: Accepted` in the body. `docs/documentation-model.md` Field Contract requires YAML front matter. | Fixed: the template shows front matter. |
| DOC-G2-04 | The aspect description and the term index for `contract-evolution.md` omitted three concepts that the document owns. | `contract-evolution.md` Boundaries And Non-Goals owns "retained data continuity, the closed core and open extension of every owned data shape, ... and the post-launch operation semantic promise". | Fixed: the README description and term index name them. |
| DOC-G2-05 | The term index omitted canonical terms that four aspect documents define. | `knowledge.md` defines `Derived Representation` and `Observation`. `sandbox.md` defines isolation levels and the shared Sandbox. `protocol.md` owns "the shared entity-identifier grammar", scope-qualified object references, and pending request semantics. `policy.md` defines `AssistantReadScope` and `OutputAudience`. | Fixed: the index rows name them. |
| DOC-G2-06 | The Document Layers list omitted decision records, although Core documents link them beside the rules they support. | `docs/documentation-model.md` Decision Records. | Fixed: one bullet for `docs/decisions/`. |
| DOC-G2-07 | The term index lists `AgentCapability` under `mediation.md`, but `mediation.md` defines no such term. `docs/specs/20260704-worker_mcp_tool_supply.md` also calls it canonical in `mediation.md`. | `grep` finds `AgentCapability` only in the README index and that specification. | Moved to the `mediation` group, which owns the definition. |
| DOC-G2-08 | No Core document defines the Goal `Coordinator` role, and the term index has no row for it. `core-concepts.md` names it, and `architecture.md` lists the internal roles without it. | `core-concepts.md` naming boundary; `architecture.md` Internal Core Roles; [Goal Redesign Rulings](../decisions/20261002-goal_redesign_rulings.md) rule 1 adds the Coordinator role. | Question Q3, because the Goal design is held under #440. |
| DOC-G2-09 | Three documents state the Core retirement rules: `docs/documentation-model.md`, `docs/core/README.md`, and `docs/core/AGENTS.md`. | README Promotion And Retirement Rules; `docs/core/AGENTS.md` lines 26 and 27; documentation-model Terminal Archive Audit And Archive Immutability. | No change to governance text. The AGENTS.md part is Question Q4. |
| DOC-G2-10 | `docs/core/AGENTS.md` lines 28 and 29 instruct a split of knowledge and AgentSession and of policy and sandbox. Both splits are complete, so the lines now read as finished tasks. | `docs/core/` contains `knowledge.md`, `agent-session.md`, `policy.md`, and `sandbox.md`. | Question Q4. |
| DOC-G2-11 | The product vision links `doctrine.md` with the label "Foundation", but the document title is "Doctrine Model". | `docs/product-vision.md` uses the link text "Foundation" for `./core/doctrine.md` five times. | Question Q5, because only the engineer may change the product vision. |

### G3: Specifications And Implementation

Not applicable: the group has no home specification.

### G4: Specification Structure

Not applicable: the group has no home specification. DOC-G2-09 records the one restated rule set.

### G5: Writing Rules

`doctrine.md` has no sentence over forty words, no filler word, and no unexplained label. `docs/core/README.md` has one 59-word sentence. It describes `storage.md`, whose group #440 holds, so the auditor did not rewrite it.

## Semantic Preservation

The inventory compares the group base with the changed files `docs/core/doctrine.md` and `docs/core/README.md`.

| Item class | Before | Present unchanged | Moved | Changed or removed |
| --- | --- | --- | --- | --- |
| Normative sentences | 71 | 71 | 0 | 0 |
| Other sentences and table rows | 191 | 184 | 0 | 7 |
| Numbers with units | 13 | 13 | 0 | 0 |
| Backticked identifiers | 73 | 73 | 0 | 0 |
| Heading anchors | 32 | 32 | 0 | 0 |
| Links | 4 | 4 | 0 | 0 |

The seven changed items are these:

- The removed status sentence of DOC-G2-02. Its receiver is the Policy model projection named there.
- Six README lines that now name additional terms: the `contract-evolution.md` description and five term index rows. Each line keeps every term it named before.

The diff also adds new text: two Relationships lines in `doctrine.md`, the decision-record bullet in the README, and one new backticked identifier, `docs/decisions/`. The template code block is outside the sentence inventory. Its only change replaces the inline status line with front matter. No anchor or file moved, so no inbound link needed repointing.

## Review

The independent review did not run. The reviewer context stopped at a usage limit before it produced a verdict. The auditor then found that a parallel audit on branch `audit/independent-docs-ag29v9` had audited this group, and it stopped this audit to avoid a second writer on the same files. These corrections are therefore unreviewed drafts. The engineer decides whether to use, merge, or discard them.
