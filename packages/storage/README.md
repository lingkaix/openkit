# Storage (`@openkit/storage`)

Storage locates bytes and enforces the caller's current admitted access. It does not own Sources, Artifact versions, Knowledge, Policy, publication, retrieval or media processing. The accepted owner is [File Storage And Knowledge Packages](../../docs/specs/20261018-file_storage_and_knowledge_packages.md).

## Contract

`StorageService` uses asynchronous JSON requests and responses. Byte chunks use base64; temporary staging uses opaque handles. No native file handle, callback or shared mutable object crosses the service contract. `ContentReference` comes from `@openkit/protocol`; do not create another descriptor or URI codec.

`LocalStorage` accepts configured mount roots and a staging root. The trusted NanoCore caller supplies a fresh `StorageAccess` projection of its existing Policy decision on every operation, including revocation and expiry. This projection is not a new grant, grant issuer or retained lease store. Do not expose the backend directly to an untrusted client. Roots, grants and owner publication remain outside this package. Configure physical roots without symlink components. The local backend pins directory traversal through an OS descriptor namespace; platforms without that primitive return unavailable/unsupported instead of falling back to mutable pathname traversal.

`stat` observes original identity and sniffed media. `read` verifies the entire original against captured digest and size with bounded memory before returning a bounded requested byte chunk; it does not retain an original for replay. Missing or changed originals return unavailable. Only whole-source and byte-coordinate references support raw reads; page, time and frame conversion belongs to Derivation.

`scan` examines at most the requested number of directory entries per call. A name filter can therefore return an empty page with a continuation. A changed directory or unusable cursor requires a new scan. Stateless continuation seeks at most 65,536 prior entries; a cursor beyond that capacity explicitly requires a rescan and cannot establish complete discovery of a larger directory. This is shallow metadata discovery, not a recursive index or durable change feed.

Staging uses `beginStage`, repeated bounded `writeStage` calls and `finishStage`. The owner consumes sealed bytes through `readStage`, performs its own Source or Artifact publication, then calls `discardStage`. Storage never writes the destination original. Handles are temporary and expire with the admitted access; a process restart invalidates them. The caller owns cleanup of its dedicated staging directory after restart, when no live process uses it. `close` removes this instance's remaining temporary stages.

## Commands

- `pnpm --filter @openkit/storage... build`
- `pnpm --filter @openkit/storage test`
- `pnpm --filter @openkit/storage test:coverage`
- `pnpm --filter @openkit/storage typecheck`
- `pnpm --filter @openkit/storage lint`

Tests use disposable local directories and the real Protocol reference schema. Shared workspace discovery includes this package in build, static, test and coverage gates. No Core consumer is switched by this package landing. Remote storage, the S3 facade and Derivation are excluded.
