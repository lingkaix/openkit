# Retrieval Kernel

This app implements the kernel portion of the accepted [Retrieval Kernel specification](../../docs/specs/20261014-retrieval_kernel.md). One Rust executable owns scope-local BM25, canonical literal and line-regex scans, segmentation, immutable identity sidecars, publication, and recovery. NanoCore supervision, product admission and adapters, owner amendments, and release packaging belong to R2. The Rust library is the executable's implementation and test boundary; NanoCore consumes the service face.

## Build and checks

The app-local `mise.toml` pins Rust 1.97.1, as NanoHost does. Run bare Cargo from this directory with mise shims on PATH. The root Cargo workspace contains this app and excludes the independent NanoHost crate and lockfile. Package scripts expose the repository's build, test, lint, and format tasks. R2 must add the empty `apps/retrieval-kernel` importer to `pnpm-lock.yaml` when root pnpm integration is authorized; that path is outside R1's write boundary.

```bash
export PATH="$HOME/.local/share/mise/shims:$PATH"
export LINDERA_BUILD_DICTIONARY_CACHE_DIR=/tmp/openkit-lindera-cache
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
cargo build --release --target aarch64-unknown-linux-gnu
```

The Linux arm64 build needs its Rust standard library and a target C compiler/linker, including a `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER` selection where the host requires one. R1 adds no installer, CI workflow, image, or target artifact to Git. The source uses Unix descriptor confinement and file locks. Linux amd64 is measured here; arm64 and macOS platform qualification belongs to R2.

### Dictionary supply

Tantivy is pinned to 0.26.2; tantivy-jieba to 0.21.0; Lindera and lindera-tantivy to 5.0.1. The lockfile resolves lindera-ipadic and lindera-dictionary to 5.3.0. Jieba and IPADIC are embedded in the executable. Runtime does not fetch dictionaries, read an ambient Lindera configuration, or call inference. The index identity binds the full Cargo lockfile digest, explicit schema/chunk/scoring/normalization settings, processor identity, and the dictionary source digest.

The Lindera build script fetches **one build dependency** from `https://Lindera.dev/mecab-ipadic-2.7.0-20250920.tar.gz`, version **mecab-ipadic 2.7.0-20250920**. Its SHA-256 is **`a7ba9f645ffe7094e56ae1c4a81d100df8fbb1e28bbe1792622e9728e162db3d`**. Lindera verifies MD5 **`a95c409f12f1023fce8ef91f991ef042`** itself; it does **not** verify SHA-256. The recorded SHA-256 was independently computed over the downloaded archive.

Set `LINDERA_BUILD_DICTIONARY_CACHE_DIR` outside the repository. The pinned build uses `<cache>/5.3.0-fmt2/`, retains the archive and built dictionary there, and reuses them. This run used `/tmp/openkit-lindera-cache`. CI and the App image build must cache or vendor this archive, verify the recorded SHA-256, and keep the supported configuration fixed. `cargo --offline` controls Cargo registry access; a cold Lindera cache still causes its build script to use the network. No archive or expanded dictionary is committed.

The repository has no central third-party notice directory. R2 packaging must ship the archive's full `COPYING` notice, including the 2000–2003 Nara Institute of Science and Technology copyright and the ICOT redistribution and no-warranty conditions, with the executable. R2 must also retain the Jieba and Rust dependency license notices. Local builds do not constitute release packaging.

## Directory CLI and MCP

```bash
retrieval-kernel index
retrieval-kernel index /selected/directory
retrieval-kernel search lexical '测试 修复'
retrieval-kernel search exact 'literal text' /selected/directory --limit 20
retrieval-kernel search regex '^pattern' /selected/directory
retrieval-kernel mcp /selected/directory
retrieval-kernel --version
```

`index` reconciles the complete current inventory and publishes a replacement scope generation. Repeating an identical healthy inventory is a no-op. Updates, removals, and repair use this same operation. A search requires a prepared index. The directory defaults to the current directory; the derived store defaults to `<directory>/.retrieval-kernel`. `--store PATH` selects a separate caller-owned derived directory. This local default assigns no product storage path.

The directory adapter includes dotfiles and ignores no Git rules. It visits regular files through held directory descriptors, refuses symlinks, skips its own derived store, and computes SHA-256 incrementally. Full-stream UTF-8 validity and NUL detection select direct text or an identity-only sidecar; no format parser runs. It checks file metadata during reads and reconciles again after a query. Changed hits are withheld and coverage becomes incomplete. `complete` describes the enumerated units and observed fixed reads; it does not claim a filesystem snapshot.

A directory whose complete inventory cannot be enumerated or digested fails with `unavailable` before generation access. In particular, a newly inaccessible file has no verified digest: R1 does not fabricate an empty-body digest. Per-file generic coverage for that missing-identity case needs the specification owner to define an unavailable inventory entry. Known-identity unavailable sources are supported by the service and recorded as failed text. This is an open finding for review.

MCP uses newline-delimited JSON-RPC 2.0 over stdio. It negotiates 2024-11-05, 2025-03-26, or 2025-06-18, exposes only the `search` tool, and has no write or index tool. Arguments are exactly `{mode,query,limit}`; additional arguments fail. The root and derived store are fixed at launch, so a model cannot supply a path or scope. CLI and MCP use the same directory query operation. Prepare or rebuild with `index` outside the MCP tool. No Sandbox face is installed by R1.

## Trusted local service contract, version 1

Launch `retrieval-kernel service --sources ROOT --store STORE`. ROOT is a trusted startup admission boundary for canonical regular files; STORE is the storage owner's private derived boundary. Requests cannot use absolute paths, parent traversal, or symlink components. The service is sequential, listens on no socket, and reads one JSON request per LF-delimited stdin frame. Stdout contains one JSON reply per frame. Errors are bounded and contain no query or source text. R2 must admit complete scope generations under current source and destination authorization before sending requests; the kernel cannot detect an authorization grant in a scope name.

The envelope requires `version:1`, a numeric or bounded string `id`, and one closed `op`. Unknown additive members are ignored. Unknown operations, versions, modes, language categories, content kinds, or persisted text statuses fail closed. The wire has no independent compatibility promise. An output-changing mechanism change updates its index identity and requires a rebuild; canonical bytes remain with their owners.

| Operation | Exact request members | Success `result` |
| --- | --- | --- |
| `publish` | `{version:1,id,op:"publish",view,expected_generation:null|string}` | `{generation:string}` |
| `search` | `{version:1,id,op:"search",request:{mode,query,scopes:[view],limit}}` | Search result below |
| `inspect` | `{version:1,id,op:"inspect",scope:string}` | `{generation:null|string}` |

`view` is `{scope:string,documents:[Document]}`. Each scope is an exact opaque eligibility partition, not a grant. There is no global registry or search-all default. `scopes:[]` reads no generation or canonical content. A missing scope set fails. A missing `expected_generation` fails; initial publication uses explicit null. An update must name the inspected current generation. One writer holds the scope lock through publication. A changed pointer, active writer, or contradictory canonical identity at the same revision returns `conflict`. Transport paths or byte ranges can move without changing the logical source identity. A scope move remains two independent scope publications.

Document core fields are `{key:{namespace,id},revision,digest,size,name,media_type,content}`. `digest` is a verified lowercase canonical SHA-256, supplied by the adapter. `size` is the source unit's byte count. Optional fields are `title` (default empty), `language` (absent or `zh|ja|unicode`), `metadata` (string-to-string map, default empty), and `locator` (opaque original coordinate or null). A revision includes canonical metadata changes. Transport form and availability can change without changing that canonical revision. Two adapters retain distinct keys for identical bytes.

| Content | Input meaning |
| --- | --- |
| `{kind:"text",path:string,range?:{start:u64,end:u64}}` | One admitted canonical UTF-8 unit. Path is root-relative. An optional range is half-open, must match `size`, and confines all hashing, indexing, and scans to that unit. This supports one Item inside a canonical JSONL log without copying or joining Items. Returned text offsets are relative to the unit. |
| `{kind:"inline-text",text:string}` | Bounded canonical UTF-8 supplied by the trusted adapter, including decoded text from an Item JSON field. Required in publish and every current search view. Its bytes and metadata must fit the 8 MiB frame/inventory ceiling. The payload is request-local and is omitted from the committed manifest; exact and regex scan the supplied current text. Text offsets refer to that UTF-8 unit, with `locator` identifying its original source coordinate. Large retained files use the file-stream form. |
| `{kind:"unreadable"}` | Identity metadata only. The kernel leaves the body unopened and creates a sidecar from the supplied verified identity. Missing digest fails admission. |
| `{kind:"unavailable"}` | The adapter knows the fixed canonical identity, but its representation is unavailable. The generation records failed text and queries are incomplete. |

Without a hint, kana in body or canonical title selects Japanese, Han without kana selects Chinese, and other text selects Unicode words. Title, body, sidecar, and query use matching analyzers and lowercase Latin normalization. Each Document uses one dictionary tokenizer. One shared word filter excludes punctuation-only tokens, retains identifiers with internal punctuation, and bounds normalized tokens to 48 KiB for indexing and analysis. The gram field nominates missed CJK candidates; a source-unit literal check is required before a gram score is admitted. There is no lexical query parser. BM25 uses one scope's tombstone-free statistics, title boost 2, maximum chunk score, and verified fallback boosts 0.1 for body and 0.2 for title. Each gram candidate is checked against that Document's selected query settings. Combined lexical order is descending score, source key, chunk ordinal, then scope as a final deterministic tie.

`exact` preserves bytes, Unicode, whitespace, case, and line endings and emits overlapping literal occurrences. `regex` uses Rust regex syntax through the grep crates. Each LF-delimited line excludes LF and retains CR. BOM sniffing and transcoding are disabled. Backreferences, lookaround, explicit LF literals even in classes, zero-length matches, and oversized regex programs fail before source access. Scan order is source key, representation, metadata field, offset, then scope. Limits are applied after scope merge.

Success replies are `{version:1,id,result}`. Failure replies are `{version:1,id,error:{code,message}}`. Codes are `invalid-request`, `conflict`, `unavailable`, `resource-limited`, and `io`. A process terminated during publication yields no acknowledgement; R2 must restart, inspect the pointer, and re-enumerate current truth before a new request. It must not replay a canonical write. EOF exits cleanly. Cancellation by process termination releases OS reader/writer locks; the next successful scoped operation removes abandoned staging.

A search result is `{generations:{scope:generation},mode,hits:[Hit],coverage,complete}`. A Hit has `{key,scope,revision,digest,representation,representation_digest,processor,locator,chunk,score,snippet,provenance}`. Representation is `text` or `sidecar`; processor is null or `identity-markdown-v1`; score is null for scans. Locators are `{kind:"text",start,end,original}`, `{kind:"title",start,end,original}`, or `{kind:"metadata",field,start,end}`. Title offsets refer to the supplied canonical title, text offsets to the canonical unit, and metadata offsets to the committed Markdown representation. Metadata offsets never claim binary-body coordinates.

Coverage has `admitted_objects`, `searched_representations`, `stale_revisions`, `stopped_work`, `unsupported_bodies`, `inventory_complete`, `representations_complete`, `matches_complete`, `reasons`, `omitted_matches`, `matching_documents`, and `enumeration_complete`. Counts come only from named committed inventories. Reasons aggregate stopped work without private identities. `complete` is the conjunction of the three completeness flags. Binary bodies remain explicitly unsearched while valid sidecar search can be complete. Changed canonical identities are withheld. A complete empty sidecar result says nothing about the binary body.

Lexical `matches_complete` certifies the requested top-k, not all matching Documents. `matching_documents` reports verified matches before the response limit; `enumeration_complete` is true only for a fresh lexical result that returns every match. **R2's governed adapter must require both `complete` and `enumeration_complete` before dispositioning a full selection.** It can request up to 1000 matches and must use its owning typed failure if enumeration exceeds that bound. R1 adds no durable cursor or second selection engine.

## Publication, sidecars, and bounds

A scope uses `STORE/SHA256(scope)/CURRENT`, immutable generation directories named by manifest digest, and private scope/reader locks. The Tantivy commit payload pins the manifest generation hash, so foreign valid engine files cannot be mixed with that tuple. The manifest binds canonical inventory, statuses, selected languages, source and representation identities, and sidecar references. Canonical text is indexed but is not stored as another scan-text body. Adapter text is stripped from the stored Document identity; it must be supplied again from current canonical truth for search. Sidecar files live inside the same immutable generation tuple. Their cache identity binds source key, source digest, metadata revision, processor, and exact Markdown digest. Fields have sorted escaped headings and fenced JSON string values; each value is a separate searchable unit. Optional canonical titles and supplied metadata are retained.

Publication builds a fresh index, disables merges to avoid duplicate temporary segment growth, flushes all tuple members, then atomically replaces and synchronizes CURRENT. It acknowledges only after pointer durability. It creates no tombstones. Queries pin a generation with a reader lock; writer cleanup cannot remove a pinned generation. Valid sidecars are hard-linked into a new generation without processing again. Metadata or digest changes create replacement identities. Missing or corrupt sidecars are rebuilt or reported incomplete; wrong machinery requires a rebuild. Query completion and publication remove unreferenced retired generations. Stopped work retains an unchanged verified identity sidecar with incomplete coverage.

A crash before pointer publication leaves the old tuple authoritative. A crash after publication leaves the new tuple authoritative. Staging is never queried. A corrupt or unreadable pointer fails explicitly; recovery does not guess a current generation from directory names. Dispose such derived storage only under its storage owner's existing authority, then rebuild from canonical input.

| Bound | Fixed ceiling |
| --- | --- |
| Normalized token | 48 KiB |
| Index chunk / read buffer | 16 KiB, no overlap, UTF-8 boundaries, prefer LF |
| Regex line / scanner heap | 64 KiB |
| Query / title / name | 4096 UTF-8 bytes each |
| Regex compiled / DFA memory | 1 MiB each |
| Sidecar | 64 KiB |
| Snippet | 512 UTF-8 bytes |
| Metadata | 64 fields and 16 KiB total key/value bytes per Document |
| Inventory / stdio frame / reply | 8 MiB; hit payload reserves 4 MiB of the reply |
| Result / scope / per-scope object count | 1000 hits / 128 scopes / 10,000 objects |
| Directory depth / per-directory names | 64 / 10,000 |
| Tantivy writer | One thread, 32 MiB budget |
| Temporary generation | 512 MiB; conservative input reservation and actual byte checks before publication |
| Executable address space / file growth | 2 GiB / 512 MiB per file, or a stricter inherited limit |
| Kernel operation / inventory wall time | 60 seconds, checked per bounded read/chunk |
| Executable foreground CPU | 65 seconds above used process CPU per stdio request |

Bounds preserve canonical bytes. Cooperative stops yield partial or resource-limited coverage; malformed declared UTF-8 fails without replacement characters or a fabricated sidecar. OS exhaustion can terminate this separate executable. R2 must supervise it, bound the total store volume and whole RPC wall time, and inspect uncertain publication. These ceilings are implementation limits, not a deployment minimum. Fixture qualification is not a hostile-filesystem, power-loss, or maximum-upload certification.

## Verification and remaining qualification

Tests use actual Tantivy generations, packaged tokenizers, exhaustive independent scan oracles, source-open observations, real SIGKILL checkpoints, reader locks, real stdio faces, OS resource observations, and an OS file-growth failure. The allocation fixture indexes 48 MiB of ASCII UTF-8 with markers at both ends, observes every Rust allocation in an isolated subprocess, and fixes a 512 MiB RSS ceiling before the run. Its size is a fixture, not an upload admission limit.

The kernel tests and exact observed result lines are listed in the R1 handoff below. The wire supports canonical file units and bounded canonical adapter text; product adapters still own decoding, eligibility, revisions, and final response validation. Product eligibility, Knowledge answer sufficiency and dispositions, trace/redaction, NanoCore supervision, the admission owner's maximum upload, true volume ENOSPC, arm64/macOS resource qualification, license distribution, and App image supply remain R2 work. The directory missing-identity finding above needs owner review. No accepted specification was changed, and no other specification was judged wrong.

## R1 handoff evidence

Observed on Linux amd64 with Rust 1.97.1. `cargo fmt --check` exited 0. `cargo clippy --offline --all-targets --all-features -- -D warnings` exited 0 and reported `Finished dev profile [unoptimized + debuginfo]`. `cargo test --offline -- --nocapture` exited 0: `test result: ok. 31 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` for the library and `test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` for the real executable faces. `cargo build --offline --release` exited 0.

The stripped Linux amd64 executable is **58,661,192 bytes**. Release smokes reported `release CLI smoke: PASS (测试, 修复, 検索)` and `release MCP stdio smoke: PASS (initialize, exact 改善)`. The allocation fixture reported `allocation: file_bytes=50331673 maximum_single_allocation=4194304 peak_rss_kib=29856` against its fixed 512 MiB ceiling. This is a 48 MiB source plus markers, not an admission-owner maximum.

`cargo build --offline --target aarch64-unknown-linux-gnu` exited 101 with `error[E0463]: can't find crate for std` and `the aarch64-unknown-linux-gnu target may not be installed`. Only `x86_64-unknown-linux-gnu` is installed, and no `aarch64-linux-gnu-gcc` is present. No arm64 binary size is available; no target download was attempted outside the network grant.

The gram-verification regression was also observed to fail when its canonical literal check was temporarily removed: `test tests::empty_text_retains_title_and_gram_candidates_require_literal_verification ... FAILED`, at `assertion failed: absent.hits.is_empty()`. The source was restored before passing checks. The first CJK test commit observed `test tests::regression_222_segmentation ... FAILED` at `Chinese body term lost: []`; shipped-dictionary tests now pass.

This table maps the specification's kernel portions to exact observed test lines. Predicate 8's product integration and the product portions of predicates 1, 2, 6, 9, 10, and 11 remain with R2 and are not certified by this table.

| Predicate or kernel responsibility | Exact observed result line |
| --- | --- |
| 1: segmentation and body regression | `test tests::regression_222_segmentation ... ok` |
| 1: segmentation and body regression | `test tests::regression_222_body_retrieval_and_language_cases ... ok` |
| 1: segmentation and body regression | `test tests::title_preference_and_deterministic_ties ... ok` |
| 1: segmentation and body regression | `test tests::empty_body_uses_cjk_title_language ... ok` |
| 1: segmentation and body regression | `test tests::title_and_hangul_character_fallback ... ok` |
| 1: segmentation and body regression | `test tests::empty_text_retains_title_and_gram_candidates_require_literal_verification ... ok` |
| 2: scope filtering before opens and scores | `test tests::scope_isolation_before_open_and_scope_score_equality ... ok` |
| 2: scope filtering before opens and scores | `test tests::directory_query_validation_precedes_inventory_reads ... ok` |
| 3: rebuild and scope merge | `test tests::rebuild_equivalence_without_tombstones_and_deterministic_merge ... ok` |
| 4: exact and regex completeness | `test tests::exact_exhaustive_completeness_and_limits ... ok` |
| 4: exact and regex completeness | `test tests::regex_line_exhaustive_completeness_and_rejected_features ... ok` |
| 4: exact and regex completeness | `test tests::regex_explicit_lf_in_classes_is_rejected ... ok` |
| 4: exact and regex completeness | `test tests::regex_preserves_utf8_bom_and_canonical_offsets ... ok` |
| 4: exact and regex completeness | `test tests::scans_reach_low_bm25_documents_and_merge_before_limits ... ok` |
| 5: hostile bounds | `test tests::hostile_input_limits_cancellation_and_disk_failure ... ok` |
| 5: hostile bounds | `test tests::sidecar_and_output_byte_limits_are_explicit ... ok` |
| 6: bounded large-file indexing | `test tests::incremental_large_file_index_without_whole_file_allocation ... ok` |
| 6: bounded large-file indexing | `test tests::large_file_actual_allocations_and_peak_memory ... ok` |
| 7: lifecycle, status, recovery, and tuple identity | `test tests::crash_recovery_at_every_publication_boundary ... ok` |
| 7: lifecycle, status, recovery, and tuple identity | `test tests::stale_partial_failed_resource_limited_and_unsupported_statuses ... ok` |
| 7: lifecycle, status, recovery, and tuple identity | `test tests::writer_expected_generation_and_identity_conflicts_are_idempotent ... ok` |
| 7: lifecycle, status, recovery, and tuple identity | `test tests::committed_identity_and_posting_corruption_require_rebuild ... ok` |
| 7: lifecycle, status, recovery, and tuple identity | `test tests::engine_commit_payload_binds_the_scope_generation ... ok` |
| 7: lifecycle, status, recovery, and tuple identity | `test tests::directory_final_revision_check_withholds_changed_sidecars ... ok` |
| 8: kernel adapter boundary, not product integration | `test tests::canonical_source_units_do_not_join_items_or_copy_scan_text ... ok` |
| 8: kernel adapter boundary, not product integration | `test tests::adapter_text_is_direct_transient_and_verified ... ok` |
| 8: kernel adapter boundary, not product integration | `test tests::bounded_lexical_enumeration_reports_all_matches ... ok` |
| 9: direct text and identity discovery | `test tests::direct_text_without_sidecars_and_identity_sidecar_discovery ... ok` |
| 9: direct text and identity discovery | `test tests::directory_inventory_confinement_and_incremental_digests ... ok` |
| 11: sidecar lifecycle | `test tests::sidecar_cache_lifecycle_and_reader_pins ... ok` |
| 11: sidecar lifecycle | `test tests::stopped_rebuild_keeps_valid_identity_sidecar_discovery ... ok` |
| 5: OS ceilings | `test executable_process_resource_limits ... ok` |
| 5/7: OS file-growth failure | `test filesystem_growth_failure_preserves_last_commit ... ok` |
| 10: CLI face | `test cli_smoke_current_and_named_directory ... ok` |
| 10: MCP face and confinement | `test mcp_stdio_smoke_and_startup_root_confinement ... ok` |
| 10: service and restart revocation | `test local_service_contract_smoke_and_revocation_after_restart ... ok` |
| 8/10: canonical adapter text over service | `test local_service_adapter_text_round_trip ... ok` |
