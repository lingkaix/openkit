# Artifact File Storage

This directory owns admission and exact-byte payload operations for arbitrary-file Artifacts. The existing Artifact record, Item, Review and command receipt retain product authority. A private staged file does not prove acceptance.

`file-admission.ts` counts actual bytes against one upload submission or one Worker file and reserves staging, extraction, derivative and publication capacity against the current filesystem and server reserve. A reservation remains held until publication or proved cleanup. Existing on-disk staging reduces available capacity after restart.

`file-payload.ts` streams into the existing `workspaces/.staging` namespace without text conversion. It checks actual size and digest, applies backpressure and cancellation, synchronizes the completed payload and removes incomplete request files. The caller retains reservation ownership.

`file-records.ts` resolves version-owned paths, verifies originals with a bounded buffer and opens exact-version streams. It never substitutes another version or reconstructs original bytes from a text projection. The existing synchronous Store and boot owner use synchronous integrity verification; capture itself remains asynchronous and bounded in memory.

`worker-file-transfer.ts` defines the private stream boundary to the existing Worker file-effect owner. The adapter retains attempt, session, no-follow, replay and live-Turn checks. Credential scanning and product publication stay with Core.

Run `pnpm --filter @openkit/nanocore exec vitest run src/storage/artifacts --maxWorkers=1` through the backlog CPU slot helper. `file-contract.test.ts` verifies the integrated shared Artifact schema. Passing storage helper tests does not prove complete route, Worker, Web or release acceptance.

`zip-snapshot.ts` uses yauzl's lazy central-directory reader. It verifies actual expanded size and CRC, rejects unsafe paths and non-regular types, checks normalized collisions and bounds the entry inventory. A completed snapshot is still private staging. Explicit nested extraction shares its existing byte, entry, capacity and time budgets. Original archives are unchanged by extraction failure. Parser and resource defaults still require qualification before release.

`worker-credential-scan.ts` defines the generic bounded digest-window seam. Core selects original credential proof and uses the existing supervised retrieval service to scan private staged originals with overlap. The sidecar receives generic window lengths, encodings, digests and bounds only. Exact literal comparison remains in the streaming Core stage. Complete range coverage and an asynchronous complete-original digest check precede publication; failed or limited comparison never grants admission.

`../canonical-write-capacity.ts` applies this same admission owner to the existing synchronous canonical publication writer. It reserves exact serialized temporary or appended bytes plus filesystem overhead, including retained inline bodies, Knowledge pages and descriptive additions that are actually rewritten. Scope covers compensation and reference/event appends. It does not estimate immutable payloads or unrelated Git/derived bytes as copies. Request staging and receipt capacity remain held concurrently. A completed capture can shrink its unused maximum forecast to actual pending bytes; it cannot increase or reuse a released reservation. Later publication refusal retains the existing recovery semantics instead of promising an atomic file/receipt result.

`artifact-folder-cache.ts` publishes a complete disposable ZIP tree and inventory beneath the exact source version. It verifies the original and complete tree before reuse. Its private interface supplies verified paths and digests for existing Worker slots. `artifact.folder-extract` is explicit; `artifact.folder-read` pages at most 100 files. Both reuse current source authorization and the existing capacity owner. No extraction receipt or canonical folder record exists. Run `src/artifact-folder-routes.test.ts` and `src/storage/artifacts/artifact-folder-cache.test.ts` with the focused parser suite.
