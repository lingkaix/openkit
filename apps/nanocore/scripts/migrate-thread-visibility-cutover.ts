import { runThreadVisibilityCutoverMigrationCli } from '../src/storage/thread-visibility-cutover-migration.js';

try {
  runThreadVisibilityCutoverMigrationCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
