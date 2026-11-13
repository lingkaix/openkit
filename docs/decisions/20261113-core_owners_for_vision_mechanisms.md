---
status: Accepted
date: "2026-11-13"
decider: Engineer
---
# Core Owns The Vision Mechanisms That Had No Core Owner

## Decision

Core gains an owner for five mechanisms that the Product Vision names and that Core did not define.

1. Work Model owns `Judgement Grounding`. The term means the conversion of a human judgement into Agent input that is precise, localized, executable, and replayable. A Judgement starts no work. It becomes Agent input only when its owning workflow admits a later step with the judged exact target as pinned input. Candidate production uses ordinary parallel or repeated work and adds no workflow mechanism.
2. Work Model owns `Improvement Input`. Improvement through ordinary work reads existing retained records and adds no second ledger. The Task Evaluator stays a reserved role.
3. Mediation owns `Budget`. A Budget is an authored limit on measured consumption inside one attributable scope. Core is the only authority for it. The boundary that produces the measurement enforces it. Evidence keeps measurement, and Policy keeps the authority to spend more.
4. Mediation owns `Logical Model`, `Model Route`, and `Provider Profile`. The Gateway is the only owner of member selection, retry, and failover for a Logical Model.
5. Doctrine owns the rule that routine setup and management are work for Core and its agents. Policy owns the classes of agent-assisted administration. Agent Supply names the `Agent Environment Package` as the current realization of the immutable launch package.

Most of these rules promote semantics that an accepted specification or decision already holds. Three statements have no earlier accepted source. The first is the list of Improvement Inputs. The second is the rule that the owning contract of each Budget states whether its measurement survives restart. The third is the rule that a missing measurement refuses new consumption for every Budget, which generalizes the accepted rule for the raw model output bound of one Turn.

## Reason

On 2026-11-13 the engineer asked whether the Core documents lack mechanisms that the Product Vision describes. The agent's review found the five gaps above. The engineer said 「对于核心文档当中缺失的内容与设计，你可否提交一个 PR，我会来审核与合并。」 The next sentence is a translation. For the content and design that the Core documents lack, can you submit a pull request, and I will review and merge it. The engineer accepts this decision when the engineer merges the change that lands this record.

The Product Vision calls `judgement grounding` the higher-level capability of OpenKit and its durable advantage. Before this decision the term occurred only in the Product Vision and the roadmap. Core held the records, but no Core rule said how a Judgement becomes Agent input.

The Product Vision and Architecture give Core the authority for budgets. Before this decision Core used the word without a definition. Evidence excluded budget enforcement, Policy had no budget rule, and Mediation allowed early implementations to omit the control.

The Product Vision asks for one interface to many model Providers with fallback. Before this decision Core used Provider profile and logical model route without a definition or a term-index entry.

The Product Vision makes the lowest configuration burden a product requirement. Before this decision no Core rule stated it, and Core used `Agent Environment Package` in two documents without a definition.

The agent derived each promoted rule from the accepted specifications for Evaluation Foundation, Work Resource Interaction, the LLM Gateway, the worker Turn reliability envelope, human attention, the Assistant management entry, and the Agent Environment Package.

## Rejected Alternatives

- A new Core aspect document for judgement grounding. Rejected because Work Model already owns Judgement, Candidate Set, and grounded collaboration. A new aspect would split one concept.
- A new workflow mechanism or run object for candidate production. Rejected because parallel work and the Candidate Set already express it.
- Policy or Evidence as the owner of Budget. Rejected because Evidence excludes budget enforcement, and the boundary that produces a measurement is the boundary that can stop consumption.
- A new Core aspect document for model supply. Rejected because Mediation already owns Gateway routing.
- A rule that distributes load across route members. Rejected for this change because no accepted specification defines one.
- An evaluation model for the Task Evaluator. Rejected for this change because the roadmap places that design in its last phase.
- An edit to the Product Vision. Rejected because DOC-018 protects that document and the engineer did not request the edit.

## Revisit When

The engineer did not state a reopen trigger. The agent proposes the triggers that follow. Reopen this decision when an accepted evaluation model replaces the reserved Task Evaluator. Reopen this decision when an accepted specification defines load distribution across route members. Reopen this decision when a Budget needs a scope that no measuring boundary owns. Reopen the placement in Work Model when a split review moves judgement and improvement into a child document.

## Affected Owners

- docs/core/work-model.md
- docs/core/mediation.md
- docs/core/evidence.md
- docs/core/agent-supply.md
- docs/core/doctrine.md
- docs/core/policy.md
- docs/core/README.md
