# Knowledge Format

This directory owns the portable OKF Markdown parser and OpenKit workspace knowledge-profile validation.

## Boundaries

- `okf.ts` parses frontmatter, derives concept identity, validates conformance levels, and rejects secret-shaped fields.
- Knowledge routes, ledgers, retrieval, indexes, and portable file storage remain with their existing feature and storage owners.
- Keep parsing deterministic and independent of database, provider, and HTTP concerns.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/knowledge` and the affected Knowledge Store tests.

See [Research Cookbook](../../../../docs/cookbooks/research.md).
