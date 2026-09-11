/**
 * Domain error with a machine-readable code and an actionable message.
 * Tools convert it into an MCP error result; the REST layer maps it to an HTTP status.
 */
export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "conflict"
  | "invalid"
  | "wip_limit";

export class EmberError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, hint?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EmberError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  httpStatus(): number {
    switch (this.code) {
      case "unauthorized":
        return 401;
      case "forbidden":
        return 403;
      case "not_found":
        return 404;
      case "conflict":
      case "wip_limit":
        return 409;
      case "invalid":
        return 400;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }

  toText(): string {
    const parts = [`Error [${this.code}]: ${this.message}`];
    if (this.hint) parts.push(`Hint: ${this.hint}`);
    return parts.join("\n");
  }
}

export const notFound = (what: string, hint?: string) => new EmberError("not_found", what, hint);
export const forbidden = (msg: string, hint?: string) => new EmberError("forbidden", msg, hint);
export const conflict = (msg: string, hint?: string, details?: Record<string, unknown>) =>
  new EmberError("conflict", msg, hint, details);
export const invalid = (msg: string, hint?: string) => new EmberError("invalid", msg, hint);
