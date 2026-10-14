---
type: change-plan
status: in-progress
date: "2026-10-15"
branch: v010/retrieval-kernel-r2
---
# Retrieval Kernel R2

## Intent Revision 1

Source: the engineer's R2 builder dispatch on 2026-10-15. Complete the accepted [Retrieval Kernel](../../specs/20261014-retrieval_kernel.md) beyond R1: required owner amendments, supervised local service, current authorized product adapters, direct Knowledge lexical replacement, packaged Linux amd64 and arm64 supply, and focused evidence. Preserve [Storage](../../core/storage.md), [Knowledge](../../core/knowledge.md), and [Permissions](../../core/permissions.md). R1 is merged at the branch base `ba79e4e0`. Do not push, merge, contact deployment hosts, change publication job blocks, or write WP1-owned paths. Commits use the engineer's requested attribution without co-author trailers. Package/crate fetches, toolchain installation, and the recorded IPADIC archive are the only network grant.

## Intent Revision 2

Source: the engineer's clarification on 2026-10-15. Report the maximum-upload regression as blocked on the undecided upload byte count/unit and arbitrary-file admission contract; choose no number. Report Assistant history Tool binding as blocked on Chat Mode; invent no Tool or operation id. Complete independent kernel and adapter work. Implement the accepted Knowledge notebook and ordered-scope behavior required by existing owners; report any further silence rather than design it.

## Accepted Owners And Boundaries

The retrieval specification identifies eight owner amendments. The Chat Mode Tool binding remains dependent on its engineer topic. Source eligibility and destination disclosure stay with current policy and canonical owners. No canonical database migration is planned. Derived indexes require rebuild, with no old-index migration, compatibility path, or dual write. WP1 owns the paths in the coordinator's external ownership list, including the NanoCore package guide; the source guide can describe this slice, and the exact package-guide amendment will be reported for later application.

## Checkpoint

The worktree started clean. Owner amendments are committed in `c754be0d`. R1's version-1 NDJSON service supports publish, inspect, search, bounded inline text, root-confined file streams, and verified-digest identity sidecars. Current NanoCore Knowledge uses synchronous JSON term postings and occurrence/title scoring. The accepted notebook and ordered-scope extensions are not implemented in that path. Current App search uses substring matching. No Assistant history Tool exists. The upload owner has not settled its maximum byte count/unit.

The implementation seam is the real NanoCore producer and Rust stdio consumer, followed by current canonical source admission and final source validation. The test-author owns only `apps/nanocore/src/retrieval-service.test.ts`; the builder owns other R2 paths outside WP1's list. The external Grok reviewer retains independent diff review. A producer's self-check does not accept owner amendments.

Next Action: amend the available owners and implement the supervised service seam. Expected artifact: one bounded, restartable process client that never replays an uncertain publication. Expected observation: real-process tests establish healthy requests, shutdown, restart and revoked-scope isolation; child failure becomes a typed local failure without terminating NanoCore. An unsupported source admission or contradictory owner stops only that dependent path.

## Blocked Acceptance

- Retrieval predicate 6 (`docs/specs/20261014-retrieval_kernel.md`, maximum admitted upload): blocked on the upload owner's exact maximum and unit, confirmed by the engineer. No maximum-upload test is created.
- Retrieval owner amendment for Chat Mode and predicate 8's Assistant Tool call: blocked on Chat Mode's history Tool binding, confirmed by the engineer. Conversation adapter work remains in scope.
- `apps/nanocore/README.md`: WP1 write ownership prevents the required package-guide update until the coordinator releases that path.

## Evidence And Closeout

Pending. Record exact focused checks, publication-input comparison, image builds for both architectures, commits, changed paths, complexity observations, unresolved findings and residual risks before handoff. Completion of the builder slice does not approve a release or a protected owner decision.

## Current Evidence

The real stdio seam initially returned `1 failed | 2 passed`: the first request after SIGKILL raced the child exit event. The source-free preflight health probe fixed that race before sending the real operation; it does not replay a publish. The combined focused run `vitest run src/retrieval-service.test.ts src/retrieval-sources.test.ts src/bootstrap/phase-order.test.ts src/bootstrap/shutdown.test.ts --maxWorkers=2 --reporter=verbose` passed 4 files and 15 tests. NanoCore typecheck passed after prerequisite packages were built with Node 24.18.0. Separate canonical Git notebook fixtures passed 3 tests outside the sandbox; the sandbox's synchronous Git subprocess EPERM was setup failure, not a deciding product result. The pinned-A/then-published-B fixture proves the primitive reads A's exact text after B and process reconstruction; S39 integration remains pending.

The cold App build received HTTP 403 from the recorded dictionary URL. R2 uses the explicitly permitted vendored option instead: exact cached R1 bytes, verified SHA-256 and COPYING, no build-time dictionary network. The Linux amd64 App image built and its packaged `retrieval-kernel --version` passed with networking disabled. The arm64 Rust cross-build passed; the arm64 App image build is still running. Final image reruns must include the completed adapter/canonical cutover diff. The packaging test rerun outside the sandbox executed both deciding cases and passed 2/2; the sandbox's file-only wrapper count was not treated as case evidence.

The engineer authorized narrow read-only HTTPS supply of missing locked-crate notices at recorded revisions. Twenty-six files were obtained with URL, revision and SHA-256 provenance. Four gaps remain: htmlescape 0.3.1 and two Windows import-library crates lack a verified recorded revision; kanaria 0.2.0 yielded no matching notice at its recorded commit. SPDX metadata stays packaged. The two Windows crates are not Linux runtime supply.

An independent Consultant inspected the actual source and accepted owners. Its direction is to retain the coordinated Git-backed canonical cutover, then replace the projection and carry exact revisions through S39; a scorer-only swap over mutable files is insufficient. Two union effects are stopped by the engineer's clarification: duplicate page-id pin binding and ownership of the one combined User/Workspace trace. Options and recommendations will be reported with exact owner lines. One-scope work continues.

Additional WP1 dependencies found by direct inspection: `packages/config-schema/src/server.ts` and tests need the accepted Server `knowledgeMaintenance` setting; its package guide is locked. `apps/nanocore/src/runtime/turn-executor-factory.test.ts` has a synchronous retrieval fixture that must await the stdio-backed result. No Core database migration is added.

## Intent Revision 3

Source: the engineer confirmed stopping union pin and union trace effects on 2026-10-15. Plain duplicate page ids and the combined private trace ledger remain owner gaps. Continue the one-scope retrieval path; report exact owner lines, options and recommendations without selecting a union rule in code.

## Intent Revision 4

Source: the engineer authorized read-only HTTPS retrieval of missing locked-crate license and notice files on 2026-10-15, only at their exact recorded upstream revisions, with vendored URL/revision/SHA-256 provenance. No other upstream files or external writes are authorized.

## Intent Revision 5

Source: the engineer's SCOPE-012 correction on 2026-10-15: “R2 replaces the Knowledge retrieval path and its index, nothing more.” Implement a pre-existing Knowledge requirement only when the replacement cannot work or would be wrong without it. Notebook editing base revisions, complete deletion confirmation, S39 history, portable closure and similar pre-existing gaps are excluded. Preserve their work as a patch outside the branch. The coordinator will batch the portable historical-closure gap with the other owner decisions; stop only its dependent publication.

## Scope Correction Checkpoint

An independent Consultant checked this narrower route against the base and owners. Git pinning, v4 scopes and expanded history traces already existed as unimplemented targets before R2. The existing file-backed owner and one-Workspace content-digest trace remain during this bounded lexical replacement. Exact observed canonical digests identify internal kernel source versions only; they are not notebook commits, retained history or ABA protection. Current source/destination authorization, complete lexical enumeration, dispositions, digest checks, one trace and shared tokenizer remain necessary retrieval work. All earlier notebook editing and portability WIP is preserved in `/home/simonx/AI/temp/rc6/r2-deferred/20261015-knowledge-notebook-cutover.patch` (361884 bytes; SHA-256 `9ff2668082d155755f9f58055c2aaf5d4fc841993c3da58f4739c3c665e367fb`). It is incomplete and unreviewed. The committed notebook primitive slice is removed by a later coherent commit rather than rewritten from history.

Next Action: replace only the existing JSON lexical owner and its asynchronous consumers over current canonical files. Expected observation: the real CJK answer regression passes, full enumeration precedes governed exclusion, and changed or revoked sources yield no successful trace. A source/metadata identity disagreement fails closed. Pre-existing notebook and portability implementation is not a deciding oracle for this slice.
