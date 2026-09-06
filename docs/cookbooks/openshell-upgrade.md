# OpenShell Upgrade

Use this cookbook to evaluate and adopt one newer official OpenShell release for NanoHost. The owning contract is `docs/specs/20260802-nanohost_runtime_and_transport.md`. This workflow trusts the official release's matched SDK, Gateway, and Supervisor; it verifies the release identity and OpenKit's integration with those components.

This is not an automatic updater or a multi-version compatibility program. OpenKit supports one qualified OpenShell release at a time.

## Prepare The Candidate

Start from an official immutable OpenShell release and record its version, resolved commit, Gateway archive and executable checksums, Supervisor platform digests, and redistributed license-file checksums in `apps/nanohost/openshell/release.json`. Update the `openshell-sdk` Cargo revision to the same commit and regenerate `Cargo.lock` through Cargo.

Rebind and review the three source-backed forward, relay, and pairing entries in `apps/nanohost/openshell/transport-assumptions.json` against every candidate commit, even when their values are unchanged. Review queue multiplicity together with frame size and pairing-buffer size per direction; matching source hashes prove identity and staleness only. Keep the smallest Git object closure needed to verify those entries. Do not add protobuf copies, compile probes, RPC inventories, authentication catalogs, upstream history, or a general source review.

From the OpenKit repository root, use a complete clean checkout of the candidate's immutable release source. Resolve the tag and root tree, then use `git ls-tree` down each of the three recorded source paths to identify the commit, required directory trees, and file blobs:

```bash
git -C /absolute/path/to/openshell rev-parse 'refs/tags/vX.Y.Z^{commit}'
git -C /absolute/path/to/openshell rev-parse '<candidate-commit>^{tree}'
git -C /absolute/path/to/openshell ls-tree <tree-object> <path-component>
git -C /absolute/path/to/openshell cat-file -t <object-id>
```

For each object in that minimal closure, retain the exact decoded object payload under its object ID:

```bash
git -C /absolute/path/to/openshell cat-file <commit-or-tree-or-blob> <object-id> > apps/nanohost/openshell/git-objects/<object-id>
```

Recompute the SHA-256 of each cited source file, inspect the cited lines in the candidate, and update the source commit, object closure, citations, queue multiplicities, frame sizes, pairing size per direction, and derived byte totals. The integrity test proves that retained bytes, citations, and arithmetic agree; the reviewer must still decide whether the cited code bounds every stock holding point used by the memory argument.

Before testing, inspect the diff and prove that the SDK source, Gateway, Supervisor, licenses, and retained assumption evidence all identify the candidate release. A mixed set is invalid and should be corrected before any live attempt.

## Run The Fast Foundation

From the repository root, run the NanoHost build, tests, and lint:

```bash
pnpm --filter @openkit/nanohost build
pnpm --filter @openkit/nanohost test
pnpm --filter @openkit/nanohost lint
node --test tests/release-preflight.test.mjs tests/release-workflow.test.mjs tests/nanohost-transport-assumptions.test.mjs
```

Run the packaging and installed-archive verification in a GNU-tar Linux environment. The authoritative test image described by [Test Execution Image](./docker-test-env.md) can run all four root checks together:

```bash
OPENKIT_TEST_USE_IMAGE=1 bash scripts/test-env.sh any node --test tests/release-preflight.test.mjs tests/release-workflow.test.mjs tests/package-release-assets.test.mjs tests/nanohost-transport-assumptions.test.mjs
```

These root checks are part of the foundation: the Cargo suite alone does not run release-preflight, workflow, packaging, installed-archive, or retained-source-evidence checks. Together the Cargo and root checks must compile the candidate SDK and validate release consistency, packaging inputs, exact byte preservation across arbitrary frame boundaries, backpressure when a queue is full, recovery after consumption resumes, capacity release on EOF, error, cancellation, and closure, and the retained assumption identity and arithmetic. They are required before a live-host attempt, but they do not qualify the stock Gateway and Supervisor, certify the semantic memory proof, or satisfy the A1 noninterference gate.

## Run Real-Stock Qualification

Follow [NanoHost Real-Use Host](./nanohost-real-use-host.md) for host prerequisites, credential handling, teardown, and retained evidence. Do not start NanoHost on A1 until the current exact-product noninterference blocker is closed. The existing `host:nanohost:bring-up` command observes readiness only; it does not run the required upgrade workload and cannot produce an OpenShell upgrade PASS.

The current ignored live test is an **unadmitted diagnostic probe**, useful for investigating the stock forwarding path. Its normalized-fact self-checks do not exercise the complete SDK, peer, and cleanup stack, so neither their success nor a successful diagnostic run is deciding qualification evidence. Admission under `docs/verification-instruments.md` requires the concrete driver, fixture, and oracle to demonstrate the required terminal outcomes before that result may decide a gate. To investigate, prepare a dedicated initially empty Gateway at exact loopback HTTPS, an attempt-local TLS directory containing `ca.crt`, `client/tls.crt`, and `client/tls.key`, the exact Gateway binary and config, and one digest-qualified Node-bearing sandbox image. From `apps/nanohost`, run:

```bash
OPENKIT_OPENSHELL_UPGRADE_LIVE=1 \
OPENKIT_OPENSHELL_UPGRADE_GATEWAY_URL="https://127.0.0.1:17670" \
OPENKIT_OPENSHELL_UPGRADE_TLS_DIR="/absolute/attempt-local/tls" \
OPENKIT_OPENSHELL_UPGRADE_GATEWAY_BINARY="/absolute/path/to/openshell-gateway" \
OPENKIT_OPENSHELL_UPGRADE_GATEWAY_CONFIG="/absolute/path/to/gateway.toml" \
OPENKIT_OPENSHELL_UPGRADE_SANDBOX_IMAGE="registry.example.invalid/repository/image@sha256:<64-lowercase-hex>" \
cargo test --locked openshell_upgrade_live -- --ignored --nocapture --test-threads=1
```

Replace every placeholder with the attempt's real value. The runner checks the exact loopback HTTPS URL, absolute regular files, release metadata against Cargo, Gateway binary checksum, and configured current-platform Supervisor digest before reading client key material. It then uses the key for verified mTLS and checks live Gateway health version and initial empty sandbox inventory before creating a sandbox. It creates one uniquely named owned sandbox, starts a bounded Node peer through the SDK, carries the production byte adapter and nested HTTP/2 over the stock forward, exercises exact bytes plus pause, backpressure, and resume, then aborts and awaits the peer and forward, revokes the short-lived authorization, deletes only its owned sandbox, and requires the dedicated Gateway to be empty again. An ambiguous create response remains cleanup uncertainty even if a later list is empty.

The terminal line starts with `outcome=observed scope=stock-forwarding-diagnostic admission=unadmitted qualification=not-evaluated` and includes the release and commit. It reports diagnostic observations and never authorizes candidate adoption. The configured Supervisor digest and requested sandbox image remain fixture premises rather than independent proof of the running instances. Fixed failure output identifies only the closed stage and outcome; cleanup failure is retained alongside the first failure without printing paths, credentials, tokens, sandbox IDs, or raw upstream errors.

The forwarding diagnostic and the full 60-second saturation, interrupt and heartbeat, successor reconnect, bootstrap monitor, and single-file Interactive-helper observations still have no admitted qualification runner. Until harness admission, those observations, and the applicable host prerequisites are available, record overall OpenShell upgrade qualification as incomplete. Do not substitute mocks, a saved result, source inspection, an ordinary readiness observation, the forwarding diagnostic, or a shorter unsaturated run.

The real-stock run must use the candidate's official Gateway and Supervisor with the Cargo-built NanoHost. It must cover:

- slow consumption and recovery with exact byte comparison and bounded outstanding bytes;
- all eight inference streams and the complete 2 MiB inference in-flight ceiling held continuously for at least 60 seconds on every session the observation spans while interrupt and heartbeat observations are collected;
- cancellation during active transfer with prompt capacity release and no replay;
- bridge loss, predecessor fencing, and successor readiness inside the accepted recovery bound; and
- the fixed bootstrap monitor and single-file Interactive helper through their success and ambiguous-failure paths.

Always run teardown after a live attempt, including collection or caller failure, using the command in the real-use host cookbook.

## Read The Result

Each scenario result must name the candidate tag and commit, Gateway and Supervisor digests, effective transport values, host and load conditions, attempt identity, expected predicate, observed value, and failure stage. It must not contain credentials, request payloads, provider output, private runtime identifiers, or raw logs.

Classify the result before changing code or a value:

| Result | Meaning | Next action |
| --- | --- | --- |
| `prerequisite` or `incomplete` | The subject was not fully observed. | Repair the host or runner and repeat; do not report PASS. |
| `foundation` | Cargo, release identity, packaging, or the NanoHost adapter is inconsistent. | Fix the narrow OpenKit owner and rerun the fast checks. |
| `integration` | The candidate's stock behavior no longer satisfies NanoHost's accepted use. | Adapt NanoHost within the current contract or reject the candidate. |
| `calibration` | The mechanism works at a different value still inside every admissibility ceiling. | Change one input, rerun all affected scenarios, and submit the measured value for independent acceptance and a specification amendment. |
| `blocking` | A safety predicate, hard ceiling, predecessor fence, no-replay rule, or hard-memory proof failed. | Reject the candidate or return to the owning specification; never loosen the check. |

When diagnosis is unclear, run the currently supported release once under the same host and load conditions. Failure of both runs points first to the host or instrument; candidate-only failure points first to the dependency change. This comparison is diagnostic evidence and does not create ongoing support for two releases.

Use the reported stage as the first inspection point:

| Observation | Inspect first |
| --- | --- |
| Byte mismatch after different frame boundaries | NanoHost adapter framing and EOF handling |
| Outstanding bytes grow while consumption is paused | Capacity release and backpressure at each OpenKit boundary, then the retained stock buffer proof |
| Interrupt or heartbeat delay rises only under saturation | Poll or enqueue delay, DATA-capacity wait, then worker-side handling |
| Cancellation leaves occupied capacity | Request cancellation propagation and accounting release |
| Reconnect accepts late bytes or repeats work | Predecessor closure, lineage binding, and route-owner retry rules |
| Bootstrap or Interactive helper becomes ambiguous | SDK result mapping, response completion, terminal event, and fail-stop disposition |

Change one parameter at a time and keep the accepted workload fixed. Never edit a target, ceiling, sample duration, failure meaning, or safety rule merely to make the candidate pass.

## Adopt The Release

Adopt the candidate only after the fast foundation, complete real-stock qualification, packaging verification, actual diff review, and independent acceptance all pass. Keep the existing release selected after any failed or incomplete candidate attempt. A later attempt starts from current source and evidence rather than editing or reclassifying the old result.
