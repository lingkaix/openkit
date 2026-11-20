# Server work journal

This journal owns Server Threads, Turns, product entries, work observations, capability calls, usage records and evidence bundles. Its database is `server/services/server-work/state.sqlite` relative to the Data Root. `0000_baseline.sql` is the v0.2.0 fresh-install baseline. The supporting `server_work_intents` table retains original drafts and settlement receipts so publication and receipt commit together. The journal preserves the Server variants of the file-local constraints, indexes and triggers.

The shared storage lifecycle applies this journal during authorized provisioning and checks for its required tables before admitting an existing file. The required table descriptor is in `src/storage/server-work-schema.ts`. Core and Workspace use their own journals.

Run `pnpm --filter @openkit/nanocore exec vitest run src/storage/server-work-schema.test.ts` to apply the packaged journal and verify its table boundary, Turn and product ordering, and the Call digest predicate.
