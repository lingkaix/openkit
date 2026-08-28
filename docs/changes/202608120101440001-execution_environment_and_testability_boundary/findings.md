# Findings

These findings preserve observations that do not authorize work beyond this plan's accepted outcome.

## Follow-up Index

- [ ] `EETB-FND-001` [deferred] Image kind vocabulary differs between its owner and implementation
- [ ] `EETB-FND-002` [open] Published base dependency prevents WP-3 entry
- [ ] `EETB-FND-003` [deferred] External derivation has no accepted GHCR visibility and authentication contract

## [deferred] EETB-FND-001 — Image kind vocabulary differs between its owner and implementation

- **Observation:** The packaging specification defines `kind` as `app`, `worker`, or `dev`, while `containers/images.json`, release preflight, and NanoCore catalog tests use `app`, `worker`, or `test`.
- **Impact:** A future catalog or validator change can follow either vocabulary and make the owner, release path, and tests disagree.
- **Evidence:** Direct inspection on 2026-08-28 found the specification vocabulary in `docs/specs/20260708-container_image_packaging.md` and the implemented vocabulary in `scripts/release-preflight.mjs` and `apps/nanocore/src/docker/container-images-manifest.test.ts`.
- **Owner:** `docs/specs/20260708-container_image_packaging.md`.
- **Next action:** Opened during WP-2 entry review on 2026-08-28. Per the engineer's instruction to retain discoveries beyond the current plan instead of expanding it, deferred to the packaging-specification owner and activated by the next accepted change to the image-kind or catalog-schema contract.

## [open] EETB-FND-002 — Published base dependency prevents WP-3 entry

- **Observation:** WP-3 requires a digest-pinned published `worker-common` base, but this program excludes GHCR publication and the current release workflow tests catalog images before its publish job.
- **Impact:** WP-3 cannot truthfully rebase `test-env`, and WP-4 and WP-5 remain sequenced behind it, so this program cannot reach verified closeout from local artifacts alone.
- **Evidence:** Direct plan, catalog, and `.github/workflows/ci.yml` inspection on 2026-08-28 plus an independent Claude Opus 5 blocker consultation rejected local tags, a local registry, and source-derived digests as substitutes for the published multi-platform digest.
- **Owner:** Engineer for release sequencing and `docs/specs/20260708-container_image_packaging.md` for any accepted packaging-design change.
- **Next action:** After WP-2 and WP-6 pass locally, either publish `worker-common` in an earlier version-tag release and record its multi-platform digest, or obtain an engineer decision accepting a different release sequence or design before WP-3 opens.

## [deferred] EETB-FND-003 — External derivation has no accepted GHCR visibility and authentication contract

- **Observation:** The owning specifications make `worker-common` an external extension point but do not decide whether its GHCR package must be public or how external builders authenticate if it is private.
- **Impact:** A correctly published base can still be unusable by the user and secondary-developer derivation path that its contract promises.
- **Evidence:** Direct specification and release-workflow inspection on 2026-08-28 found publication mechanics and extension guarantees but no package-visibility or consumer-authentication predicate; an anonymous GHCR token probe returned HTTP 403 and therefore proved no package state.
- **Owner:** `docs/specs/20260708-container_image_packaging.md` and the release owner that first publishes `worker-common`.
- **Next action:** Opened during WP-2 entry review on 2026-08-28. Per the engineer's instruction to retain discoveries beyond the current plan instead of expanding it, deferred to the packaging-specification and first-publication owners and activated before the first `worker-common` version-tag release.
