# Correction, candidate v2 and human selection

Use this reference for an explicit human correction or comparison request, including comparison of the Meta-Skill onboarding setups. This procedure uses the existing candidate, exact-version Turn, pin and selection operations. It defines no evaluator, score, automatic promotion, candidate-set API or new durable comparison record.

## Inspect setup quality and downstream work

Have the human review each setup output against the supplied business needs: role Skills, Knowledge, connections and authority rules, needed glue apps or their omission, and recurring-work proposals. Retain existing review or judgement records and exact output references. Review responsibility and authority boundaries, the information map, action evidence/effects and each costly rule's independent check. A prepared proposal, accepted candidate or successful transport is not proof of a correct working setup.

Agree on a fixed downstream task set and permitted effects before comparing setups. Retain observed success, human corrections, Turns, tokens and cost available through the existing usage ledger, wall time, approvals, Policy denials and escalations. Join actual output, Turn, usage, approval and effect references; report missing joins or unavailable cost as unverified. A denial may be correct enforcement; have the human examine whether a denial or escalation exposes a Skill/Policy mismatch. Do not infer a quality score, add an evaluator or invent a measurement record type.

## Preserve the correction

Record the human's correction, the exact v1 Skill digest, the task or setup and observed output being corrected, relevant source references and the intended behavior change. Ask about an ambiguous correction before changing its governing rule. A single bad result does not establish a new policy or a universal quality score.

Read the retained v1 tree and prepare the complete v2 tree with only the authorized correction. Submit `catalog.skill-candidate-submit` with `baseDigest` equal to v1 and the current catalog revision through an authorized caller. Retain the actual candidate id and candidate digest. Use `catalog.skill-diff` to show the exact change. Leave the shared pin/default unchanged while the candidate is proposed.

## Compare onboarding setups

For a Meta-Skill correction, have the human create two fresh Workspaces and supply the same retained intake and approved onboarding work to each. An authorized actor supplies the exact retained Meta-Skill v1 and candidate v2 through the existing catalog and composed Agent setup, then uses the exact-version run selection described below. Keep the comparison version explicit; do not substitute the currently pinned version or claim that an unpromoted candidate must first be promoted.

Review the produced setups separately and apply only the separately authorized decisions needed for the fixed downstream tasks. Run that same task set against each setup, then show the human both setup reviews, actual work outcomes and measurement limits. Record differing data, connections, model/runtime/context or approvals; a fresh Workspace does not reset an external system. Do not reset another run or duplicate sensitive effects to manufacture comparable state.

Keep the Meta-Skill v1/v2 references distinct from the domain Skill versions each setup produced. Each Workspace has its own current catalog identities, revisions and decisions; read them rather than reusing another Workspace's selectors or grants. Use retained exact Skill content through the ordinary authorized catalog path, without inventing a cross-Workspace activation operation. The human selects the Meta-Skill version after inspecting setup and work results; its shared pin remains unchanged during comparison.

## Compare the next task

Have the human identify the same next task, available inputs and permitted actions for both runs. If the chosen task or tool state is unsuitable for a fair comparison, explain the limit and ask the human; do not invent fixture edits or reset another run's effects. Record differences in external facts, model/runtime/context and human input that limit comparison.

An actor with current launch authority can start two ordinary Worker Turns with `turn.start.skillSelections:[{skillId,digest}]`, one at v1 and one at v2. The Skill must already be included in each composed Agent setup. Explicit exact selection can use an unpromoted retained candidate and changes neither default nor pin. Do not modify an active session's files, omit an override while claiming to test v2, or claim that promoting v2 is required to compare it.

Keep comparison effects within the approved scope. Read/draft comparison is sufficient to inspect a correction; do not send or issue twice merely to compare versions. Sensitive calls still need their own captured human approval, and a run must not execute another run's pending effect. Report an existing deterministic draft or changed external state as a comparison limit rather than fabricated independent evidence.

Where a compared output already has an Artifact Review, the human can record its exact choice through `artifact.review.select` using that Artifact id, version and content digest. The returned candidateSelections records actor, time and reason; it is neither a final Review decision nor catalog activation. Retain the actual choice reference with both compared outputs.

Retain each actual Turn, AEP `supply.skills` digest and `selectionSource:run`, observed native Skill consumption, task inputs and output references. Keep the first adopted run's `selectionSource:pin` evidence separate. `catalog.skill-diff` proves byte differences only; it does not prove better setup or task behavior. Show the human both outputs with their actual limitations, without selecting a winner on the human's behalf.

## Apply the human choice

If the human chooses v2, an authorized actor promotes its proposed candidate through `catalog.skill-candidate-decide` against the expected v1 current digest and current revision, then separately moves the Workspace pin with `catalog.skill-pin`. If v1 is chosen, retain that choice and leave its pin; reject or withdraw v2 only through the authorized existing candidate decision. A stale base or moved pin is a conflict to inspect, not permission to overwrite a different decision.

If rollback is requested after promotion, `catalog.skill-select` chooses the retained v1 default and `catalog.skill-pin` independently restores the desired pin using their current compare-and-set values. Neither operation undoes an external effect, restores a Light App snapshot or reverses Knowledge publication. Retain the actual selection audit and the human's decision reference where available.

There is no aggregate Skill candidate-set comparison operation. This bounded loop uses ordinary exact-version runs, output choice evidence, human review and catalog decisions; do not claim that these create an aggregate comparison record or an evaluation result. The available evidence is the two ordinary runs, their exact versions, their outputs, any existing Artifact choice, the human decision and the existing catalog decision/pin records. An unavailable onboarding or next-task run, human decision or evidence join remains explicitly unverified.
