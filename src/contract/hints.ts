import type * as Action from "./Action.js";

/**
 * An action's MCP tool hints, MCP's defaults where its `mcp` leaves one out: a write destructive,
 * a read not, no tool idempotent and every tool open-world. A given value passes through, as MCP
 * calls `destructiveHint` and `idempotentHint` meaningless on a read-only tool.
 */
export const hintsOf = ({ readOnly, mcp }: Action.Any) => ({
  readOnlyHint: readOnly,
  destructiveHint: mcp.destructiveHint ?? !readOnly,
  idempotentHint: mcp.idempotentHint ?? false,
  openWorldHint: mcp.openWorldHint ?? true,
});
