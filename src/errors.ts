export type ErrorCode =
  | "TAKE_NOT_FOUND"
  | "SHOT_NOT_FOUND"
  | "INVALID_SHOTLIST"
  | "NO_SHOTLIST"
  | "NO_PLAN"
  | "ELEMENT_NOT_FOUND"
  | "TIME_OUT_OF_RANGE"
  | "RENDER_FAILED"
  | "CAPTURE_FAILED"
  | "FFMPEG_MISSING"
  | "BUSY"
  | "NOT_IMPLEMENTED"
  | "BAD_INPUT";

export interface ToolErrorBody {
  ok: false;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }

  toJSON(): ToolErrorBody {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }

  toToolText(): string {
    return JSON.stringify(this.toJSON());
  }
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}
