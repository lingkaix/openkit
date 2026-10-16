---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/aw
---
# Artifacts And Workspace Data

This record preserves execution context for lane L-AW. It adds no design authority.

## Intent

The engineer assigned P17, P18, and P27 in that order: arbitrary-file Artifacts and upload admission; exact authorized Worker input delivery; Artifact and Material Web review. Use the recommended product decisions and the accepted large-file ruling. Only raw LLM output counts toward the per-Turn output bound. Large files remain exact retained bytes, with bounded model projections and on-demand references.

## Owners

[Work Resource Interaction](../../specs/20260713-work_resource_interaction_model.md), [Storage Layout](../../specs/20260703-storage_layout_record_ownership.md), [Worker Context Package](../../specs/20260703-worker_context_package.md), [Session-Static Materialization](../../specs/20260704-session_static_workspace_materialization.md), [NanoHost Data Boundary](../../specs/20260801-nanohost_workspace_data_boundary.md), [Workspace Data Sources](../../specs/20260704-workspace_data_source_catalog.md), [Worker Reliability](../../specs/20260531-worker_turn_reliability_envelope.md), and [Web Projection](../../specs/20260628-web_product_surface_projection.md) govern implementation.

## Increments

1. Complete the exact file lifecycle: reserve-aware admission, streamed capture and download, safe folder intake, immutable publication and replay, independent raw-output accounting, binary review, and portability.
2. Complete authorized per-Turn read-only snapshots, bounded source projections, exact input lineage and delivery, PDF text and explicit vision views, and failure/refusal behavior.
3. Complete the Artifact and Material review surfaces, precise feedback, and explicit candidate selection.

Each increment includes owner alignment, local guides, focused regressions, integration checks, independent review, and exact-head full CI before landing. Shared integration paths are edited only inside the lane's landing window. Cross-lane changes require coordinated ownership.

## Checkpoint

The fixture and oracle branch at 3b8ea153 is merged. No production change has landed. Begin at file admission and private payload staging. Existing Artifact content is non-empty inline text; arbitrary binary and empty originals cannot pass it. No byte conversion can satisfy exact original identity.

## Verification

Use the prior frozen corpus under `tests/fixtures/large-context/` for byte, size, range, and archive expectations. Its integrity test alone proves no product behavior. Source-level tests exercise actual admission, filesystem bytes, durable owners, authorization, replay, and model-visible projections. Host resource and exact-image evidence remain separate from deterministic unit evidence. Use the shared CPU slot helper and one Vitest worker.

## Next Action

Add a regression against the current Artifact contract. Expected observation: the empty and arbitrary-byte file representation is refused. Implement bounded file counters, concurrent free-space reservation, and private streaming staging next. A failed probe that exposes a cross-lane owner dependency will narrow an interface request before editing that owner's path.
