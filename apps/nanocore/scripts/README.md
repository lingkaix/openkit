# NanoCore Operator Scripts

This directory contains NanoCore build-time and stopped-server helpers. `generate-openapi.ts` and `validate-openapi.ts` own the generated App API projection checks, `migrate-workspace-storage.ts` owns explicit storage migration, and `restore-data-root.ts` owns stopped-server restore. Run them only through the package commands documented in the parent [README](../README.md).
