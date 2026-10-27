import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

import { CurrentCaller } from "../identity/Identity.js";

export const Task = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  assignee: Schema.String,
  addedBy: Schema.String,
  notes: Schema.String,
  done: Schema.Boolean,
});

export type Task = typeof Task.Type;

// A declared error is part of the contract.
export class TaskNotFound extends Schema.TaggedError<
  TaskNotFound,
  { readonly brand: unique symbol }
>()("TaskNotFound", {
  id: Schema.String,
}) {}

// A field's description is what a model reads beside the tool, and the flag's help text.
const Id = Schema.String.annotate({
  description: "The id listed beside the task.",
});

const Assignee = Schema.String.annotate({
  description: "A teammate's name, such as ada.",
});

const team = { caller: CurrentCaller } as const;

export const ListTasks = Action.make("listTasks", {
  ...team,
  description: "List the team's tasks, or one teammate's.",
  input: { assignee: Schema.optionalKey(Assignee) },
  success: { tasks: Schema.Array(Task) },
  readOnly: true,
});

export const AddTask = Action.make("addTask", {
  ...team,
  description: "Add a task and assign it to a teammate.",
  input: {
    title: Schema.String.check(Schema.isMinLength(1)),
    assignee: Assignee,
  },
  success: Task,
  readOnly: false,
});

export const CompleteTask = Action.make("completeTask", {
  ...team,
  description: "Mark a task as done.",
  input: { id: Id },
  success: Task,
  error: TaskNotFound,
  readOnly: false,
});

export const AnnotateTask = Action.make("annotateTask", {
  ...team,
  description: "Replace a task's notes.",
  input: {
    id: Id,
    notes: Schema.String.annotate({ description: "The notes, as plain text." }),
  },
  success: Task,
  error: TaskNotFound,
  readOnly: false,
});

export const Tasks = [ListTasks, AddTask, CompleteTask, AnnotateTask] as const;
