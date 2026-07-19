import { runWorkspaceStorageMigrationCli } from '../src/storage/workspace-storage-migration-cli.js';

try {
  runWorkspaceStorageMigrationCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
