---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/rt
---
# NanoHost Native Readiness Repair

## Intent Revision 1

Source: engineer dispatch to lane L-RT on 2026-10-16. Diagnose the published rc.8 NanoHost readiness failure on dev for issue #248, correct the proved cause against the train-3 baseline, add the lowest sufficient regression, and verify one locally built branch binary on dev. Land through the lane window, exact-head independent review and full CI. Leave NanoHost stopped. Do not change the retained App, host kernel settings, or a1/a2. Host data is unimportant under the engineer's direction. Published-artifact acceptance remains separate from local-build verification.

## Owners And Boundaries

[NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md) owns verified TLS, the physical session, admission, readiness and startup limits. [Runtime Model](../../core/runtime-model.md) owns substrate lifecycle and [Communication](../../core/communication.md) owns transport principles. [Test Strategy](../../specs/20260529-test_strategy.md) and [Verification Instruments](../../verification-instruments.md) own regression scope and deciding evidence. This repair restores accepted behavior and adds no transport fallback or authentication authority.

The current seam is the Rust TLS byte adapter and the native Node HTTPS/H2 listener. Existing real-route regression fixtures will be reused where they can observe the defect. A real dev-host run must prove exact-pair positive readiness and complete stop separately from credential-free listener reachability.

## Rewritable Checkpoint

The seven existing native TLS tests pass. A credential-free Rust probe to the dev listener fails immediately with certificate rejection because the listener presents a CA as its server leaf. The published source and lane base have identical transport code. H2 driver completion discards the concrete verification error. The initial session then retries physical closes until its startup budget expires. This explains the published generic 120-second failure without a transport stall. P02 adds inspection but leaves this path unchanged.

The ops lane owns the retained App and was asked to issue a valid separate server leaf. L-RT owns the Rust correction and the locally built NanoHost verification. No NanoHost service effect has run in this lane. The unit has MainPID zero. The independent test author owns the existing Rust native TLS test file and Node peer fixture; the primary owns production code and documentation.

Next action: observe the CA-as-leaf regression fail, then complete TLS verification before handing the stream to H2. Expected observation: invalid server certificates produce a fixed verification cause before admission; valid native connections retain positive durable readiness. Reuse the current TLS adapter and deadline rather than add a transport or trust fallback. Raw evidence stays outside this record under the lane evidence directory.

## Verification And Closeout

The independent test author observed the intended red: no HTTP request or RuntimeTarget, but the generic `outer-session admission response failed` cause. After correction, all nine native TLS tests pass. They cover successful admission/readiness, fragmented handshakes, certificate rejection and bounded silent peers. The test author notes that this proves the TLS/H2 seam; the unchanged initial and successor caller mapping requires code review.

Before rebase, `cargo fmt --check`, `cargo clippy --locked --all-targets --all-features -- -D warnings`, the NanoCore typecheck and focused Biome check pass. The three affected NanoCore suites pass 23 tests. The two service-unit tests and one version test pass. The full NanoHost run records 265 passed, 68 failed and three existing ignored tests. Those failures occur in unchanged collection and seed capacity checks. The dev Btrfs filesystem reports zero available inode counts despite sufficient free bytes; those checks interpret zero as insufficient capacity. Keep this follow-up separate from the TLS repair and do not weaken its checks. Exact-head full CI remains required.

Pending dev-host verification, exact-head review, full CI and landing. Train 3 must land before the final rebase. The locally built binary is a debug build from this branch, separate from the published artifact. No completion or published-artifact readiness claim is made.
