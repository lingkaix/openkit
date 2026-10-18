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

Owned paths are packages/storage/, packages/README.md, the package-manager lock update, the implementation projection in the existing mechanism, this change record and its generated index. The only out-of-area integration is the repository release-test owner's package-count fixture. No Context lease path, Knowledge record, runtime, host, reset or backup implementation changes.

## Method And Acceptance

The async interface uses serializable control and bounded base64 chunks with temporary opaque staging handles. Local roots provide exact stat/read, shallow metadata continuation and staged owner handoff. Full captured digest and size are verified before original chunks are disclosed. Missing or changed content is unavailable without substitution or a replay copy. Staging leaves destination originals unchanged; owning publishers consume sealed chunks and admit publication separately. No native resource or shared mutable object crosses the service contract.

An independent test author exercises real Protocol-to-Storage references, JSON boundaries, exact split bytes, unavailable identity, current access refusal, confined no-follow paths, bounded scans and isolated staging. Run the complete Storage suite and coverage plus shared release-owner/temp-fixture inventories, builds and the required static gate. A fresh independent Sol reviews the actual authored diff. No large-file or large-entry qualification campaign is included.

## Working Checkpoint

The branch normally merges L-ID's shared Protocol schema preparation as a dependency. That stack also contains reset-dependent L-ID work and cannot land before its owner and coordinator release it; after it reaches main, merge main and recompute the actual small Storage delta. The initial scaffold is committed/pushed and the independent test branch is normally merged. Backend implementation is prepared; package-manager setup and semantic-red evidence are still queued through run-slot. No gate or behavior pass is claimed yet. Next observed change: the scaffold tests must fail at unsupported operation responses, then the complete implemented package must return exact bytes and the named refusal outcomes. No publication or host action has occurred.
