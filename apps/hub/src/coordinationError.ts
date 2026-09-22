/** A typed hub tool failure; `code` and `message` are safe to return to the calling model. */
export class CoordinationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}
