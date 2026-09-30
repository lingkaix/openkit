---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Pi Codemode Support Boundary

## Decision

The engineer approved narrowing Pi 0.99.1 native codemode to a bounded support boundary: 「Pi Agent CodeMode 那个，我也同意你建议的 收窄为支持边界」 ("For Pi Agent CodeMode, I also agree with your suggestion to narrow it to a support boundary"). OpenKit does not supply the composer and retains static and immediate post-session_start setup checks, including inactive registration, with pi-codemode-unsupported before provider work. Later user Extension execution is outside supported supply and has no comprehensive prevention or closed-outcome guarantee. Such code may hit #10239 and affect a wrong target that is currently permitted. Sandbox and Gateway authority and every managed, credential, cancellation and lifecycle protection remain unchanged. This design approval does not establish implementation acceptance or release readiness.

## Reason

Extensions share the Pi host process and permissions, so they are not a security boundary. Universal prevention would impose an in-Sandbox feature ban on user code, contrary to the Sandbox full-permission principle. Upstream #10239 presents a target-integrity and correctness risk: Gateway authorization of the actual target does not prove that it matches user intent. It is not evidence of an authority escape. Three genuine composer registrations during input, before_agent_start and agent_start showed that event-by-event snapshots cannot converge on a universal prevention guarantee. The bounded setup checks protect the configuration OpenKit supports without inventing a new execution boundary.

## Rejected Alternatives

- An execution-time tool_call block: cannot guarantee zero provider requests or stop direct library use, and would require a separately qualified execution-enforcement contract.
- More event snapshots: another observation point does not prove absence of later user code and repeats the failed method.
- A loader or import ban: would restrict full-permission user code inside the Sandbox rather than qualify OpenKit supply.

## Revisit When

- A released Pi version contains the #10239 fix; the adapter owner still requires exact-target, deployed asset, credential, cancellation and retained-session qualification before supported supply.
- Evidence shows that a wrong target avoids Gateway checks or gains another binding's authority. That would be a separate Safety Kernel defect, which fails closed.
- OpenKit decides to supply codemode, requiring an accepted support contract and its qualification evidence.

## Affected Owners

- docs/specs/20260716-pi_worker_adapter.md
