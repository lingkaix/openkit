---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Worker Failure, Cancellation Final, And Chat Call Rulings

## Decision

- #186: a settled, correlated Pi inference failure has a distinct private adapter reason, `pi-inference-failed`. Genuine missing or contradictory prompt/terminal correlation retains `pi-terminal-correlation-failed`. Neither reason creates a public StopReason, success, automatic retry, or cleanup proof.
- #179: a closing lineage may accept one first cancellation final under its exact cancellation, binding, worker-control token, operation, and sequence. This exception admits no ordinary output or successful completion. Sealing, exact replay, conflict rejection, and all other authority checks remain binding.
- #127: newly produced Chat tool calls, final or streamed, must match the current request's admitted callable declarations. Historical Tool context remains non-executable and cannot create a declaration.

## Reason

Source: engineer-rulings-20261015.md in the coordinator's backlog-20261015 working record, Resulting rulings and Confirmation and expanded delegation. On 2026-10-15 the engineer accepted the first recommended option for all items except the three named exceptions. These items use the first options from decisions-zh.md, rows #186/pi-failure-reason, #179, and #127. The coordinator explicitly dispatched these owner amendments to P11. The external records preserve source evidence, not design authority.

The distinct Pi reason identifies an inference failure instead of misreporting correlation loss. The narrow final exception preserves cancellation evidence after an ordinary append refusal. Chat declaration parity removes a public-format difference without executing historical calls.

## Rejected Alternatives

- Retaining the same Pi correlation reason for an already correlated inference failure hides the failed stage.
- Requiring Core to synthesize all missing cancellation evidence was not the selected first-final option.
- Broad first-final admission, reopened output after sealing, or successful completion on closing lineage exceeds the cancellation-only ruling.
- Leaving new Chat calls unchecked or treating historical calls as declarations contradicts the selected parity option.

## Revisit When

Revisit when evidence requires a broader terminal reason, closing-lineage admission, or callable-declaration contract. Any expanded effect or authority needs its owning decision first.

## Affected Owners

- [Pi Worker Adapter](../specs/20260716-pi_worker_adapter.md)
- [Worker Runtime Communication](../specs/20260629-worker_runtime_communication_model.md)
- [Worker Control Protocol](../specs/20260703-worker_control_protocol.md)
- [Pi-AI Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md)
