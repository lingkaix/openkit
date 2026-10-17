# Large-context fixture preparation

This corpus freezes byte inputs and expected observations before P17 production implementation. It is preparation evidence only. The root test verifies fixture integrity, ZIP fields at frozen offsets, UTF-8 ranges, and arithmetic. It does not exercise upload admission, storage, authorization, extraction, provider routing, model admission, or output metering. Its green result cannot qualify those behaviors.

## Provenance

Expected observations come from accepted owners at commit `254648075222463bccbee7f7ef9db71c5c38d7bd` on `rc8/large-context-owners`, not production constants, helpers, or implementation diffs:

- [Large Files And Model Context](https://github.com/lingkaix/openkit/blob/254648075222463bccbee7f7ef9db71c5c38d7bd/docs/decisions/20261015-large_files_and_model_context.md): Raw Model Output; File Storage And Transfer; Model Context And Exact Reads; Per-Turn Snapshot And Disclosure.
- [Work Resource Interaction](https://github.com/lingkaix/openkit/blob/254648075222463bccbee7f7ef9db71c5c38d7bd/docs/specs/20260713-work_resource_interaction_model.md): Artifact and Item lineage; File Admission, Publication, And Download; Bounded Media Processors.
- [Worker Turn Reliability](https://github.com/lingkaix/openkit/blob/254648075222463bccbee7f7ef9db71c5c38d7bd/docs/specs/20260531-worker_turn_reliability_envelope.md): Worker Raw-Output Accounting.
- [Context Package](https://github.com/lingkaix/openkit/blob/254648075222463bccbee7f7ef9db71c5c38d7bd/docs/specs/20260703-worker_context_package.md): Personal Scope Projection; Selection Pipeline; bounded representation and replay requirements.
- [Retrieval Kernel](https://github.com/lingkaix/openkit/blob/254648075222463bccbee7f7ef9db71c5c38d7bd/docs/specs/20261014-retrieval_kernel.md): source ownership, scope filtering before ranking, representation coverage and failure semantics.

The engineer's #190 ruling and delegation are in `/home/simonx/AI/temp/backlog-20261015/engineer-rulings-20261015.md`. Independent corrections and the required scenario additions are in `/home/simonx/AI/temp/research/2026-10-15-large-context/consultant.md`. Consultant corrections govern the synthesis. Planning files in `/home/simonx/AI/temp/backlog-20261015/large-context-impl/` supplied context, not authority. Accepted owner text must be read at the pinned commit when the local implementation branch has not integrated it.

Small originals were specified as literal byte patterns. Their SHA-256 values were computed once with Python's standard `hashlib`, independently of the Node fixture functions. ZIP bytes were generated once with Python's standard `zipfile`, fixed timestamps, Unix mode fields, and no extraction. Truncation removes seven end-record bytes. The CRC fault changes both stored CRC fields to zero. The size fault changes both advertised expanded sizes to one while retaining nine actual body bytes. `cases.json` retains frozen base64 bytes, sizes, SHA-256 values, body digests, and exact local/central offsets. Node's built-in SHA-256, CRC-32 and bounded raw inflation check those bytes. Compression output is frozen; regeneration with another zlib version is not required.

## Run

Run from the repository root with the existing pinned Node installation. No install, service, network, container, provider, or archive extraction is required.

```bash
export PATH=/home/simonx/.local/share/mise/installs/node/24.18.0/bin:$PATH
/home/simonx/AI/temp/backlog-20261015/bin/run-slot.sh node --test --test-concurrency=1 tests/large-context-fixtures.test.mjs
```

The deliberate negative control flips one original byte and uses the same SHA-256 comparison as the positive check. The test must observe that mismatch. Invalid UTF-8 also must fail strict decoding, and replacing its bytes through text decoding must change its digest. These checks prove that the fixture oracle can detect byte damage. They are not production failure tests.

## Consume

Import `cases`, `originalBytes`, `archiveBytes`, `streamChunks`, and `archiveEntryDescriptions` from `corpus.mjs`. Byte-returning helpers return fresh buffers. All data is invented and contains no credentials or real private source data. Keep hostile archive bytes inert until a later test passes them to the real isolated archive owner. Never extract them with a generic host command or into a source directory.

The small originals cover empty content, NUL and invalid UTF-8, a 54,000-byte CJK single line, a 120,000-byte ASCII line, and 2,001 short lines. Identity is over original bytes. The base64 round trip in the integrity check is only a byte round trip; it is not an upload/download or durable replay proof.

File recipes produce zero-filled streams at 999,999,999, 1,000,000,000 and 1,000,000,001 bytes. Every yielded buffer is at most 65,536 bytes. A consumer can pipe the full generator to its real streaming interface; it must not collect that stream into an array or concatenate it. The default check samples only two 65,537-byte ranges per recipe. No full large-stream digest or gigabyte execution is claimed. Combined submission cases independently exercise the sum of 400,000,000 and 600,000,000 or 600,000,001 bytes. Worker file admission applies the per-file bound; the two independent 1,000,000,000-byte files remain individually within that bound even though their total is 2,000,000,000 bytes. Repeated accepted files do not create a cumulative Turn file quota. The shared-reserve recipe separately includes the server reserve, existing in-flight writes, staging, extraction, derivatives and publication overlap; each contender fits alone but both do not fit together.

Archive entry recipes describe actual-output counts without allocating bodies. They reach one below, at, and one above 4,000,000,000 expanded bytes and 100,000 entries. `explicit-nested-shared` sums two depths into one over-limit total. These descriptors are not valid large ZIP files. Future consumers must connect them to a real stream or build a bounded archive for the real extractor. Small actual ZIPs cover valid empty/file/compressed archives, nesting, traversal, Unix and Windows absolute names, symlinks, a FIFO, normalized path collision, truncation, bad CRC, and forged size. The compressed example expands to only 4,096 bytes in memory. Frozen offsets permit integrity inspection without implementing an admission parser.

`scenarios` freezes later consumer expectations as prose and example transcripts. The raw transcript distinguishes trusted attempts, content-part identity and byte position, duplicate snapshots, reconnect replay, equal text on a new attempt, failed-attempt output, mechanical forwarding, generated summaries and exposed reasoning. Its 23-byte arithmetic is fixture consistency only. The parallel example starts five bytes below the shared 16,777,216-byte ceiling and observes two three-byte emissions. Either child can win; real atomic storage must prevent both from proceeding within the bound and must preserve truthful observed output and stop semantics. This file contains no counter, deduplication engine or fake race test.

Context ranges use zero-based, half-open UTF-8 byte offsets. They preserve character boundaries, advance within huge single lines, and reach the exact end. The supplied direct-text ranges bind `fixture-revision-1` and `canonical-utf8`; consumers must also bind the source digest. The fixture selects maximal complete-code-point prefixes for these examples. It does not require that every production preview fill its capacity. Privacy examples freeze identical visible source IDs and counts before and after adding a hidden source, forbidden disclosure markers, an authorized local snapshot, revoked subsequent operations and refused old-mount reuse by the next Turn. Privacy and failure scenarios require real checks of generation/ranking inputs, access revocation, absent private metadata, unavailable representations and no full-body fallback. Checking the scenario's expected words cannot prove those behaviors.

## Evidence boundary and remaining qualification

The expected current-main failures are not yet executed: text-only and non-empty Artifact admission cannot preserve empty or arbitrary binary originals; a published-file 16 MiB aggregate would reject an otherwise admitted large file; missing real range/representation and raw-meter seams cannot prove bounded context or shared emission accounting. These are hypotheses from the inspected planning baseline, not observed red production results. No production implementation diff was read to derive this corpus.

The deciding integrity oracle is prior to the production candidate, finite, deterministic for the frozen bytes, and cheap to rerun. Its sufficiency ends at the fixture boundary. Independent review must still inspect these bytes, source clauses and test assertions. The following require later real qualification: exact immutable upload/download and receipt replay, combined upload admission, streamed-byte and actual-entry enforcement against lying headers, isolated extraction and bounded CPU/memory/disk, concurrent reserve admission, real SQLite race/restart/recovery, every supported inference and child route, cancellation and incomplete argument prevention, provider-visible request and token bounds, current authorization and destination disclosure, and parser/processor failure without full-body fallback. PDF and vision processor fixtures and resource measurements are outside this preparation slice.
