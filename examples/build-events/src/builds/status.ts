import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { PipelineStatus } from "./Builds.js";
import { BuildStore } from "./store.js";

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
  { authorize: Event.allowAll }
);
