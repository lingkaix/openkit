import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const developerSetupSkillPath = new URL('../../skills/openkit-setup-dev/SKILL.md', import.meta.url);
const userSetupSkillPath = new URL('../../skills/openkit-setup/SKILL.md', import.meta.url);
const developerLoopSkillPath = new URL('../../skills/openkit-loop-dev/SKILL.md', import.meta.url);
const userLoopSkillPath = new URL('../../skills/openkit-loop/SKILL.md', import.meta.url);

describe('OpenKit Skill artifacts', () => {
  it('documents the developer dogfood setup path and loop handoff', () => {
    const skill = readFileSync(developerSetupSkillPath, 'utf8');

    expect(skill).toContain('name: openkit-setup-dev');
    expect(skill).toContain('bash scripts/repo-init.sh');
    expect(skill).toContain('pnpm --filter @openkit/nanocore dev');
    expect(skill).toContain('pnpm --filter @openkit/mcp smoke:nanocore');
    expect(skill).toContain('openkit.read_status');
    expect(skill).toContain('openkit.link_repository');
    expect(skill).toContain('openkit-loop-dev');
    expect(skill).toContain('docs/changes/');
  });

  it('documents the developer review-gated loop workflow', () => {
    const skill = readFileSync(developerLoopSkillPath, 'utf8');

    expect(skill).toContain('name: openkit-loop-dev');
    expect(skill).toContain('openkit.draft_goal_plan');
    expect(skill).toContain('openkit.start_chat');
    expect(skill).toContain('openkit.start_task');
    expect(skill).toContain('openkit.step_goal');
    expect(skill).toContain('openkit.read_runtime_diagnostics');
    expect(skill).toContain('openkit.read_action_center');
    expect(skill).toContain('openkit.read_workspace_reviews');
    expect(skill).toContain('openkit://workspaces/{workspaceId}/evidence-bundles');
    expect(skill).not.toContain('openkit.create_evidence_bundle');
    expect(skill).toContain('Do not implement unattended recursive self-modification.');
  });

  it('documents the end-user local and remote backend setup paths', () => {
    const skill = readFileSync(userSetupSkillPath, 'utf8');

    expect(skill).toContain('name: openkit-setup');
    expect(skill).toContain('local NanoCore backend');
    expect(skill).toContain('remote NanoCore backend');
    expect(skill).toContain('standard stdio MCP');
    expect(skill).toContain('OPENKIT_NANOCORE_URL');
    expect(skill).toContain('openkit.read_status');
    expect(skill).toContain('openkit-loop');
  });

  it('documents the end-user bounded loop workflow', () => {
    const skill = readFileSync(userLoopSkillPath, 'utf8');

    expect(skill).toContain('name: openkit-loop');
    expect(skill).toContain('openkit.start_chat');
    expect(skill).toContain('openkit.start_task');
    expect(skill).toContain('openkit.start_goal');
    expect(skill).toContain('openkit.read_runtime_diagnostics');
    expect(skill).toContain('openkit.read_action_center');
    expect(skill).toContain('openkit.read_workspace_reviews');
    expect(skill).toContain('openkit://workspaces/{workspaceId}/evidence-bundles');
    expect(skill).not.toContain('openkit.create_evidence_bundle');
    expect(skill).toContain(
      'Ask the human before approving plans, resolving Action Center rows, accepting results, rejecting results, extending budgets, spending provider quota, changing workspace files, calling external services, committing, pushing, publishing, deploying, or triggering external side effects.'
    );
  });
});
