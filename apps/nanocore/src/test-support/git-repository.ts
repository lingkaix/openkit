import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Seeds one writable Git repository with a resolvable HEAD commit.
 *
 * @param repositoryPath Host-local repository root.
 */
export function seedWritableGitRepository(repositoryPath: string): void {
  execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
    cwd: repositoryPath,
  });
  execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
  writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
  execFileSync('git', ['commit', '-m', 'initial'], {
    cwd: repositoryPath,
    stdio: 'ignore',
  });
}
