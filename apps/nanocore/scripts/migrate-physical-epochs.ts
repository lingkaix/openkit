import { runPhysicalEpochMigrationCli } from '../src/storage/physical-epoch-cutover.js';

try {
  runPhysicalEpochMigrationCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
