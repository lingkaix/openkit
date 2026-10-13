---
status: Accepted
date: "2026-10-13"
decider: Engineer
---
# App Image Release Identity

## Decision

On 2026-10-13 the engineer accepted that the App image carries its release identity as a file set by the release build, and that authenticated App Diagnostics reports it. [Operational Telemetry Standardization](../specs/20260731-operational_telemetry_standardization.md#app-diagnostics-operational-sample) owns the diagnostics projection. [Container Image Packaging](../specs/20260708-container_image_packaging.md) owns the image file. [App Update Delivery](../specs/20260910-app_update_delivery.md) uses that report as the operator path to `expectedCurrentImageId`.

## Reason

[issue #232](https://github.com/lingkaix/openkit/issues/232) is the defect: there was no public read of the running release or image for `app-update.prepare`. The engineer's words are not quoted.

## Rejected Alternatives

- An image ENV. The App-update helper replays the old container's full `Config.Env`, so an ENV identity from the previous image would override the new image after every update. [issue #239](https://github.com/lingkaix/openkit/issues/239).
- Helper-side derivation in prepare. The helper is a host-installed program outside the App container, and the built-in update replaces the App container and leaves that helper file in place. [issue #230](https://github.com/lingkaix/openkit/issues/230).
- A new public operation. `diagnostics.app` is already a deployment-admin read and already carries build-adjacent facts, including the process sample, so the running release identity belongs on that read.

## Revisit When

Revisit this decision if a built-in update starts replacing the helper, or if App Diagnostics stops admitting the deployment administrator.

## Affected Owners

- [Operational Telemetry Standardization](../specs/20260731-operational_telemetry_standardization.md) states the diagnostics projection.
- [Container Image Packaging](../specs/20260708-container_image_packaging.md) states that the identity is a file set by the release build.
- [App Update Delivery](../specs/20260910-app_update_delivery.md) states the operator path from that report to `expectedCurrentImageId`.
- [NanoCore operations](../../skills/openkit-ops/references/nanocore-operations.en.md) tells an administrator how to read the running release and supply the published App image digest.
