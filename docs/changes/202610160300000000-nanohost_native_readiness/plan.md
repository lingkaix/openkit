---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/rt
---
# NanoHost Native Readiness Repair

## Intent Revision 1

Source: engineer dispatch to lane L-RT on 2026-10-16. Diagnose the published rc.8 NanoHost readiness failure on dev for issue #248, correct the proved cause against the train-3 baseline, add the lowest sufficient regression, and verify one locally built branch binary on dev. Land through the lane window, exact-head independent review and full CI. Leave NanoHost stopped. Do not change the retained App, host kernel settings, or a1/a2. Host data is unimportant under the engineer's direction. Published-artifact acceptance remains separate from local-build verification.

## Intent Revision 2

Source: coordinator direction on 2026-10-16 after accepting the certificate root cause. Select the corrected issuer CA and verify the exact published rc.8 NanoHost on dev. Retain it only while healthy and ready so ops can continue #242. Trace the original certificate source and correct any product or document path that can produce it. Keep eager TLS verification and the explicit cause. Include chunk 1b: unavailable Btrfs inode counts must not become zero capacity; preserve strict byte checks and add regressions. Land both repairs together or consecutively.

## Intent Revision 3

Source: coordinator authorization after the first published attempt hit its retained rebuild-bound hold. Retain complete old epoch state outside its live names, then start from fresh state. Never delete a marker in isolation. Up to three published attempts in total are authorized, each after whole-state retention and only when it can teach a new fact. Dev data is disposable under engineer direction. Inspect recovery guidance and document the operator procedure if missing.

## Owners And Boundaries

[NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md) owns verified TLS, the physical session, admission, readiness and startup limits. [Runtime Model](../../core/runtime-model.md) owns substrate lifecycle and [Communication](../../core/communication.md) owns transport principles. [Test Strategy](../../specs/20260529-test_strategy.md) and [Verification Instruments](../../verification-instruments.md) own regression scope and deciding evidence. This repair restores accepted behavior and adds no transport fallback or authentication authority.

The current seam is the Rust TLS byte adapter and the native Node HTTPS/H2 listener. Existing real-route regression fixtures will be reused where they can observe the defect. A real dev-host run must prove exact-pair positive readiness and complete stop separately from credential-free listener reachability.

## Rewritable Checkpoint

The credential-free Rust probe proved that the original dev listener presented a CA as its server leaf. The published source and lane base have identical transport code. H2 driver completion discarded the verification error, and the initial session retried physical closes until startup expired. P02 adds inspection but leaves this path unchanged. Eager verification now preserves the closed TLS cause. Initial transport refusal also invokes the existing startup invalidation owner before returning.

Ops corrected the retained App certificate. L-RT selected its issuer CA after strict verification. Published attempt 1 exited before TLS because the prior rebuild interval had expired. After whole-state retention, published attempt 2 reached fresh generation 1 with the exact configured pair and all readiness booleans true. The published NanoHost remains running and ready under Revision 2. Two published attempts occurred; no local-build host readiness is claimed. The initial collector observed readiness, then failed on a binary journal message; independent reads recovered the same running attempt without another start. Three structural comparisons pass. This is readiness evidence, not Worker or full release qualification.

The Btrfs capacity fix shares one inode reserve interpretation between volume seeding and Workspace collection. Both still enforce their existing byte checks and finite inode reserves. Synthetic and real-consumer regressions failed before the correction and now pass. The independent test author has released all test paths. Final verification after train 3 remains open. Raw evidence and the live checkpoint stay in the external lane evidence directory.

The original certificate matches the setup receipt and came through an operator bind mount outside the product checkout. It is a CA with a loopback SAN and no serverAuth or key-usage extension. The installer installs no TLS material; the App loads operator-supplied certificate files. The shipped Skill references and named deployment/host manuals contain no certificate-generation recipe. This attributes the invalid shape to ad hoc dev listener configuration, not a product certificate generator. The exact original creation command is not retained in repository evidence. The manuals now identify the required leaf/issuer roles and provide the previously missing whole-state recovery procedure.

The combined reviewer found that retaining complete epoch roots could hide the observation flags previously used to release old retained-volume attachment hints. Startup already proves the complete prior process group absent. The correction makes production store opening use that proof and the existing release owner regardless of root or marker presence, while preserving bytes and association lineage. Core settlement remains separate. The independent real retained-store regression failed with the old generation-three attachment still present. With the release call, it preserves all retained metadata except the attachment hint, then attaches the same retained bytes at generation four.

## Verification And Closeout

The independent test author observed the intended red: no HTTP request or RuntimeTarget, but the generic `outer-session admission response failed` cause. After correction, all nine native TLS tests pass. The preliminary reviewer found missing startup invalidation evidence. A real `run_sessions` regression then failed with zero reports instead of one; the caller now invokes that existing owner. These tests cover the real TLS/H2 seam and the initial caller path without a deployed host.

Before the capacity correction, the full NanoHost run recorded 265 passed, 68 failed and three existing ignored tests. The dev Btrfs filesystem reports all three inode counts as zero despite sufficient free bytes. The admitted chunk 1b corrects that interpretation. Eight new capacity regressions pass, including actual seed/collection writes and byte-reserve and overflow refusals. After the retained-attachment correction, the full suite passes 343 unit tests and three service/version integration tests, with three existing tests ignored. Exact-head full CI remains required.

The affected NanoCore suites pass 23 tests; its typecheck and focused Biome check pass. Cargo formatting and Clippy pass after the capacity amendment. Documentation validation and index checks pass. The Skill interface and public-redaction suites pass all 87 tests. Train 3 must land before the final rebase, exact-head review and full CI. No landing or Worker-readiness claim is made.
