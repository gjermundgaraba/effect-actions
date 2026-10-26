import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Logger,
  Queue,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { McpSchema } from "effect/ai";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { as, initializeParams, sessionRequest } from "../support/requests.js";
import { Posted, settle } from "../support/events.js";
import { recorder } from "../support/reporter.js";
import { Json } from "../support/sse.js";
import { transcript } from "../support/stdio-host.js";
import { statelessRequest } from "../../src/mcp/request.js";

const Changed = Event.make("user.changed", {
  description: "A user of your tenant changed.",
  payload: { by: Schema.String },
  caller: CurrentActor,
});

const Login = Authentication.make("events.Login", CurrentActor, {
  principal: (actor) => actor.id,
});

const authenticate = Authentication.layer(Login, verify);

const makeLog = () => {
  const messages: Array<typeof Posted.payload.Type> = [];

  const post = (channel: string, text: string) =>
    Effect.sync(() => messages.push({ id: `m${messages.length + 1}`, channel, text }));

  const check = ({ channel }: typeof Posted.input.Type, cursor: string | null) =>
    Effect.sync(() => ({
      cursor: String(messages.length),
      events: messages
        .slice(cursor === null ? messages.length : Number(cursor))
        .filter((message) => channel === undefined || message.channel === channel)
        .map((data) => ({ eventId: data.id, data })),
    }));

  return { post, posted: Event.implement(Posted, { check }) };
};

const changes = Event.implement(
  Changed,
  {
    check: (_input, cursor) =>
      Effect.map(CurrentActor, (actor) => ({
        cursor: "1",
        events: cursor === null ? [] : [{ eventId: `by-${actor.id}`, data: { by: actor.id } }],
      })),
  },
  {
    authorize: () =>
      Effect.flatMap(CurrentActor, (actor) =>
        actor.permissions.includes("users:write")
          ? Effect.void
          : Effect.fail(new Action.Forbidden({ message: "Requires users:write." })),
      ),
  },
);

const Listed = Schema.Struct({
  result: Schema.Struct({ events: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});

const send = (method: string, params: ActionMcp.Params = {}, token?: string) =>
  Effect.flatMap(
    HttpClient.execute(
      ActionMcp.request(method, params, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
    ),
    (response) =>
      Effect.map(response.text, (body) => ({
        status: response.status,
        reply: Schema.decodeUnknownSync(Json)(body),
      })),
  );

const framesOf = (response: HttpClientResponse.HttpClientResponse, count: number) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map((frame) => Schema.decodeUnknownSync(Json)(frame.data)),
    Stream.take(count),
    Stream.runCollect,
  );

it("refuses an event type whose input or payload is no object, naming it", () => {
  const options = { name: "events", version: "0" };
  const emitted = { log: { emit: Stream.empty } };
  const read = { description: "", caller: Action.Anyone } as const;

  const Counted = Event.make("count.changed", { ...read, payload: Schema.Finite });
  const Tagged = Event.make("tags.changed", { ...read, payload: Schema.Array(Schema.String) });
  const Named = Event.make("name.changed", { ...read, input: Schema.String, payload: {} });

  expect(() => ActionMcp.layerHttp(Event.implement(Counted, emitted), options)).toThrow(
    "MCP event payload must be one object, such as a struct: count.changed (wrap an array or a scalar in a field)",
  );
  expect(() => ActionMcp.layerHttp(Event.implement(Tagged, emitted), options)).toThrow(
    "MCP event payload must be one object, such as a struct: tags.changed",
  );
  expect(() => ActionMcp.layerHttp(Event.implement(Named, emitted), options)).toThrow(
    "MCP event input must be one object with keys, such as a struct: name.changed",
  );
});

it("refuses an event type named starting with mcp., a prefix MCP keeps", () => {
  const Reserved = Event.make("mcp.task", { description: "", payload: {}, caller: Action.Anyone });

  expect(() =>
    ActionMcp.layerHttp(Event.implement(Reserved, { log: { emit: Stream.empty } }), {
      name: "events",
      version: "0",
    }),
  ).toThrow(
    `MCP event name starts with "mcp.", which MCP keeps for its own events: mcp.task (rename it, or serve it on another surface)`,
  );
});

describe("MCP events over HTTP", () => {
  it.effect(
    "advertises the events extension in 2026-07-28 discovery alone, and lists each event with its schemas and delivery",
    () =>
      Effect.gen(function* () {
        const discovered = yield* send("server/discover");

        const initialized = yield* HttpClient.execute(
          HttpClientRequest.fromWeb(
            sessionRequest({ method: "initialize", params: initializeParams }),
          ),
        ).pipe(Effect.flatMap((response) => response.text));

        const listed = yield* send("events/list");

        expect(discovered.reply).toMatchObject({
          result: {
            capabilities: {
              extensions: { "io.modelcontextprotocol/events": { listChanged: false } },
            },
          },
        });
        expect(initialized).not.toContain("io.modelcontextprotocol/events");
        expect(listed.reply).toMatchObject({
          result: {
            resultType: "complete",
            events: [
              {
                name: "message.posted",
                description: "A message was posted.",
                delivery: ["poll", "push"],
                inputSchema: { type: "object", properties: { channel: {} } },
                payloadSchema: { type: "object", required: ["id", "channel", "text"] },
              },
            ],
          },
        });
      })
        .pipe(
          Effect.provide(
            Testing.layer(ActionMcp.layerHttp(makeLog().posted, { name: "events", version: "0" })),
          ),
        )
        .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("names the server in each result's _meta whole, its title and icons included", () =>
    Effect.gen(function* () {
      const serverInfo = {
        name: "events",
        title: "Events",
        version: "0",
        description: "What happened.",
        icons: [new McpSchema.Icon({ src: "https://example.com/icon.png", sizes: ["48x48"] })],
      };

      const replies = yield* Effect.all([
        send("events/list"),
        send("events/poll", { name: "message.posted", cursor: null }),
      ]).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(makeLog().posted, {
              ...serverInfo,
              websiteUrl: "https://example.com",
            }),
          ),
        ),
      );

      for (const { reply } of replies) {
        expect(reply).toMatchObject({
          result: {
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "events",
                title: "Events",
                version: "0",
                description: "What happened.",
                websiteUrl: "https://example.com",
                icons: [{ src: "https://example.com/icon.png", sizes: ["48x48"] }],
              },
            },
          },
        });
      }
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "lists the event types its actions list alone, needing no authentication for the others",
    () =>
      Effect.gen(function* () {
        const listed = yield* send("events/list");
        const polled = yield* send("events/poll", { name: "user.changed", cursor: null });

        expect(Schema.decodeUnknownSync(Listed)(listed.reply).result.events).toEqual([
          { name: "message.posted" },
        ]);
        expect(polled.reply).toMatchObject({ error: { code: -32023 } });
      })
        .pipe(
          Effect.provide(
            Testing.layer(
              ActionMcp.layerHttp([makeLog().posted, changes], {
                name: "events",
                version: "0",
                actions: [Posted],
              }),
            ),
          ),
        )
        .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "polls from now, then answers what happened since, each occurrence with its cursor",
    () =>
      Effect.gen(function* () {
        const log = makeLog();

        const answers = yield* Effect.gen(function* () {
          const first = yield* send("events/poll", { name: "message.posted", cursor: null });

          yield* log.post("general", "hello");

          const second = yield* send("events/poll", {
            name: "message.posted",
            arguments: { channel: "general" },
            cursor: "0",
          });

          return [first.reply, second.reply];
        }).pipe(
          Effect.provide(
            Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
          ),
        );

        expect(answers).toMatchObject([
          {
            result: {
              resultType: "complete",
              events: [],
              cursor: "0",
              truncated: false,
              hasMore: false,
              nextPollMs: 5000,
            },
          },
          {
            result: {
              events: [
                {
                  eventId: "m1",
                  name: "message.posted",
                  data: { id: "m1", channel: "general", text: "hello" },
                  cursor: "1",
                },
              ],
              cursor: "1",
            },
          },
        ]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("caps a log source's page at maxEvents, with more to come", () =>
    Effect.gen(function* () {
      const messages = ["first", "second"].map((text, index) => ({
        eventId: `m${index + 1}`,
        data: { id: `m${index + 1}`, channel: "general", text },
      }));

      const pushed = Event.implement(Posted, { log: { emit: Stream.fromIterable(messages) } });

      const { reply } = yield* send("events/poll", {
        name: "message.posted",
        cursor: "a cursor of another process",
        maxEvents: 1,
      }).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(pushed, { name: "events", version: "0" })),
        ),
      );

      expect(reply).toMatchObject({
        result: { events: [{ eventId: "m1" }], truncated: true, hasMore: true },
      });
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "answers an unknown event, arguments its schema refuses, and an Mcp-Name absent or naming another event with SEP-3415's errors",
    () =>
      Effect.gen(function* () {
        const unknown = yield* send("events/poll", { name: "nothing.here", cursor: null });

        const refused = yield* send("events/poll", {
          name: "message.posted",
          arguments: { channel: 1 },
        });

        const misrouted = yield* HttpClient.execute(
          ActionMcp.request("events/poll", { name: "message.posted" }).pipe(
            HttpClientRequest.setHeader("mcp-name", "other.event"),
          ),
        );

        expect(unknown.reply).toMatchObject({
          error: {
            code: -32023,
            message: `Event "nothing.here" is not served`,
            data: { kind: "event" },
          },
        });
        expect(refused.reply).toMatchObject({ error: { code: -32602 } });
        expect(JSON.stringify(refused.reply)).toContain(
          "Invalid arguments for event 'message.posted'",
        );

        const unnamed = yield* HttpClient.execute(
          ActionMcp.request("events/poll", { name: "message.posted" }).pipe(
            HttpClientRequest.removeHeader("mcp-name"),
          ),
        );

        expect(misrouted.status).toBe(400);
        expect(Schema.decodeUnknownSync(Json)(yield* misrouted.text)).toMatchObject({
          error: { code: -32020 },
        });
        expect(unnamed.status).toBe(400);
        expect(Schema.decodeUnknownSync(Json)(yield* unnamed.text)).toMatchObject({
          error: { code: -32020 },
        });
      })
        .pipe(
          Effect.provide(
            Testing.layer(ActionMcp.layerHttp(makeLog().posted, { name: "events", version: "0" })),
          ),
        )
        .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("answers events/* in a 2025 session as a method it does not know", () =>
    Effect.gen(function* () {
      const opened = yield* HttpClient.execute(
        HttpClientRequest.fromWeb(
          sessionRequest({ method: "initialize", params: initializeParams }),
        ),
      );

      const session = opened.headers["mcp-session-id"] ?? "";

      const polled = yield* HttpClient.execute(
        HttpClientRequest.fromWeb(
          sessionRequest({
            method: "events/poll",
            params: { name: "message.posted", cursor: null },
            session,
            headers: { "mcp-protocol-version": "2025-11-25" },
          }),
        ),
      ).pipe(Effect.flatMap((response) => response.text));

      expect(polled).toContain("-32601");
    })
      .pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(makeLog().posted, { name: "events", version: "0" })),
        ),
      )
      .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "pushes active, each occurrence, and every 30 seconds a heartbeat with its cursor, under the request's id",
    () =>
      Effect.gen(function* () {
        const log = makeLog();

        const frames = yield* Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            ActionMcp.request("events/stream", { name: "message.posted", cursor: null }),
          );

          const reading = yield* Effect.forkChild(framesOf(response, 3));

          yield* settle;
          yield* log.post("general", "hello");
          yield* TestClock.adjust("5 seconds");
          yield* TestClock.adjust("25 seconds");

          return yield* Fiber.join(reading);
        }).pipe(
          Effect.provide(
            Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
          ),
        );

        const subscription = { _meta: { "io.modelcontextprotocol/subscriptionId": 1 } };

        expect(frames).toMatchObject([
          {
            method: "notifications/events/active",
            params: { cursor: "0", truncated: false, ...subscription },
          },
          {
            method: "notifications/events/event",
            params: { eventId: "m1", name: "message.posted", cursor: "1", ...subscription },
          },
          { method: "notifications/events/heartbeat", params: { cursor: "1", ...subscription } },
        ]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "honors no eventsListChanged filter on subscriptions/listen, as listChanged is false",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          ActionMcp.request("subscriptions/listen", {
            notifications: { eventsListChanged: true },
          }),
        );

        const [acknowledged] = yield* framesOf(response, 1);

        expect(acknowledged).toMatchObject({
          method: "notifications/subscriptions/acknowledged",
          params: { notifications: {} },
        });
        expect(acknowledged).not.toHaveProperty(["params", "notifications", "eventsListChanged"]);
      })
        .pipe(
          Effect.provide(
            Testing.layer(ActionMcp.layerHttp(makeLog().posted, { name: "events", version: "0" })),
          ),
        )
        .pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("an MCP push stream", () => {
  it.effect("tears its subscription hook down when the client stops reading", () =>
    Effect.gen(function* () {
      const held: Array<string> = [];

      const hooked = Event.implement(Posted, {
        check: () => Effect.succeed({ cursor: "0", events: [] }),
        subscription: () =>
          Effect.acquireRelease(
            Effect.sync(() => held.push("set up")),
            () => Effect.sync(() => held.push("torn down")),
          ),
      });

      const [active] = yield* Effect.scoped(
        Effect.flatMap(
          HttpClient.execute(ActionMcp.request("events/stream", { name: "message.posted" })),
          (response) => framesOf(response, 1),
        ),
      ).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(hooked, { name: "events", version: "0" })),
        ),
      );

      yield* settle;

      expect(active).toMatchObject({ method: "notifications/events/active" });
      expect(held).toEqual(["set up", "torn down"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("an MCP push stream's lifecycle", () => {
  const streamOf = (implementation: typeof makeLog extends () => { posted: infer I } ? I : never) =>
    Effect.flatMap(
      HttpClient.execute(ActionMcp.request("events/stream", { name: "message.posted" })),
      (response) => framesOf(response, 3),
    ).pipe(
      Effect.provide(
        Testing.layer(ActionMcp.layerHttp(implementation, { name: "events", version: "0" })),
      ),
      Effect.forkChild,
    );

  it.effect("confirms with active before its first heartbeat, however long the first page", () =>
    Effect.gen(function* () {
      let pages = 0;

      const slow = Event.implement(Posted, {
        check: () =>
          Effect.andThen(
            Effect.sleep((pages += 1) === 1 ? "40 seconds" : "0 millis"),
            Effect.succeed({ cursor: "0", events: [] }),
          ),
      });

      const reading = yield* streamOf(slow);

      yield* settle;
      yield* TestClock.adjust("40 seconds");
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("30 seconds");

      expect(yield* Fiber.join(reading)).toMatchObject([
        { method: "notifications/events/active" },
        { method: "notifications/events/heartbeat" },
        { method: "notifications/events/heartbeat" },
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reports an upstream's failure as an error, and goes on from where it reached", () =>
    Effect.gen(function* () {
      let pages = 0;
      const data = { id: "m1", channel: "general", text: "after the outage" };

      const flaky = Event.implement(Posted, {
        check: () =>
          Effect.suspend(() => {
            pages += 1;

            return pages === 2
              ? Effect.die(new Error("The upstream answered 503."))
              : Effect.succeed({
                  cursor: String(pages),
                  events: pages === 3 ? [{ eventId: data.id, data }] : [],
                });
          }),
      });

      const reading = yield* streamOf(flaky);

      yield* settle;
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");

      expect(yield* Fiber.join(reading)).toMatchObject([
        { method: "notifications/events/active", params: { cursor: "1" } },
        {
          method: "notifications/events/error",
          params: { error: { code: -32603, message: "Internal error" } },
        },
        { method: "notifications/events/event", params: { eventId: "m1", cursor: "3" } },
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "reports an occurrence its payload schema refuses, sends a gap in its place, and reads on to the rest of its page",
    () =>
      Effect.gen(function* () {
        const Counted = Event.make("counter.counted", {
          description: "A counter counted.",
          payload: { n: Schema.Int },
          caller: Action.Anyone,
        });

        const reported: Array<string> = [];

        const breakingBeforeValid = Event.implement(Counted, {
          check: (_input, cursor) =>
            Effect.succeed(
              cursor === null
                ? { cursor: "0", events: [] }
                : {
                    cursor: "2",
                    events:
                      cursor === "0"
                        ? [
                            { eventId: "c1", data: { n: 1.5 } },
                            { eventId: "c2", data: { n: 2 } },
                          ]
                        : [],
                  },
            ),
        });

        const reading = yield* Effect.flatMap(
          HttpClient.execute(ActionMcp.request("events/stream", { name: "counter.counted" })),
          (response) => framesOf(response, 3),
        ).pipe(
          Effect.provide(
            Testing.layer(
              ActionMcp.layerHttp(breakingBeforeValid, { name: "events", version: "0" }).pipe(
                Layer.provide(ErrorReporter.layer([recorder(reported)])),
              ),
            ),
          ),
          Effect.forkChild,
        );

        yield* settle;
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("5 seconds");

        expect(yield* Fiber.join(reading)).toMatchObject([
          { method: "notifications/events/active", params: { cursor: "0", truncated: false } },
          { method: "notifications/events/active", params: { cursor: "0", truncated: true } },
          { method: "notifications/events/event", params: { eventId: "c2", cursor: "2" } },
        ]);
        expect(reported).toHaveLength(1);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("tears its subscription hook down when a stdio host cancels it", () =>
    Effect.gen(function* () {
      const held: Array<string> = [];
      const active = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();

      const hooked = Event.implement(Posted, {
        check: () => Effect.succeed({ cursor: "0", events: [] }),
        subscription: () =>
          Effect.acquireRelease(
            Effect.sync(() => held.push("set up")),
            () =>
              Effect.andThen(
                Effect.sync(() => held.push("torn down")),
                Deferred.succeed(ended, undefined),
              ),
          ),
      });

      const line = <A>(message: A) => `${JSON.stringify(message)}\n`;

      const stdin = Stream.concat(
        Stream.make(
          line({ ...statelessRequest("events/stream", { name: "message.posted" }).body, id: 7 }),
        ),
        Stream.fromEffectDrain(Deferred.await(active)),
      ).pipe(
        Stream.concat(
          Stream.make(
            line({
              ...statelessRequest("notifications/cancelled", { requestId: 7 }).body,
              id: undefined,
            }),
          ),
        ),
        Stream.concat(Stream.fromEffectDrain(Deferred.await(ended))),
        Stream.encodeText,
      );

      const stdout = () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          String(chunk).includes("notifications/events/active")
            ? Deferred.succeed(active, undefined)
            : Effect.void,
        );

      yield* ActionMcp.runStdio(hooked, { name: "events", version: "0" }).pipe(
        Effect.provide(Stdio.layerTest({ stdin, stdout })),
      );

      expect(held).toEqual(["set up", "torn down"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("ActionMcp.client's reconnecting watch", () => {
  it.effect("reconnects after a 503 the default client reads, streaming and polling", () =>
    Effect.gen(function* () {
      const log = makeLog();
      let unavailable = 0;

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted], {
          transformClient: HttpClient.transform((response, request) =>
            unavailable > 0
              ? Effect.sync(() => {
                  unavailable -= 1;

                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("unavailable", { status: 503 }),
                  );
                })
              : response,
          ),
        });

        yield* log.post("general", "hello");

        return yield* Effect.forEach(["stream", "poll"] as const, (mode) =>
          Effect.gen(function* () {
            unavailable = 1;

            const fiber = yield* client
              .watch(Posted, {}, { cursor: "0", mode })
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

            yield* settle;
            yield* TestClock.adjust("1 second");

            return yield* Fiber.join(fiber);
          }),
        );
      }).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
        ),
      );

      expect(watched).toMatchObject([[{ eventId: "m1" }], [{ eventId: "m1" }]]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reconnects after a poll the source failed, answered as an internal error", () =>
    Effect.gen(function* () {
      const reported: Array<string> = [];
      let reads = 0;

      const failingFirstRead = Event.implement(Posted, {
        check: () =>
          (reads += 1) === 1
            ? Effect.die(new Error("upstream blew up"))
            : Effect.succeed({
                cursor: "1",
                events: [{ eventId: "m1", data: { id: "m1", channel: "general", text: "hello" } }],
              }),
      });

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted]);

        const fiber = yield* client
          .watch(Posted, {}, { cursor: "0", mode: "poll" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* TestClock.adjust("1 second");

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(failingFirstRead, { name: "events", version: "0" }).pipe(
              Layer.provide(ErrorReporter.layer([recorder(reported)])),
            ),
          ),
        ),
      );

      expect([watched, reads, reported.length]).toMatchObject([[{ eventId: "m1" }], 2, 1]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reconnects after a request unanswered for 60 seconds, streaming or polling", () =>
    Effect.gen(function* () {
      let stalling = true;

      const stallingFirstRead = Event.implement(Posted, {
        check: () => {
          if (stalling) {
            stalling = false;

            return Effect.never;
          }

          return Effect.succeed({
            cursor: "1",
            events: [{ eventId: "m1", data: { id: "m1", channel: "general", text: "hello" } }],
          });
        },
      });

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted]);

        return yield* Effect.forEach(["stream", "poll"] as const, (mode) =>
          Effect.gen(function* () {
            stalling = true;

            const fiber = yield* client
              .watch(Posted, {}, { mode, cursor: "0" })
              .pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.timeoutOption("2 minutes"),
                Effect.forkChild,
              );

            yield* settle;
            yield* TestClock.adjust("2 minutes");

            return yield* Fiber.join(fiber);
          }),
        );
      }).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(stallingFirstRead, { name: "events", version: "0" })),
        ),
      );

      expect(watched).toMatchObject([
        { _tag: "Some", value: [{ eventId: "m1" }] },
        { _tag: "Some", value: [{ eventId: "m1" }] },
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reconnects after a stream answered as JSON whose body stalls for 60 seconds", () =>
    Effect.gen(function* () {
      const log = makeLog();
      let stalled = 0;

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted], {
          transformClient: HttpClient.transform((response, request) =>
            stalled > 0
              ? response
              : Effect.sync(() => {
                  stalled += 1;

                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(new ReadableStream(), {
                      headers: { "content-type": "application/json" },
                    }),
                  );
                }),
          ),
        });

        yield* log.post("general", "hello");

        const fiber = yield* client
          .watch(Posted, {}, { cursor: "0" })
          .pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeoutOption("2 minutes"),
            Effect.forkChild,
          );

        yield* settle;
        yield* TestClock.adjust("2 minutes");

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
        ),
      );

      expect([watched, stalled]).toMatchObject([{ _tag: "Some", value: [{ eventId: "m1" }] }, 1]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("skips a retry field sent alone, delivering over the stream it opened", () =>
    Effect.gen(function* () {
      const log = makeLog();
      let streams = 0;

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted], {
          transformClient: HttpClient.transform((response, request) =>
            Effect.flatMap(response, (answered) =>
              (answered.headers["content-type"] ?? "").startsWith("text/event-stream")
                ? Effect.map(
                    Stream.toReadableStreamEffect(
                      Stream.concat(
                        Stream.make(new TextEncoder().encode("retry: 5000\n\n")),
                        answered.stream,
                      ),
                    ),
                    (body) => {
                      streams += 1;

                      return HttpClientResponse.fromWeb(
                        request,
                        new Response(body, { status: answered.status, headers: answered.headers }),
                      );
                    },
                  )
                : Effect.succeed(answered),
            ),
          ),
        });

        yield* log.post("general", "hello");

        const fiber = yield* client
          .watch(Posted, {}, { cursor: "0" })
          .pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeoutOption("5 seconds"),
            Effect.forkChild,
          );

        yield* settle;
        yield* TestClock.adjust("5 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
        ),
      );

      expect([watched, streams]).toMatchObject([
        { _tag: "Some", value: [{ eventId: "m1", data: { text: "hello" } }] },
        1,
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails at once on a status no reconnect outlasts, streaming or polling", () =>
    Effect.gen(function* () {
      let requests = 0;

      const failures = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Changed], {
          transformClient: (native) =>
            native.pipe(
              HttpClient.tapRequest(() => Effect.sync(() => (requests += 1))),
              HttpClient.filterStatusOk,
            ),
        });

        return yield* Effect.all(
          [
            Effect.flip(Stream.runDrain(client.watch(Changed, {}, { mode: "stream" }))),
            Effect.flip(Stream.runDrain(client.watch(Changed, {}, { mode: "poll" }))),
          ],
          { concurrency: "unbounded" },
        );
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(changes, {
              name: "events",
              version: "0",
              authentication: Login,
            }).pipe(Layer.provide(authenticate)),
          ),
        ),
      );

      expect(failures).toMatchObject([
        { _tag: "HttpClientError", reason: { _tag: "StatusCodeError" } },
        { _tag: "HttpClientError", reason: { _tag: "StatusCodeError" } },
      ]);
      expect(requests).toBe(2);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("MCP events over stdio", () => {
  it.effect("polls, and streams until the source refuses, as over HTTP", () =>
    Effect.gen(function* () {
      let pages = 0;

      const numbered = Event.implement(Posted, {
        check: (_input, cursor) =>
          Effect.suspend(() => {
            pages += 1;

            const data = { id: `m${pages}`, channel: "general", text: "hi" };

            return pages === 4
              ? Effect.fail(new Action.Forbidden({ message: "Channel closed." }))
              : Effect.succeed({
                  cursor: String(pages),
                  events: cursor === null ? [] : [{ eventId: data.id, data }],
                });
          }),
      });

      const exchanged = yield* Effect.forkChild(
        transcript(
          ActionMcp.runStdio(numbered, { name: "events", version: "0" }).pipe(
            Effect.provide(Event.layerMemory),
          ),
          [
            { method: "events/poll", params: { name: "message.posted", cursor: "0" } },
            { method: "events/stream", params: { name: "message.posted" } },
          ],
        ),
      );

      yield* settle;
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");

      const [polled, ...streamed] = (yield* Fiber.join(exchanged)).map((line) =>
        Schema.decodeUnknownSync(Json)(line),
      );

      expect(polled).toMatchObject({
        result: { events: [{ eventId: "m1", data: { id: "m1" } }], cursor: "1" },
      });
      expect(streamed).toMatchObject([
        { method: "notifications/events/active", params: { cursor: "2" } },
        { method: "notifications/events/event", params: { eventId: "m3", cursor: "3" } },
        {
          method: "notifications/events/terminated",
          params: { error: { code: -32024, data: { _tag: "Forbidden" } } },
        },
        { result: { resultType: "complete" } },
      ]);
    }),
  );
});

describe("ActionMcp.client's watch", () => {
  it.effect("streams and polls what happened since it started", () =>
    Effect.gen(function* () {
      const log = makeLog();

      const [streamed, polled] = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted]);

        const fibers = [
          yield* client.watch(Posted).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild),
          yield* client
            .watch(Posted, { channel: "general" }, { mode: "poll" })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild),
        ];

        yield* settle;
        yield* log.post("general", "hello");
        yield* TestClock.adjust("5 seconds");

        return yield* Fiber.joinAll(fibers);
      }).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
        ),
      );

      const hello = { _tag: "Occurrence", eventId: "m1", data: { text: "hello" }, cursor: "1" };

      expect(streamed).toMatchObject([hello]);
      expect(polled).toMatchObject([hello]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("keeps the cursor each polled occurrence of a check source arrives with", () =>
    Effect.gen(function* () {
      const log = makeLog();

      yield* log.post("general", "first");
      yield* log.post("general", "second");

      const polled = yield* ActionMcp.client([Posted]).pipe(
        Effect.flatMap((client) =>
          client
            .watch(Posted, {}, { cursor: "0", mode: "poll" })
            .pipe(Stream.take(2), Stream.runCollect),
        ),
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
        ),
      );

      expect(polled).toMatchObject([
        { eventId: "m1", cursor: "0" },
        { eventId: "m2", cursor: "2" },
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "keeps each polled occurrence of a log source at its own position, resuming after it",
    () =>
      Effect.gen(function* () {
        const events = yield* Event.Events;
        const published = Event.implement(Posted, { log: {} });

        const Page = Schema.Struct({
          result: Schema.Struct({
            cursor: Schema.String,
            events: Schema.Array(Schema.Struct({ eventId: Schema.String })),
          }),
        });

        const [first, resumed] = yield* Effect.gen(function* () {
          const before = Schema.decodeUnknownSync(Page)(
            (yield* send("events/poll", { name: "message.posted", cursor: null })).reply,
          ).result.cursor;

          for (const id of ["m1", "m2"]) {
            yield* events.publish(Posted, {
              eventId: id,
              data: { id, channel: "general", text: id },
            });
          }

          const client = yield* ActionMcp.client([Posted]);

          const [m1] = yield* client
            .watch(Posted, {}, { cursor: before, mode: "poll" })
            .pipe(Stream.take(1), Stream.runCollect);

          const after = yield* send("events/poll", {
            name: "message.posted",
            cursor: m1?.cursor ?? null,
          });

          return [m1, Schema.decodeUnknownSync(Page)(after.reply).result.events] as const;
        }).pipe(
          Effect.provide(
            Testing.layer(ActionMcp.layerHttp(published, { name: "events", version: "0" })),
          ),
        );

        expect(first).toMatchObject({ eventId: "m1" });
        expect(resumed).toEqual([{ eventId: "m2" }]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("logs an error a stream reports as HTTP and RPC watches do, and reads on", () =>
    Effect.gen(function* () {
      let pages = 0;
      const logged: Array<unknown> = [];
      const data = { id: "m1", channel: "general", text: "after the outage" };

      const flaky = Event.implement(Posted, {
        check: () =>
          Effect.suspend(() => {
            pages += 1;

            return pages === 2
              ? Effect.die(new Error("The upstream answered 503."))
              : Effect.succeed({
                  cursor: String(pages),
                  events: pages === 3 ? [{ eventId: data.id, data }] : [],
                });
          }),
      });

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted]);

        const fiber = yield* client
          .watch(Posted)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("5 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(flaky, { name: "events", version: "0" }))),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              logged.push(Array.isArray(message) ? message[0] : message);
            }),
          ]),
        ),
      );

      expect(watched).toMatchObject([{ eventId: "m1" }]);
      expect(logged).toContain('MCP event "message.posted" failed to read, and resumes');
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "polls where the endpoint serves events by poll alone, and fails a forced stream with Unsupported",
    () =>
      Effect.gen(function* () {
        const log = makeLog();

        const [chosen, forced] = yield* Effect.gen(function* () {
          const client = yield* ActionMcp.client([Posted]);

          const watching = yield* client
            .watch(Posted)
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

          const failure = yield* Effect.flip(
            Stream.runDrain(client.watch(Posted, {}, { mode: "stream" })),
          );

          yield* settle;
          yield* log.post("general", "hello");
          yield* TestClock.adjust("5 seconds");

          return [yield* Fiber.join(watching), failure] as const;
        }).pipe(
          Effect.provide(
            Testing.layer(
              ActionMcp.layerHttp(log.posted, {
                name: "events",
                version: "0",
                requestScoped: true,
              }),
            ),
          ),
        );

        expect(chosen).toMatchObject([{ data: { text: "hello" } }]);
        expect(forced).toMatchObject({
          _tag: "SubscriptionError",
          event: "message.posted",
          reason: { _tag: "Unsupported", feature: "deliveryMode", value: "push" },
        });
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails with NotServed for an event type the endpoint does not serve", () =>
    Effect.gen(function* () {
      const client = yield* ActionMcp.client([Changed]);

      expect(yield* Effect.flip(Stream.runDrain(client.watch(Changed)))).toMatchObject({
        _tag: "SubscriptionError",
        reason: { _tag: "NotServed" },
      });
    })
      .pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(makeLog().posted, { name: "events", version: "0" })),
        ),
      )
      .pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("a protected MCP event", () => {
  const mixed = () =>
    Testing.layer(
      ActionMcp.layerHttp([makeLog().posted, changes], {
        name: "events",
        version: "0",
        authentication: Login,
      }).pipe(Layer.provide(authenticate)),
    );

  it.effect(
    "is listed and a public one polled signed out, while its own poll asks to sign in first",
    () =>
      Effect.gen(function* () {
        const listed = yield* send("events/list");
        const publicPoll = yield* send("events/poll", { name: "message.posted", cursor: null });
        const protectedPoll = yield* send("events/poll", { name: "user.changed", cursor: null });

        expect(listed.status).toBe(200);
        expect(publicPoll.status).toBe(200);
        expect(protectedPoll.status).toBe(401);
      })
        .pipe(Effect.provide(mixed()))
        .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("runs as the subscriber its authorize admits, and is Forbidden to one it refuses", () =>
    Effect.gen(function* () {
      const watchAs = (token: string) =>
        Effect.flatMap(
          ActionMcp.client([Changed], { ...as(token), authentication: Login }),
          (client) =>
            client.watch(Changed, {}, { mode: "poll" }).pipe(Stream.take(1), Stream.runCollect),
        );

      const admitted = yield* Effect.forkChild(watchAs("alice"));
      const refused = yield* Effect.flip(watchAs("reader"));

      yield* TestClock.adjust("5 seconds");

      expect(yield* Fiber.join(admitted)).toMatchObject([{ data: { by: "alice" } }]);
      expect(refused).toEqual(new Action.Forbidden({ message: "Requires users:write." }));
    })
      .pipe(Effect.provide(mixed()))
      .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("refuses a public event's Mcp-Name carrying a body that names a protected one", () =>
    Effect.gen(function* () {
      const smuggled = yield* HttpClient.execute(
        ActionMcp.request("events/poll", { name: "user.changed" }).pipe(
          HttpClientRequest.setHeader("mcp-name", "message.posted"),
        ),
      );

      expect(smuggled.status).toBe(400);
      expect(Schema.decodeUnknownSync(Json)(yield* smuggled.text)).toMatchObject({
        error: { code: -32020 },
      });
    })
      .pipe(Effect.provide(mixed()))
      .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "reports an internal failure's cause once, and no refusal or request it got wrong",
    () =>
      Effect.gen(function* () {
        const reported: Array<string> = [];

        const failing = Event.implement(Posted, {
          check: () => Effect.die(new Error("The upstream is down.")),
        });

        const answers = yield* Effect.all([
          send("events/poll", { name: "message.posted" }),
          send("events/poll", { name: "nothing.here" }, "alice"),
          send("events/poll", { name: "message.posted", arguments: { channel: 1 } }),
          send("events/poll", { name: "user.changed" }, "reader"),
        ]).pipe(
          Effect.provide(
            Testing.layer(
              ActionMcp.layerHttp([failing, changes], {
                name: "events",
                version: "0",
                authentication: Login,
              }).pipe(
                Layer.provide(authenticate),
                Layer.provide(ErrorReporter.layer([recorder(reported)])),
              ),
            ),
          ),
        );

        expect(answers.map(({ reply }) => reply)).toMatchObject([
          { error: { code: -32603, message: "Internal error" } },
          { error: { code: -32023 } },
          { error: { code: -32602 } },
          { error: { code: -32024, data: { _tag: "Forbidden" } } },
        ]);
        expect(reported).toHaveLength(1);
        expect(reported[0]).toContain("The upstream is down.");
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("sets up one subscription hook per principal for the polls of one input", () =>
    Effect.gen(function* () {
      const held: Array<string> = [];

      const hooked = Event.implement(
        Changed,
        {
          check: () => Effect.succeed({ cursor: "0", events: [] }),
          subscription: () =>
            Effect.flatMap(CurrentActor, (actor) =>
              Effect.acquireRelease(
                Effect.sync(() => held.push(actor.id)),
                () => Effect.sync(() => held.splice(held.indexOf(actor.id), 1)),
              ),
            ),
        },
        { authorize: Event.allowAll },
      );

      yield* Effect.gen(function* () {
        for (const token of ["alice", "alice", "bob"]) {
          expect((yield* send("events/poll", { name: "user.changed" }, token)).status).toBe(200);
        }

        expect(held.toSorted()).toEqual(["alice", "bob"]);
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(hooked, {
              name: "events",
              version: "0",
              authentication: Login,
            }).pipe(Layer.provide(authenticate)),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "refuses to start where a protected event's subscription hook has no principal to key it by",
    () =>
      Effect.gen(function* () {
        const Bare = Authentication.make("events.Bare", CurrentActor);

        const hooked = Event.implement(
          Changed,
          {
            check: () => Effect.succeed({ cursor: "0", events: [] }),
            subscription: () => Effect.void,
          },
          { authorize: Event.allowAll },
        );

        const exit = yield* Effect.exit(
          send("events/list", {}, "alice").pipe(
            Effect.provide(
              Testing.layer(
                ActionMcp.layerHttp(hooked, {
                  name: "events",
                  version: "0",
                  authentication: Bare,
                }).pipe(Layer.provide(Authentication.layer(Bare, verify))),
              ),
            ),
          ),
        );

        expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
          'MCP event "user.changed" is protected and has a subscription hook, so its authentication needs principal to tell poll subscribers apart (give Authentication.make a principal, such as (user) => user.id)',
        );
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("ends a stream with terminated when the source refuses the subscriber later", () =>
    Effect.gen(function* () {
      let pages = 0;

      const revoking = Event.implement(
        Changed,
        {
          check: () =>
            Effect.suspend(() =>
              (pages += 1) > 1
                ? Effect.fail(new Action.Forbidden({ message: "Access revoked." }))
                : Effect.succeed({ cursor: "0", events: [] }),
            ),
        },
        { authorize: Event.allowAll },
      );

      const [frames, failure] = yield* Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          ActionMcp.request(
            "events/stream",
            { name: "user.changed" },
            { headers: { authorization: "Bearer alice" } },
          ),
        );

        const reading = yield* Effect.forkChild(framesOf(response, 3));

        const watched = yield* ActionMcp.client([Changed], {
          ...as("alice"),
          authentication: Login,
        }).pipe(
          Effect.flatMap((client) =>
            Effect.forkChild(Effect.flip(Stream.runDrain(client.watch(Changed)))),
          ),
        );

        yield* TestClock.adjust("5 seconds");

        return [yield* Fiber.join(reading), yield* Fiber.join(watched)] as const;
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(revoking, {
              name: "events",
              version: "0",
              authentication: Login,
            }).pipe(Layer.provide(authenticate)),
          ),
        ),
      );

      expect(frames).toMatchObject([
        { method: "notifications/events/active" },
        {
          method: "notifications/events/terminated",
          params: { error: { code: -32024, message: "Access revoked." } },
        },
        { result: { resultType: "complete" } },
      ]);
      expect(failure).toEqual(new Action.Forbidden({ message: "Access revoked." }));
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("a request-scoped MCP endpoint", () => {
  it.effect(
    "polls a log source fed by emit and holds its subscription hook between requests, both built once with the endpoint",
    () =>
      Effect.gen(function* () {
        const emitted = yield* Queue.unbounded<{
          readonly eventId: string;
          readonly data: typeof Posted.payload.Type;
        }>();

        let hooks = 0;

        const posted = Event.implement(Posted, {
          log: { emit: Stream.fromQueue(emitted) },
          subscription: () =>
            Effect.sync(() => {
              hooks += 1;
            }),
        });

        const answer = yield* Effect.gen(function* () {
          const first = yield* send("events/poll", { name: "message.posted", cursor: null });

          const cursor = Schema.decodeUnknownSync(
            Schema.Struct({ result: Schema.Struct({ cursor: Schema.String }) }),
          )(first.reply).result.cursor;

          const data = { id: "m1", channel: "general", text: "hello" };

          yield* Queue.offer(emitted, { eventId: data.id, data });
          yield* settle;

          return (yield* send("events/poll", { name: "message.posted", cursor })).reply;
        }).pipe(
          Effect.provide(
            Testing.layer(
              ActionMcp.layerHttp(posted, { name: "events", version: "0", requestScoped: true }),
            ),
          ),
        );

        expect(answer).toMatchObject({
          result: { events: [{ eventId: "m1", data: { text: "hello" } }] },
        });
        expect(hooks).toBe(1);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("serves a log source published to between requests, its log kept by Events", () =>
    Effect.gen(function* () {
      const events = yield* Event.Events;
      const published = Event.implement(Posted, { log: {} });

      const answers = yield* Effect.gen(function* () {
        const first = yield* send("events/poll", { name: "message.posted", cursor: null });

        yield* events.publish(Posted, { data: { id: "m1", channel: "general", text: "hello" } });

        const cursor = Schema.decodeUnknownSync(
          Schema.Struct({ result: Schema.Struct({ cursor: Schema.String }) }),
        )(first.reply).result.cursor;

        const second = yield* send("events/poll", { name: "message.posted", cursor });

        return second.reply;
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(published, { name: "events", version: "0", requestScoped: true }),
          ),
        ),
      );

      expect(answers).toMatchObject({
        result: { events: [{ data: { id: "m1", channel: "general", text: "hello" } }] },
      });
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("ActionMcp.client's watch, refused in SEP-3415's codes", () => {
  const answering = (error: Schema.Json) => async (request: Request) => {
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Json }))(
      await request.json(),
    );

    return Response.json({ jsonrpc: "2.0", id, error });
  };

  it.effect(
    "fails with McpCallError's ProtocolError where an Unsupported error's data does not say what it names, or the code is none SEP-3415 reads",
    () =>
      Effect.gen(function* () {
        const refusals = yield* Effect.forEach([-32026, -32025], (code) =>
          ActionMcp.client([Posted]).pipe(
            Effect.flatMap((client) =>
              client.watch(Posted, {}, { cursor: "0", mode: "poll" }).pipe(Stream.runDrain),
            ),
            Effect.flip,
            Effect.provide(Testing.layer(answering({ code, message: "Refused." }))),
          ),
        );

        expect(refusals).toMatchObject([
          { _tag: "McpCallError", reason: { _tag: "ProtocolError", code: -32026 } },
          { _tag: "McpCallError", reason: { _tag: "ProtocolError", code: -32025 } },
        ]);
      }),
  );

  it.effect("fails with InvalidInput where the server answers -32602", () =>
    Effect.gen(function* () {
      const client = yield* ActionMcp.client([Posted]);

      const refused = yield* client
        .watch(Posted, {}, { cursor: "0", mode: "poll" })
        .pipe(Stream.runDrain, Effect.flip);

      expect(refused).toMatchObject({ _tag: "InvalidInput", message: "channel is required" });
    }).pipe(
      Effect.provide(Testing.layer(answering({ code: -32602, message: "channel is required" }))),
    ),
  );
});
