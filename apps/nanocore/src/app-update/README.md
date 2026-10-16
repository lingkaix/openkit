# App Update

This directory joins the administrator App update operations to the restricted host helper. [App Update Delivery](../../../../docs/specs/20260910-app_update_delivery.md) owns authorization, receipt lifecycle, interruption, and recovery. Public schemas stay in `@openkit/app-api-schemas`; application composition stays with its existing owner.

## Boundaries

- `app-update-operations.ts` enforces the existing model-delivery refusal, records the authorized start handoff, and projects helper observations.
- `preflight.ts` reads content-free active-work counts. Its observation is not a product admission barrier.
- `host-request.ts` admits closed helper commands and projects bounded helper envelopes.
- `host-transport.ts` invokes fixed SSH arguments with pinned host-key verification. A non-zero exit without stdout emits `app_update_helper_exit_before_envelope` in the server log with only the exit code and termination signal. It drains stderr without retaining its contents, so host paths, credentials, and arbitrary process text cannot enter that diagnostic. The public result stays `app_update_unavailable`. A written helper envelope remains the observation, including on a non-zero exit.

## Receipt Inspection

Use the saved request ID to inspect an uncertain update. Status reads require safe deployment configuration and receipt-location validation, but do not require a current compatibility assessment. A pre-removal commit-only receipt returns `app_update_recovery_required` for its ID. A valid retained release receipt stays readable with a stale, missing, or malformed assessment. Neither result authorizes another execution.

Prepare, start, and the supervised apply job still require the compatibility assessment. A pre-removal assessment must be re-authored for a release candidate before these operations. The assessment binds the exact current image, published release source, and observed applied migrations; an operator must establish those facts under the existing authorization. Receipt inspection supplies no migration or recovery approval. If the helper or transport is unavailable, use the authorized offline inspection path in the [operations reference](../../../../skills/openkit-ops/references/nanocore-operations.en.md); never infer success or submit another start from missing evidence.

## Verification

Run the focused transport and parser checks with `pnpm --filter @openkit/nanocore exec vitest run src/app-update/host-transport.test.ts src/app-update/host-request.test.ts --maxWorkers=1 --no-file-parallelism`. Run the helper filesystem and host-double suite with `python3 -I -B scripts/docker/app-update-helper.test.py`. These checks do not establish selected-host update success; that evidence requires a separately authorized deployment.
