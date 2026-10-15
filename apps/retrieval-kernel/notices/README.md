# Retrieval Dependency Notices

This directory retains upstream license and notice files omitted from the locked crates.io archives. The engineer authorized only these read-only source-file fetches on 2026-10-15. `UPSTREAM.json` records each crate/version, exact source URL, recorded commit, and SHA-256. The image build verifies these bytes before copying them beside the notices and SPDX metadata supplied by Cargo packages.

`GAPS.json` records unresolved notice obligations for the shipped Linux dependency graph. It makes no license-completeness claim. The `htmlescape` and `kanaria` gaps remain relevant to both Linux targets. They require verified notices or dependency replacement before #249 can close. The two Windows import-library crates are excluded only by the target evidence below; their presence in `Cargo.lock` is not a Linux linkage obligation.

The full IPADIC notice and exact archived dictionary source are in the sibling `vendor/` directory. The executable embeds the dictionaries and needs no runtime network access. Do not rewrite upstream notice text.

## #249 Linux Dependency Evidence

The P08 first slice checked the locked graph on 2026-10-15 with Rust/Cargo 1.97.1. `containers/app/Dockerfile` builds the target-native executable for each Linux platform. `x86_64-unknown-linux-gnu` corresponds to `linux/amd64`; `aarch64-unknown-linux-gnu` corresponds to `linux/arm64`. This is dependency-graph evidence, not native arm64 image qualification.

| Input | SHA-256 |
| --- | --- |
| Root `Cargo.lock` | `396967ced6f5473ecd5b164075fa8ea654d01f8bbbd62d25d6c7654c1b8ebdb0` |
| Root `Cargo.toml` | `37df6268b46a4fe8934dcd4acdcc9a3fc4c9701acb9bad13e41dcfdd9d18692c` |
| `apps/retrieval-kernel/Cargo.toml` | `b6aaabe3fbc76d32b82be8334bb47dcaaf0e8f7d93bfd1ec5dfb8d83b5f75d00` |

From `apps/retrieval-kernel`, run each crate query for each target through the shared command slot, with `CARGO_BUILD_JOBS=1`:

```sh
cargo tree --locked --offline --target <target> -e normal -i <crate>@<version>
```

All eight commands exited 0. The following table records their complete path conclusions. A path starts at the queried crate and ends at `retrieval-kernel 0.1.0`.

| Crate query | Linux amd64 | Linux arm64 | Disposition |
| --- | --- | --- | --- |
| `htmlescape@0.3.1` | Via `tantivy 0.26.2`, directly and via `lindera-tantivy 5.0.1` | Same paths | Keep notice gap |
| `kanaria@0.2.0` | Via `lindera-analysis 5.0.1` and `lindera-tantivy 5.0.1` | Same path | Keep notice gap |
| `winapi-i686-pc-windows-gnu@0.4.0` | Empty stdout; `warning: nothing to print.` | Same result | Exclude from Linux notice obligation |
| `winapi-x86_64-pc-windows-gnu@0.4.0` | Empty stdout; `warning: nothing to print.` | Same result | Exclude from Linux notice obligation |

As a positive control, the same two Windows queries with `--target all` each exited 0 and returned a path through `winapi 0.3.9`, then `fs2 0.4.3` or `tantivy 0.26.2`, to `retrieval-kernel`. Thus, Cargo recognized both exact package queries; target filtering removed them on both shipped Linux targets. No dependency, lock entry, or supplied notice was removed. Recheck these conclusions when the graph or supported distribution targets change.

## Linked Crate Source Checks

Both published archives were fetched over HTTPS and checked against their existing `Cargo.lock` package checksums. Their complete file inventories contain no file whose name begins with `license`, `copying`, `notice`, or `unlicense`, without case sensitivity. Neither archive supplies a copyright notice in its Rust source. Package author metadata is not substituted for a copyright notice.

| Crate | Published source URL | Archive SHA-256 |
| --- | --- | --- |
| `htmlescape 0.3.1` | <https://static.crates.io/crates/htmlescape/htmlescape-0.3.1.crate> | `e9025058dae765dee5070ec375f591e2ba14638c63feff74f13805a72e523163` |
| `kanaria 0.2.0` | <https://static.crates.io/crates/kanaria/kanaria-0.2.0.crate> | `c0f9d9652540055ac4fded998a73aca97d965899077ab1212587437da44196ff` |

`htmlescape` has no `.cargo_vcs_info.json` in the published archive. Its manifest and all five files in `src/` were compared byte for byte with [upstream revision `1699b539179798e705ad8464128492a0a0092876`](https://github.com/veddan/rust-htmlescape/tree/1699b539179798e705ad8464128492a0a0092876) and matched. That revision's tree supplies no license or notice file. Its manifest declares `Apache-2.0 / MIT / MPL-2.0`, but that declaration is not the missing notice text. [Upstream PR #17](https://github.com/veddan/rust-htmlescape/pull/17), whose head is `64b1b9f4237697849a390434ea2b8c4bade05edf`, was open and unmerged when checked. It proposes license files from external templates. An unmerged contributor proposal does not establish the released crate's exact copyright notice, so no bytes from that proposal are admitted to `UPSTREAM.json`.

`kanaria` records revision `c994ccf06d179851a1c7c3285c3a408ccb6279ec` in the published archive's `.cargo_vcs_info.json`. Its manifest declares MIT. The [recorded revision's LICENSE URL](https://raw.githubusercontent.com/sam-osamu/com.kanaria/c994ccf06d179851a1c7c3285c3a408ccb6279ec/LICENSE) returned HTTP 404, and authenticated inspection of the recorded repository also returned 404. This establishes that the attempted sources were unavailable, not that no notice exists elsewhere. No copyright holder, year, or license text is inferred.

## Proposed Dependency Replacements

These are proposals for the next slice, not accepted patches or completed notice remediation. Keep both linked entries in `GAPS.json` until verified upstream bytes or a verified dependency change resolves them. P12 owns root manifest and `Cargo.lock` changes.

- For `htmlescape`, retain Tantivy and replace its HTML encoder dependency in a controlled Tantivy source patch. In `tantivy 0.26.2`, the crate is an unconditional dependency and its source consumer is `src/snippet/mod.rs`, which imports `encode_minimal`. A replacement must preserve that encoder's HTML escaping behavior, carry verified notices for any new dependency, and preserve OpenKit's retrieval predicates. Disabling default features does not remove this dependency. Coordinate any root Cargo patch and lock update with P12; do not replace the accepted search engine to remove one encoder.
- For `kanaria`, replace the `lindera-tantivy` adapter with a direct Tantivy tokenizer over the existing Lindera `Segmenter`. OpenKit constructs the current adapter with `from_segmenter` and adds its own lowercase and word filters; it does not configure the `lindera-analysis` kana conversion filter that imports `kanaria`. Remove `lindera-tantivy` and its `lindera-analysis` dependency only after equivalent token text, positions, offsets, Chinese/Japanese word lookup, and scope-filtered retrieval pass. Keep embedded IPADIC and its notice supply. Coordinate the lock update with P12.

Before either proposal can close its gap, rerun both target graphs and verify that the old crate is absent, verify the notices of every replacement dependency, and check exact packaged notice bytes. The main package README and shared packaging test remain reserved to the main-CI-fix builder until handback. Native arm64 image proof remains a separate release qualification task.
