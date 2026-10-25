import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { as, initializeParams, sessionRequest } from "../support/requests.js";
import { recorder } from "../support/reporter.js";
import { transcript } from "../support/stdio-host.js";
import { statelessRequest } from "../../src/mcp/request.js";

const Posted = Event.make("message.posted", {
  description: "A message was posted.",
  input: { channel: Schema.optional(Schema.String) },
  payload: { id: Schema.String, channel: Schema.String, text: Schema.String },
  caller: Action.Anyone,
});

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

const Json = Schema.fromJsonString(Schema.Json);

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

const settle = TestClock.adjust("0 millis");

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

  it.effect("polls from now, then answers what happened since with the page's cursor alone", () =>
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
              },
            ],
            cursor: "1",
          },
        },
      ]);
      expect(answers[1]).not.toHaveProperty(["result", "events", 0, "cursor"]);
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
          error: { code: -32023, message: "Unknown event: nothing.here", data: { kind: "event" } },
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
  const transportFailure = (request: HttpClientRequest.HttpClientRequest) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "connection reset" }),
    });

  it.effect("reconnects after the transport fails, waiting longer each time, and resumes", () =>
    Effect.gen(function* () {
      const log = makeLog();
      const attempts: Array<number> = [];

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionMcp.client([Posted], {
          transformClient: HttpClient.transform((response, request) =>
            Effect.flatMap(
              Effect.clockWith((clock) => clock.currentTimeMillis),
              (now) => {
                attempts.push(now);

                return attempts.length <= 3 ? Effect.fail(transportFailure(request)) : response;
              },
            ),
          ),
        });

        const fiber = yield* client
          .watch(Posted, {}, { cursor: "0" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* log.post("general", "hello");
        yield* settle;
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("2 seconds");
        yield* TestClock.adjust("4 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Testing.layer(ActionMcp.layerHttp(log.posted, { name: "events", version: "0" })),
        ),
      );

      expect(attempts).toEqual([0, 1000, 3000, 7000]);
      expect(watched).toMatchObject([{ eventId: "m1", data: { text: "hello" } }]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

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

  it.effect("resumes an occurrence before a polled page's last from the cursor polled", () =>
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
  it.effect("refuses to start with an event it cannot hold between requests", () =>
    Effect.gen(function* () {
      const emitted = Event.implement(Posted, { log: { emit: Stream.never } });

      const hooked = Event.implement(Posted, {
        check: () => Effect.succeed({ cursor: "0", events: [] }),
        subscription: () => Effect.void,
      });

      const startWith = (implementation: typeof emitted) =>
        Effect.map(
          Effect.exit(
            send("events/list").pipe(
              Effect.provide(
                Testing.layer(
                  ActionMcp.layerHttp(implementation, {
                    name: "events",
                    version: "0",
                    requestScoped: true,
                  }),
                ),
              ),
            ),
          ),
          (exit) => (Exit.isFailure(exit) ? String(exit.cause) : "started"),
        );

      expect(yield* startWith(emitted)).toContain(
        'MCP event "message.posted" has a log source fed by emit, which a request-scoped endpoint reads only while a request lasts (serve it on an endpoint without requestScoped)',
      );
      expect(yield* startWith(hooked)).toContain(
        'MCP event "message.posted" has a subscription hook, which a request-scoped endpoint cannot hold between requests (remove the hook, or serve it on an endpoint without requestScoped)',
      );
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

  const exhausted = answering({
    code: -32025,
    message: "ResourceExhausted",
    data: { limit: "subscriptions", max: 10 },
  });

  it.effect("fails with LimitReached where the server answers ResourceExhausted", () =>
    Effect.gen(function* () {
      const client = yield* ActionMcp.client([Posted]);

      const refused = yield* client
        .watch(Posted, {}, { cursor: "0", mode: "poll" })
        .pipe(Stream.runDrain, Effect.flip);

      expect(refused).toMatchObject({
        _tag: "SubscriptionError",
        event: "message.posted",
        reason: { _tag: "LimitReached", limit: "subscriptions", max: 10 },
        message: `Event "message.posted" is refused at the server's limit of subscriptions: at most 10`,
      });
    }).pipe(Effect.provide(Testing.layer(exhausted))),
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
