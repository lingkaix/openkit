---
type: change-plan
status: implemented
date: 2026-10-19
branch: lane/go-admin-lifetime
---
# Administration Turn Lifetime And Deadline Diagnosis

## Intent Revision 1

On 2026-10-19 the engineer assigned the Administration setup blocker and confirmed three rulings. An admitted Turn must survive loss of its submitting connection. Only explicit interruption or the admitted deadline cancels execution. An ordinary answer timeout must not claim that continuation summary production timed out. Investigate the observed 120-second failure and propose any different bound from evidence, rather than increasing it without diagnosis.

A fresh Administration Thread also failed at exactly 120 seconds with a 300-second client timeout. Thus prior Thread history is not necessary to reproduce the deadline. The operator will supply retained execution metadata and capability timing. Public Turn detail does not expose all of that evidence. No agent in this implementation may access dev.

## Intent Revision 2

The engineer approved 600 seconds as the shared Assistant profile default for both Administration and ordinary Assistant. Five observed worst-case rounds take about 413 seconds. Knowledge Manager remains at 300 seconds; other roles are unchanged. Explicit configured limits, model selection and both count fuses remain binding. The ordinary Assistant and its Knowledge Manager journeys need the same headroom, so a separate Administration default would move the failure. Update the owning default in this same landing.

## Owners And Boundary

The [Administration entry](../../specs/20260704-chat_mode_assistant.md#administration-entry-path) owns lifetime and publication. The [internal loop](../../specs/20260813-internal_agent_runtime.md) owns cancellation and bounded execution. The [context owner](../../specs/20260902-agent_runtime_context_compaction.md#internal-durable-rolling-context) owns summary fitting and the shared budget. The [decision](../../decisions/20261019-administration_turn_connection_lifetime.md) records the engineer's lifetime ruling.

Use the existing Turn, command receipt, configuration candidate and interrupt operation. Add no durable family, store, route, automatic replay, or restart resumption. Keep configuration application separate from proposal preparation. Store, storage, executor, scheduler, recovery, shared database definitions and worker shim remain outside this change. Synthetic model transport and isolated fixture records are the only effects.

## Acceptance

- After admission, submitting-connection loss does not cancel inference or an admitted Tool. A successful candidate remains readable and command replay repeats no effect.
- Explicit interruption cancels the exact active Administration Turn, records its terminal outcome, and prevents late model output from publishing a candidate or answer.
- The admitted deadline remains effective without the submitting connection. Ordinary answer and summary deadline diagnostics identify their phases.
- Existing current-authority, private-entry, candidate confirmation, exact identity and unknown-effect rules remain unchanged.
- Retained phase evidence explains the observed slow request. Any default-bound proposal states what consumed the time and why the proposed bound fits; missing evidence remains a blocker, not a guessed fix.

## Execution And Evidence

A fresh independent test author writes and runs deciding regressions before production edits. The primary inspects the actual RED and implements only the owned slice. A fresh independent reviewer examines the actual diff and named execution output. Complete affected files/directories, focused typecheck, lint, build, repository and generated-output checks qualify the frozen head. The containing-main result remains distinct from local qualification.

## Checkpoint

Base is accepted main `75747a7a248843614ca6f351b6fbe6411d839ab0`. Independent author `9ec7a1fdd` records four intended RED cases and one passing real-candidate control. The lifetime and diagnostic correction passes all five unchanged cases. Focused formatting, Native typecheck and diff checks pass; complete-module qualification and fresh review remain pending.

The operator's retained evidence places 119.7 seconds of each 120.1-second failed Turn inside model calls. A fresh Thread has no prior Items, and completed model calls take 4–83 seconds. The proposed 600-second default fits five calls at that observed maximum with about 187 seconds left for Tools and publication. The count fuses remain 16 model calls and 48 Tool calls.

The engineer settled the shared-default scope in Intent Revision 2. Independent author commits `4d5a30251` and `ff638e3f5` add parsed/exported schema checks and real Administration/ordinary Assistant admission checks. The actual RED retains three schema failures and four entry-default failures; explicit 4000 ms controls pass. The implementation uses one shared Assistant deadline constant in the disjoint profile schema and all three fallback admissions. KM, other roles, explicit limits and both count fuses remain unchanged.

The requested landing contains lifetime, diagnostics and the effective default together. Complete qualification and a fresh review remain required; no live-account success is inferred. Final named gate and containing-main evidence are retained by the execution checkpoint.
