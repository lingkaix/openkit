# Runtime security

This directory implements the bounded detection parts of [Runtime Security](../../../../docs/specs/20261109-runtime_security.md). Authorization, credentials, physical storage connections, scheduling and delivery retain their existing owners. The closed Server security record family uses the existing native Core control worker.

## Inventory

`buildInventory` admits exact package identities from build metadata and CycloneDX SBOMs. Official Worker and NanoHost attachments require an exact filename and SHA-256 match in their release checksums. It preserves package ecosystem, version, qualifiers and subpath. Missing or unverified SBOMs are unavailable, never successful empty coverage. Malformed package rows make coverage incomplete. Derived artifacts and independently supplied extensions are explicitly outside release coverage.

The release-identity owner supplies observed build metadata. Release tooling owns SBOM production and artifact selection. This pure boundary performs no file reads, network requests, retained writes, or model calls. Production attachment acquisition and the recurring trigger join remain separate work; this module alone does not enable monitoring or claim installed-image coverage.

## Advisory feeds

`assessAdvisories` matches exact OSV package versions and SEMVER ranges, or OpenKit GIT repository and explicit release tags. KEV and MAL records can set K; RSS identifiers only raise inventory-backed findings to C. Findings keep their original clock, and disappearance or untrusted prose never lowers their class or changes their disposition. Only complete inventory coverage can prove removal of a matched version. Unsupported ranges or severity vectors remain visible assessment gaps; CVSS v2, v3.0, v3.1 and v4.0 base vectors use the pinned standard `@pandatix/js-cvss` calculator; bounded structured numeric scores remain supported. No local v4 scoring table or source-authored Environmental/Threat adjustment chooses instance base severity. The workspace pins an import-only Node ESM patch for the calculator's extensionless published paths; it changes no scoring code.

`readFeedDocument` bounds HTTPS requests and local OSV files. The default Undici adapter enforces the 10-second connection bound; every request has a 60-second total deadline, including body reads. Documents stop at 32 MiB and 100,000 records. OSV arrays retain a valid prefix at truncation. Other feeds permit at most three same-origin redirects. RSS rejects DTDs/entities and never fetches item links. `queryOsvApi` submits selected purls and versions, fetches matched records without redirects, and shares one five-minute run deadline. It discloses inventory to the configured endpoint; selection requires the administrator's confirmation view to state this.

Assessment also reuses the release-authored 32 MiB ceiling for projection/work bytes, including escaped identifiers, aliases, tuple keys and diagnostics. Conservative pre-allocation accounting stops new work with an explicit incomplete gap, keeps the admitted prefix and never discards earlier findings to fit. Replacing a projected row accounts its current cost rather than accumulating old row versions. This is local transient accounting, not a configurable budget, retained field or authority grant.

These are bounded transient module boundaries. They do not enable monitoring, persist findings, or install a second scheduler. Daily matching, hourly enrichment, source staleness, the independent audit watch and enable/boot composition join the existing recurring owner in slice 8.

## Source-only trigger and sensor preparation

`assessSecurityWatch` compares explicit original check/start facts against the accepted daily, hourly and 300-second intervals. Completion times do not delay nominal polling. In-flight work suppresses only its own lane; off or lost delegation does not suppress outstanding-notice drain assessment. This pure projection creates no timer, retained state, retry policy or delivery grant. Actual scheduling, writes and grant checks remain with the existing owners.

`securityRequestId`, `securityThreadId` and `securityPublicationIds` implement the exact E4 UUID names from already assigned inputs. They never allocate an occurrence, advance a generation, publish a tuple or repair partial state. Native counters, receipts and recovery remain required.

`createSecurityCanaryMcpSupply` constructs the fixed inert `openkit-security` source declaration in the existing AEP supply shape. `classifySecurityCanaryRequest` recognizes an exact selected call from borrowed authenticated lineage, independently of a Tool grant. It projects observation eligibility only while the existing trigger is on; exact calls remain inert while off/stopping. This module is not an authenticator, route integration or Audit writer. Real route admission must prove current token/run/schema lineage and refuse before credentials or upstream. No package is automatically supplied a canary, no sensor is activated and no containment grant is introduced by these helpers. Native sensor evidence and the zero-grant credential issuer remain separate prerequisites.

## Native trigger preparation (N1)

`SecurityTriggerStore` is an internal typed facade for default-off state, current enabling-administrator delegation, enable/stop, original pending R1/R8 alarm identities and bounded original Server Audit pages. It uses only the existing Core worker/client. Current authority comes from canonical User and actual usable administrator credential records, never a caller privilege flag. Actor authentication and public human-only/full-diff authorization remain with their existing owners; this cut exposes no public activation operation.

Stopping and all original alarm recipient rows are one native transaction. Authority loss detected by an Audit read commits stopping/R8 before the facade refuses the read. Repeated stop/check and reopen reuse exact IDs. No eligible administrator is an explicit native failed outcome. Original counts, markers and derived identifiers are checked; missing or partial tuples require recovery rather than reseeding. Independent alarm run identities use UUIDv7; request identities use the accepted E4 derivation. Core0026 adds only this family to the existing Core home and its whole-database backup.

Audit pages are bounded at 128 and keep original Core facts, including opaque Workspace links, without joining a Workspace database or content. Pending alarm pages are bounded at 128. N1 does not raise an alarm, mark it published, complete stopping, create a scheduler, call a Provider/feed, issue a credential or activate a canary/containment consumer. The initial native Audit cut below adds assessment/cursor obligations; N3 Attention/drain and stopping completion remain required.

## Initial native Audit assessment (N2)

`detectAudit` reads at most 128 actual physical Core Audit rows through the same closed native worker operation. Its durable append position is private; the returned cursor names the original last row by time and Audit identity. Timestamp order is not append authority: a later original producer can retain an earlier clock and must still be detected. All scanned rows advance progress, including unrelated actions and opaque Workspace links; no Workspace database or content is joined. Caller inputs cannot select recipients, supply events, reset progress or assign counters.

Successful original `user.disable` facts with recorded Actor/User subject produce R1d for the native responsible administrator: daily for that recorded User actor, immediate otherwise. Successful original stopped-operator `auth.admin-recovery.issue` facts produce immediate R1 obligations for every current eligible administrator. Assessment, every initial recipient and progress share one original Core savepoint/FULL acknowledgement. Existing N1 alarm tuples remain separate; detection of lost delegation commits original R8 before facade refusal, without advancing this cursor.

Other named E5 actions retain structured unsupported assessments with closed missing-fact diagnostics and zero notices. Summaries, resource strings and mutable Token/configuration records never supply historical authority. Full historical source facts and bootstrap/null-Actor semantics remain deferred in [issue 721](https://github.com/lingkaix/openkit/issues/721). Read-only assessment paging is chronological and never advances append progress. Reopen/replay reuse the original facts and request identities; missing/changed source positions, marker/count/identity mismatches and partial tuples refuse recovery rather than reseeding. This cut creates no scheduler, delivery acknowledgement, event Raise, cursor-gap recovery alarm, activation or useful grant.

## Initial native Thread destination (N3 preparation)

`prepareSecurityThread` accepts an actual pending N1 R1/R8 request identity, not a caller recipient, generation or grant. The existing Core security worker validates original source tuples and current recipient eligibility, resolves the canonical Personal Workspace binding and reserves the initial generation. The composition then uses the original Personal Workspace and private Administration Thread native publishers. Only after the actual Workspace acknowledgement does Core mark this original destination ready. Core0027 retains generation/source/publication progress; the actual Thread stays in its Workspace. No cross-database transaction is claimed.

`selectSecurityThread` is a read-only join of that original native binding and the actual private Administration Thread owner. Names and guessed IDs are not proof. A registered reserved, missing or mismatched tuple refuses instead of becoming ordinary work or being repaired. Historical archived security Threads keep their classification. Preparation reuses exact ready tuples, but refuses archived destinations; generation rollover remains with the later N3 Raise path. The facade requires both actual owners to share one Data Root.

The destination-only cut creates no report, Turn, Pending Request, Attention or notice acknowledgement and does not mark an alarm raised or complete stopping. It exposes no activation route, credential, useful grant or scheduler. SEC-REPORT still owns actual principal/private-audience and effect admission.

## Initial actual alarm publication

`publishSecurityAlarm` composes only an actual owed N1 R1/R8 source with its current native recipient and private destination. The existing complete-inventory Artifact owner publishes the real version1 markdown report. Its reference reuses the single `artifactReferenceItemId(artifactId, turnId)` owner. The original Pending/terminal operation publishes a completed agentless automation Turn and canonical `automation` user-input request together, with truthful Core system history and fixed code-written choices. Its existing native transaction repeats the actual idle check; a known busy Thread admits no publication tuple. Unknown file/native settlement remains unavailable rather than being treated as rollback.

`readSecurityAlarmPublication` joins the original alarm, destination and actual file/version/reference/Turn/Pending owners. Only a wholly absent publication returns null; collisions, partial tuples and mismatched scope require recovery without repair. Complete replay reuses the original tuple. Archived complete history remains readable; new publication to an archived destination refuses. This prefix leaves raised flags and original notice obligations unchanged. Attention, triage, archive rollover, scheduling/drain and stopping-to-off remain separate incomplete joins. No useful grant, public activation or effect admission is introduced.

## Checks

Run the inventory and feeds owner suites with NanoCore's Vitest configuration and zero retries. Run `server.security.test.ts` in Config Schema for authored feed choices. Tests use fixture SBOMs, checksum bytes and injected recorded/hostile feed streams, not third-party endpoints.
