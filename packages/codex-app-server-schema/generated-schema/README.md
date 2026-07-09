# Codex App Server Schema

This directory contains generated JSON Schema for the `codex app-server` JSON-RPC surface used by the NanoCore host adapter.

Generated with:

```bash
codex --version
codex app-server generate-json-schema --out generated-schema
```

Current generator version:

```text
codex-cli 0.134.0
```

Keep these files inside `@openkit/codex-app-server-schema`. They document the external worker runtime boundary and should not be moved into `packages/protocol`, which remains the UI-to-Core protocol package.
