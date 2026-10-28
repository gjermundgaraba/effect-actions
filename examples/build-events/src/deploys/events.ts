import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { Approvers } from "./approvers.js";
import { DeployRequested } from "./Deploys.js";

export const deployEvents = Event.implement(
  DeployRequested,
  Effect.gen(function* () {
    const approvers = yield* Approvers;

    return {
      log: {},
      match: ({ environment }, deploy) =>
        environment === undefined || deploy.environment === environment,
      subscription: ({ environment }) =>
        Effect.flatMap(CurrentMember, (member) =>
          approvers.standBy(environment, member.id)
        ),
    };
  }),
  { authorize: Event.allowAll }
);
