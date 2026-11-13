# Runtime security

This directory implements the bounded detection parts of [Runtime Security](../../../../docs/specs/20261109-runtime_security.md). It does not own authorization, credentials, native storage, scheduling, or delivery.

## Inventory

`buildInventory` admits exact package identities from build metadata and CycloneDX SBOMs. Official Worker and NanoHost attachments require an exact filename and SHA-256 match in their release checksums. It preserves package ecosystem, version, qualifiers and subpath. Missing or unverified SBOMs are unavailable, never successful empty coverage. Malformed package rows make coverage incomplete. Derived artifacts and independently supplied extensions are explicitly outside release coverage.

The release-identity owner supplies observed build metadata. Release tooling owns SBOM production and artifact selection. This pure boundary performs no file reads, network requests, retained writes, or model calls. Production attachment acquisition and the recurring trigger join remain separate work; this module alone does not enable monitoring or claim installed-image coverage.

## Advisory feeds

`assessAdvisories` matches exact OSV package versions and SEMVER ranges, or OpenKit GIT repository and explicit release tags. KEV and MAL records can set K; RSS identifiers only raise inventory-backed findings to C. Findings keep their original clock, and disappearance or untrusted prose never lowers their class or changes their disposition. Only complete inventory coverage can prove removal of a matched version. Unsupported ranges or severity vectors remain visible assessment gaps; CVSS v3 base vectors and structured numeric scores are evaluated locally.

`readFeedDocument` bounds HTTPS requests and local OSV files. The default Undici adapter enforces the 10-second connection bound; every request has a 60-second total deadline, including body reads. Documents stop at 32 MiB and 100,000 records. OSV arrays retain a valid prefix at truncation. Other feeds permit at most three same-origin redirects. RSS rejects DTDs/entities and never fetches item links. `queryOsvApi` submits selected purls and versions, fetches matched records without redirects, and shares one five-minute run deadline. It discloses inventory to the configured endpoint; selection requires the administrator's confirmation view to state this.

These are bounded transient module boundaries. They do not enable monitoring, persist findings, or install a second scheduler. Daily matching, hourly enrichment, source staleness, the independent audit watch and enable/boot composition join the existing recurring owner in slice 8.

## Checks

Run the inventory and feeds owner suites with NanoCore's Vitest configuration and zero retries. Run `server.security.test.ts` in Config Schema for authored feed choices. Tests use fixture SBOMs, checksum bytes and injected recorded/hostile feed streams, not third-party endpoints.
