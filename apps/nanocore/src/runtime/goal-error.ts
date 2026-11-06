/** Domain-owned outcomes, preserved by every projection. */
export class GoalCommandError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}
