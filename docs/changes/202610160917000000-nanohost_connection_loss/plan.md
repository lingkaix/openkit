---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/rt-5
---
# NanoHost Physical Connection Loss During Worker Startup

## Intent Revision 1

Source: coordinator direction on 2026-10-16. Finish chunk1 landing first, then prioritize D-RT-5 before P29. Diagnose repeated a1 published rc.8 Worker failures after authoritative H2 loss or replacement while a mutating effect remains unsettled. Investigate the repeated 224–226-second delay after OpenBridge without assuming its cause. Correct the initiating defect, preserve the unknown-outcome fence, add safe close provenance and distinguish an unsettled effect result from a later rejected poll. A1 OpenKit-only journal reads, disposable native builds, explicitly identified diagnostic candidates, NanoHost start/stop and single Codex Turns in the existing rc8 acceptance Workspace are authorized. Never attribute candidate results to published rc.8. No non-OpenKit service, platform setting, host kernel change or a2 effect is authorized. L-AW owns large-file carriage and provider raw-output/native-stop work.

## Owners And Boundary

[NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md) owns physical sessions, effect/result carriage, unknown outcomes and closed diagnostics. [Runtime Model](../../core/runtime-model.md), [Communication](../../core/communication.md) and the runtime specification retain their failure-domain and authentication boundaries. [Verification Instruments](../../verification-instruments.md) owns actual-host attribution. This work restores accepted transport and result ownership; it cannot infer that an unsettled mutating effect succeeded or authorize replay.

## Rewritable Checkpoint

Chunk1 is landed at `0b5532bbbee716c2ea140686f3736da84c2d7af3`; both exact-head full CI and main-push CI passed. Diagnostic source `8b7a0506282d2f53485d1d46a1c8795f5858c993` was built natively on a1, installed with retained published-byte custody and one confirmed start, and reached fresh generation9 readiness with unchanged App and host structures. It is an unpublished candidate, not rc.8. One synthetic Codex Turn then reproduced the terminal unknown-outcome fence. The driver reported I/O `other`224.859seconds after OpenBridge; the failed poll was `reference.import`, and NanoHost retained no definite effect result. This does not prove that OpenBridge was the unsettled effect. The candidate is stopped with its complete failure group absent and its operation-owned Restart=no guard retained.

A deterministic independently authored verified-TLS regression reproduced a byte-loss defect: the adapter read16KiB from the socket, but rustls consumed only a prefix and the adapter discarded the remainder. Coalesced ciphertext produced a typed rustls decryption error wrapped as I/O `Other`; a fragmented control passed. The corrected adapter reads directly into the buffer supplied by rustls. Both cases now preserve a large exact payload, a later bidirectional exchange and clean TLS closure. Actual-host cause attribution and successful Worker verification remain pending. The fixed-delay correlation has not established a timeout owner.

The diagnostic also found a final host nftables text fingerprint different from its initial fingerprint, while the App, system Docker bridge, container population and attachments, Gateway and unit bytes remained unchanged. Its cause and semantic significance are unresolved. No host rules or non-OpenKit service were changed by operator commands. Keep this observation visible; it is not an unchanged-host PASS.

Pinned H2 erases wrapped typed I/O causes. The smallest safe TLS observation therefore runs at the still-typed rustls processing boundary before that erasure, without retained connection state or new retry behavior. Independent tests are checking its closed cause grammar and privacy. Native candidate receipts, test outputs and instrument review remain external under evidence/L-RT.

## First Decisive Regression And Probe

Before a candidate Worker Turn, expose the actual H2 driver's typed close cause without raw error text or peer debug data. An independently authored regression must exercise real H2 GOAWAY and injected I/O errors, including secret-shaped fixture text that must not appear. The diagnostic carries only closed source/outcome/initiator/reason/I/O classes. Separately report the retained result's fixed operation before a successor attempt; never label that as the later poll's operation. These are observations, not new authority or an update state machine.

After diagnosis, add the lowest sufficient cause regression, run each changed module's checks and one exact-byte candidate Worker verification on a1. Use the lane landing protocol and exact-head independent review/full CI. Chunk1's frozen head and published/local dev receipts remain unchanged by this branch. P29 is retained in its sibling worktree and remains deferred until D-RT-5 lands.
