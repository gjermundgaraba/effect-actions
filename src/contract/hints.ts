import type * as Action from "./Action.js";

export const hintsOf = ({ readOnly, mcp }: Action.Any) => ({
  readOnlyHint: readOnly,
  destructiveHint: mcp.destructiveHint ?? !readOnly,
  idempotentHint: mcp.idempotentHint ?? false,
  openWorldHint: mcp.openWorldHint ?? true,
});
