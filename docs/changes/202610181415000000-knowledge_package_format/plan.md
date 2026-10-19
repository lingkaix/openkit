---
type: change-plan
status: in-progress
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

The first builder public round trip and complete format module pass 11 cases; Native typecheck passes. The final affected gate, generated contracts and fresh review remain pending. Exact commands, RED and builder logs are in backlog `evidence/L-AW/knowledge-roundtrip/`; the final landing note must name the reviewed source, deciding gate and main SHA. Historical failed logs remain evidence. No branch CI, deployment or reset is authorized or performed.
