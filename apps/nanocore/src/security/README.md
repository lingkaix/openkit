# Runtime security

This directory implements the bounded detection parts of [Runtime Security](../../../../docs/specs/20261109-runtime_security.md). It does not own authorization, credentials, native storage, scheduling, or delivery.

## Inventory

`buildInventory` admits exact package identities from build metadata and CycloneDX SBOMs. Official Worker and NanoHost attachments require an exact filename and SHA-256 match in their release checksums. It preserves package ecosystem, version, qualifiers and subpath. Missing or unverified SBOMs are unavailable, never successful empty coverage. Malformed package rows make coverage incomplete. Derived artifacts and independently supplied extensions are explicitly outside release coverage.

The release-identity owner supplies observed build metadata. Release tooling owns SBOM production and artifact selection. This pure boundary performs no file reads, network requests, retained writes, or model calls. Production attachment acquisition and the recurring trigger join remain separate work; this module alone does not enable monitoring or claim installed-image coverage.

## Checks

Run the inventory owner suite with NanoCore's Vitest configuration and zero retries. Tests use fixture SBOMs and exact checksum bytes, not third-party endpoints.
