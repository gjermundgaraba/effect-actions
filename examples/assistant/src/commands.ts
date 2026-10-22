import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { identity } from "./identity/handlers.js";
import { tasks } from "./tasks/handlers.js";

// The same implementations as local commands, `assistant <action>`: a command runs the handler
// in this process, behind the same `authorize`. `add-task` and `who-am-i` are as derived; the
// others each change their syntax or output.
export const commands = ActionCli.make([tasks, identity], {
  name: "assistant",
  commands: {
    // `assistant list-tasks -a ada`: a short flag beside `--assignee`. `render` prints a line
    // per task for a person, and adds `--json` for the JSON a script reads. `description` is the
    // command's help, saying what a line holds; the action's stays what a model reads.
    listTasks: {
      description: "Print one line per task: [x] when done, then its id, title and assignee.",
      aliases: { assignee: "a" },
      render: ({ tasks }) =>
        tasks
          .map((task) => `${task.done ? "[x]" : "[ ]"} ${task.id} ${task.title} (${task.assignee})`)
          .join("\n"),
    },
    // `assistant complete-task 2`: an argument instead of `--id 2`.
    completeTask: { positional: ["id"] },
    // `assistant annotate-task --id 2 < notes.md`: the notes are piped in, not a flag.
    annotateTask: { stdin: "notes" },
  },
});
