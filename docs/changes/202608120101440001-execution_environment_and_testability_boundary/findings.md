# Findings

These findings preserve observations that do not authorize work beyond this plan's accepted outcome.

## Follow-up Index

- [x] `EETB-FND-001` [closed] Image kind vocabulary differs between its owner and implementation
- [x] `EETB-FND-002` [closed] Published base dependency prevents WP-3 entry
- [ ] `EETB-FND-003` [deferred] External derivation has no accepted GHCR visibility and authentication contract
- [x] `EETB-FND-004` [closed] Pi worker smoke used a dry-run package the adapter rejects
- [x] `EETB-FND-005` [closed] Platform-interface enforcement required a bounded corpus migration
- [ ] `EETB-FND-006` [deferred] Web production entry chunk exceeds the configured size warning

## [closed] EETB-FND-001 — Image kind vocabulary differs between its owner and implementation

- **Observation:** The packaging specification defines `kind` as `app`, `worker`, or `dev`, while `containers/images.json`, release preflight, and NanoCore catalog tests use `app`, `worker`, or `test`.
- **Impact:** A future catalog or validator change can follow either vocabulary and make the owner, release path, and tests disagree.
- **Evidence:** Direct inspection on 2026-08-28 found the specification vocabulary in `docs/specs/20260708-container_image_packaging.md` and the implemented vocabulary in `scripts/release-preflight.mjs` and `apps/nanocore/src/docker/container-images-manifest.test.ts`.
- **Owner:** `docs/specs/20260708-container_image_packaging.md`.
- **Next action:** Opened during WP-2 entry review on 2026-08-28. Per the engineer's instruction to retain discoveries beyond the current plan instead of expanding it, deferred to the packaging-specification owner and activated by the next accepted change to the image-kind or catalog-schema contract. During ordinary review correction on 2026-08-28, the already-touched packaging owner was aligned to the implemented `test` vocabulary; no further action remains under this finding.
- **Closing verdict:** Recorded disposition: the packaging owner now matches the catalog, release preflight, and NanoCore tests. Terminal disposition: the vocabulary mismatch is resolved without changing the implemented catalog contract.
- **Closure evidence:** `docs/specs/20260708-container_image_packaging.md` now defines `kind` as `app`, `worker`, or `test`; documentation validation and specification-lifecycle validation pass.

## [closed] EETB-FND-002 — Published base dependency prevents WP-3 entry

- **Observation:** WP-3 requires a digest-pinned published `worker-common` base, but this program excludes GHCR publication and the current release workflow tests catalog images before its publish job.
- **Impact:** WP-3 cannot truthfully rebase `test-env`, and WP-4 and WP-5 remain sequenced behind it, so this program cannot reach verified closeout from local artifacts alone.
- **Evidence:** Direct plan, catalog, and `.github/workflows/ci.yml` inspection on 2026-08-28 plus an independent Claude Opus 5 blocker consultation rejected local tags, a local registry, and source-derived digests as substitutes for the published multi-platform digest.
- **Owner:** Engineer for release sequencing and `docs/specs/20260708-container_image_packaging.md` for any accepted packaging-design change.
- **Next action:** None. The 2026-08-28 engineer recut closed the publication dependency by making current WP-3 a sibling package that pins `test-env` to the same Node digest without `FROM worker-common`.
- **Closing verdict:** Recorded disposition: WP-3 no longer requires a published `worker-common` digest because `test-env` is an internal sibling of that public base. Terminal disposition: the sibling recut leaves no further work under EETB-FND-002.
- **Closure evidence:** Direct inspection of the 2026-08-28 recut: `containers/test-env/Dockerfile` `FROM` equals the worker-common Node digest `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` and is not `FROM worker-common`; Intent Epoch 2 records the supersession.

## [deferred] EETB-FND-003 — External derivation has no accepted GHCR visibility and authentication contract

- **Observation:** The owning specifications make `worker-common` an external extension point but do not decide whether its GHCR package must be public or how external builders authenticate if it is private.
- **Impact:** A correctly published base can still be unusable by the user and secondary-developer derivation path that its contract promises.
- **Evidence:** Direct specification and release-workflow inspection on 2026-08-28 found publication mechanics and extension guarantees but no package-visibility or consumer-authentication predicate; an anonymous GHCR token probe returned HTTP 403 and therefore proved no package state.
- **Owner:** `docs/specs/20260708-container_image_packaging.md` and the release owner that first publishes `worker-common`.
- **Next action:** Opened during WP-2 entry review on 2026-08-28. Per the engineer's instruction to retain discoveries beyond the current plan instead of expanding it, deferred to the packaging-specification and first-publication owners and activated before the first `worker-common` version-tag release.

## [closed] EETB-FND-004 — Pi worker smoke used a dry-run package the adapter rejects

- **Observation:** Local rebuild of `worker-pi` failed image smoke with `Unsupported Pi provider route.` because `containers/worker-pi/smoke.sh` encoded a placeholder, openai-compatible, nanocore-gateway package rather than the adapter-accepted environment, provider-compatible, direct-provider Anthropic route.
- **Impact:** Image smoke could not pass after an otherwise correct Pi image build. The defect is adjacent to WP-2 publication work and is not a catalog, base-image, launcher, protocol, or schema defect.
- **Evidence:** Named rebuild failure `Unsupported Pi provider route.` on 2026-08-28. `packages/worker-shim/src/adapters/pi.ts` requires `credentialVisibility: "environment"`, `endpoint.kind: "provider-compatible"`, `upstream.kind: "direct-provider"`, `providerInstanceId: "anthropic"`, `model: "claude-sonnet-4-5"`, non-empty `ANTHROPIC_API_KEY`, and exactly one `credentials.declarations` runtime-env name.
- **Owner:** `containers/worker-pi/smoke.sh`; the adapter contract remains `packages/worker-shim`.
- **Next action:** Correct the dry-run package and `ANTHROPIC_API_KEY=smoke` prefix in `containers/worker-pi/smoke.sh` without changing launcher, protocol, or schema. Recorded transition history: the smoke script was corrected on 2026-08-28 and `scripts/docker/smoke-image.sh worker-pi` reported `OpenKit Pi worker image smoke OK`. No further action remains under this finding; the correction stays isolated to its smoke script within the final closeout bundle.
- **Closing verdict:** Recorded disposition: the Pi smoke dry-run package now matches the adapter-accepted direct-provider route. Terminal disposition: the named rebuild failure is resolved and leaves no further work under EETB-FND-004.
- **Closure evidence:** Direct inspection of `containers/worker-pi/smoke.sh` plus the named rebuild failure `Unsupported Pi provider route.` followed by a passing `scripts/docker/smoke-image.sh worker-pi` run reporting `OpenKit Pi worker image smoke OK`.

## [closed] EETB-FND-005 — Platform-interface enforcement required a bounded corpus migration

- **Observation:** The bounded WP-5 validator initially named thirty-three test files rather than confirming the plan's expectation that the corpus would start close to clean: thirty-one depend on declared POSIX interfaces and two assert a platform divergence.
- **Impact:** Treating the initial estimate as fact would either leave the new rule unenforced or turn a known, finite declaration migration into unexplained gate failures.
- **Evidence:** The refined semantic scan on 2026-08-28 reported thirty-one `// openkit-test-platform: posix` dispositions, two `// openkit-test-platform-divergence` dispositions, and zero direct container-runtime invocations; refinement removed an AgentEnvironmentPackage policy-data false positive by limiting `/proc` and cgroup detection to accessed path literals.
- **Owner:** `docs/verification-instruments.md` owns the declaration rule; the thirty-three affected tests own their exact disposition.
- **Next action:** Completed in WP-5 by applying only the two accepted exact declarations and retaining the scanner's unenumerated-interface residual for review.
- **Closing verdict:** Recorded disposition: the hit list was a finite declaration migration, not evidence that the platform boundary should be weakened. Terminal disposition: every named file now declares its surface and no unexplained scanner finding remains.
- **Closure evidence:** Exact repository counts are thirty-one POSIX declarations, two asserted-divergence declarations, and zero container-subject declarations; `node scripts/validate-test-governance.mjs` exits zero and Biome accepts the thirty-three one-line dispositions.

## [deferred] EETB-FND-006 — Web production entry chunk exceeds the configured size warning

- **Observation:** The Docker-unavailable closeout build completed but Vite reported the minified Web entry JavaScript chunk at 987.59 kB, above its configured 500 kB warning threshold.
- **Impact:** The current bundle may impose avoidable parse, transfer, or startup cost, but this program has no page-performance predicate and changing module boundaries or loading behavior would exceed the execution-environment scope.
- **Evidence:** `pnpm build` on 2026-08-28 completed eleven of eleven tasks and reported `dist/assets/index-DT0NOdh7.js 987.59 kB | gzip: 274.75 kB` followed by Vite's chunk-size warning.
- **Owner:** `apps/web` and a future accepted Web performance change.
- **Next action:** Measure actual route and Core Web Vital impact before choosing dynamic imports or output chunking; activate only when an accepted performance objective supplies the deciding oracle.
