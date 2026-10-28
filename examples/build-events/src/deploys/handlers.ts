import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { Approvers } from "./approvers.js";
import { DeployRequested, RequestDeploy } from "./Deploys.js";

export const deploys = Action.implement(
  RequestDeploy,
  Effect.gen(function* () {
    const approvers = yield* Approvers;
    const events = yield* Event.Events;

    return ({ environment, version }) =>
      Effect.gen(function* () {
        const member = yield* CurrentMember;

        const deploy = {
          id: crypto.randomUUID(),
          environment,
          version,
          requestedBy: member.id,
          approvers: yield* approvers.standingBy(environment),
        };

        yield* events.publish(DeployRequested, {
          eventId: deploy.id,
          data: deploy,
        });

        return deploy;
      });
  }),
  { authorize: Action.allowAll }
);
