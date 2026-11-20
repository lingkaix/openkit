# NanoHost storage journal

This journal provisions `server/extensions/nanohost/state.sqlite` under the Data Root. Its baseline owns transport identities and token records, native target and session placement, Worker receipts and sequence evidence, image results, and persistent storage associations.

The NanoCore owner descriptor [`nanoHostStoreDescriptor`](../../../src/storage/nanohost-store-descriptor.ts) lists the tables required for serving. The shared storage worker controls provisioning, existing-only serving opens and the durable commit acknowledgement. Kernel grants and work-owner publication remain with their existing owners. The five foreign keys in this journal connect only NanoHost tables.

This baseline is staged for the v0.2.0 fresh-root cutover. The serving switch requires the shared worker and the NanoHost handlers to use the admitted extension owner.
