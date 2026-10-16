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

1. Land the exact any-file Artifact lifecycle: reserve-aware admission, streamed capture and download, immutable publication and replay, independent raw-output accounting, exact credential admission, and portability.
2. Land D01 client file drafts and Turn-owned immutable inputs. A helper implements this in its own branch.
3. Land safe ZIP folder intake. A second helper implements this in its own branch.
4. Land authorized per-Turn read-only snapshots, bounded source projections, exact input lineage and delivery, PDF text and explicit vision views, and failure/refusal behavior.

The coordinator transferred P27 Artifact and Material Web review to L-WEB on 2026-10-16. L-AW retains the file-input portions of the Composer and chat screens. The original assignment above remains intent history.

Each increment includes owner alignment, local guides, focused regressions, integration checks, independent review, and exact-head full CI before landing. Landing protocol v2 prepares shared integration, generation, gates, independent review and full CI before acquiring the final landing window. Cross-lane changes require coordinated ownership.

## Checkpoint

The fixture and oracle branch at 3b8ea153 is merged. No production change has landed. WIP 5f5f21b6 is pushed as a backup, and main a1f2c6b8 is merged. Exact file storage, streaming and raw accounting are implemented and under integration checks. D01 and ZIP are separate landable features.

## Verification

Use the prior frozen corpus under `tests/fixtures/large-context/` for byte, size, range, and archive expectations. Its integrity test alone proves no product behavior. Source-level tests exercise actual admission, filesystem bytes, durable owners, authorization, replay, and model-visible projections. Host resource and exact-image evidence remain separate from deterministic unit evidence. Use the shared CPU slot helper and one Vitest worker.

## Next Action

Complete the first-feature integration checks, regenerate the API and CLI, obtain exact-head independent review and run full branch CI before acquiring the landing window. Preserve the same session, attempt, no-follow, replay and live-Turn fences across Core, NanoHost and helper streaming.
