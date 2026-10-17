# Correction, candidate v2 and human selection

Use this reference only for an explicit human correction and comparison request. This procedure uses the existing candidate, exact-version Turn, pin and selection operations. It defines no evaluator, score, automatic promotion, candidate-set API or new durable comparison record.

## Preserve the correction

Record the human's correction, the exact v1 Skill digest, the case and observed output being corrected, relevant source references and the intended behavior change. Ask about an ambiguous correction before changing its governing rule. A single bad result does not establish a new policy or a universal quality score.

Read the retained v1 tree and prepare the complete v2 tree with only the authorized correction. Submit `catalog.skill-candidate-submit` with `baseDigest` equal to v1 and the current catalog revision through an authorized caller. Retain the actual candidate id and candidate digest. Use `catalog.skill-diff` to show the exact change. Leave the shared pin/default unchanged while the candidate is proposed.

## Compare the next case

Have the human identify the same next case, available inputs and permitted actions for both runs. If the chosen case or tool state is unsuitable for a fair comparison, explain the limit and ask the human; do not invent fixture edits or reset another run's effects. Record differences in external facts, model/runtime/context and human input that limit comparison.

An actor with current launch authority can start two ordinary Worker Turns with `turn.start.skillSelections:[{skillId,digest}]`, one at v1 and one at v2. The Skill must already be included in each composed Agent setup. Explicit exact selection can use an unpromoted retained candidate and changes neither default nor pin. Do not modify an active session's files, omit an override while claiming to test v2, or claim that promoting v2 is required to compare it.

Keep comparison effects within the approved scope. Read/draft comparison is sufficient to inspect a correction; do not send or issue twice merely to compare versions. Sensitive calls still need their own captured human approval, and a run must not execute another run's pending effect. Report an existing deterministic draft or changed external state as a comparison limit rather than fabricated independent evidence.

Where a compared output already has an Artifact Review, the human can record its exact choice through `artifact.review.select` using that Artifact id, version and content digest. The returned candidateSelections records actor, time and reason; it is neither a final Review decision nor catalog activation. Retain the actual choice reference with both compared outputs.

Retain each actual Turn, AEP `supply.skills` digest and `selectionSource:run`, observed native Skill consumption, case inputs and output references. Keep the first adopted run's `selectionSource:pin` evidence separate. `catalog.skill-diff` proves byte differences only; it does not prove better case behavior. Show the human both outputs with their actual limitations, without selecting a winner on the human's behalf.

## Apply the human choice

If the human chooses v2, an authorized actor promotes its proposed candidate through `catalog.skill-candidate-decide` against the expected v1 current digest and current revision, then separately moves the Workspace pin with `catalog.skill-pin`. If v1 is chosen, retain that choice and leave its pin; reject or withdraw v2 only through the authorized existing candidate decision. A stale base or moved pin is a conflict to inspect, not permission to overwrite a different decision.

If rollback is requested after promotion, `catalog.skill-select` chooses the retained v1 default and `catalog.skill-pin` independently restores the desired pin using their current compare-and-set values. Neither operation undoes an external effect, restores a Light App snapshot or reverses Knowledge publication. Retain the actual selection audit and the human's decision reference where available.

There is no aggregate Skill candidate-set comparison operation. This bounded loop uses ordinary exact-version runs, output choice evidence, human review and catalog decisions; do not claim that these create an aggregate comparison record or an evaluation result. The available evidence is the two ordinary runs, their exact versions, their outputs, any existing Artifact choice, the human decision and the existing catalog decision/pin records. An unavailable next-case run, human decision or evidence join remains explicitly unverified.
