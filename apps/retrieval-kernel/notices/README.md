# Retrieval Dependency Notices

This directory retains omitted upstream notices and OpenKit's elected license texts for locked dependencies. `UPSTREAM.json` records exact upstream files with their crate/version, source URL, verified revision, and SHA-256. `ELECTIONS.json` records OpenKit's license election and provenance separately. `scripts/retrieval-notices.py` checks each file's path and digest before copying it, retains both provenance inventories byte for byte, and supplies Cargo's declared license metadata in `CRATES.json`.

`GAPS.json` records unresolved source notice obligations. It is empty after the #249 corrections below. This is not built-image acceptance or a license-completeness claim: #249 remains open until both target images are inspected for the exact packaged license and provenance bytes. The full IPADIC notice and archived dictionary source remain in the sibling `vendor/` directory. Runtime does not fetch dictionaries or notices. Do not rewrite supplied notice text.

## #249 Linux Dependency Evidence

P08 checked the locked graph on 2026-10-15 with Rust/Cargo 1.97.1. `containers/app/Dockerfile` builds the target-native executable for each Linux platform. `x86_64-unknown-linux-gnu` corresponds to `linux/amd64`; `aarch64-unknown-linux-gnu` corresponds to `linux/arm64`. These are dependency-graph observations, not native image qualification.

| Current input | SHA-256 |
| --- | --- |
| Root `Cargo.lock` | `88be6b21f6430d1aa5bf3b730822905e37ed7514a2378a49b454265797a0947a` |
| Root `Cargo.toml` | `37df6268b46a4fe8934dcd4acdcc9a3fc4c9701acb9bad13e41dcfdd9d18692c` |
| `apps/retrieval-kernel/Cargo.toml` | `d04a4ba566f11591761cbdbfb6b1098c532b16aff64fe88ee18f57e2d1def5a7` |

From `apps/retrieval-kernel`, use the shared command slot and `CARGO_BUILD_JOBS=1` to run the complete normal graph for each target:

```sh
cargo tree --locked --offline --target <target> -e normal --prefix none --format '{p}'
```

Both commands exited 0. The amd64 graph contains 193 distinct package names; arm64 contains 192. Neither contains `kanaria`, `lindera-analysis`, `lindera-tantivy`, or either Windows import-library crate. Both contain `htmlescape 0.3.1` and `lindera 5.0.1`. Positive-control queries using the same target and `-e normal -i lindera@5.0.1` each exited 0 and showed Lindera directly under `retrieval-kernel`.

| Original gap | Linux amd64 | Linux arm64 | Source disposition |
| --- | --- | --- | --- |
| `htmlescape 0.3.1` | Normal dependency through Tantivy | Same path | Elect Apache-2.0 and supply exact canonical text and provenance |
| `kanaria 0.2.0` | Absent after the adapter replacement | Same result | Remove the unused dependency and its obligation |
| `winapi-i686-pc-windows-gnu 0.4.0` | Absent | Absent | Exclude from Linux notice obligation |
| `winapi-x86_64-pc-windows-gnu 0.4.0` | Absent | Absent | Exclude from Linux notice obligation |

The first-slice positive controls queried both exact Windows packages with `--target all -e normal -i <crate>@0.4.0`. Each exited 0 and showed a path through `winapi 0.3.9`, then `fs2 0.4.3` or `tantivy 0.26.2`, to `retrieval-kernel`. Their corresponding Linux queries exited 0 with empty stdout and `warning: nothing to print.` Thus Cargo recognized the exact packages; target filtering excluded them on both Linux targets. No Windows lock entries or supplied notices were removed. Recheck these conclusions when dependencies or distribution targets change.

## Kanaria Removal And Tokenizer Preservation

OpenKit now maps the existing Lindera `Segmenter` directly into Tantivy tokens. It preserves surface text, positions, position lengths, and original UTF-8 byte offsets, then applies the same OpenKit lowercase and word filters. The old `from_segmenter` path configured no Lindera analysis filters; the removed analysis layer brought in `kanaria` for an unused kana-conversion filter. Embedded IPADIC remains enabled on Lindera itself, with its existing identity and notices.

A separate test author froze the old adapter's behavior before production edits. The committed `p08_` characterization tests contain exact Japanese and Chinese token fields, punctuation gaps, Unicode lowercase expansion, empty-input and stream-reuse cases, and fixed CJK retrieval order, scores, snippets, locators, coverage, and scope isolation across private publication and restart. Both tests pass before and after replacement. Existing body-word lookup and scope-isolation regressions remain in the crate suite. The Cargo-generated lock update removes nine packages, adds none, and changes no retained dependency version. `kanaria`, `lindera-analysis`, and `lindera-tantivy` are absent from the lock and Cargo metadata. The obsolete supplemental Lindera analysis notice is removed with its dependency.

Index machinery already binds the complete Cargo lock digest. This dependency removal therefore requires rebuilding old derived generations from their canonical source; it does not migrate or discard canonical data.

## Htmlescape Apache-2.0 Election

The coordinator confirmed the Apache-2.0 election on 2026-10-15 after Consultant agreement. The published manifest declares `Apache-2.0 / MIT / MPL-2.0`. OpenKit elects Apache-2.0 and ships the exact canonical [Apache License 2.0 text](https://www.apache.org/licenses/LICENSE-2.0.txt), fetched from Apache without edits. Its SHA-256 is `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`. The source file is `htmlescape-0.3.1/LICENSE-APACHE-2.0`; packaging places it at `elected/htmlescape-0.3.1/LICENSE-APACHE-2.0`, beside the exact root `ELECTIONS.json` provenance inventory.

`ELECTIONS.json` is OpenKit's record, not an upstream notice file. It retains the manifest's `license` and `authors` values verbatim, the manifest and archive digests, the matched upstream revision, each source file's path and digest, the canonical license URL and digest, and the explicit absence of upstream NOTICE and source attribution notices. Author metadata is not represented as a copyright notice. No copyright holder, year, or attribution line is inferred. The unedited Apache text retains its standard appendix placeholders.

The [published htmlescape archive](https://static.crates.io/crates/htmlescape/htmlescape-0.3.1.crate) has SHA-256 `e9025058dae765dee5070ec375f591e2ba14638c63feff74f13805a72e523163`, which matches `Cargo.lock`. Its manifest and all five Rust source files match [upstream revision `1699b539179798e705ad8464128492a0a0092876`](https://github.com/veddan/rust-htmlescape/tree/1699b539179798e705ad8464128492a0a0092876) byte for byte. The verified archive and revision contain no NOTICE file. Inspection found no copyright, patent, trademark, or attribution notice in those source files, so no source notice text is omitted or invented. The archive omits `.cargo_vcs_info.json` and a license file. Upstream PR #17 was unmerged when checked; its proposed files are not the source of the shipped license. No dependency fork or patch is introduced.

For the removed `kanaria 0.2.0`, the [published archive](https://static.crates.io/crates/kanaria/kanaria-0.2.0.crate) has SHA-256 `c0f9d9652540055ac4fded998a73aca97d965899077ab1212587437da44196ff` and records revision `c994ccf06d179851a1c7c3285c3a408ccb6279ec`. It supplies no license or copyright notice file, and the recorded revision's LICENSE URL returned HTTP 404. Its obligation is removed because the dependency is absent, without substituting package authors for copyright holders or guessing missing notice text.

## Verification And Remaining Image Evidence

The package test command discovers `tests/*_test.py` with standard-library unittest before its Cargo tests. The source notice tests execute the real collector against real locked Cargo metadata and isolated notice copies. They check exact elected license and provenance bytes, verbatim manifest values and source digests, and rejection of corrupt license bytes or a path outside the owned directory. The image-check self-tests use fixed filesystem bytes and simulated Docker replies only to check comparison and driver control flow; they do not establish image acceptance. Existing upstream notice and dictionary-supply checks remain strict. Focused checks use the shared slot and one worker; no full local repository gate or image matrix is part of this slice.

Before #249 closes, build both target-native App images and compare the packaged `ELECTIONS.json`, canonical Apache text, remaining upstream notice inventory/files, `GAPS.json`, and IPADIC notice with the selected source bytes. Confirm that their Cargo metadata and executable supply use the corrected graph. Source collection and passing local tests do not prove those built-image bytes. The main package README and shared packaging test remain reserved to the main-CI-fix builder until handback. CI remains on hold until the coordinator announces green main; native arm64 and release qualification remain separate proof.

## Prepared Image Notice Check

`apps/retrieval-kernel/verify-image-notices.py` checks the full notice tree from both built App images. Run it after the CI hold ends on a Docker-capable CI host or against loaded candidate images, from the selected source checkout. It requires Python 3, the pinned Cargo toolchain and already-fetched locked crate sources, and Docker API 1.49 or later for [explicit platform inspection](https://docs.docker.com/reference/cli/docker/image/inspect/). Supply platform-specific image references, or a locally loaded multi-platform reference that the engine can select for both platforms. The check never builds or pulls an image.

```sh
CARGO_BUILD_JOBS=1 python3 apps/retrieval-kernel/verify-image-notices.py --amd64-image <loaded-amd64-App-reference> --arm64-image <loaded-arm64-App-reference>
```

Use the dispatch's shared command slot when running this command on the shared development machine. The expected tree is generated once by the existing source collector plus the source IPADIC COPYING file. Both images must have the exact same complete regular-file inventory and bytes, including `CRATES.json`, both provenance inventories, all upstream and elected licenses, dictionary COPYING, and an empty `GAPS.json`. Missing, extra, changed, linked, or nonregular entries fail the check.

For each requested platform, the script inspects the image's OS and architecture, pins the returned immutable image ID, then [creates a stopped container](https://docs.docker.com/reference/cli/docker/container/create/) with image pulling disabled. It copies `/usr/local/share/licenses/retrieval-kernel/.` into its own temporary directory and compares the bytes. It never starts or executes the App. It removes only the container ID positively returned by its own create command, including that container's anonymous volumes. If creation is unconfirmed, it fails and reports the unique scratch name for inspection rather than deleting an unverified object or retrying creation automatically. No existing deployment container or service is selected.

Exit 0 and the final JSON report occur only after both platform checks and scratch-container cleanup succeed. The report retains both platform/image IDs, verified file counts, a digest of the expected notice-file hashes, and the source Cargo lock digest. Retain that output with the exact source commit and candidate image references in CI evidence. Missing tools, failed commands, timeouts, cleanup failure, or either platform's mismatch return nonzero without an overall success report.

Preparation self-checks cover matching and damaged notice trees, both required platforms, wrong platform/identity rejection, immutable-image selection, failure and timeout cleanup, and rejection of a partial success report. They are unit/harness evidence only. Real Docker extraction on the two candidate App images has not yet run; its result must be retained before this instrument supplies #249 image evidence. The script verifies notice distribution and image platform metadata, not the native executable's behavior or release promotion eligibility.
