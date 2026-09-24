---
status: Accepted
---
# Engineering Glossary

This glossary is the Ubiquitous Language of the engineering process: the words that root AGENTS.md, the governance documents, the role contracts, and change records use for how this repository is built. Product words such as Workspace, Thread, Turn, and Orchestrator belong to a different bounded context, owned by docs/core/core-concepts.md. The decision and its reason are recorded in [a decision record](decisions/20260923-engineering_vocabulary_and_writer.md).

## Owns

- The meaning, within the engineering-process context, of every term listed below, and the fixed phrase for each meaning of an overloaded word.
- Which project-specific terms remain, which were renamed, and which words are avoided.
- The resolution of words that collide with the product context.

A rule that uses a term stays in the document that owns the rule; an entry here defines the word and points to that owner without restating the rule.

### Classic Terms

These terms keep their standard meaning. The source names where the meaning comes from; the usage notes say where this project narrows it and which role contracts name it as a leading word.

| Term | Source | Project usage |
| --- | --- | --- |
| Abstraction barrier | Abelson and Sussman, SICP, section 2.1 | Callers use data only through its constructors and selectors; used to ask which values are bound once and passed on opaquely. Reviewer. |
| Ablation | Machine-learning ablation studies | Removing one mechanism to learn which required behavior it carries. Decided only with a check shown to see that responsibility. Builder, reviewer, auditor. |
| Additivity, data-directed design | SICP, section 2.4 | Adding a member by registering one entry instead of editing every operation. Consultant. |
| Chesterton's Fence | G. K. Chesterton, The Thing | Learn why a rule exists before removing it; decision records hold the answer. Consultant, writer. |
| Characterization test | Michael Feathers, Working Effectively with Legacy Code | A test that pins current behavior before a change to untested code. Test author. |
| Closure property | SICP, section 2.2 | Combining things yields the same kind of thing, so a new concept can often be an instance of an existing kind. Consultant. Not the same as consumer closure below. |
| Code Smell | Martin Fowler, Refactoring | A diagnostic clue, not a defect by itself; name the concrete cost first. Root AGENTS.md, reviewer. |
| Composition over inheritance | Gamma et al., Design Patterns | Reuse by composing functions and objects rather than extending classes. Builder. |
| Conway's Law | Melvin Conway, 1968 | Structure follows the communication structure that produced it; here, code grows along the lines the primary dispatches work. Primary. |
| Deep module, information hiding | John Ousterhout, A Philosophy of Software Design; David Parnas, 1972 | A small interface that hides decisions callers would otherwise reconstruct. Judged by fewer internal concepts, call orders, and compensation steps that callers must know. Primary, builder. |
| Design by contract | Bertrand Meyer | Preconditions, postconditions, and invariants as the form of a boundary specification. Writer. |
| Diátaxis | Daniele Procida | Tutorial, how-to, reference, and explanation as distinct document purposes; here normative owners, rationale, and manuals stay separate. Writer. |
| Essential and accidental complexity | Fred Brooks, No Silver Bullet | Essential complexity is the price of a requirement the engineer chose; accidental complexity is the rest. Consultant, auditor. |
| Fail fast | Jim Shore, 2004 | Detect a violated invariant at the boundary and stop with a clear error instead of continuing. Not the same as retrying fast. Builder. |
| Fault injection | Reliability engineering | Deliberately causing a failure at a boundary, such as a failed step, restart, duplicate, reorder, or split. Test author. |
| Goodhart's Law | Charles Goodhart | A measure that becomes a target stops measuring; signals never become builder targets. Reviewer, auditor. |
| Gray-box testing | Testing practice | Test the public seam's contract and observable consequences, observing internals only where a return value cannot prove a responsibility. Test author. |
| Mutation testing | DeMillo, Lipton, and Sayward, 1978 | Planting a fault to learn whether checks detect it; specification mutation applies the idea to documents. Test author. |
| Normalization | Relational database design | Each fact is stored once; a restated copy is an update anomaly. Writer. |
| Open-closed principle | Bertrand Meyer; part of SOLID | Open to extension, closed to modification, applied only at a variation point that already has a second member. Consultant. |
| Property-based testing, invariant | QuickCheck; testing practice | Assert what must always hold across generated or composed inputs rather than one example. Test author. |
| Seam | Michael Feathers, Working Effectively with Legacy Code | A place where behavior crosses between owners and can be observed or altered; the primary names one when a representation crosses different owners. Primary, test author. |
| Separation of concerns | Edsger Dijkstra, 1974 | Different responsibilities live in different places; the same idea as high cohesion and low coupling in root AGENTS.md. Primary. |
| Single source of truth | Data management practice | One owner holds each fact; other documents link to it. Writer. |
| Specification by example, example mapping | Gojko Adzic; Matt Wynne | Rules illustrated with examples agreed before building, with open questions recorded; no Gherkin runner. Test author. |
| Strategic programming | Ousterhout, A Philosophy of Software Design | Continuous design investment as part of delivery; the doctrine keeps the 10–20% heuristic and says it is not a quota. Primary, builder. |
| Test oracle | Testing theory | What an observation should have been, compared with the observation; docs/verification-instruments.md owns its classification. Test author. |
| Tolerant reader | Martin Fowler | A reader that ignores what it does not need; here only for safely ignorable fields, never for required or authority-bearing ones. Consultant. |
| Tracer bullet | Hunt and Thomas, The Pragmatic Programmer | A thin end-to-end path built first to learn the route; a Draft specification plays this role before promotion. Primary. |
| Traceability | Requirements engineering | Links from each criterion to the tests that prove it and back. Writer. |
| Ubiquitous Language, bounded context | Eric Evans, Domain-Driven Design | One meaning per word inside a context, with explicit translation between contexts; this glossary applies it. Builder. |
| YAGNI | Extreme Programming | Build nothing for a variant that does not exist yet. Root AGENTS.md, consultant. |

### Project-Specific Terms

These terms have no classic equivalent that says the same thing. Each is marked project-specific.

| Term | Definition | Scope | Owner |
| --- | --- | --- | --- |
| Intent Revision | One append-only entry in a change plan that records the requested outcome, non-negotiables, acceptance, and effect boundary with its source; a change of any of them appends a new revision. Change plans written before 2026-09-24 call it Intent Epoch. | Change plans | docs/change-execution.md |
| Checkpoint | The rewritable part of a change plan that holds current facts, method, and the next action. | Change plans | docs/change-execution.md |
| Material work | Work whose consequence, uncertainty, irreversibility, or coordination need makes it follow change execution governance. | All work | Root AGENTS.md, docs/change-execution.md |
| Safety Kernel | The eight strict concerns listed in root AGENTS.md that stay strict for every task. | All work | Root AGENTS.md |
| Effect domain | A kind of external effect, such as Core storage or a container runtime, owned by one component. | Verification, architecture | docs/verification-instruments.md |
| Harness Admission | Admitting an executable test harness as an oracle only after it has produced each of its declared outcomes. | Verification | docs/verification-instruments.md |
| Direction-bearing commitment | A step that changes scope or accepted design, invests substantially in a new route, has an irreversible or external effect, or closes with a scheme that differs from the scrutinized one. | Change execution | docs/change-execution.md |
| Turn outcomes: Continue, Reframe, Ask Human, Close | The four possible outcomes of a material turn. | Change execution | docs/change-execution.md |
| Primary, dispatcher, delegate | Positions relative to one scope of work: the dispatcher hands a scope over, the primary owns its intent, integration, and acceptance, and a delegate does part of it. | Agent coordination | docs/change-execution.md |
| Capability tier: frontier, standard, fast | Abstract model capability used by role contracts instead of model names. | Agent coordination | docs/change-execution.md |
| Bounded task contract | The dispatch a primary writes for a fast-tier delegate: inputs, writable paths, completion check, prohibitions, and return shape. | Agent coordination | docs/documentation-model.md |
| Context budget | The part of its context window a primary spends; a side task whose detail the main line does not need is delegated so that only its conclusion and evidence pointers return. | Agent coordination | docs/change-execution.md |
| Consumer closure | The complete set of places that consume a symbol, file, or record, found before it is changed or removed. | Change and review | docs/roles/builder.md, docs/roles/reviewer.md |
| Rebuild test | The documentation criterion that an agent could rebuild a conforming system from the documents after the implementation is deleted; a rebuild probe samples it. | Documentation | docs/specs/20260719-verification_calibration.md |
| Decision record | One file under docs/decisions/ recording a durable decision and its reason. | Documentation | docs/documentation-model.md |
| Specification kind | One of concept, boundary, mechanism, topology, or process. | Specifications | docs/documentation-model.md |

### Overloaded Words

Use the fixed phrase for the meaning you intend. A bare word is acceptable only when the surrounding sentence leaves one reading.

| Word | Meaning | Fixed phrase |
| --- | --- | --- |
| owner | The document that decides a concern | owning document |
| owner | The single agent allowed to write a path at a time | path writer |
| owner | The component that owns an external effect | effect owner |
| owner | The existing code module responsible for a behavior | owning module |
| authority | A document's power to decide | governing authority |
| authority | Permission to perform an effect | authorization |
| projection | A derived, non-authoritative restatement of an owner | document projection |
| projection | A product read model derived from durable records | read projection (product context) |
| closure | Every consumer of a symbol or record | consumer closure |
| closure | Every record a portable export must carry | reference closure (product context) |
| closure | Combination yielding the same kind of thing | closure property |
| gate | A reserved engineer decision | engineer gate |
| gate | A check whose result decides acceptance | deciding check |
| bounded | An oracle that asks a finite set of questions | bounded oracle |
| bounded | Limited in scope | bounded (scope sense) |

### Collisions With The Product Context

| Word | Engineering context | Product context | Resolution |
| --- | --- | --- | --- |
| epoch | Former name of an Intent Revision | Runtime, physical, and execution epochs in NanoHost and storage | Renamed to Intent Revision in engineering text |
| Orchestrator | Not used | The built-in Goal Mode coordinating agent | In engineering text, a dispatcher; say "the product Orchestrator" when the product component is meant |
| audit record | A dated observation record under docs/audits/ | A product audit record owned by docs/core/audit.md | Say "repository audit record" when the product one could be meant |
| projection | Document projection | Read projection | Use the fixed phrases above |

### Avoid

| Word | Reason | Use instead |
| --- | --- | --- |
| Intent Epoch in new text | Collides with product epochs | Intent Revision |
| ledger | Discussion slang with no defined meaning here | round record, change record, or the specific file |
| G1, G2, D1, D2, D3, O1 | Codes from the 2026-09-22 pilot, meaningless outside it | the question itself, such as caller burden |
| copilot | Names a position, not a function | delegate |
| advisor | Not a role; folded into the Consultant | Consultant with a capability stance |
| verifier as a role | Removed role | reviewer or auditor |

## Does Not Own

- Product vocabulary: docs/core/core-concepts.md and the Core documents own it.
- Any rule, threshold, or procedure: the linked owner of each entry owns it.
- Writing rules: docs/writing.md owns them.

## Judgments

- Naming a classic concept triggers the behavior an agent already knows more reliably than describing it, so classic terms are preferred and are named in role contracts where the behavior happens. Rests on: the engineer's observation of agent behavior during the 2026-09-23 discussion. Overturned by: trials in which named leading words show no effect on the behavior they name.
- A coined term that triggers no prior knowledge costs every reader a definition, so a coined term remains only when no classic term or plain phrase says the same thing. Rests on: measured misreadings of coined and overloaded terms in September 2026. Overturned by: a coined term that is never misread after its definition lands.

## Related Documents

- docs/core/core-concepts.md
- docs/writing.md
- docs/roles/README.md
