import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { CurrentMember } from "../identity/Identity.js";

export const Environment = Schema.Literals(["staging", "production"]).annotate({
  description: "Where to deploy.",
});

export type Environment = typeof Environment.Type;

export const Deploy = Schema.Struct({
  id: Schema.String,
  environment: Environment,
  version: Schema.String,
  requestedBy: Schema.String,
  approvers: Schema.Array(Schema.String).annotate({
    description: "The members watching its environment when it was requested, asked to approve it.",
  }),
});

export type Deploy = typeof Deploy.Type;

export const RequestDeploy = Action.make("requestDeploy", {
  description: "Ask for a version to be deployed to an environment.",
  input: { environment: Environment, version: Schema.String },
  success: Deploy,
  readOnly: false,
  caller: CurrentMember,
});

export const DeployRequested = Event.make("deploy.requested", {
  description:
    "Someone asked for a deploy. Watching an environment stands you by to approve its deploys.",
  input: {
    environment: Schema.optional(Environment).annotate({ description: "Only deploys to here." }),
  },
  payload: Deploy,
  caller: CurrentMember,
});
