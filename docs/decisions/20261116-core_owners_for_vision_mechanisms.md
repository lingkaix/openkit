---
status: Accepted
date: "2026-11-16"
decider: Engineer, delegated to the DOC-FINAL ruling of 2026-11-16
---
# Core owners for Vision mechanisms

## Decision

Core gains an owner for five mechanisms that the Product Vision names and that Core did not define.

1. Work Model owns `Judgement Grounding`. The term means the conversion of a human judgement into Agent input that is precise, localized, executable, and replayable. The accepted examples are assessment, correction, and selection. General annotation and compare-driven feedback are not part of this contract. A Judgement starts no work. An explicit next-step submission carries the selected candidate as an exact pinned Artifact version. Other Judgement kinds become Agent input only through their owning contract. Candidate production uses ordinary parallel or repeated work under the existing Thread and Turn rules. One Thread has no simultaneous Turns. Candidate production adds no workflow mechanism.
2. Work Model owns `Improvement Input`. An `Improvement Input` is a retained record that an improvement proposal may cite. A proposal reads it through the owner of the record. No second ledger exists. A missing input stays a recorded gap and is never reconstructed. An input grants no authority. The contract of the proposal owner decides which inputs are admissible evidence. A Knowledge proposal accepts only the source references that the Knowledge contract admits. Evidence outside that set requires registered Source capture first. Current classes, not a closed set, are Judgements and Candidate Set selections, Review And Acceptance decisions, the ordered Item history of the judged work, the exact Agent setup and the delivered context of that work, and measured usage. The Task Evaluator stays a reserved role.
3. Mediation owns `Budget`. A Budget is an authored limit on measured consumption inside one attributable scope. Core is the only authority for it. Enforcement is a Policy projection at the mediation boundary. Evidence keeps measurement. Each Budget's owning contract states the unit, the scope, the measuring producer, the enforcement point, the missing-measurement behavior, and the restart durability. A missing measurement is neither zero use nor exhaustion. The owning contract states whether new consumption is refused while its measurement is missing. The raw model output bound of a Turn refuses further inference. That refusal is not a rule for every Budget.
4. Mediation owns `Logical Model`, `Model Route`, and `Provider Profile`. A Provider Profile holds an explicit model list. An endpoint, a credential reference, or an account binding depends on the Provider kind. The Gateway is the only owner of member selection, retry, and failover for a Logical Model. The comparison that exhausts a bound stays with the owning contract.
5. Doctrine owns the rule that routine setup and management are work for Core and its agents. A default work path SHOULD NOT require a user to author or maintain Workspace, Agent, Policy, or execution-environment configuration. Policy owns the classes of agent-assisted administration. Those classes widen no entry's finite action list. Agent Supply names the `Agent Environment Package` as the current realization of the immutable launch package. An external representation may differ and MUST preserve the Core authority chain.

`policy.md` owns authority and `PermissionDecision`. Budget enforcement is a Policy projection over measured usage and is not a Metering decision. `mediation.md` owns the `Budget` term and its enforcement boundary.

The new or inferred rules accepted here are the five statements above, as amended. A general Budget enforcement and update lifecycle is not accepted (#796). A general Judgement-to-input rule is not accepted (#797). This record does not state those contracts.

## Reason

On 2026-11-13 the engineer asked whether the Core documents lack mechanisms that the Product Vision describes. The review found the five gaps above. The engineer asked for a pull request. The DOC-FINAL ruling of 2026-11-16 accepts the amended statements in this record.

The Product Vision calls judgement grounding a higher-level capability. Before this decision the term had no Core rule for how a Judgement becomes Agent input.

The Product Vision and Architecture give Core the authority for budgets. Before this decision Core used the word without a definition.

The Product Vision asks for one interface to many model Providers with fallback. Before this decision Core used a Provider profile and a logical model route without a definition or a term-index entry.

The Product Vision makes the lowest configuration burden a product requirement. Before this decision no Core rule stated it, and Core used `Agent Environment Package` without a definition.

## Rejected Alternatives

- A new Core aspect document for judgement grounding. Rejected because Work Model already owns Judgement, Candidate Set, and grounded collaboration.
- A new workflow mechanism or run object for candidate production. Rejected because parallel work and the Candidate Set already express it.
- Policy or Evidence as the owner of Budget. Rejected because Evidence keeps measurement, and enforcement is a Policy projection at the mediation boundary.
- A new Core aspect document for model supply. Rejected because Mediation already owns Gateway routing.
- A rule that distributes load across route members. Rejected because no accepted owner defines one.
- An evaluation model for the Task Evaluator. Rejected because that role stays reserved.
- A universal rule that every missing measurement refuses new consumption. Rejected. Only the raw model output bound of a Turn refuses further inference. Each other owner states its own missing-measurement behavior.
- Producer-owned enforcement, a prospective update lifecycle, commit-before-stop, and stop-proof exhaustion for every Budget. Rejected. #796 holds that design.
- A generic conversion of every Judgement and typed choice into Agent input. Rejected. #797 holds that design.

## Revisit When

Reopen this decision when an accepted evaluation model replaces the reserved Task Evaluator. Reopen this decision when an accepted owner defines load distribution across route members. Reopen this decision when a Budget needs a scope that no measuring boundary owns. Reopen the placement in Work Model when a split review moves judgement and improvement into a child document.

## Affected Owners

- [Work Model](../core/work-model.md)
- [Mediation](../core/mediation.md)
- [Evidence](../core/evidence.md)
- [Agent Supply](../core/agent-supply.md)
- [Doctrine](../core/doctrine.md)
- [Policy](../core/policy.md)
- [Core README](../core/README.md)
