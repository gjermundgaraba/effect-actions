import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Schema } from "effect";

import { CurrentMember } from "../identity/Identity.js";

const Pipeline = Schema.String.annotate({
  description: "A pipeline's name, such as api.",
});

const Status = Schema.Literals(["passed", "failed"]).annotate({
  description: "How the build ended.",
});

export const Build = Schema.Struct({
  id: Schema.String,
  pipeline: Pipeline,
  status: Status,
});

export type Build = typeof Build.Type;

export const FinishBuild = Action.make("finishBuild", {
  description: "Record that a build of a pipeline finished.",
  input: { pipeline: Pipeline, status: Status },
  success: Build,
  readOnly: false,
  caller: CurrentMember,
});

export const StartBuild = Action.make("startBuild", {
  description:
    "Run a build of a pipeline, reporting each step, and record how it ended.",
  input: { pipeline: Pipeline },
  success: Build,
  progress: {
    step: Schema.String.annotate({
      description: "The step that started, such as test.",
    }),
    done: Schema.Finite.annotate({
      description: "How many steps finished before it.",
    }),
    total: Schema.Finite.annotate({
      description: "How many steps the build has.",
    }),
  },
  readOnly: false,
  caller: CurrentMember,
});

export class BuildNotFound extends Schema.TaggedError<
  BuildNotFound,
  { readonly brand: unique symbol }
>()("BuildNotFound", { buildId: Schema.String }, { httpApiStatus: 404 }) {}

export const TailLog = Action.make("tailLog", {
  description: "Stream a build's log, line by line.",
  input: {
    buildId: Schema.String.annotate({
      description: "The build's id, such as build-1.",
    }),
  },
  success: Action.Stream({ line: Schema.String }),
  error: BuildNotFound,
  readOnly: true,
  caller: CurrentMember,
});

export const BuildFinished = Event.make("build.finished", {
  description: "A build of a pipeline you may see finished.",
  input: {
    pipeline: Schema.optional(Pipeline).annotate({
      description: "Only this pipeline's builds.",
    }),
    status: Schema.optional(Status).annotate({
      description: "Only builds that ended so.",
    }),
  },
  payload: Build,
  caller: CurrentMember,
});

export const PipelineStatus = Event.make("pipeline.status", {
  description:
    "How a pipeline's last build ended: first as it is, then each time one finishes.",
  input: { pipeline: Pipeline },
  payload: {
    status: Schema.NullOr(Status).annotate({
      description: "How it ended; null before any did.",
    }),
  },
  caller: CurrentMember,
});
