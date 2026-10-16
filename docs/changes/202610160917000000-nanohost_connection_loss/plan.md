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

The three published failures prove consequential successor-poll HTTP409 and systemd exit-code recovery, not the initiating physical-close cause. The current H2 driver discards its completion value, and reconnects are silent. A1's configured TLS endpoint is loopback port7443, through one direct Docker port binding to the App native port3443. No Swarm service publishes that port. This excludes an external ingress hop from that observed path, not all network failures. Source inspection finds120-second bridge bounds and300-second harness/result budgets, without a proved225-second timeout.

A private arm64 Rust1.97.1 toolchain and baseline dependency build are being prepared in disposable a1 storage with one Cargo worker and reduced scheduling priority. They do not replace or start NanoHost. A credential-free native H2 idle probe uses the configured issuer trust without Token presentation and observes at most260seconds. It cannot prove authoritative-session or Worker success. Raw receipts remain external under evidence/L-RT.

## First Decisive Regression And Probe

Before a candidate Worker Turn, expose the actual H2 driver's typed close cause without raw error text or peer debug data. An independently authored regression must exercise real H2 GOAWAY and injected I/O errors, including secret-shaped fixture text that must not appear. The diagnostic carries only closed source/outcome/initiator/reason/I/O classes. Separately report the retained result's fixed operation before a successor attempt; never label that as the later poll's operation. These are observations, not new authority or an update state machine.

After diagnosis, add the lowest sufficient cause regression, run each changed module's checks and one exact-byte candidate Worker verification on a1. Use the lane landing protocol and exact-head independent review/full CI. Chunk1's frozen head and published/local dev receipts remain unchanged by this branch. P29 is retained in its sibling worktree and remains deferred until D-RT-5 lands.
