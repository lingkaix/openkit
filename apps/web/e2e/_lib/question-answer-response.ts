/** Matches the browser submission itself; worker continuation creates no browser turn.start request. */
export function isQuestionAnswerResponse(response: {
  request(): { method(): string };
  url(): string;
}): boolean {
  return (
    response.request().method() === 'POST' &&
    response.url().endsWith('/api/app/operations/question.answer')
  );
}
