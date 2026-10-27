import { expectTypeOf } from "@effect/vitest";
import { Context, Effect, Schema, Stream } from "effect";
import type { Command } from "effect/cli";
import { HttpClient } from "effect/http";

import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";

const Tail = Action.make("tail", {
  description: "Follow a log.",
  success: Action.Stream({ line: Schema.String }),
  readOnly: true,
  caller: Action.Anyone,
});

const tails = Action.implement(Tail, () => Stream.make({ line: "" }));

ActionCli.command(tails, Tail, {
  render: (element) => {
    expectTypeOf(element).toEqualTypeOf<{ readonly line: string }>();

    return element.line;
  },
});

class Region extends Context.Service<Region, string>()("stream-types/Region") {}

class Gone extends Schema.TaggedError<
  Gone,
  { readonly brand: unique symbol }
>()("Gone", {}) {}

const Follow = Action.make("follow", {
  description: "Follow a log until it is gone.",
  success: Action.Stream(Schema.String),
  error: Gone,
  readOnly: true,
  caller: Action.Anyone,
});

const Http = ActionHttp.make([Follow]);

const client = ActionHttp.client(Http, {
  transformClient: HttpClient.mapRequestEffect((request) =>
    Effect.as(Region, request)
  ),
});

const remoteOne = ActionCli.remoteCommand(Http, Follow, { client });

const remoteAll = ActionCli.remote(Http, { name: "logs", client });

expectTypeOf<Gone>().toExtend<
  Extract<Command.Error<typeof remoteOne>, ActionCli.UserError>["cause"]
>();

expectTypeOf<Gone>().toExtend<
  Extract<Command.Error<typeof remoteAll>, ActionCli.UserError>["cause"]
>();

expectTypeOf<Command.Services<typeof remoteOne>>().toEqualTypeOf<
  HttpClient.HttpClient | Region
>();

expectTypeOf<Command.Services<typeof remoteAll>>().toEqualTypeOf<
  HttpClient.HttpClient | Region
>();
