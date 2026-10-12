/** A problem the user can fix (empty text, bad address...). Shown as a message, not a crash. */
export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}
