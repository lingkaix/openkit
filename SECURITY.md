# Security Policy

This policy tells reporters how to disclose a suspected OpenKit vulnerability. [Development Security](docs/specs/20261109-development_security.md) owns the finding classes and response process.

## Supported Versions

| Version | Security support |
| --- | --- |
| Latest published release, including the current prerelease before v0.1.0 | Supported; update to the release containing the fix |
| Older releases | Upgrade to the latest release |
| Unreleased main | Reports accepted; fixes ship through the release process |

## Report Privately

Use [GitHub private vulnerability reporting](https://github.com/lingkaix/openkit/security/advisories/new). Include the affected release, observed impact and a minimal reproduction in that private report. Never open a public issue for a suspected vulnerability. Never include credentials in a report.

Maintainers assign a provisional class at intake. They acknowledge within 3 days and confirm the class within 7 days, or sooner for K and C. The response clock starts at intake or the first match, whichever is earlier.

| Class | Condition | Fix or mitigation target |
| --- | --- | --- |
| K | Known exploitation or a published malicious-package record, regardless of reachability | 24 hours |
| C | Critical, including CVSS at least 9.0, unless judged unreachable | 72 hours |
| H | High, including CVSS at least 7.0, or unrated, unless judged unreachable | 7 days |
| N | Other findings | Next routine upgrade |

Unknown reachability counts as reachable. These targets are response commitments, not guarantees of a fix. Maintainers record mitigations, reviewed non-applicability and accepted risks privately under the development specification.

## Coordinated Disclosure

Maintainers investigate and prepare fixes in the advisory's temporary private fork. They merge immediately before releasing, then publish the advisory, affected and fixed versions, OSV record and advisory-linked release notes. They request a CVE through the advisory and credit the reporter unless declined.

Until publication, use neutral wording in commits, pull requests, branch names, issues, release notes, CI logs and public agent channels. Do not describe the vulnerability or attack path there. Disclosure occurs no later than 90 days after the report unless the reporter agrees otherwise.
