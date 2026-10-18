---
type: change-plan
status: in-progress
date: "2026-10-18"
---
# Local Storage Package

## Intent Revision 1

Source: the coordinator's GO for the three rc.11 increments, starting with Storage package, local backend, shared references and unavailable results. Build a process-agnostic contract under packages/ with a local backend only. No S3, remote backend, facade, Derivation or apps/web changes. Later Context adoption waits for L-ID's lease release; Knowledge package round trip waits for L-AK's Source cutover. Additive changes can land normally; reset-dependent changes wait for the coordinator's rc.10 cut announcement.

## Owners And Boundaries

The accepted [File Storage And Knowledge Packages](../../specs/20261018-file_storage_and_knowledge_packages.md) mechanism owns this package. [Core Protocol](../../core/protocol.md) and its shared ContentReference schema own the citable descriptor and URI codec. Storage imports that schema instead of creating another descriptor. Existing Policy decisions provide current scope, Knowledge Base, mount, prefix, mode and expiry; the transient service access projection creates no retained grant family. Existing Source and Artifact owners retain publication and retention authority.

Owned paths are packages/storage/, packages/README.md, the package-manager lock update, the implementation projection in the existing mechanism, this change record and its generated index. The out-of-area integrations are the package-count fixtures in tests/release-tests.test.mjs and tests/release-shards.test.mjs. No Context lease path, Knowledge record, runtime, host, reset or backup implementation changes.

## Method And Acceptance

The async interface uses serializable control and bounded base64 chunks with temporary opaque staging handles. Local roots provide exact stat/read, shallow metadata continuation and staged owner handoff. Full captured digest and size are verified before original chunks are disclosed. Missing or changed content is unavailable without substitution or a replay copy. Staging leaves destination originals unchanged; owning publishers consume sealed chunks and admit publication separately. No native resource or shared mutable object crosses the service contract.

An independent test author exercises real Protocol-to-Storage references, JSON boundaries, exact split bytes, unavailable identity, current access refusal, confined no-follow paths, bounded scans and isolated staging. Run the complete Storage suite and coverage plus shared release-owner/temp-fixture inventories, builds and the required static gate. A fresh independent Sol reviews the actual authored diff. No large-file or large-entry qualification campaign is included.

## Working Checkpoint

The branch normally merges L-ID's shared Protocol schema preparation as a dependency. That stack also contains reset-dependent L-ID work and cannot land before its owner and coordinator release it; after it reaches main, merge main and recompute the actual small Storage delta. The independent scaffold run collected33 tests and failed29 at the expected unsupported responses; the earlier offline metadata failure was setup-only. Exact pinned dependencies are now linked through pnpm with the new Storage importer. Independent review found a parent-path mutation defect; the correction pins each segment to an open directory handle, refuses symlinks and unsupported safe primitives, and rechecks the binding before disclosure. Its regression changes only a disposable fixture and asserts refusal. Source at280ad1ed is independently approved after a real temporary-filesystem refusal check. Complete Storage build and coverage passed34/34 tests, with92.05% lines and80.67% branches. The repository gate passed check:repo/lint and Storage typecheck, then stopped at the L-ID dependency's unupdated importedWorkspaceNotebookReferences call in Core lib/store.ts:1468. Shared inventory execution found one additional grouped-owner count fixture; both inventory fixtures now explicitly require Storage and their complete families will be rerun. No full gate pass or publication is claimed.
