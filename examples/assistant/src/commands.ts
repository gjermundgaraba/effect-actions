import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";

import { identity } from "./identity/handlers.js";
import { tasks } from "./tasks/handlers.js";

export const commands = ActionCli.make([tasks, identity], {
  name: "assistant",
  commands: {
    listTasks: {
      description:
        "Print one line per task: [x] when done, then its id, title and assignee.",
      aliases: { assignee: "a" },
      render: ({ tasks: listed }) =>
        listed
          .map(
            (task) =>
              `${task.done ? "[x]" : "[ ]"} ${task.id} ${task.title} (${task.assignee})`
          )
          .join("\n"),
    },
    completeTask: { positional: ["id"] },
    annotateTask: { stdin: "notes" },
  },
});
