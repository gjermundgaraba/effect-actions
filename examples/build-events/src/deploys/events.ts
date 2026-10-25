import { Effect } from "effect";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { CurrentMember } from "../identity/Identity.js";
import { Approvers } from "./approvers.js";
import { DeployRequested } from "./Deploys.js";

// A log source, for occurrences nothing else keeps: the library keeps each one `requestDeploy`
// publishes, for 10 minutes and at most 10,000 of them by default, and gives each subscriber
// what its `match` accepts. A subscriber resuming from a cursor gets what the log still holds:
// after a restart, or once its occurrences are dropped, a gap first. An upstream you can ask
// "what since?", such as a table, is a check source.
export const deployEvents = Event.implement(
  DeployRequested,
  Effect.gen(function* () {
    const approvers = yield* Approvers;

    return {
      log: {},
      match: ({ environment }, deploy) =>
        environment === undefined || deploy.environment === environment,
      // Set up while each subscription lasts, as the subscriber: a stream's as long as it is
      // read, a poll's until 5 minutes after its last poll. It may run again for one
      // subscription, after a restart, so standing by twice must be harmless.
      subscription: ({ environment }) =>
        Effect.flatMap(CurrentMember, (member) => approvers.standBy(environment, member.id)),
    };
  }),
  { authorize: Event.allowAll },
);
