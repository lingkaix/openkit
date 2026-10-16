// @vitest-environment node

import { createCoreClient } from '@openkit/core-client';
import { expect, it } from 'vitest';
import { isQuestionAnswerResponse } from '../e2e/_lib/question-answer-response.js';

it.each([
  'first answer',
  'second answer',
])('observes the actual question.answer submission for %s', async (name) => {
  const observed: Array<{ request(): { method(): string }; url(): string }> = [];
  const client = createCoreClient({
    baseUrl: 'http://nanocore.test',
    fetch: async (url, init) => {
      const request = new Request(url, init);
      observed.push({ request: () => ({ method: () => request.method }), url: () => request.url });
      return Response.json({
        requestId: 'question_1',
        workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
        threadId: 'th_00000000-0000-70a0-9cde-4561f64881c6',
        state: 'resolved',
        resolution: 'answered',
        ending: null,
      });
    },
  });
  const result = await client.operations['question.answer']({
    workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
    threadId: 'th_00000000-0000-70a0-9cde-4561f64881c6',
    userInputRequestId: 'question_1',
    requestId: name,
    answers: { tone: ['Concise'] },
  });
  expect(result.resolution).toBe('answered');
  expect(observed).toHaveLength(1);
  expect(isQuestionAnswerResponse(observed[0]!)).toBe(true);
  expect(
    isQuestionAnswerResponse({
      request: () => ({ method: () => 'POST' }),
      url: () => 'http://nanocore.test/api/app/operations/turn.start',
    })
  ).toBe(false);
  for (const [method, path] of [
    ['GET', '/api/app/operations/question.answer'],
    ['POST', '/other/api/app/operations/question.answer'],
    ['POST', '/api/app/operations/question.answer-extra'],
  ] as const) {
    expect(
      isQuestionAnswerResponse({
        request: () => ({ method: () => method }),
        url: () => `http://nanocore.test${path}`,
      })
    ).toBe(false);
  }
});
