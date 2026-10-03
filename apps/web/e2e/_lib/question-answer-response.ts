/** Matches the exact question.answer POST; worker continuation creates no browser turn.start request. */
export function isQuestionAnswerResponse(response: {
  request(): { method(): string };
  url(): string;
}): boolean {
  return (
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/app/operations/question.answer'
  );
}
