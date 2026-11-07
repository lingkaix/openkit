import { describe, expect, it } from 'vitest';
import {
  CreateMcpConfigRequestSchema,
  DecideSkillCandidateRequestSchema,
  ImportPluginRequestSchema,
  ImportSkillRequestSchema,
  SubmitSkillCandidateRequestSchema,
} from './index.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const digest = `sha256:${'d'.repeat(64)}`;
const tree = [{ kind: 'file' as const, path: 'SKILL.md', contentBase64: 'IyBTa2lsbAo=' }];

describe('resource catalog request and configuration schemas', () => {
  it('requires exactly one of uploaded tree or ecosystem source on ImportSkillRequestSchema and forbids source selectors without source', () => {
    const fromTree = ImportSkillRequestSchema.parse({
      displayName: 'Deploy Helper',
      expectedRevision: 0,
      id: 'deploy-helper',
      requestId,
      tree,
    });
    expect(fromTree.activate).toBe(true);

    const fromSource = ImportSkillRequestSchema.parse({
      activate: false,
      displayName: 'Deploy Helper',
      expectedRevision: 1,
      requestId,
      source: 'https://example.com/skills.git',
      sourceSubpath: 'skills/deploy',
      sourceSkillName: 'deploy-helper',
    });
    expect(fromSource.activate).toBe(false);

    for (const invalid of [
      {
        displayName: 'Deploy Helper',
        expectedRevision: 0,
        requestId,
      },
      {
        displayName: 'Deploy Helper',
        expectedRevision: 0,
        requestId,
        tree,
        source: 'https://example.com/skills.git',
      },
      {
        displayName: 'Deploy Helper',
        expectedRevision: 0,
        requestId,
        tree,
        sourceSubpath: 'skills/deploy',
      },
      {
        displayName: 'Deploy Helper',
        expectedRevision: 0,
        requestId,
        tree,
        sourceSkillName: 'deploy-helper',
      },
      {
        displayName: 'Deploy Helper',
        expectedRevision: 0,
        id: 'Invalid_Slug',
        requestId,
        tree,
      },
    ]) {
      expect(ImportSkillRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('refuses HTTP MCP declarations with missing or credential-bearing endpoints in CreateMcpConfigRequestSchema', () => {
    const validHttp = {
      allowedTools: ['search'],
      declaration: {
        kind: 'http',
        endpoint: 'https://example.com/v1',
      },
      displayName: 'Example MCP',
      expectedRevision: 0,
      id: 'example-mcp',
      requestId,
    };
    expect(CreateMcpConfigRequestSchema.parse(validHttp).id).toBe('example-mcp');

    for (const invalidDeclaration of [
      { kind: 'http' },
      { kind: 'http', endpoint: 'https://user:pass@example.com/v1' },
      { kind: 'http', endpoint: 'ftp://example.com/v1' },
      { kind: 'http', endpoint: 'not-a-url' },
    ]) {
      expect(
        CreateMcpConfigRequestSchema.safeParse({
          ...validHttp,
          declaration: invalidDeclaration,
        }).success
      ).toBe(false);
    }
  });

  it('enforces sha256 digests, summary bounds, and catalog slug remapping on skill candidate and plugin import requests', () => {
    expect(
      SubmitSkillCandidateRequestSchema.parse({
        baseDigest: null,
        expectedRevision: 2,
        requestId,
        summary: 'Add troubleshooting section',
        tree,
      }).summary
    ).toBe('Add troubleshooting section');

    expect(
      SubmitSkillCandidateRequestSchema.safeParse({
        baseDigest: 'sha256:bad',
        expectedRevision: 2,
        requestId,
        summary: 'Add troubleshooting section',
        tree,
      }).success
    ).toBe(false);

    expect(
      DecideSkillCandidateRequestSchema.parse({
        decision: 'promoted',
        expectedCurrentDigest: digest,
        expectedRevision: 3,
        requestId,
      }).decision
    ).toBe('promoted');

    expect(
      ImportPluginRequestSchema.parse({
        pluginId: 'team-plugin',
        memberIds: { '@scope/pkg': 'scoped-pkg' },
        expectedRevision: 0,
        requestId,
        tree,
      }).install
    ).toBe(true);

    expect(
      ImportPluginRequestSchema.safeParse({
        memberIds: { '@scope/pkg': 'Invalid_Slug' },
        expectedRevision: 0,
        requestId,
        tree,
      }).success
    ).toBe(false);
  });
});
