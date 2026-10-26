import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schema } from "effect";
import type { Command } from "effect/cli";
import { TestClock, TestConsole } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as ActionCli from "../../src/cli/ActionCli.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { causeOf, exec, printed } from "../support/cli-services.js";
import { serve } from "../support/serve.js";

const Posted = Event.make("message.posted", {
  description: "A message was posted.",
  input: { channel: Schema.optional(Schema.String) },
  payload: { id: Schema.String, channel: Schema.String, at: Schema.DateTimeUtcFromMillis },
  caller: Action.Anyone,
});

const Changed = Event.make("user.changed", {
  description: "A user of your tenant changed.",
  payload: { by: Schema.String },
  caller: CurrentActor,
});

const Ping = Action.make("ping", {
  description: "Answers pong.",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const Login = Authentication.make("cli-watch.Login", CurrentActor);

const messages = [
  { id: "m1", channel: "general", at: 1000 },
  { id: "m2", channel: "random", at: 2000 },
  { id: "m3", channel: "general", at: 3000 },
];

const posted = Event.implement(Posted, {
  check: ({ channel }, cursor) =>
    Effect.sync(() => ({
      cursor: String(messages.length),
      events: messages
        .slice(cursor === null ? messages.length : Number(cursor))
        .filter((message) => channel === undefined || message.channel === channel)
        .map((message) => ({
          eventId: message.id,
          data: { ...message, at: Schema.decodeSync(Schema.DateTimeUtcFromMillis)(message.at) },
        })),
    })),
});

const changes = Event.implement(
  Changed,
  { check: () => Effect.succeed({ cursor: "0", events: [] }) },
  { authorize: Event.allowAll },
);

const pinged = Action.implement(Ping, () => Effect.succeed("pong"));

const watched = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  args: ReadonlyArray<string>,
  count: number,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(exec(command, args));

    const lines = yield* Effect.repeat(
      Effect.andThen(TestClock.adjust("0 millis"), TestConsole.logLines),
      { until: (logged) => logged.length >= count, times: 100 },
    );

    yield* Fiber.interrupt(fiber);

    return lines;
  }).pipe(Effect.provide(TestConsole.layer, { local: true }));

const Lines = Schema.Array(Schema.fromJsonString(Schema.Unknown));

const general = [
  { _tag: "Occurrence", eventId: "m1", data: { id: "m1", channel: "general", at: 1000 } },
  { _tag: "Occurrence", eventId: "m3", data: { id: "m3", channel: "general", at: 3000 } },
];

describe("a CLI's watch", () => {
  it.effect("prints each occurrence of a local event type as a line of JSON, from a cursor", () =>
    Effect.gen(function* () {
      const cli = ActionCli.make([pinged, posted], { name: "cli" });

      const lines = yield* watched(
        cli,
        ["watch", "message.posted", "--channel", "general", "--cursor", "0"],
        2,
      );

      expect(Schema.decodeUnknownSync(Lines)(lines)).toMatchObject(general);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("prints each occurrence over HTTP, as the server sends it", () =>
    Effect.gen(function* () {
      const Http = ActionHttp.make([Ping, Posted]);

      const web = serve(
        ActionHttp.layer(Http, [pinged, posted]).pipe(Layer.provide(Event.layerMemory)),
      );

      const lines = yield* watched(
        ActionCli.remote(Http, { name: "cli" }),
        ["watch", "message.posted", "--channel", "general", "--cursor", "0"],
        2,
      ).pipe(Effect.provide(Testing.layer(web.handler)));

      expect(Schema.decodeUnknownSync(Lines)(lines)).toMatchObject(general);
    }),
  );

  it.effect("adds a watch for each event type its actions list alone, local and remote", () =>
    Effect.gen(function* () {
      const Http = ActionHttp.make([Ping, Posted, Changed], { authentication: Login });

      const help = <E, R>(cli: Command.Command<string, {}, {}, E, R>) =>
        Effect.map(printed(exec(cli, ["watch", "--help"])), ([, lines]) => lines.join("\n"));

      const helped = yield* Effect.all([
        help(ActionCli.make([pinged, posted, changes], { name: "cli", actions: [Ping, Posted] })),
        help(ActionCli.remote(Http, { name: "cli", actions: [Ping, Posted] })),
        help(ActionCli.remote(Http, { name: "cli", actions: [Ping] })),
      ]).pipe(Effect.provide(Testing.layer(async () => new Response(null, { status: 500 }))));

      expect(
        helped.map((help) => [help.includes("message.posted"), help.includes("user.changed")]),
      ).toEqual([
        [true, false],
        [true, false],
        [false, false],
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails a watch the server refuses as its declared error", () =>
    Effect.gen(function* () {
      const Http = ActionHttp.make([Changed, Posted], { authentication: Login });

      const web = serve(
        ActionHttp.layer(Http, [changes, posted]).pipe(
          Layer.provide(Authentication.layer(Login, verify)),
          Layer.provide(Event.layerMemory),
        ),
      );

      const cli = ActionCli.remote(Http, { name: "cli" });

      const [signedOut] = yield* printed(exec(cli, ["watch", "user.changed"])).pipe(
        Effect.provide(Testing.layer(web.handler)),
      );

      expect(causeOf(signedOut)).toMatchObject({ _tag: "Unauthenticated" });
    }),
  );

  it.effect("prints a local watch's bad input and refusal as their JSON, as an action's", () =>
    Effect.gen(function* () {
      const Limited = Event.make("counter.limited", {
        description: "",
        input: { limit: Schema.Int },
        payload: {},
        caller: Action.Anyone,
      });

      const limited = Event.implement(Limited, {
        check: () => Effect.fail(new Action.Forbidden({ message: "No." })),
      });

      const cli = ActionCli.make([limited], { name: "cli" });

      const [[invalid, , invalidLines], [refused, , refusedLines]] = yield* Effect.all([
        printed(exec(cli, ["watch", "counter.limited", "--limit", "1.5"])),
        printed(exec(cli, ["watch", "counter.limited", "--limit", "1"])),
      ]);

      expect(causeOf(invalid)).toMatchObject({ _tag: "InvalidInput" });
      expect(invalidLines).toEqual([
        expect.stringMatching(/"_tag":"InvalidInput".*"issues":\[\{"path":\["limit"\]/u),
      ]);
      expect(causeOf(refused)).toMatchObject({ _tag: "Forbidden" });
      expect(refusedLines).toEqual([
        expect.stringContaining('{"_tag":"Forbidden","message":"No."}'),
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("builds the one implementation holding the event it watches", () =>
    Effect.gen(function* () {
      const built: Array<string> = [];

      const quiet = (name: string) =>
        Effect.sync(() => {
          built.push(name);

          return { check: () => Effect.succeed({ cursor: "0", events: [] }) };
        });

      const Other = Event.make("other.posted", {
        description: "",
        input: Posted.input.fields,
        payload: Posted.payload.fields,
        caller: Action.Anyone,
      });

      const cli = ActionCli.make(
        [Event.implement(Posted, quiet("posted")), Event.implement(Other, quiet("other"))],
        {
          name: "cli",
        },
      );

      yield* watched(cli, ["watch", "message.posted"], 0);

      expect(built).toEqual(["posted"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it("refuses an event type with a field its cursor flag claims", () => {
    const Cursored = Event.make("cursored.thing", {
      description: "",
      input: { cursor: Schema.String },
      payload: {},
      caller: Action.Anyone,
    });

    expect(() =>
      ActionCli.make([Event.implement(Cursored, { check: () => Effect.die("unused") })], {
        name: "cli",
      }),
    ).toThrow("--cursor");
  });
});
