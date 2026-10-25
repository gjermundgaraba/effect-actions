import { Effect } from "effect";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { CurrentMember } from "../identity/Identity.js";
import { PipelineStatus } from "./Builds.js";
import { BuildStore } from "./store.js";

// A current source: the value as it is, which the library sends first and again after each
// notify reaching the subscriber's key, keeping the revision that tells them apart, so the store
// keeps no cursor for it. The key is the pipeline: a build of another wakes no one here.
export const statusEvents = Event.implement(
  PipelineStatus,
  Effect.gen(function* () {
    const store = yield* BuildStore;

    return {
      current: ({ pipeline }) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;

          return { status: yield* store.statusOf(member.pipelines, pipeline) };
        }),
      key: ({ pipeline }) => pipeline,
    };
  }),
  // Every member may watch; which pipelines each sees is the store's check.
  { authorize: Event.allowAll },
);
