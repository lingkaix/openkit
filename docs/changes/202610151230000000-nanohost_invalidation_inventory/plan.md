---
type: change-plan
status: in-progress
date: "2026-10-15"
branch: rc8/p02-nanohost-transport
---
# NanoHost Invalidation Member Inventory

Status: implementation corrected after independent review; exact-head recheck pending. Updated: 2026-10-16. This record supplies no design authority.

## Intent Revision 1

The coordinator directed P02 to continue its remaining package items after live inspection. The inventory gap requires the existing Epoch Invalidation Report to preserve observed effect-capable member identity, PID, binary identity and version availability, cgroup membership and exit code or signal. Missing proof stays unavailable. The existing first-failure cause remains exact; no diagnostic collection can delay or weaken fencing. Source: coordinator follow-up on 2026-10-15 and the P02 invalidation-evidence inventory item.

## Intent Revision 2

The coordinator assigned this plan to P02 as its single writer and confirmed that it covers only the accepted report-inventory behavior, with no new design decision. The engineer directed quality before speed, no more than one active helper per builder, and heavy commands through the shared resource wrapper. Source: coordinator replies granting this record on 2026-10-16 and citing the engineer's 2026-10-15 pace note.

## Accepted Owners And Boundary

[NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md#epoch-invalidation-report) owns the private report, best-effort completeness, secret redaction, eight-MiB size limit, two-second export limit, twenty-artifact retention and strict export-before-fence order. Existing startup/member lifecycle and the native process interface supply observations. The existing members field and evidence exporter retain ownership; no public schema, authority record, recovery input, polling owner or durable state is introduced. Production writes remain in the NanoHost package. The specification and Release Management need no design amendment for this implementation.

## Current Checkpoint

The approved rebased parent is 58402e6b, based on the coordinator-named fcbb9978. Its six preceding P02 patches match the previously approved branch by range-diff; the additional record reconciles the collection-test environment with the passing main gate. The coordinator assigned this record to P02. This slice changes six files under one package's write ownership: the coordinator, test-only evidence hooks, test-module entry, independent producer tests, local guide and this record.

The prepared producer pins each process directory while its owned child is still unreaped. It records actual pre-fence wait results and measures executable device, inode and size plus resolvable unified-cgroup device and inode in the existing bounded export worker. The existing members string holds a compact array in dependency start order. Status uses running, exited with an observed code, signaled with an observed signal, or unavailable. Reaped or changing executable proof stays unavailable. No version is inferred or obtained through a new command. Unsupported cgroup layouts remain unavailable rather than guessing a hierarchy translation. No image content is hashed on the fencing thread, and no private path or command line enters the report.

Named seam: owned process/wait observations to the existing private redacted members field, before the monitor terminates members. A separate test author derives process-exit, signal, missing-observation, replacement, redaction and export-timeout cases from the owner before reading implementation. Tests use their own processes, files and temporary roots; no installed service, App container, host configuration or external host is authorized.

The independent test author first observed the real monitor and exporter omit members, producing the intended behavioral failure before production changes. The final `cargo test --locked --bin nanohost epoch_inventory_tests -- --test-threads=1` passed seven cases, zero failed or ignored, in 2.17 seconds. These cover installed-path replacement, actual exit and signal, missing process proof, exec before and during measurement, first-cause preservation and blocked export. `cargo test --locked --bin nanohost epoch_coordinator::tests:: -- --test-threads=1` passed thirty-eight with one pre-existing privileged case ignored; `cargo test --locked --bin nanohost epoch_evidence:: -- --test-threads=1` passed six. `cargo check --locked --bin nanohost`, `cargo clippy --locked --all-targets --all-features -- -D warnings`, `cargo fmt --check` and the whitespace check passed. Heavy commands used the coordinator's resource wrapper with one build worker and one test thread. A fresh direction context reread this draft, accepted owner, Git state and coordinator source, returning Continue for the bounded inventory route; that judgment does not accept the artifact.

The first independent review of implementation revision 3a64ffee requested one correction: the new Linux cgroup constant was not guarded on other Unix development hosts. The resolver is now Linux-only; other hosts leave cgroup proof unavailable. The same seven real-process cases passed again, zero failed or ignored, in 2.16 seconds. Clippy and formatting passed after this correction. The platform finding is established from source; no macOS compiler result is claimed. The independent test file is unchanged.

Next Action: obtain the same reviewer's exact-head recheck before push for the merge train. A missing safe observation remains unavailable; it does not permit inference, a wider export deadline or a weakened fence. Partial-start reports before monitor ownership are unchanged by this slice; this delivery does not claim every remaining invalidation-evidence criterion is closed.

## Completion Evidence

This six-file slice adds the accepted member observations to the existing private report. Its exact-head independent verdict accompanies the coordinator submission; merge-train CI remains with the coordinator. The unchanged source owner supplies every criterion, and this record adds no design decision. The private status vocabulary is running, exited, signaled and unavailable, with only observed exit codes or signals. Version proof and unavailable process or cgroup evidence remain explicit unknowns. Partial-start inventory and the other report-context fields remain follow-up work.

The temporary-directory rule applies to every check and helper. Original intent revisions remain unchanged; raw output, host paths, host identifiers and credentials stay outside this record. No branch CI or installed-service effect was performed. Published-host proof stays separate.
