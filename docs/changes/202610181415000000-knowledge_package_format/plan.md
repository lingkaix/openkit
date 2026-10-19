---
type: change-plan
status: completed
date: "2026-10-18"
---
# Knowledge Package v1 Format

## Intent Revision 1

Coordinator instruction at 14:00Z on 2026-10-18: implement the shape-bearing Knowledge package v1 format on a branch separate from Storage and Context, using the canonical Knowledge Base layout, shared retained-v1 marker, writer, validator and deterministic fixtures. Export/import round-trip integration waits for L-AK's Source cutover. Reset-dependent landing requires the coordinator's pre-reset cut announcement. L-ID owns the inherited canonical page-URI consumer; this increment does not repair it.

## Intent Revision 2

Coordinator approval on 2026-10-19 activates the minimal Workspace export/import round trip after L-AK Source cutover landed on main `2d7e04bed`. Reuse the prepared final format with one marker, independent test-author RED before builder, a fresh Sol review and affected suites plus Native typecheck, then direct-main fix-forward. No Web, history selection, remote activation, derivative export, converter, extra store or receipt family is included.

## Authority And Scope

The [file-storage and Knowledge package specification](../../specs/20261018-file_storage_and_knowledge_packages.md#knowledge-package-format) owns layout, references, mount declarations, integrity, remapping and publication. Protocol owns identities, references and the retained-v1 helper. The implementation activates the same format through two native streaming operations, shared Source reminting and the existing human Notebook/Audit/command publisher. It adds no product authority or retained attachment family.

## Verification Plan

Independent format fixtures freeze page/schema bytes, a binary original and deterministic manifest output. Independent public regression author `knowledge_package_roundtrip_test_author` commits actual RED `0fd9cd2cd` on landed Source main: valid current Notebook, configured default mount and real binary/text Source setup reach missing public export 404. The builder preserves its exact-byte, distinct reminted Source, target seed/fixed-KB, dependent page pin and tamper-before-publication assertions. Run complete package, Knowledge and Storage owner directories, affected public/catalog/generated checks, shared API suites and Native typecheck through bounded slots, then fresh source review. No scale campaign or real-host action is required.

## Current Checkpoint

The format and minimal public Workspace round trip are implemented. Independent author RED `0fd9cd2cd` reaches export 404 after real Source capture and Notebook setup; the original exact-byte, remint, fixed-KB, dependent-pin and tamper assertions remain unchanged. Fresh review `00d6d3710` qualified replay, Markdown literal preservation and streaming Source disclosure defects; canonical RED `7601bfe10` precedes their corrections. The final implementation reuses the existing receipt publisher, remaps parser-identified destination spans and checks current Source/page disclosure before every bounded archive chunk. Tar framing is coalesced within the existing 64 KiB bound; the 30-second test budget is unchanged. The CLI explicitly excludes the two HTTP-only streams through its existing owner-backed catalog disposition.

Affected Native directories initially passed 1,561 cases with three failures: the original round-trip timing, the operation registration fixture and L-AK's Source-root history fixture. The corrected complete files passed all 49 cases, including the main-owned history repair; unchanged passing cases carry forward. Final complete package/public qualification passes 13 cases; all 101 CLI cases, Native typecheck/build, repository checks and canonical generation pass. The shared App API suite passes 463 cases and Core Client passes 119. All raw failed logs and the exact gate commands remain in backlog `evidence/L-AW/knowledge-roundtrip/`, including `builder-affected-gate.log`, `builder-final-gate.log` and `builder-qualification-gate.log`. The fresh independent review is `reviews/L-AW-knowledge-package-roundtrip.md`; the external landing note records the exact main SHA. No Web, deployment, reset or branch CI action was performed.
