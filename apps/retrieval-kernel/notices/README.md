# Retrieval Dependency Notices

This directory retains upstream license and notice files omitted from the locked crates.io archives. The engineer authorized only these read-only source-file fetches on 2026-10-15. `UPSTREAM.json` records each crate/version, exact source URL, recorded commit, and SHA-256. The image build verifies these bytes before copying them beside the notices and SPDX metadata supplied by Cargo packages.

`GAPS.json` records the files that could not be tied to a recorded revision or obtained at that revision. It makes no license-completeness claim. The two Windows import-library crates are not Linux runtime dependencies. The `htmlescape` and `kanaria` gaps remain relevant to the Linux executable and need a matched upstream notice before release acceptance.

The full IPADIC notice and exact archived dictionary source are in the sibling `vendor/` directory. The executable embeds the dictionaries and needs no runtime network access. Do not rewrite upstream notice text.
