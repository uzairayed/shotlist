import { isToolError, ToolError } from "./errors.js";

export function toolErrorResult(err: unknown) {
  if (isToolError(err)) {
    return {
      content: [{ type: "text" as const, text: err.toToolText() }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const body = new ToolError("BAD_INPUT", message);
  return {
    content: [{ type: "text" as const, text: body.toToolText() }],
    isError: true,
  };
}

export function okResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}
