export const serverInfo = {
  name: "print-farm",
  version: "1.0.0",
  instructions:
    "Tools for one 3D print farm. Printer ids come from list_printers; call it first. When a " +
    "print may have failed, look at it with get_camera_snapshot and pause it with set_paused " +
    "while deciding. cancel_print cannot be undone: ask the user before cancelling.",
};
