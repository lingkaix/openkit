import { runDataRootRestoreCli } from '../src/storage/data-root-restore-cli.js';

try {
  runDataRootRestoreCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
