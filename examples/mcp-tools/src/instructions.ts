// What the server tells a client of itself, on either transport: `server.ts` and `stdio.ts`
// both give it. `instructions` are for the model, as the tools' descriptions are: what the
// tools are for together, and what to be careful with. A client shows them to the model once,
// when it connects.
export const serverInfo = {
  name: "print-farm",
  version: "1.0.0",
  instructions:
    "Tools for one 3D print farm. Printer ids come from list_printers; call it first. When a " +
    "print may have failed, look at it with get_camera_snapshot and pause it with set_paused " +
    "while deciding. cancel_print cannot be undone: ask the user before cancelling.",
};
