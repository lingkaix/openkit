import { runCancelledAdmissionCheckpointCleanupCli } from '../src/runtime/cancelled-admission-checkpoint-cleanup.js';

try {
  await runCancelledAdmissionCheckpointCleanupCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
