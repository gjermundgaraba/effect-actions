import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, ErrorReporter, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { OpenApi } from "effect/http-api";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { recorder } from "../support/reporter.js";
import { memoryStorage } from "../../src/contract/log.js";

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

const Counted = Event.make("counter.counted", {
  description: "A counter counted.",
  payload: { n: Schema.Int },
  caller: Action.Anyone,
});

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

const failingSecondRead = () => {
  let reads = 0;

  return Event.implement(Counted, {
    check: (_input, cursor) =>
      (reads += 1) === 2
        ? Effect.die(new Error("upstream blew up"))
        : Effect.succeed(
            cursor === null
              ? { cursor: "0", events: [] }
              : { cursor: "1", events: [{ eventId: "c1", data: { n: 1 } }] },
          ),
  });
};

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

const Http = ActionHttp.make([Posted, Changed], { authentication: Login });

const Public = ActionHttp.make([Posted]);

const Json = Schema.fromJsonString(Schema.Json);

const subscribe = (
  name: string,
  body: Schema.Json,
  { token, stream = false }: { readonly token?: string; readonly stream?: boolean } = {},
) =>
  HttpClient.execute(
    HttpClientRequest.post(`/api/events/${name}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      HttpClientRequest.setHeaders({
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(stream ? { accept: "text/event-stream" } : {}),
      }),
    ),
  );

const answerOf = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(response.text, (body) => ({
    status: response.status,
    body: Schema.decodeUnknownSync(Json)(body),
  }));

const framesOf = (response: HttpClientResponse.HttpClientResponse, count: number) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map((frame) => ({ event: frame.event, data: frame.data })),
    Stream.take(count),
    Stream.runCollect,
  );

const settle = TestClock.adjust("0 millis");

const served = (log = makeLog()) =>
  Testing.layer(ActionHttp.layer(Http, [log.posted, changes]).pipe(Layer.provide(authenticate)));

describe("HTTP events", () => {
  it.effect(
    "starts only the sources of the event types it serves, the shared builder run once",
    () =>
      Effect.gen(function* () {
        const Tailed = Event.make("job.tailed", {
          description: "A job wrote a line.",
          payload: { line: Schema.String },
          caller: Action.Anyone,
        });

        let built = 0;
        let tailed = 0;

        const both = Event.implement(
          [Counted, Tailed],
          Effect.sync(() => {
            built += 1;

            return {
              [Counted.name]: { check: () => Effect.succeed({ cursor: "1", events: [] }) },
              [Tailed.name]: {
                log: {
                  emit: Stream.fromEffect(
                    Effect.sync(() => {
                      tailed += 1;

                      return { data: { line: "started" } };
                    }),
                  ),
                },
              },
            };
          }),
        );

        const refusingEmit = Layer.effect(Event.Events)(
          Event.makeEvents({ log: () => memoryStorage(), emits: false }),
        );

        const answers = yield* Effect.forEach([0, 1], () =>
          Effect.flatMap(subscribe("counter.counted", { input: {}, cursor: null }), answerOf),
        ).pipe(
          Effect.provide(
            Testing.layer(
              ActionHttp.layer(ActionHttp.make([Counted]), [both], { actions: [Counted] }),
            ),
          ),
          Effect.provide(refusingEmit),
        );

        expect(answers.map(({ status }) => status)).toEqual([200, 200]);
        expect([built, tailed]).toEqual([1, 0]);
      }),
  );

  it.effect("answers a poll whose source fails with no refusal 500, reporting it", () =>
    Effect.gen(function* () {
      const reportedCauses: Array<string> = [];

      const failing = Event.implement(Posted, {
        check: () => Effect.die(new Error("upstream down")),
      });

      const response = yield* subscribe("message.posted", { input: {}, cursor: "0" }).pipe(
        Effect.provide(Testing.layer(ActionHttp.layer(Public, failing))),
        Effect.provide(ErrorReporter.layer([recorder(reportedCauses)])),
      );

      expect(response.status).toBe(500);
      expect(reportedCauses.join("\n")).toContain("upstream down");
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("answers a nextPoll over 5 minutes, Duration.infinity included, as 5 minutes", () =>
    Effect.gen(function* () {
      const waits = [Duration.infinity, Duration.minutes(10), Duration.seconds(30)];

      const answered = yield* Effect.forEach(waits, (nextPoll) =>
        Effect.flatMap(subscribe("counter.counted", { input: {}, cursor: null }), answerOf).pipe(
          Effect.provide(
            Testing.layer(
              ActionHttp.layer(
                ActionHttp.make([Counted]),
                Event.implement(Counted, {
                  check: () => Effect.succeed({ cursor: "0", events: [], nextPoll }),
                }),
              ),
            ),
          ),
        ),
      );

      expect(answered.map(({ status, body }) => [status, body])).toMatchObject(
        waits.map((wait) => [200, { nextPollMs: Math.min(Duration.toMillis(wait), 5 * 60_000) }]),
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("polls from now as JSON, then answers what happened since with its cursor", () =>
    Effect.gen(function* () {
      const log = makeLog();

      const answers = yield* Effect.gen(function* () {
        const first = yield* Effect.flatMap(
          subscribe("message.posted", { input: {}, cursor: null }),
          answerOf,
        );

        yield* log.post("general", "hello");

        const second = yield* Effect.flatMap(
          subscribe("message.posted", { input: { channel: "general" }, cursor: "0" }),
          answerOf,
        );

        return [first, second];
      }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Public, log.posted))));

      expect(answers).toEqual([
        {
          status: 200,
          body: { events: [], cursor: "0", truncated: false, hasMore: false, nextPollMs: 5000 },
        },
        {
          status: 200,
          body: {
            events: [
              {
                _tag: "Occurrence",
                eventId: "m1",
                name: "message.posted",
                timestamp: "1970-01-01T00:00:00.000Z",
                data: { id: "m1", channel: "general", text: "hello" },
                cursor: "1",
              },
            ],
            cursor: "1",
            truncated: false,
            hasMore: false,
            nextPollMs: 5000,
          },
        },
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "streams a confirmation, each occurrence and a heartbeat every 30 seconds, as SSE",
    () =>
      Effect.gen(function* () {
        const log = makeLog();

        const reading = yield* Effect.gen(function* () {
          const response = yield* subscribe("message.posted", { input: {} }, { stream: true });

          const frames = yield* Effect.forkChild(framesOf(response, 3));

          yield* settle;
          yield* log.post("general", "hello");
          yield* TestClock.adjust("5 seconds");
          yield* TestClock.adjust("25 seconds");

          return { type: response.headers["content-type"], frames: yield* Fiber.join(frames) };
        }).pipe(
          Effect.scoped,
          Effect.provide(Testing.layer(ActionHttp.layer(Public, log.posted))),
          Effect.forkChild,
        );

        const { type, frames } = yield* Fiber.join(reading);

        expect(type).toContain("text/event-stream");
        expect(frames.map(({ data }) => Schema.decodeUnknownSync(Json)(data))).toMatchObject([
          { _tag: "Checked", cursor: "0" },
          { _tag: "Occurrence", eventId: "m1", data: { text: "hello" }, cursor: "1" },
          { _tag: "Checked", cursor: "1" },
        ]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "refuses a protected event's subscriber with the route's 401 or 403, streaming or polling",
    () =>
      Effect.gen(function* () {
        const answers = yield* Effect.all(
          [false, true].flatMap((stream) => [
            Effect.flatMap(subscribe("user.changed", { input: {} }, { stream }), answerOf),
            Effect.flatMap(
              subscribe("user.changed", { input: {} }, { stream, token: "reader" }),
              answerOf,
            ),
          ]),
        ).pipe(Effect.provide(served()));

        expect(answers).toMatchObject([
          { status: 401, body: { _tag: "Unauthenticated" } },
          { status: 403, body: { _tag: "Forbidden", message: "Requires users:write." } },
          { status: 401, body: { _tag: "Unauthenticated" } },
          { status: 403, body: { _tag: "Forbidden", message: "Requires users:write." } },
        ]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "reports a source's failure once, sends Failed without its cause, and reads on, before and after confirming",
    () =>
      Effect.gen(function* () {
        let pages = 0;
        const data = { id: "m1", channel: "general", text: "after the outage" };
        const reported: Array<string> = [];

        const flaky = Event.implement(Posted, {
          check: () =>
            Effect.suspend(() => {
              pages += 1;

              return pages === 1 || pages === 3
                ? Effect.die(new Error("The upstream answered 503."))
                : Effect.succeed({
                    cursor: String(pages),
                    events: pages === 4 ? [{ eventId: data.id, data }] : [],
                  });
            }),
        });

        const reading = yield* Effect.flatMap(
          subscribe("message.posted", { input: {} }, { stream: true }),
          (response) => framesOf(response, 4),
        ).pipe(
          Effect.scoped,
          Effect.provide(
            Testing.layer(
              ActionHttp.layer(Public, flaky).pipe(
                Layer.provide(ErrorReporter.layer([recorder(reported)])),
              ),
            ),
          ),
          Effect.forkChild,
        );

        yield* settle;
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("5 seconds");

        const frames = yield* Fiber.join(reading);

        expect(frames.map(({ data }) => Schema.decodeUnknownSync(Json)(data))).toEqual([
          { _tag: "Failed" },
          { _tag: "Checked", cursor: "2" },
          { _tag: "Failed" },
          expect.objectContaining({ _tag: "Occurrence", eventId: "m1", cursor: "4" }),
        ]);
        expect(JSON.stringify(frames)).not.toContain("503");
        expect(reported).toHaveLength(2);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "reports an occurrence its payload schema refuses, sends a Gap in its place, and reads on to the rest of its page",
    () =>
      Effect.gen(function* () {
        const reported: Array<string> = [];

        const reading = yield* Effect.flatMap(
          subscribe("counter.counted", { input: {} }, { stream: true }),
          (response) => framesOf(response, 3),
        ).pipe(
          Effect.scoped,
          Effect.provide(
            Testing.layer(
              ActionHttp.layer(ActionHttp.make([Counted]), breakingBeforeValid).pipe(
                Layer.provide(ErrorReporter.layer([recorder(reported)])),
              ),
            ),
          ),
          Effect.forkChild,
        );

        yield* settle;
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("5 seconds");

        const frames = yield* Fiber.join(reading);

        expect(frames.map(({ data }) => Schema.decodeUnknownSync(Json)(data))).toEqual([
          { _tag: "Checked", cursor: "0" },
          { _tag: "Gap", cursor: "0" },
          expect.objectContaining({ _tag: "Occurrence", eventId: "c2", cursor: "2" }),
        ]);
        expect(JSON.stringify(frames)).not.toContain("integer");
        expect(reported).toHaveLength(1);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("ends a stream with Effect's failure event when the source refuses later", () =>
    Effect.gen(function* () {
      let pages = 0;

      const revoked = Event.implement(Posted, {
        check: () =>
          Effect.suspend(() =>
            (pages += 1) === 1
              ? Effect.succeed({ cursor: "1", events: [] })
              : Effect.fail(new Action.Forbidden({ message: "Revoked." })),
          ),
      });

      const reading = yield* Effect.flatMap(
        subscribe("message.posted", { input: {} }, { stream: true }),
        (response) => framesOf(response, 2),
      ).pipe(
        Effect.scoped,
        Effect.provide(Testing.layer(ActionHttp.layer(Public, revoked))),
        Effect.forkChild,
      );

      yield* settle;
      yield* TestClock.adjust("5 seconds");

      expect(yield* Fiber.join(reading)).toMatchObject([
        { event: "message", data: JSON.stringify({ _tag: "Checked", cursor: "1" }) },
        { event: "effect/http-api/stream/failure" },
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("keeps each poll subscriber's subscription hook apart by principal", () =>
    Effect.gen(function* () {
      const held: Array<string> = [];

      const hooked = Event.implement(
        Changed,
        {
          check: () => Effect.succeed({ cursor: "0", events: [] }),
          subscription: () =>
            Effect.flatMap(CurrentActor, (actor) =>
              Effect.acquireRelease(
                Effect.sync(() => held.push(`set up for ${actor.id}`)),
                () => Effect.void,
              ),
            ),
        },
        { authorize: Event.allowAll },
      );

      const statuses = yield* Effect.all(
        ["alice", "bob", "alice"].map((token) =>
          Effect.map(
            subscribe("user.changed", { input: {} }, { token }),
            (response) => response.status,
          ),
        ),
      ).pipe(
        Effect.provide(
          Testing.layer(
            ActionHttp.layer(ActionHttp.make([Changed], { authentication: Login }), hooked).pipe(
              Layer.provide(authenticate),
            ),
          ),
        ),
      );

      expect(statuses).toEqual([200, 200, 200]);
      expect(held).toEqual(["set up for alice", "set up for bob"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("holds one set-up for the polls of one input, until 5 minutes after the last", () =>
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

      yield* Effect.gen(function* () {
        yield* subscribe("message.posted", { input: {} });
        yield* TestClock.adjust("4 minutes");
        yield* subscribe("message.posted", { input: {} });
        yield* TestClock.adjust("4 minutes");
        expect(held).toEqual(["set up"]);
        yield* TestClock.adjust("1 minute");
        expect(held).toEqual(["set up", "torn down"]);
      }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Public, hooked))));
    }).pipe(Effect.provide(Event.layerMemory)),
  );

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

      yield* Effect.flatMap(
        subscribe("message.posted", { input: {} }, { stream: true }),
        (response) => framesOf(response, 1),
      ).pipe(Effect.scoped, Effect.provide(Testing.layer(ActionHttp.layer(Public, hooked))));

      yield* settle;

      expect(held).toEqual(["set up", "torn down"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it("lists each event's route with its JSON page and its event stream", () => {
    const document = OpenApi.fromApi(Http.api);
    const operation = document.paths["/api/events/user.changed"]?.post;

    expect(Object.keys(operation?.responses["200"]?.content ?? {})).toEqual([
      "application/json",
      "text/event-stream",
    ]);
    expect(operation?.description).toBe("A user of your tenant changed.");
    expect(operation?.security).not.toEqual([]);
    expect(document.paths["/api/events/message.posted"]?.post?.security ?? []).toEqual([]);
  });

  it.effect(
    "serves one list through two layers of a binding, each the actions and event types it lists",
    () =>
      Effect.gen(function* () {
        const Ping = Action.make("ping", {
          description: "Ping",
          readOnly: true,
          caller: Action.Anyone,
          success: Schema.String,
        });

        const Both = ActionHttp.make([Ping, Posted]);

        const implementations = [
          Action.implement(Ping, () => Effect.succeed("pong")),
          makeLog().posted,
        ];

        const read = Effect.all([
          Effect.map(subscribe("message.posted", { input: {}, cursor: null }), (r) => r.status),
          Effect.flatMap(ActionHttp.client(Both), (client) => client.ping()),
        ]);

        const split = yield* read.pipe(
          Effect.provide(
            Testing.layer(
              Layer.mergeAll(
                ActionHttp.layer(Both, implementations, { actions: [Ping] }),
                ActionHttp.layer(Both, implementations, { actions: [Posted] }),
              ),
            ),
          ),
        );

        const actionsAlone = yield* read.pipe(
          Effect.provide(
            Testing.layer(ActionHttp.layer(Both, implementations, { actions: [Ping] })),
          ),
        );

        expect(split).toEqual([200, "pong"]);
        expect(actionsAlone).toEqual([404, "pong"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it("refuses event implementations holding none of its binding's event types, and serves a bound one beside the others", () => {
    expect(() => ActionHttp.layer(Public, [changes])).toThrow(
      "No event of these implementations is in this HTTP binding: user.changed (pass an implementation of a bound event, or bind one of these)",
    );
    expect(() => ActionHttp.layer(Public, [makeLog().posted, changes])).not.toThrow();
  });

  it("refuses a listed event type its binding lacks", () => {
    expect(() =>
      // @ts-expect-error -- The failure under test: an event type the binding does not hold.
      ActionHttp.layer(Public, [makeLog().posted, changes], { actions: [Posted, Changed] }),
    ).toThrow(
      "Listed in actions, but the binding does not hold it: user.changed (add it to the binding's actions)",
    );
  });

  it("refuses an event and an action sharing a name, and an event listed twice", () => {
    const Pinged = Event.make("pinged", {
      description: "Pinged.",
      payload: {},
      caller: Action.Anyone,
    });

    const Ping = Action.make("pinged", {
      description: "Ping",
      readOnly: false,
      caller: Action.Anyone,
    });

    expect(() => ActionHttp.make([Pinged, Ping])).toThrow(/pinged/);
    expect(() => ActionHttp.make([Posted, Posted])).toThrow(/message\.posted/);
  });

  it.effect(
    "fails to build where a protected event's subscription hook has no principal to key it",
    () =>
      Effect.gen(function* () {
        const Anonymous = Authentication.make("events.Anonymous", CurrentActor);

        const hooked = Event.implement(
          Changed,
          {
            check: () => Effect.succeed({ cursor: "0", events: [] }),
            subscription: () => Effect.void,
          },
          { authorize: Event.allowAll },
        );

        const exit = yield* Effect.exit(
          Layer.build(
            Testing.layer(
              ActionHttp.layer(
                ActionHttp.make([Changed], { authentication: Anonymous }),
                hooked,
              ).pipe(Layer.provide(Authentication.layer(Anonymous, verify))),
            ),
          ).pipe(Effect.scoped),
        );

        expect(Exit.isFailure(exit) ? String(exit.cause) : "built").toContain(
          "needs principal to tell poll subscribers apart",
        );
      }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("ActionHttp.client's watch", () => {
  const watchedBy = <A, E>(watch: Effect.Effect<A, E, HttpClient.HttpClient>, log = makeLog()) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(watch);

      yield* settle;
      yield* log.post("general", "hello");
      yield* TestClock.adjust("5 seconds");

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(served(log)));

  it.effect("streams and polls from a cursor", () =>
    Effect.gen(function* () {
      const watched = yield* watchedBy(
        Effect.gen(function* () {
          const client = yield* ActionHttp.client(Http);

          return yield* Effect.all(
            (["stream", "poll"] as const).map((mode) =>
              client
                .watch(Posted, { channel: "general" }, { mode, cursor: "0" })
                .pipe(Stream.take(1), Stream.runCollect),
            ),
            { concurrency: "unbounded" },
          );
        }),
      );

      expect(watched).toMatchObject([
        [{ _tag: "Occurrence", eventId: "m1", data: { text: "hello" }, cursor: "1" }],
        [{ _tag: "Occurrence", eventId: "m1", data: { text: "hello" }, cursor: "1" }],
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("watches a protected event as the client's caller, refused as declared", () =>
    Effect.gen(function* () {
      const as = (token: string) =>
        ActionHttp.client(Http, {
          transformClient: (client) =>
            HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token)),
        });

      const changed = yield* watchedBy(
        Effect.flatMap(as("alice"), (client) =>
          client.watch(Changed, {}, { cursor: "0" }).pipe(Stream.take(1), Stream.runCollect),
        ),
      );

      const refused = yield* Effect.flatMap(as("reader"), (client) =>
        Effect.flip(Stream.runDrain(client.watch(Changed))),
      ).pipe(Effect.provide(served()));

      expect(changed).toMatchObject([{ eventId: "by-alice", data: { by: "alice" } }]);
      expect(refused).toMatchObject({ _tag: "Forbidden", message: "Requires users:write." });
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reconnects after a status the route does not declare, streaming or polling", () =>
    Effect.gen(function* () {
      const attempts: Array<number> = [];

      const watched = yield* watchedBy(
        Effect.gen(function* () {
          const client = yield* ActionHttp.client(Http, {
            transformClient: HttpClient.transform((response, request) =>
              Effect.flatMap(
                Effect.clockWith((clock) => clock.currentTimeMillis),
                (now) => {
                  attempts.push(now);

                  return attempts.length <= 2
                    ? Effect.succeed(
                        HttpClientResponse.fromWeb(request, new Response("", { status: 503 })),
                      )
                    : response;
                },
              ),
            ),
          });

          const fiber = yield* Effect.forkChild(
            Effect.all(
              (["stream", "poll"] as const).map((mode) =>
                client
                  .watch(Posted, {}, { mode, cursor: "0" })
                  .pipe(Stream.take(1), Stream.runCollect),
              ),
              { concurrency: "unbounded" },
            ),
          );

          yield* TestClock.adjust("1 second");
          yield* TestClock.adjust("2 seconds");

          return yield* Fiber.join(fiber);
        }),
      );

      expect(attempts.slice(0, 2)).toEqual([0, 0]);
      expect(attempts.slice(2, 4)).toEqual([1000, 1000]);
      expect(watched).toMatchObject([[{ eventId: "m1" }], [{ eventId: "m1" }]]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reconnects after a request unanswered for 60 seconds, streaming or polling", () =>
    Effect.gen(function* () {
      let stalling = true;

      const stallingFirstRead = Event.implement(Counted, {
        check: () => {
          if (stalling) {
            stalling = false;

            return Effect.never;
          }

          return Effect.succeed({ cursor: "1", events: [{ eventId: "c1", data: { n: 1 } }] });
        },
      });

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(ActionHttp.make([Counted]));

        return yield* Effect.forEach(["stream", "poll"] as const, (mode) =>
          Effect.gen(function* () {
            stalling = true;

            const fiber = yield* client
              .watch(Counted, {}, { mode, cursor: "0" })
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
          Testing.layer(ActionHttp.layer(ActionHttp.make([Counted]), stallingFirstRead)),
        ),
      );

      expect(watched).toMatchObject([
        { _tag: "Some", value: [{ eventId: "c1" }] },
        { _tag: "Some", value: [{ eventId: "c1" }] },
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("yields no Failed the server sends, only what it reads on to", () =>
    Effect.gen(function* () {
      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(ActionHttp.make([Counted]));

        const fiber = yield* client
          .watch(Counted, {}, { mode: "stream" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("5 seconds");

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Testing.layer(ActionHttp.layer(ActionHttp.make([Counted]), failingSecondRead())),
        ),
      );

      expect(watched).toMatchObject([{ _tag: "Occurrence", eventId: "c1" }]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reconnects after its stream's body breaks, and reads on from where it reached", () =>
    Effect.gen(function* () {
      let requests = 0;
      let frames = 0;
      const log = makeLog();

      yield* log.post("general", "hello");

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.transform((response, request) =>
            (requests += 1) === 1
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      new ReadableStream({
                        pull(controller) {
                          if (frames === 1) {
                            controller.error(new Error("connection reset"));
                          } else {
                            frames += 1;
                            controller.enqueue(
                              new TextEncoder().encode(
                                `data: ${JSON.stringify({ _tag: "Checked", cursor: "0" })}\n\n`,
                              ),
                            );
                          }
                        },
                      }),
                      { headers: { "content-type": "text/event-stream" } },
                    ),
                  ),
                )
              : response,
          ),
        });

        const fiber = yield* client
          .watch(Posted, {}, { mode: "stream" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("1 second");

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(served(log)));

      expect(requests).toBe(2);
      expect(watched).toMatchObject([{ eventId: "m1", cursor: "1" }]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails with NotServed for an event the server does not serve", () =>
    Effect.gen(function* () {
      const error = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        return yield* Effect.flip(Stream.runDrain(client.watch(Changed)));
      }).pipe(Effect.provide(Testing.layer(ActionHttp.layer(Public, makeLog().posted))));

      expect(error).toMatchObject({
        _tag: "SubscriptionError",
        event: "user.changed",
        reason: { _tag: "NotServed" },
      });
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails with InvalidInput, sending nothing, for an input that does not encode", () =>
    Effect.gen(function* () {
      let requests = 0;

      const error = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.tapRequest(() => Effect.sync(() => (requests += 1))),
        });

        return yield* Effect.flip(
          // @ts-expect-error -- A channel is a string.
          Stream.runDrain(client.watch(Posted, { channel: 1 })),
        );
      }).pipe(Effect.provide(served()));

      expect(error).toMatchObject({ _tag: "InvalidInput" });
      expect(requests).toBe(0);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});
