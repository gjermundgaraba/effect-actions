import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { CurrentMember } from "../identity/Identity.js";

const Pipeline = Schema.String.annotate({ description: "A pipeline's name, such as api." });

const Status = Schema.Literals(["passed", "failed"]).annotate({
  description: "How the build ended.",
});

export const Build = Schema.Struct({ id: Schema.String, pipeline: Pipeline, status: Status });

export type Build = typeof Build.Type;

// DEMO ONLY: a CI runner reports finished builds; here a member does, so the example can
// cause the event it watches.
export const FinishBuild = Action.make("finishBuild", {
  description: "Record that a build of a pipeline finished.",
  input: { pipeline: Pipeline, status: Status },
  success: Build,
  readOnly: false,
  caller: CurrentMember,
});

// A build run here, which reports each step as it starts, before it answers how the build ended.
// A caller reads the steps only if it asks, with `onProgress`; each surface carries them its
// own way. They are a snapshot to show: a caller falling behind misses some, never the answer.
// What a caller must see every time is the answer, or `build.finished`, which this build causes.
export const StartBuild = Action.make("startBuild", {
  description: "Run a build of a pipeline, reporting each step, and record how it ended.",
  input: { pipeline: Pipeline },
  success: Build,
  progress: {
    step: Schema.String.annotate({ description: "The step that started, such as test." }),
    done: Schema.Finite.annotate({ description: "How many steps finished before it." }),
    total: Schema.Finite.annotate({ description: "How many steps the build has." }),
  },
  readOnly: false,
  caller: CurrentMember,
});

// A build this member may not see is not found, as one that never ran: its id tells nothing.
export class BuildNotFound extends Schema.TaggedError<BuildNotFound>()(
  "BuildNotFound",
  { buildId: Schema.String },
  { httpApiStatus: 404 },
) {}

// An action answering a stream: its handler returns a `Stream` of lines, and every client's
// call returns one, each line arriving as the server sends it. HTTP, RPC and a command carry a
// stream; an MCP tool answers one result, the lines collected once the stream ends, so the MCP
// endpoint in `routes.ts` leaves it out rather than put a whole log in a model's context.
export const TailLog = Action.make("tailLog", {
  description: "Stream a build's log, line by line.",
  input: {
    buildId: Schema.String.annotate({ description: "The build's id, such as build-1." }),
  },
  success: Action.Stream({ line: Schema.String }),
  error: BuildNotFound,
  readOnly: true,
  caller: CurrentMember,
});

// An event type: what a subscription takes, what each occurrence carries, and who may
// subscribe. Like an action's contract, it imports no server code.
export const BuildFinished = Event.make("build.finished", {
  description: "A build of a pipeline you may see finished.",
  input: {
    pipeline: Schema.optional(Pipeline).annotate({ description: "Only this pipeline's builds." }),
    status: Schema.optional(Status).annotate({ description: "Only builds that ended so." }),
  },
  payload: Build,
  caller: CurrentMember,
});

// An event whose occurrence is the whole value: how a pipeline's last build ended, `null` before
// its first. A subscriber is sent it as it is, then again each time a build of it finishes.
export const PipelineStatus = Event.make("pipeline.status", {
  description: "How a pipeline's last build ended: first as it is, then each time one finishes.",
  input: { pipeline: Pipeline },
  payload: {
    status: Schema.NullOr(Status).annotate({ description: "How it ended; null before any did." }),
  },
  caller: CurrentMember,
});
