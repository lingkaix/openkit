---
type: change-plan
status: in-progress
date: "2026-10-18"
---
# Knowledge Package v1 Format

## Intent Revision 1

Coordinator instruction at 14:00Z on 2026-10-18: implement the shape-bearing Knowledge package v1 format on a branch separate from Storage and Context, using the canonical Knowledge Base layout, shared retained-v1 marker, writer, validator and deterministic fixtures. Export/import round-trip integration waits for L-AK's Source cutover. Reset-dependent landing requires the coordinator's pre-reset cut announcement. L-ID owns the inherited canonical page-URI consumer; this increment does not repair it.

## Authority And Scope

The [file-storage and Knowledge package specification](../../specs/20261018-file_storage_and_knowledge_packages.md#knowledge-package-format) owns layout, references, mount declarations, manifest semantics, integrity and later publication. Protocol owns identities, references, ranges and the retained-v1 helper. This increment adds one Core Storage module and its guides; it adds no operation, Source record, representation registry, remote activation, Derivation, archive wrapper or live import/export publication.

## Verification Plan

An independent test author freezes authored page/schema bytes, a binary original and canonical manifest output before integration. Complete real-filesystem module regressions must show exact bytes and deterministic output, marker-before-decoder refusal, declared closure, bounded quotas, path/link refusal, reserved mount exclusion, truthful derivative lineage and fresh-output failure cleanup. No scale campaign is required. Run the complete module directory plus lint and typecheck, then obtain a fresh Sol review of the actual own diff. No producer report is acceptance evidence.

## Current Checkpoint

Implementation is in progress on `lane/aw-knowledge-package-format`, based on fresh main plus the bounded L-ID marker dependency. The format checker is an integrity seam only; full Source/page/schema admission and remapping remain deferred until Source cutover. No branch CI, landing window, deployment or reset has run. The Storage and Context branches remain separate and unchanged.
