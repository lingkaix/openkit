---
type: change-plan
status: blocked
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

The branch normally merges L-ID's shared Protocol schema preparation as a dependency. That stack contains reset-dependent work and cannot land before its owner and coordinator release it. Merge main after that dependency lands and recompute the actual Storage delta. No landing window, branch CI, host or reset action has occurred.

The independent scaffold run collected33 tests and failed29 at the expected unsupported responses; its earlier offline metadata failure was setup-only. Package-manager resolution then supplied the new Storage importer. A fresh independent Sol found a parent-path mutation defect; pinned no-follow traversal and a disposable-fixture refusal regression corrected it. Source280ad1ed and the subsequent inventory-only heads are independently approved. Complete Protocol/Storage build and Storage coverage passed34/34, with92.05% lines,80.67% branches and100% functions. All33 cases in the complete release-tests, release-shards and Vitest temporary-directory families passed after updating their package-owner cardinalities; exact-owner and distinct-report assertions remain.

The repository gate passed check:repo, all15 lint tasks and16 of17 typecheck tasks, including Storage. Its only failure is the unupdated importedWorkspaceNotebookReferences call in Core lib/store.ts:1468, where the L-ID dependency now requires files plus scopeId. This file has no authored Storage delta. The dependency branch still contains that call; L-AW has not changed its owner's path. No complete repository-gate pass is claimed. Next: join the owning correction, rerun the required gate, preserve source approval through clean joins, then express after the dependency reaches main and the coordinator releases reset-dependent landing.

The authored increment changes15 files, including one governing specification's implementation projection and two shared test-inventory fixtures. It adds one transient eight-operation service contract, not a retained registry, entity, grant or publication authority. Context and Knowledge consumer adoption remain later increments.
