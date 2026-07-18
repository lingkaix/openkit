# Bounded Work Loop

Load this reference for normal workspace work, mode selection, plans, bounded execution, Action Center decisions, artifacts, evidence, reviews, or completion.

## Prepare the work context

Run `doctor`, select or create the intended workspace, and inspect its durable resources. Ask the user to confirm repositories, data sources, and external-effect boundaries before linking or changing them.

Create or resume one thread for the work. Read the current thread, active mode state, Action Center, and relevant artifacts before mutating anything.

## Select the smallest suitable mode

- Use Chat Mode for a lightweight answer that does not need delegated execution or a negotiated plan.
- Use Task Mode for one bounded delegated task that needs worker execution but not plan negotiation.
- Use Goal Mode for tracked multi-step work that needs a plan, approval, bounded steps, and review.

Do not promote work to a heavier mode merely because that mode exists. Let NanoCore report when an accepted handoff or transition is required.

## Run bounded work

1. Search and describe the required operation when its contract is not already known.
2. For Goal Mode, draft a narrow objective and plan, then obtain required human approval.
3. Invoke one mutation through stdin.
4. Re-read the thread, mode state, Action Center, artifacts, and evidence.
5. Explain the durable result and any pending human decision.
6. Continue with one next operation only when the state and user direction permit it.

Treat Action Center as the authoritative projection of required human attention. Never approve a plan, answer a question, accept or reject a result, extend a budget, authorize spending, or resolve another decision without explicit user direction.

Treat artifacts and evidence as review inputs, not automatic proof of correctness. Compare them with the objective, constraints, requested verification, and durable status before recommending acceptance.

Use an accepted refine, redo, steering, pause, resume, interrupt, or stop operation only when CLI discovery exposes it and the durable state permits it. Never claim that an active-turn input was delivered merely because a local call completed; report the durable delivery outcome returned by NanoCore.

## Close or hand off

Call the loop complete only when the requested stop condition is met, relevant evidence has been reviewed, no blocking Action Center decision remains, and the user accepts the result.

If state is interrupted, unknown, stale, or contradictory, stop normal execution and load [recovery.md](recovery.md). If the user asks for operator-only changes, load [administration.md](administration.md).
