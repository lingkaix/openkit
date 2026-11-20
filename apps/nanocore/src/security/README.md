# Runtime security

`security.pauseAgentWork` is an administrator-owned persistent Server configuration switch. Boot reads it before scheduling. New agent admissions, queued dispatch, scheduled work, outcome successors and public remote Gateway calls refuse while paused, with fresh checks before execution effects. Existing running Turns continue; reads, answers, cancellation, credential revocation and configuration changes remain available. Clearing the switch wakes waiting outcomes and Goals through their existing owners. Each actual switch change supplies an R1 Server configuration event.

v0.2.0 reports the security trigger disabled. `SecurityTriggerStore.status()` returns unavailable with reason `disabled` and does not open `server/services/security-trigger/state.sqlite`. Enable, stop, detection, notice publication, replay and background maintenance refuse before SQL, publication or automatic containment. The six tables are installed by `drizzle/services/security-trigger/0000_baseline.sql`. The outbox stores a nullable `command_receipt` and has no foreign key to `notification_attention`. No v0.2.0 writer sets `raised` to 1. Kernel Policy restrictions, `security.pauseAgentWork` and containment inspection stay in effect. Notice read, settle and attention enqueue arrive with the first B3 consumer. Authorization, credentials, physical storage connections, scheduling and delivery retain their existing owners.

`notebook-influence.ts` derives the reserved Notebook revision provenance from the exact inherited revision and trusted writing Turn and AgentSession. Model operation JSON cannot supply the writing context. A remote model write without a local Turn stays influenced, and remote reads do not fabricate a local execution. Unknown ancestry stays influenced; a later human edit or Review cannot clear it. `receiveContextInfluence` joins the existing Turn writer before governed Knowledge or Memory content reaches an executing context; the native owner carries that restriction into the bound AgentSession. Historical browsing does not mutate an old execution.

## Inventory

`buildInventory` admits exact package identities from build metadata and CycloneDX SBOMs. Official Worker and NanoHost attachments require an exact filename and SHA-256 match in their release checksums. It preserves package ecosystem, version, qualifiers and subpath. Missing or unverified SBOMs are unavailable, never successful empty coverage. Malformed package rows make coverage incomplete. Derived artifacts and independently supplied extensions are explicitly outside release coverage.

The release-identity owner supplies observed build metadata. Release tooling owns SBOM production and artifact selection. This pure boundary performs no file reads, network requests, retained writes, or model calls. Production attachment acquisition and the recurring trigger join remain separate work; this module alone does not enable monitoring or claim installed-image coverage.

## Advisory feeds

`assessAdvisories` matches exact OSV package versions and SEMVER ranges, or OpenKit GIT repository and explicit release tags. KEV and MAL records can set K; RSS identifiers only raise inventory-backed findings to C. Findings keep their original clock, and disappearance or untrusted prose never lowers their class or changes their disposition. Only complete inventory coverage can prove removal of a matched version. Unsupported ranges or severity vectors remain visible assessment gaps; CVSS v2, v3.0, v3.1 and v4.0 base vectors use the pinned standard `@pandatix/js-cvss` calculator; bounded structured numeric scores remain supported. No local v4 scoring table or source-authored Environmental/Threat adjustment chooses instance base severity. The workspace pins an import-only Node ESM patch for the calculator's extensionless published paths; it changes no scoring code.

`readFeedDocument` bounds HTTPS requests and local OSV files. The default Undici adapter enforces the 10-second connection bound; every request has a 60-second total deadline, including body reads. Documents stop at 32 MiB and 100,000 records. OSV arrays retain a valid prefix at truncation. Other feeds permit at most three same-origin redirects. RSS rejects DTDs/entities and never fetches item links. `queryOsvApi` submits selected purls and versions, fetches matched records without redirects, and shares one five-minute run deadline. It discloses inventory to the configured endpoint; selection requires the administrator's confirmation view to state this.

Assessment also reuses the release-authored 32 MiB ceiling for projection/work bytes, including escaped identifiers, aliases, tuple keys and diagnostics. Conservative pre-allocation accounting stops new work with an explicit incomplete gap, keeps the admitted prefix and never discards earlier findings to fit. Replacing a projected row accounts its current cost rather than accumulating old row versions. This is local transient accounting, not a configurable budget, retained field or authority grant.

These are bounded transient module boundaries. They do not enable monitoring, persist findings, or install a second scheduler. Daily matching, hourly enrichment, source staleness, the independent audit watch and enable/boot composition join the existing recurring owner in slice 8.

## Source-only helpers

`assessSecurityWatch` compares explicit original check/start facts against the accepted daily, hourly and 300-second intervals. Completion times do not delay nominal polling. In-flight work suppresses only its own lane. This pure projection creates no timer, retained state, retry policy or delivery grant. Boot does not call it.

`securityRequestId`, `securityThreadId` and `securityPublicationIds` implement the exact E4 UUID names from already assigned inputs. They never allocate an occurrence, advance a generation, publish a tuple or repair partial state.

`createSecurityCanaryMcpSupply` constructs the fixed inert `openkit-security` source declaration. `classifySecurityCanaryRequest` recognizes an exact selected call from borrowed authenticated lineage. It does not authenticate, write Audit or activate a sensor. v0.2.0 does not admit that call into containment.

## Disabled trigger, publication and containment

`enable` and `stop` throw `SecurityTriggerRefusal` code `forbidden` before the Core worker. `current` reports state `off` and delegation not current without reading the six tables. `detectAudit` returns an empty scan. Alarm, detection and event reads return no rows. `publishSecurityAlarm` and `prepareSecurityThread` throw the same refusal before creating a Thread, Turn, report or Attention row. `drainSecurityNotices` returns without publication. `selectSecurityThread` returns null, so ordinary Administration is not classified as a security Thread. `readSecurityAlarmNoticeInDb` returns null and does not query Core.

`consumeSensor` returns `not-admitted` before a Policy write. `prepareContainment` and `checkContainment` return null. `advanceContainment` returns before Turn interruption or credential revocation. `containmentUsage` still reads containment-inspect. Existing kernel Policy prohibit and quarantine statements stay in effect. Authored feeds parse and do not enable monitoring.

The Core baseline still contains the six tables until A8 removes them. This lane does not read or write those rows. A service file is not created on boot, status, enable, replay or background work.

## Checks

Run the inventory and feeds owner suites with NanoCore's Vitest configuration and zero retries. Run `server.security.test.ts` in Config Schema for authored feed choices. Tests use fixture SBOMs, checksum bytes and injected recorded/hostile feed streams, not third-party endpoints.

The Vault plan owner still issues the reserved `security_honey_inbound` declaration through ordinary Identity before delivery. The Token retains a private zero-grant Automation subject with the real responsible Human, original attempt, plan and pinned reference version. Ordinary Human tokens still reject empty Workspace bindings. The bearer verifier refuses this subject before returning an authorized Actor. The disabled consumer does not quarantine that sensor. `pauseAgentWork` still refuses new agent work with status 503.
