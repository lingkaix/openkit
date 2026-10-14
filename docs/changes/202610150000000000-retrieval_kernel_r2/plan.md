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

The bounded replacement is implemented. The old lexical JSON index, tokenizer, scorer and consumer read model are removed. The three non-lexical projections remain. NanoCore uses its supervised Rust service and current source/destination admission. Knowledge answer, preparation, Task selection and App search share the asynchronous governed lexical owner. Internal source revisions are exact current-byte digests; they do not claim notebook history. The kernel accepts domain-free searchable byte ranges so the product adapter can exclude governance frontmatter while verifying full canonical bytes. No canonical migration, old-index migration, compatibility path or dual write is added.

The engineer's narrower scope supersedes the earlier notebook cutover route. The builder has removed that implementation and retained its incomplete patch externally. Scoped Git notebooks, full S39 commit pinning and portability remain pre-existing work. Union pin/trace effects, the upload maximum regression and the Assistant history Tool binding remain blocked on owner decisions. WP1 still owns the NanoCore package guide and one synchronous runtime test fixture. No WP1 path is edited.

Both target images built. The amd64 offline full App smoke passed. After stand-in admission, the ARM full-system guest established packaged retrieval and resource behavior through the exact shipped bytes; its full App smoke failed the unchanged 60-second health deadline. A later common-App comparison found no R2-specific regression, as accepted by the coordinator; native qualification belongs to a1 later with the exact reviewed image. The earlier failure remains historical evidence, and no timeout or product limit was changed. The Grok migration regression and three owner-text findings are corrected. The final whole NanoCore suite passes all 260 tests in the five changed test files; seven failures and ten unhandled errors remain in two unchanged WP1-owned files. Next action belongs to renewed independent review and the coordinator's WP1/owner-decision batch. No release or merge is authorized by this record.

## Evidence And Closeout

[Builder report](#builder-report) records exact observed checks, blocked owner decisions, pre-existing gaps, WP1 changes, deferred patch, changed paths and residual risks. The independent Grok review at `/home/simonx/AI/temp/research/2026-10-14-retrieval-kernel/r2-review.md` returned `CHANGES REQUIRED` against `ef1bb84b`. The correction evidence is recorded below; renewed acceptance and the coordinator's post-rc.6 merge decision remain pending. Builder verification does not approve the owner amendments or publication.

## Intent Revision 3

Source: the engineer confirmed stopping union pin and union trace effects on 2026-10-15. Plain duplicate page ids and the combined private trace ledger remain owner gaps. Continue the one-scope retrieval path; report exact owner lines, options and recommendations without selecting a union rule in code.

## Intent Revision 4

Source: the engineer authorized read-only HTTPS retrieval of missing locked-crate license and notice files on 2026-10-15, only at their exact recorded upstream revisions, with vendored URL/revision/SHA-256 provenance. No other upstream files or external writes are authorized.

## Intent Revision 5

Source: the engineer's SCOPE-012 correction on 2026-10-15: “R2 replaces the Knowledge retrieval path and its index, nothing more.” Implement a pre-existing Knowledge requirement only when the replacement cannot work or would be wrong without it. Notebook editing base revisions, complete deletion confirmation, S39 history, portable closure and similar pre-existing gaps are excluded. Preserve their work as a patch outside the branch. The coordinator will batch the portable historical-closure gap with the other owner decisions; stop only its dependent publication.

## Intent Revision 6

Source: the coordinator's Grok-review correction dispatch on 2026-10-15. Correct the Workspace migration test to require exactly the three non-lexical derived files and the absence of both removed lexical files, then run the whole NanoCore suite. Align the three identified owner-text findings with the accepted retrieval replacement. Historical import closure is settled by coordinator–Consultant agreement as bounded fail-closed rejection of imports that need unavailable historical closure; no new project or R2 import implementation is authorized. Union pins and the combined trace ledger wait for the engineer. The upload maximum and Assistant history Tool wait for the Artifacts and Chat Mode topics. Keep all dependent effects stopped. The coordinator accepts the ARM comparison as “no R2-specific regression; native qualification happens on a1 later with the exact reviewed image”. Commit the correction with the requested identity and no trailer; do not push.

## Grok Review Correction

The migration regression was reproduced before editing: 1 failed, 16 skipped, exit 1, with `ENOENT` on `indexes/search.json`. The correction preserves the old rebuilt-header assertions for each of the three non-lexical files, requires the exact directory entries, and explicitly rejects both `search.json` and `knowledge-fts.json`. No product writer is changed.

The initial whole-suite attempt found another stale assertion in the unprotected `server.test.ts`: the Task Mode trace expectation omitted normalized `states: ['active']`, required by Knowledge Store line 201. The selected page and completed Task were correct. Its isolated reproduction failed at that exact trace assertion; adding the exact default-state expectation passed (1 passed, 165 filtered skips). No assertion or production behavior was weakened. The old whole-suite attempt had already loaded that file, so it was stopped before restarting the complete suite against the final assertions. Its partial output is retained and is not a completed suite result.

The complete run also exposed missing normalized states in the shared fixtures in `workspace-export-lineage.test.ts` and `workspace-portable-file-state-io.test.ts`. Isolated runs reproduced 8 and 4 failures respectively, all caused by fixture trace rows without `retrievalParameters.states`. Those two fixtures now declare the exact default `['active']`; existing import/export and rejection assertions are unchanged. This corrects retrieval trace test data only and adds no historical closure or import publication behavior.

The same full run found the App search case in `b6-operation-retirement.test.ts` using a memory-only store despite an existing canonical data root. Its isolated reproduction returned the required 409 durable-storage failure instead of the fixture's expected 200. The fixture now supplies that existing root to `createDemoStore`; every binding/schema assertion remains. Its complete 27-test file passed. This adds no fallback or compatibility path.

The complete discovery run used eight workers on the 16-CPU host, without a file or test-name filter: 343 files (339 passed, 4 failed), 5986 tests (5970 passed, 16 failed, 0 skipped), 10 unhandled errors, exit 1, 1117.28 seconds. Its JSON and log are `review-fix-full-final.json` and `review-fix-full-final.log`. Nine failed cases were the corrected unprotected lineage and App search fixtures; their focused files passed all 77 tests after correction. The seven other failures and all ten unhandled errors belong to the protected WP1 paths described below. The migration file passed all 17 tests and the server file passed all 166 tests in this complete run.

The final confirmation ran every NanoCore test against the final fixtures with the same eight-worker configuration and unchanged timeouts: 343 files (341 passed, 2 failed), 5986 tests (5979 passed, 7 failed, 0 skipped), 10 unhandled errors, exit 1, 970.25 seconds. All five changed test files passed all 260 tests. The seven failures and all ten unhandled errors are confined to the same two unchanged WP1-owned files. This is not a green package gate. Its complete log and JSON are `review-fix-full-confirmed.log` and `review-fix-full-confirmed.json`.

Both complete runs used `mise exec node@24.18.0 -- corepack pnpm --filter @openkit/nanocore exec vitest run --maxWorkers=8 --reporter=default --reporter=json --outputFile=<named task evidence JSON>`, with `MISE_STATE_DIR=/tmp/openkit-mise-state`, `COREPACK_HOME=/tmp/openkit-corepack` and the task-owned on-disk `review-fix-tmp` as `TMPDIR`. No file, test-name, exclusion or skip filter was used. No test timeout, assertion or production contract was weakened. Raw results stay under `temp/changes/202610150000000000-retrieval_kernel_r2/review-fix-*`.

| Correction check | Exact result |
| --- | --- |
| Migration file before correction, named regression only | 1 failed, 16 filtered skips, exit 1; missing `indexes/search.json` reproduced. |
| Complete migration file after correction | 17 passed, 0 failed, exit 0; also 17 passed in both complete package runs. |
| Task Mode trace regression after correction | 1 passed, 165 filtered skips, exit 0; complete server file passed all 166 tests in both complete package runs. |
| Portable trace fixture files after correction | 2 files, 50 passed, 0 failed, exit 0; all 50 passed again in the final complete package run. |
| Complete B6 binding retirement file after correction | 27 passed, 0 failed, exit 0; all 27 passed again in the final complete package run. |
| NanoCore typecheck | `pnpm --filter @openkit/nanocore typecheck`, exit 0; `review-fix-typecheck.log`. |
| Focused Biome | All 5 changed test files checked, no fixes, exit 0; `review-fix-lint-final.log`. |
| Documentation validators | Spec lifecycle passed; 10 stories; 480 documents; generated index current; reachability 5 passed; terminology 2 passed; test governance passed; exit 0. `review-fix-docs-final.log`. |

The nine-file correction changes tests and documentation only. Existing packaged image and Cargo results remain the earlier observations; neither runtime payload nor build input is changed by this correction. No WP1 path, workflow or database migration is edited. Renewed independent acceptance remains required.

The separate ARM comparison used the same common App smoke, unchanged 60-second deadline, and sequential fresh guests under Cortex-A72/TCG, 4 vCPUs and 8 GiB RAM. Main startup was 49.307 and 47.766 seconds; R2 was 49.263 and 48.317 seconds. All four common App smokes passed. Kernel service startup was 156.496 and 168.689 ms, excluding Node/module loading. The comparison does not rerun the R2-only retrieval prelude or qualify native ARM. Its source and guest files were removed; small evidence remains at `/var/tmp/openkit-r2-arm-comparison.4y8dPu/REPORT.md`. No tracked file changed during that probe.

The pre-commit `publicationInputsAt` comparison returned `publicationInputsChanged=false`: base `ba79e4e0` and reviewed HEAD `ef1bb84b` both hash to `9029285e5b35bf435c3f5afb0fe90600151b8f00c5f27caa433b49bba5cbd1e4`, exit 0. The correction paths are outside the observed publication inputs. The committed revision is checked again after commit; the handoff reports that result. No publication job is edited.

## Scope Correction Checkpoint

An independent Consultant checked this narrower route against the base and owners. Git pinning, v4 scopes and expanded history traces already existed as unimplemented targets before R2. The existing file-backed owner and one-Workspace content-digest trace remain during this bounded lexical replacement. Exact observed canonical digests identify internal kernel source versions only; they are not notebook commits, retained history or ABA protection. Current source/destination authorization, complete lexical enumeration, dispositions, digest checks, one trace and shared tokenizer remain necessary retrieval work. All earlier notebook editing and portability WIP is preserved in `/home/simonx/AI/temp/rc6/r2-deferred/20261015-knowledge-notebook-cutover.patch` (361884 bytes; SHA-256 `9ff2668082d155755f9f58055c2aaf5d4fc841993c3da58f4739c3c665e367fb`). It is incomplete and unreviewed. The committed notebook primitive slice is removed by a later coherent commit rather than rewritten from history.

The bounded current-file lexical replacement is complete. The real CJK answer, full enumeration/disposition and canonical-change regressions passed as recorded below. Pre-existing notebook and portability implementation is not a deciding oracle for this slice.

## Builder Report

This is implementation evidence, not design authority or release approval. The accepted [Retrieval Kernel](../../specs/20261014-retrieval_kernel.md) and the engineer's scope correction govern this slice. Independent Grok review, owner decisions and the coordinator's post-rc.6 merge decision remain pending. No push, merge, tag, publication or deployment-host access occurred.

### Delivered Scope

NanoCore supervises the target-native local kernel service with health, bounded requests, restart, shutdown and explicit uncertain-publication failure. Current product adapters admit conversation Items, Artifact text and saved Material revisions. The identity-only sidecar helper accepts a canonical owner's verified digest and has no body handle. Arbitrary-file admission and authored-description storage remain with their owners. The past-Thread Assistant Tool is blocked; no new operation or Tool was invented.

Knowledge retrieval, answer, preparation, Task selection and the Knowledge part of App search use one asynchronous governed lexical pipeline. The old JSON lexical postings, tokenizer, scorer and public read model are deleted. Three non-lexical JSON projections remain. Complete kernel enumeration precedes dispositions and the product limit. Current source and destination authorization also applies to pins and exact selected-page reads. The product adapter declares searchable byte ranges for title/description/tags/body; the Rust kernel verifies full canonical bytes and knows no YAML or product domain. Existing Workspace digest-based traces remain; no notebook commits or retained-history claims are fabricated.

The App Dockerfile builds a native executable for each Linux target. The verified IPADIC archive is vendored once, cached for Cargo/CI and embedded in the executable. Its recorded URL, version, SHA-256 and full COPYING remain in the [kernel guide](../../../apps/retrieval-kernel/README.md) and vendor guide. Images include SPDX metadata, supplied notices and 26 additional upstream notice files with exact revision/URL/SHA-256 provenance. Root pnpm/Turbo and release-test wiring include the kernel. No workflow file or protected publication job was edited.

### Verification

Commands use Node 24.18.0, pnpm 10.33.3 and Rust 1.97.1. Node checks use `mise exec node@24.18.0 --`; pnpm resolves through Corepack with `COREPACK_HOME=/tmp/openkit-corepack`. Cargo uses `LINDERA_BUILD_DICTIONARY_CACHE_DIR=/tmp/openkit-lindera-cache`. Focused NanoCore tests use the task's ignored on-disk `test-tmp` directory because the shared `/tmp` inode pool was exhausted by unrelated fixtures. Setup failures are not product results.

| Check | Exact observed result |
| --- | --- |
| NanoCore focused Vitest run: service, sources, CJK Knowledge, governed enumeration/races, manager, work history, operation projections, index rebuild, proposal authority, App search/visibility, boot/shutdown and OpenAPI | 14 files, 169 tests passed; 0 failed; 141.54 seconds. `/tmp/openkit-r2-final-nanocore-focused.log`. |
| App API schema suite | 22 files, 211 tests passed; 0 failed. `/tmp/openkit-r2-final-api-schema-tests.log`. |
| NanoCore/Web/App API schema typecheck | All three packages exited 0. `/tmp/openkit-r2-final-typecheck.log`. |
| Biome over changed source/configuration files | 34 TypeScript, JavaScript and JSON files checked; no fixes, warnings or errors; exit 0. |
| Rust `cargo test --locked --offline -p retrieval-kernel` | 39 library tests and 6 executable-face tests passed; 0 failed/ignored; 0 doc tests. `/tmp/openkit-r2-final-cargo-test.log`. |
| Rust format and Clippy | `cargo fmt --check` and `cargo clippy --locked --offline -p retrieval-kernel --all-targets --all-features -- -D warnings` exited 0. `/tmp/openkit-r2-final-clippy.log`. |
| ARM cross build | `cargo build --locked --offline -p retrieval-kernel --target aarch64-unknown-linux-gnu --release` exited 0 with the AArch64 GNU linker. `/tmp/openkit-r2-final-arm64-cross.log`. |
| Dictionary, notice provenance and toolchain mirror tests | 15 passed, 0 failed/skipped. `/tmp/openkit-r2-final2-root-packaging.log`. |
| Release runner regressions | 12 passed, 0 failed/skipped; exit 0. `/tmp/openkit-r2-final2-release-tests.log`. |
| App Dockerfile regressions | 1 file, 4 tests passed; exit 0. `/tmp/openkit-r2-final-dockerfile-tests.log`. |
| Web Knowledge panel | `vitest run src/screens/workspace/workspace.test.tsx -t 'Knowledge \(board 14\)'`: 82 passed; 60 unrelated cases outside the name selection; 0 failed; exit 0. `/tmp/openkit-r2-final-web-knowledge.log`. |
| Worker Knowledge bridge checks | 8 passed, 198 outside the focused name selection; current-authority/materialization sample 3 passed, 203 outside its selection. |
| Documentation validators | Spec lifecycle passed; story schema 10 stories; documentation model 480 documents including this report; generated index current; interface reachability 5 passed; terminology 2 passed; test governance passed. Report-inclusive documentation model and index checks also passed. |
| Final App image builds | Both `docker buildx build --platform linux/<architecture> --load -f containers/app/Dockerfile` builds exited 0. Local tags: `openkit/retrieval-r2-app:amd64` and `:arm64`. Logs: `/tmp/openkit-r2-final2-app-amd64-build.log`, `/tmp/openkit-r2-final2-app-arm64-build.log`. |
| Final amd64 App smoke | `docker run --rm --network none --platform linux/amd64 --entrypoint /usr/local/bin/openkit-app-smoke openkit/retrieval-r2-app:amd64` exited 0: CLI, MCP, actual supervisor/restart, dictionaries, Linux limits, App health and SPA. `/tmp/openkit-r2-final2-amd64-smoke.log`. |
| Final ARM packaged retrieval | Under the full-system ARM Linux guest: CLI, MCP, actual NanoCore supervisor/restart, CJK, ranges, revocation and shipped-child Linux limits all passed. The same guest passed the independent 3 GiB allocation control. Exact serial marker: `Retrieval image smoke OK (arm64): CLI, MCP, supervised service/restart, CJK, sidecar isolation, ranges, revocation, limits.` |
| Final ARM full App smoke | **Failed**: NanoCore did not reach public App health within the unchanged 60-second deadline under TCG. `R2_APP_SMOKE_EXIT=1`; admitted driver exited 1 with `{outcome:"FAIL",retrieval:"PASS",app:"FAIL",returncode:0,child_reaped:true}`; clean guest poweroff at 127.18 guest seconds. The retrieval checks above passed before this failure. Native ARM App startup and Docker deployment remain unqualified. |

The CJK answer regression was observed red before implementation: both two-term body queries returned insufficient evidence. It is now green through the actual service and shared analyzer. The 1001-page regression requires a typed incomplete-enumeration failure with no trace. The concurrent-edit regression changes real canonical bytes during real index preparation and requires no successful trace. Tests do not infer those outcomes from mocked scores.

### Acceptance Coverage

The existing Rust regressions were rerun rather than copied into another harness. Predicate 1 uses `regression_222_*`, language/title fixtures and the real Knowledge answer regression. Predicate 2 uses pre-open scope/statistics isolation, the executable faces and current-policy/private-audience product fixtures. Predicate 3 uses clean rebuild equivalence and deterministic scope merge. Predicate 4 uses independent exhaustive literal/regex scan oracles. Predicate 5 uses hostile-input, real allocation/peak-memory, process-limit and supervisor-failure fixtures. Predicate 6 is blocked on the upload owner. Predicate 7 uses publication-boundary interruption, pointer recovery, status and real canonical-edit races. Predicate 8 uses the product adapter and governed Knowledge fixtures; Assistant Tool binding and the pre-existing scoped notebook/history target remain explicitly unresolved. Predicate 9 uses zero-sidecar direct text, canonical verified-digest identity discovery and binary-body isolation fixtures. Predicate 10 uses the final images and packaged smoke; the ARM observation boundary is recorded below. Predicate 11 uses cache lifecycle, interrupted replacement, corruption and pinned-reader regressions. No maximum upload size, history commit or union rule is invented by a fixture.

### ARM Observation Boundary

The first ARM image smoke failed the address-space assertion under QEMU user mode. A separate static ARM control proved this is missing enforcement: a 3 GiB `PROT_NONE` mapping succeeded before and after a successful `setrlimit` call setting both limits to 2 GiB; guest readback remained unlimited. CPU and file-size readback worked. This failure remains evidence and is not waived.

The authorized package-only fallback uses QEMU system AArch64 11.1.1, Debian ARM kernel `linux-image-6.1.0-53-arm64` 6.1.187-1 and static BusyBox 1.35.0. A minimal guest with networking disabled passed the unchanged allocation control: baseline mapping succeeded, guest `/proc` and `getrlimit` reported soft/hard 2147483648, and the later mapping failed with `ENOMEM` (12). `R2_PROBE_EXIT=0`; clean poweroff. The minimal boot had a 120-second wall bound and 4 GiB memory allocation. Its raw evidence is under the task's ignored `arm-vm/` directory.

The final App filesystem check uses an 8 GiB, network-disabled ARM Linux guest, a 16 GiB emulator address-space ceiling and a 420-second outer wall bound. The packaged smoke retains its original deadlines and product ceilings. It exercises the actual NanoCore `RetrievalService` separately from direct child `/proc` checks. A pass establishes packaged ARM Linux behavior under a guest kernel; it does not establish native performance or the Docker deployment profile. An initial full-App boot failed before smoke admission because BusyBox dispatches by its executable basename and the exported console was a regular placeholder. A direct negative probe identified the basename fault. The temporary guest bootstrap now uses an unchanged `busybox` basename and a guest console, and explicitly requires serial smoke completion; packaged App bytes and limits are unchanged. The next run passed all retrieval checks but Caddy could not resolve `localhost`: `docker export` omits Docker's generated runtime hosts file. The guest bootstrap supplies standard loopback host entries; the original App health deadline remains 60 seconds. These two setup failures remain retained separately. The manual run then passed every packaged retrieval and resource check but failed the existing App health deadline at 121.54 guest seconds. After harness admission, the deciding rerun again passed retrieval/resource checks and failed App health: `R2_APP_SMOKE_EXIT=1`, clean poweroff at 127.18 guest seconds. No deadline was raised. The exact deciding log is `temp/changes/202610150000000000-retrieval_kernel_r2/arm-vm/admitted-app-boot.log`; prior probes and setup-failure logs remain beside it. The timeout cause is unknown; these observations do not prove that emulation caused it.

### VM Driver Admission

The temporary driver is `temp/changes/202610150000000000-retrieval_kernel_r2/arm-vm/vm-driver.py`, SHA-256 `77b8196b98be2a3755b76f86f0b2918c0745c083a1f53e858754984b177d4055`. On 2026-10-15, `python3 <driver> --self-check` exercised the same persistent-output, subprocess completion, timeout, kill/wait and serial-classification paths against stable non-product targets. Five interventions produced their expected observations: complete markers/exit 0 gave PASS; a missing retrieval marker gave FAIL; exit 23 despite complete markers gave FAIL; an App failure after valid retrieval markers gave overall FAIL with retrieval PASS; and a timeout after premature complete markers gave TIMEOUT with both subjects UNQUALIFIED. Each target's expected output remained in its log until after classification; all children were reaped. This establishes pass/fail/timeout discrimination, not product evidence. `driver-self-check.log` retains the observations. The real `--gate` run follows that admission; earlier manual runs are retained probes, not deciding qualified runs. The driver adds a 16 MiB host output-file ceiling without changing the guest product budgets. The admitted real `--gate` run exited 1 with `{outcome:"FAIL",retrieval:"PASS",app:"FAIL",returncode:0,child_reaped:true}`. `admitted-result.json` and `admitted-app-boot.log` retain the result and serial output. The successful retrieval observation is distinct from the failed full App smoke. The driver source digest remained unchanged after the run.

### Build Artifact Identities

Local image identities are `linux/amd64 sha256:935b3ee3d9ed9a827a2792155b31f5f549f07f35251d1116cfed073cae8d09f4` and `linux/arm64 sha256:ef8acee484627aaf799e2f7375dd87cc0bf0921c1d9680c4e881b3489ebfb25b`. The exported ARM executable SHA-256 is `6a784625cc042e7f5958758459ecfa71343cc74aeb4862f27aedad6ce57adc1e`. The packaged smoke SHA-256 is `17a9dce781e7434af93c46f49055b3b1bdb5ded24e499e799b6a34cc1de72d44`, identical to the committed script. The four recorded executable/supervisor/smoke/dictionary-notice payload hashes remained unchanged after guest preparation. Image environment, working directory and file permissions came from the export; only guest bootstrap tools, pseudo-filesystems, console and ordinary runtime loopback hosts were supplied externally. No App code was patched.

The two local image tags, Docker build cache, installed ARM toolchains and ignored VM/package evidence remain on the dev machine. Each temporary source container was removed. Each guest powered off. No App service or guest remains running from these probes.

### Owner Decision Batch

Current coordinator status: items 1 (union pins) and 2 (combined trace ledger) wait for the engineer; item 3 (historical import closure) is settled as bounded fail-closed rejection; items 4 (upload maximum) and 5 (Assistant history Tool) wait for the Artifacts and Chat Mode topics. All dependent effects remain stopped. The table retains the exact owner lines, alternatives and reasons; the settled row replaces the earlier recommendation.

| Gap and exact owner lines | Options and recommendation |
| --- | --- |
| Maximum-upload regression: [retrieval:33](../../specs/20261014-retrieval_kernel.md:33), [retrieval:268](../../specs/20261014-retrieval_kernel.md:268); [core-experience ruling 4:56](../202610140256550000-v0_1_0_core_experience/plan.md:56) sets only 1 GB per upload. | Wait for the Artifact/upload owner to define byte count, unit and arbitrary-file admission. Do not choose a number or add a maximum-upload test. This is the engineer's confirmed disposition. |
| Assistant history Tool amendment: [retrieval:285](../../specs/20261014-retrieval_kernel.md:285), [Chat Mode:108](../../specs/20260704-chat_mode_assistant.md:108). The current Assistant has no history Tool implementation. | Bind the adapter after Chat Mode settles its intended Tool/operation, or explicitly amend that owner. Recommend the first option to keep history continuity and Tool admission under one owner. No Tool or operation id is added here. |
| Union pins: [Knowledge Store:195](../../specs/20260703-knowledge_store_implementation.md:195), [Knowledge Store:197](../../specs/20260703-knowledge_store_implementation.md:197), [scoped learning:64](../../specs/20260909-personal_memory_and_knowledge_learning.md:64). Pins are plain page ids while candidate identities include scopes; duplicate ids have no binding rule. | Options: address both pages; address only the first ordered scope; or scope-qualify pins. Recommend scope-qualified pins because they name one intended page and remain unambiguous when identifier generation changes. Scope order is explicitly a ranking tie-break, not authority. No union rule is selected in code. |
| Combined private trace ledger: [Knowledge Store:201](../../specs/20260703-knowledge_store_implementation.md:201), [Knowledge Store:209](../../specs/20260703-knowledge_store_implementation.md:209), [scoped learning:62](../../specs/20260909-personal_memory_and_knowledge_learning.md:62) and [:64](../../specs/20260909-personal_memory_and_knowledge_learning.md:64) require one combined trace but do not assign its owning ledger. | Options: current User ledger, Workspace ledger with a separately defined private boundary, or a newly accepted private owner. Recommend the User ledger because combined results include private Memory; an ordinary Workspace ledger could expose that evidence to Workspace members. Do not introduce a new ledger when the User owner can hold it. No union trace is written here. |
| Portable historical notebook closure: [S51:220–222](../../specs/20260704-workspace_backup_export_import.md:220), [S39:299](../../specs/20260703-worker_context_package.md:299), [Notebook:48](../../specs/20260909-knowledge_notebook_editing.md:48), [:50](../../specs/20260909-knowledge_notebook_editing.md:50), [:102](../../specs/20260909-knowledge_notebook_editing.md:102), [:104](../../specs/20260909-knowledge_notebook_editing.md:104). Import remints a page's Context Package digest, selected pages bind exact notebook commits, and changed bytes require new commits. Current export lacks complete historical trees. | Decision-batch item 3 is settled by coordinator–Consultant agreement, reported in Intent Revision 6: bounded fail-closed rejection of imports that need unavailable historical closure. No new project is opened. This replaces the earlier recommendation to define the closure. Assigning the reminted current commit to historical selections can create a digest cycle. Implementation remains pre-existing work outside R2; dependent import publication stays stopped. |

### Pre-existing Knowledge Gaps Outside R2

- Git notebook authority, fixed editing base, atomic whole-tree publication and history remain unimplemented targets: [Notebook:44–50](../../specs/20260909-knowledge_notebook_editing.md:44), [:70](../../specs/20260909-knowledge_notebook_editing.md:70), [:80–84](../../specs/20260909-knowledge_notebook_editing.md:80), [:112](../../specs/20260909-knowledge_notebook_editing.md:112). The bounded current-file retrieval path makes no Git history claim.
- Complete canonical-byte deletion/forget confirmation and suppression remain separate work: [Notebook:76](../../specs/20260909-knowledge_notebook_editing.md:76), [:100](../../specs/20260909-knowledge_notebook_editing.md:100), [scoped learning:94](../../specs/20260909-personal_memory_and_knowledge_learning.md:94). No deletion behavior is changed here.
- User/Server scoped notebooks, commit-tagged projections, pinned-commit reads and full scoped traces remain pre-existing requirements: [Knowledge Store:191](../../specs/20260703-knowledge_store_implementation.md:191), [:195](../../specs/20260703-knowledge_store_implementation.md:195), [:199](../../specs/20260703-knowledge_store_implementation.md:199), [:201](../../specs/20260703-knowledge_store_implementation.md:201), [:209](../../specs/20260703-knowledge_store_implementation.md:209), with the implementation gap recorded at [:262](../../specs/20260703-knowledge_store_implementation.md:262). R2 retains the existing one-Workspace current-digest trace.
- Exact historical S39 notebook selections and portable closure remain separate work: [S39:299](../../specs/20260703-worker_context_package.md:299), [Notebook:102–104](../../specs/20260909-knowledge_notebook_editing.md:102), and the decision batch above. Current retrieval disclosure checks are added without changing S39's retained shape or import/export behavior.
- The pre-existing Server maintenance configuration is outside this replacement: [scoped learning:88](../../specs/20260909-personal_memory_and_knowledge_learning.md:88) and the notebook delegation owner. It is no longer an R2 WP1 dependency after the scope correction.

The removed WIP is saved at `/home/simonx/AI/temp/rc6/r2-deferred/20261015-knowledge-notebook-cutover.patch`: 361884 bytes; SHA-256 `9ff2668082d155755f9f58055c2aaf5d4fc841993c3da58f4739c3c665e367fb`. It is incomplete and unreviewed. Commit `730e59a4` removes the earlier notebook primitive slice without rewriting history. No notebook implementation file remains in the final net diff.

### WP1-owned Follow-up

No listed WP1 path was edited. After WP1 merges and the coordinator releases ownership:

- `apps/nanocore/README.md:188`: replace the old full-text JSON index description with the three non-lexical projections and supervised kernel path; document current admission, asynchronous retrieval, binary/dictionary supply and explicit failures. Retain the current one-Workspace limitation and the pre-existing notebook gap.
- `apps/nanocore/src/runtime/turn-executor-factory.test.ts:9091`: change the synchronous retrieval fixture map to `await Promise.all(...map(async ...))`; await `retrieveWorkspaceKnowledge` at the current call near line 9134 and pass current `{store,coreDb,actor:entry.triggerActor,outputThreadId:entry.threadId}` access. Use ordinary service cleanup. No production runtime factory change or Core migration is requested.
- The complete discovery run confirms five failed capacity scenarios in that runtime factory file (`active`, `closeout`, `late-capacity`, `materialization-initial-guard`, and `materialization-forced-retirement-guard`) plus ten unhandled `access.coreDb` errors from the unawaited fixture call at line 9134. The failed Task preparation reports contradictory Knowledge selection because the trace has not been published.
- `apps/nanocore/src/runtime/nanohost-lifecycle-diagnostics.test.ts:471`: inspect the two failed `sampled-event-loop-control` and `sampled-event-loop-before-sample` cases under the whole suite. Their first sampled delays were 533 and 511 ms against the existing `<250` ms assertion. No threshold, deadline or production diagnostic is changed. Their cause remains unqualified; ownership stays with WP1.
- The final complete confirmation reproduced those same five factory failures and ten unhandled missing-access rejections, plus both diagnostic failures. Its diagnostic delays were 616 and 663 ms against `<250` ms. Both complete runs remain failed observations, and no protected assertion is weakened or skipped.

### Residual Risks

The four unresolved notice gaps are recorded in `apps/retrieval-kernel/notices/GAPS.json`: htmlescape 0.3.1 has no recorded/verified revision; kanaria 0.2.0 has no obtainable matching notice at recorded commit `c994ccf06d179851a1c7c3285c3a408ccb6279ec`; winapi-i686-pc-windows-gnu and winapi-x86_64-pc-windows-gnu 0.4.0 have no recorded/verified revision. The Windows crates are not Linux runtime dependencies. SPDX metadata and supplied notices do not replace missing copyright notices.

The earlier full ARM App-health smoke failed in the full-system guest even though all target retrieval/resource checks passed. The timeout cause is unknown; the coordinator accepts the later comparison as no R2-specific regression. Native ARM qualification belongs to a1 later with the exact reviewed image. The ARM Docker deployment profile, macOS resource enforcement and native ARM performance were not qualified on this Linux host. The protected WP1 runtime fixture cannot pass unchanged against the asynchronous API until its owner applies the listed change. The complete discovery run also exposed two protected diagnostics failures, whose cause remains unqualified. The final whole-suite confirmation is recorded in the review correction section; no full repository gate or release approval is implied. The accepted owner amendments and actual diff still require renewed independent review.

### Commits, Changed Paths And Publication Inputs

The implementation commits are below. The final documentation/evidence commit follows these commits. Git history retains both the deferred notebook commit and its removal; their implementation files are absent from the net diff.

```text
c754be0d docs(retrieval): align accepted owners for kernel integration
09d8be19 feat(retrieval): supervise kernel and admit canonical product text
2fb67c73 build(retrieval): package target-native kernel and verified dictionaries
281c54e2 feat(knowledge): add fixed-base canonical notebook primitives
76d0f64a test(knowledge): expose governed CJK answer retrieval failure
730e59a4 chore(retrieval): defer unrelated notebook implementation
4bb932d7 feat(retrieval): index adapter-selected canonical text ranges
5c1c1229 feat(knowledge): replace lexical JSON retrieval with governed kernel search
c9ed0226 test(retrieval): exercise packaged faces and NanoCore supervision
```

The final net diff contains 105 files after the review correction, including 8 owning Core/specification documents (7 required available owner amendments and the retrieval implementation projection). The 12 named product/mechanism owners touched are Retrieval Kernel, Knowledge Store, Knowledge Manager, Core Storage, Storage Layout, Personal Memory, Work Resource Interaction, Thread Visibility, Policy Enforcement Mapping, Worker Context Package, Container Image Packaging and Deployment Host Requirements. No new product registry, operation catalog or database table is added. The stdio operation set adds `analyze`; searchable-range admission extends the existing Document shape. Third-party supply adds one dictionary archive and a 26-file upstream-notice provenance inventory. These are raw counts, not acceptance thresholds. The review correction itself touches nine files and three owning documents, with no new closed set or registry.

Changed paths relative to `ba79e4e0973b952fe2dd515fa23c0d4b91304f19`:

```text
apps/nanocore/openapi/app-api.openapi.json
apps/nanocore/src/README.md
apps/nanocore/src/app-search-operation-implementations.ts
apps/nanocore/src/b6-operation-retirement.test.ts
apps/nanocore/src/bootstrap/README.md
apps/nanocore/src/bootstrap/phase-order.test.ts
apps/nanocore/src/dashboard-search-visibility.test.ts
apps/nanocore/src/docker/README.md
apps/nanocore/src/docker/app-dockerfile.test.ts
apps/nanocore/src/index.ts
apps/nanocore/src/knowledge-manager-work-history.test.ts
apps/nanocore/src/knowledge-manager.test.ts
apps/nanocore/src/knowledge-manager.ts
apps/nanocore/src/knowledge-operations.ts
apps/nanocore/src/knowledge-source-authority.ts
apps/nanocore/src/retrieval-knowledge-adapter.ts
apps/nanocore/src/retrieval-knowledge-governance.test.ts
apps/nanocore/src/retrieval-knowledge.test.ts
apps/nanocore/src/retrieval-service.test.ts
apps/nanocore/src/retrieval-service.ts
apps/nanocore/src/retrieval-sources.test.ts
apps/nanocore/src/retrieval-sources.ts
apps/nanocore/src/runtime/worker-governance-turn-executor.test.ts
apps/nanocore/src/runtime/worker-governance-turn-executor.ts
apps/nanocore/src/search.test.ts
apps/nanocore/src/server.test.ts
apps/nanocore/src/storage/README.md
apps/nanocore/src/storage/index-rebuild.test.ts
apps/nanocore/src/storage/index-rebuild.ts
apps/nanocore/src/storage/knowledge-proposal-authority.test.ts
apps/nanocore/src/storage/workspace-export-lineage.test.ts
apps/nanocore/src/storage/workspace-portable-file-state-io.test.ts
apps/nanocore/src/storage/workspace-storage-migration.test.ts
apps/retrieval-kernel/README.md
apps/retrieval-kernel/notices/GAPS.json
apps/retrieval-kernel/notices/README.md
apps/retrieval-kernel/notices/UPSTREAM.json
apps/retrieval-kernel/notices/datasketches-0.2.0/LICENSE
apps/retrieval-kernel/notices/datasketches-0.2.0/NOTICE
apps/retrieval-kernel/notices/include-flate-codegen-0.3.4/LICENSE
apps/retrieval-kernel/notices/include-flate-compress-0.3.4/LICENSE
apps/retrieval-kernel/notices/jieba-macros-0.11.0/LICENSE
apps/retrieval-kernel/notices/jieba-rs-0.11.0/LICENSE
apps/retrieval-kernel/notices/lindera-5.0.1/LICENSE
apps/retrieval-kernel/notices/lindera-analysis-5.0.1/LICENSE
apps/retrieval-kernel/notices/lindera-dictionary-5.3.0/LICENSE
apps/retrieval-kernel/notices/ownedbytes-0.9.0/AUTHORS
apps/retrieval-kernel/notices/ownedbytes-0.9.0/LICENSE
apps/retrieval-kernel/notices/r-efi-6.0.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-bitpacker-0.10.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-bitpacker-0.10.0/LICENSE
apps/retrieval-kernel/notices/tantivy-columnar-0.7.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-columnar-0.7.0/LICENSE
apps/retrieval-kernel/notices/tantivy-common-0.11.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-common-0.11.0/LICENSE
apps/retrieval-kernel/notices/tantivy-query-grammar-0.26.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-query-grammar-0.26.0/LICENSE
apps/retrieval-kernel/notices/tantivy-sstable-0.7.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-sstable-0.7.0/LICENSE
apps/retrieval-kernel/notices/tantivy-stacker-0.7.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-stacker-0.7.0/LICENSE
apps/retrieval-kernel/notices/tantivy-tokenizer-api-0.7.0/AUTHORS
apps/retrieval-kernel/notices/tantivy-tokenizer-api-0.7.0/LICENSE
apps/retrieval-kernel/package.json
apps/retrieval-kernel/src/directory.rs
apps/retrieval-kernel/src/lib.rs
apps/retrieval-kernel/src/main.rs
apps/retrieval-kernel/src/model.rs
apps/retrieval-kernel/src/store.rs
apps/retrieval-kernel/src/tests.rs
apps/retrieval-kernel/src/text.rs
apps/retrieval-kernel/vendor/IPADIC-COPYING
apps/retrieval-kernel/vendor/README.md
apps/retrieval-kernel/vendor/mecab-ipadic-2.7.0-20250920.tar.gz
apps/web/README.md
apps/web/src/screens/workspace/KnowledgeScreen.tsx
apps/web/src/screens/workspace/workspace.test.tsx
containers/app/Dockerfile
containers/app/README.md
containers/app/smoke.sh
containers/test-env/Dockerfile
containers/test-env/README.md
docs/INDEX.md
docs/changes/202610150000000000-retrieval_kernel_r2/plan.md
docs/core/storage.md
docs/specs/20260703-knowledge_store_implementation.md
docs/specs/20260703-storage_layout_record_ownership.md
docs/specs/20260704-knowledge_manager_internal_agent_runtime.md
docs/specs/20260713-work_resource_interaction_model.md
docs/specs/20260909-deployment_host_requirements.md
docs/specs/20260909-personal_memory_and_knowledge_learning.md
docs/specs/20261014-retrieval_kernel.md
packages/app-api-schemas/README.md
packages/app-api-schemas/src/index.test.ts
packages/app-api-schemas/src/knowledge-manager.ts
scripts/README.md
scripts/docker/test-image-tag.mjs
scripts/release-tests.mjs
scripts/retrieval-cargo.sh
scripts/retrieval-dictionary.py
scripts/retrieval-notices.py
skills/openkit-ops/scripts/openkit
tests/README.md
tests/retrieval-packaging.test.mjs
turbo.json
```

`publicationInputsAt` from `scripts/release-publication-check.mjs` compared the exact base with implementation commit `c9ed0226ae52873d1b90f9e55500b51d609a6366`: both SHA-256 values are `9029285e5b35bf435c3f5afb0fe90600151b8f00c5f27caa433b49bba5cbd1e4`; `publicationInputsChanged=false`, exit 0. No workflow changed, including `publish-container-images`, `github-release` and `verify-release`. A final post-commit rerun is required and is reported in the handoff. Documentation-only closeout edits no member of the observed publication-input closure. This is an input comparison, not release-grant admission or a publication rehearsal.
