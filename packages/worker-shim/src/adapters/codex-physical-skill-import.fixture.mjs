// Use the actual fixed helper with the same root substitution as its local contract tests.
import {
  CANONICAL_SLOT_ROOTS,
  runFileEffect,
} from '../../../../containers/workers/openkit-file-effect';

const [supplyRoot, ...argv] = process.argv.slice(2);
process.exitCode = await runFileEffect({
  argv,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  slotRoots: { ...CANONICAL_SLOT_ROOTS, 'worker-supply': supplyRoot },
});
