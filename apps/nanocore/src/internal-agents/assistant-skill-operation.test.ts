import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OperationError } from '../operation-error.js';
import {
  ASSISTANT_SKILL_OPERATION_DEFINITIONS,
  AssistantSkillReadInputSchema,
  type AssistantSkillReadOutput,
  AssistantSkillReadOutputSchema,
  AssistantSkillResourceError,
  createAssistantSkillReadTool,
} from './assistant-skill-resources.js';
import type { AgentToolResult } from './internal-agent-loop.js';

const digest = `sha256:${'a'.repeat(64)}`;
const rawInput = { skillId: 'selected-skill', versionId: digest, contentDigest: digest };
const logicalOutput: AssistantSkillReadOutput = {
  skillId: 'selected-skill',
  versionId: digest,
  path: 'SKILL.md',
  fileDigest: `sha256:${'b'.repeat(64)}`,
  text: 'Retained guidance.',
};

/** Decodes the existing bounded Tool envelope without treating a refusal as success. */
function envelope(result: AgentToolResult, error = false) {
  expect(result.isError === true).toBe(error);
  expect(result.content).toHaveLength(1);
  const content = result.content[0]!;
  expect(content.type).toBe('text');
  if (content.type !== 'text') throw new Error('The Skill Tool returns text only.');
  expect(Buffer.byteLength(content.text, 'utf8')).toBeLessThanOrEqual(65_536);
  return JSON.parse(content.text);
}

/** Fixes safe model failure meaning independently from thrown private error fields. */
function refusal(result: AgentToolResult, code = 'resource_unavailable') {
  const messages: Record<string, string> = {
    resource_unavailable: 'Selected Skill resources are unavailable.',
    resource_access_denied: 'Skill resource access is denied.',
    invalid_skill_read: 'The Skill read does not match an admitted relative file.',
    skill_content_integrity_failed: 'The selected Skill content failed integrity checks.',
    skill_content_too_large: 'The Skill content exceeds the response size limit.',
  };
  expect(envelope(result, true)).toEqual({ code, message: messages[code] });
}

function execution() {
  return { callId: 'model-call-correlation', signal: new AbortController().signal };
}

describe('private Skill read declaration', () => {
  it('owns exact strict logical schemas, default path, catalog IDs and canonical digests', () => {
    expect(AssistantSkillReadInputSchema.parse(rawInput)).toEqual({
      ...rawInput,
      path: 'SKILL.md',
    });
    expect(AssistantSkillReadOutputSchema.parse(logicalOutput)).toEqual(logicalOutput);
    expect(Object.keys(AssistantSkillReadInputSchema.shape).sort()).toEqual([
      'contentDigest',
      'path',
      'skillId',
      'versionId',
    ]);
    expect(Object.keys(AssistantSkillReadOutputSchema.shape).sort()).toEqual([
      'fileDigest',
      'path',
      'skillId',
      'text',
      'versionId',
    ]);
    for (const skillId of ['', 'UPPER', 'two_words', '../outside', '-leading', 'trailing-']) {
      expect(AssistantSkillReadInputSchema.safeParse({ ...rawInput, skillId }).success).toBe(false);
      expect(AssistantSkillReadOutputSchema.safeParse({ ...logicalOutput, skillId }).success).toBe(
        false
      );
    }
    for (const invalidDigest of [
      '',
      'a'.repeat(64),
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
    ]) {
      for (const field of ['versionId', 'contentDigest'])
        expect(
          AssistantSkillReadInputSchema.safeParse({ ...rawInput, [field]: invalidDigest }).success
        ).toBe(false);
      for (const field of ['versionId', 'fileDigest'])
        expect(
          AssistantSkillReadOutputSchema.safeParse({ ...logicalOutput, [field]: invalidDigest })
            .success
        ).toBe(false);
    }
    expect(AssistantSkillReadInputSchema.safeParse({ ...rawInput, path: '' }).success).toBe(false);
    expect(
      AssistantSkillReadInputSchema.safeParse({ ...rawInput, workspaceId: 'model-authority' })
        .success
    ).toBe(false);
    expect(
      AssistantSkillReadOutputSchema.safeParse({ ...logicalOutput, content: [] }).success
    ).toBe(false);
    expect(AssistantSkillReadOutputSchema.safeParse({ ...logicalOutput, path: '' }).success).toBe(
      false
    );
  });

  it('declares only the internal read and derives its Tool name, description and model schema', () => {
    expect(Object.keys(ASSISTANT_SKILL_OPERATION_DEFINITIONS)).toEqual(['skill.read']);
    const definition = ASSISTANT_SKILL_OPERATION_DEFINITIONS['skill.read'];
    expect(definition).toMatchObject({
      binding: 'internal',
      entryScope: 'conversation.submit',
      policyOperation: 'workspace.read',
      mutating: false,
      description:
        'Read one UTF-8 text file from an exact selected Skill. Loading text executes no code.',
    });
    expect(definition.inputSchema).toBe(AssistantSkillReadInputSchema);
    expect(definition.outputSchema).toBe(AssistantSkillReadOutputSchema);
    const invoke = vi.fn().mockResolvedValue(logicalOutput);
    const tool = createAssistantSkillReadTool(invoke);
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(definition.inputSchema, {
      io: 'input',
    });
    expect(tool.name).toBe('skill.read');
    expect(tool.description).toBe(definition.description);
    expect(tool.inputSchema).toEqual(inputSchema);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect([...(tool.inputSchema.required as string[])].sort()).toEqual([
      'contentDigest',
      'skillId',
      'versionId',
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('definition-derived Skill model projection', () => {
  it('calls only the supplied invoker with unchanged logical args and Tool context', async () => {
    const invoke = vi.fn().mockResolvedValue(logicalOutput);
    const tool = createAssistantSkillReadTool(invoke);
    const context = execution();

    const result = await tool.execute(rawInput, context);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0]).toBe(rawInput);
    expect(invoke.mock.calls[0]![1]).toBe(context);
    expect(rawInput).not.toHaveProperty('path');
    expect(envelope(result)).toEqual(logicalOutput);
  });

  it.each([
    { label: 'extra output authority', value: { ...logicalOutput, workspaceId: 'untrusted' } },
    { label: 'invalid digest', value: { ...logicalOutput, fileDigest: 'unverified' } },
    { label: 'missing output text', value: { ...logicalOutput, text: undefined } },
    {
      label: 'model envelope instead of logical output',
      value: { content: [{ type: 'text', text: 'not logical' }] },
    },
    {
      label: 'serialized output above 64 KiB',
      expectedCode: 'skill_content_too_large',
      value: { ...logicalOutput, text: 'x'.repeat(65_536) },
    },
    {
      label: 'output the loop sanitizer would change',
      value: { ...logicalOutput, path: 'references/SK-guidance.md' },
    },
  ])('refuses $label without forwarding private output', async ({ value, expectedCode }) => {
    const invoke = vi.fn().mockResolvedValue(value);

    const result = await createAssistantSkillReadTool(invoke).execute(rawInput, execution());

    refusal(result, expectedCode);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('keeps a complete large valid output without truncation', async () => {
    const output = { ...logicalOutput, text: 'x'.repeat(63_000) };
    const result = await createAssistantSkillReadTool(async () => output).execute(
      rawInput,
      execution()
    );

    expect(envelope(result)).toEqual(output);
  });

  it('preserves an owner resource failure as its bounded safe code and message', async () => {
    const result = await createAssistantSkillReadTool(async () => {
      throw new AssistantSkillResourceError('skill_content_integrity_failed');
    }).execute(rawInput, execution());

    refusal(result, 'skill_content_integrity_failed');
  });

  it.each([
    ['invalid_request', 'invalid_skill_read'],
    ['invalid_operation_input', 'invalid_skill_read'],
    ['bound_input_conflict', 'resource_access_denied'],
    ['workspace_access_denied', 'resource_access_denied'],
    ['core.auth.unauthenticated', 'resource_access_denied'],
    ['other_private_engine_code', 'resource_unavailable'],
  ] as const)('maps known nominal operation failure %s without exposing private fields', async (code, expected) => {
    const failure = new OperationError(code, '/private/path source-content-canary', 403, {
      details: { private: 'details-canary' },
      path: ['private-path-canary'],
      cause: new Error('cause-canary'),
    });
    const result = await createAssistantSkillReadTool(async () => {
      throw failure;
    }).execute(rawInput, execution());

    refusal(result, expected);
    expect(JSON.stringify(result)).not.toMatch(/canary|private\/path/);
  });

  it.each([
    new Error('/private/path unknown-exception-canary'),
    { code: 'workspace_access_denied', message: 'forged-error-canary', status: 403 },
  ])('does not trust unknown exceptions or structural OperationError lookalikes', async (failure) => {
    const result = await createAssistantSkillReadTool(async () => {
      throw failure;
    }).execute(rawInput, execution());

    refusal(result);
    expect(JSON.stringify(result)).not.toContain('canary');
  });

  it('preserves cancellation before invocation with zero invoker contact', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled.');
    controller.abort(reason);
    const invoke = vi.fn().mockResolvedValue(logicalOutput);

    await expect(
      createAssistantSkillReadTool(invoke).execute(rawInput, {
        callId: 'aborted',
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a late successful invoker result after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('Caller cancelled in flight.');
    let settle!: (output: AssistantSkillReadOutput) => void;
    const invoke = vi.fn(
      () =>
        new Promise<AssistantSkillReadOutput>((resolve) => {
          settle = resolve;
        })
    );
    const running = createAssistantSkillReadTool(invoke).execute(rawInput, {
      callId: 'late',
      signal: controller.signal,
    });
    controller.abort(reason);
    settle(logicalOutput);

    await expect(running).rejects.toBe(reason);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
