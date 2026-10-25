import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import { Headers, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  RpcClient,
  RpcClientError,
  type RpcMessage,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { isRpcTransient } from "../../src/rpc/watch.js";
import * as Testing from "../../src/testing/Testing.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { recorder } from "../support/reporter.js";
import { serve } from "../support/serve.js";
import { inMemoryValuesProtocolTo } from "../support/values.js";

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

const Login = Authentication.make("rpc-events.Login", CurrentActor);

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
      Effect.suspend(() =>
        cursor === "revoked"
          ? Effect.fail(new Action.Forbidden({ message: "Revoked." }))
          : Effect.map(CurrentActor, (actor) => ({
              cursor: cursor === null ? "0" : "revoked",
              events:
                cursor === null ? [] : [{ eventId: `by-${actor.id}`, data: { by: actor.id } }],
            })),
      ),
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

const miscounted = () => {
  let pages = 0;

  return Event.implement(Counted, {
    check: () =>
      Effect.sync(() => {
        pages += 1;

        return {
          cursor: String(pages),
          events:
            pages === 2 || pages === 3
              ? [{ eventId: `c${pages}`, data: { n: pages === 2 ? 1.5 : pages } }]
              : [],
        };
      }),
  });
};

const Rpc = ActionRpc.make([Posted, Changed, Counted], { authentication: Login });

const overHttp = <E, R>(server: Layer.Layer<never, E, R>) =>
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(
      Testing.layer(
        server.pipe(
          Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
      ),
    ),
  );

const rpcRoutes = <E, R>(server: Layer.Layer<never, E, R>) =>
  server.pipe(
    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerNdjson),
  );

const cutAfterAnOccurrence = (response: Response) => {
  const decoder = new TextDecoder();

  return new Response(
    response.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);

          if (decoder.decode(chunk).includes('"Occurrence"')) controller.terminate();
        },
      }),
    ),
    { headers: response.headers },
  );
};

const served = (log = makeLog(), reported: Array<string> = []) =>
  overHttp(
    ActionRpc.layer(Rpc, [log.posted, changes, miscounted()]).pipe(
      Layer.provide(Authentication.layer(Login, verify)),
      Layer.provide(ErrorReporter.layer([recorder(reported)])),
    ),
  );

const signedInAs = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });

const settle = TestClock.adjust("0 millis");

describe("RPC events", () => {
  it.effect("streams what happened since a cursor, and from now", () =>
    Effect.gen(function* () {
      const log = makeLog();

      yield* log.post("general", "before");

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        const fromCursor = yield* client
          .watch(Posted, { channel: "general" }, { cursor: "0" })
          .pipe(Stream.take(1), Stream.runCollect);

        const fromNow = yield* client
          .watch(Posted)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* log.post("general", "after");
        yield* TestClock.adjust("5 seconds");

        return [fromCursor, yield* Fiber.join(fromNow)];
      }).pipe(Effect.scoped, Effect.provide(served(log)));

      expect(watched).toMatchObject([
        [{ _tag: "Occurrence", eventId: "m1", data: { text: "before" }, cursor: "1" }],
        [{ _tag: "Occurrence", eventId: "m2", data: { text: "after" }, cursor: "2" }],
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "watches a protected event as the message's caller, refused when it starts and later",
    () =>
      Effect.gen(function* () {
        const [changed, refused, revoked, signedOut] = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(Rpc);
          const watch = client.watch(Changed, {}, { cursor: "1" });

          const revoking = yield* Effect.flip(Stream.runDrain(watch)).pipe(
            signedInAs("alice"),
            Effect.forkChild,
          );

          yield* settle;
          yield* TestClock.adjust("5 seconds");

          return yield* Effect.all([
            watch.pipe(Stream.take(1), Stream.runCollect, signedInAs("alice")),
            Effect.flip(Stream.runDrain(watch)).pipe(signedInAs("reader")),
            Fiber.join(revoking),
            Effect.flip(Stream.runDrain(watch)),
          ]);
        }).pipe(Effect.scoped, Effect.provide(served()));

        expect(changed).toMatchObject([{ eventId: "by-alice", data: { by: "alice" } }]);
        expect(refused).toMatchObject({ _tag: "Forbidden", message: "Requires users:write." });
        expect(revoked).toMatchObject({ _tag: "Forbidden", message: "Revoked." });
        expect(signedOut).toMatchObject({ _tag: "Unauthenticated" });
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "reports an occurrence its payload schema refuses once, and reads on past the Gap in its place",
    () =>
      Effect.gen(function* () {
        const reported: Array<string> = [];

        const watched = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(Rpc);

          const fiber = yield* client
            .watch(Counted)
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

          yield* settle;
          yield* TestClock.adjust("5 seconds");
          yield* TestClock.adjust("5 seconds");

          return yield* Fiber.join(fiber);
        }).pipe(Effect.scoped, Effect.provide(served(makeLog(), reported)));

        expect(watched).toMatchObject([
          { _tag: "Gap" },
          { _tag: "Occurrence", eventId: "c3", data: { n: 3 } },
        ]);
        expect(reported).toHaveLength(1);
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

      const Public = ActionRpc.make([Posted]);

      yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(Public);

        const fiber = yield* Effect.forkChild(Stream.runDrain(client.watch(Posted)));

        yield* settle;
        yield* Fiber.interrupt(fiber);
        yield* settle;
      }).pipe(Effect.scoped, Effect.provide(overHttp(ActionRpc.layer(Public, hooked))));

      expect(held).toEqual(["set up", "torn down"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "fails a poll with Unsupported, and an input that does not encode, sending nothing",
    () =>
      Effect.gen(function* () {
        const client = ActionRpc.client(Rpc);

        const polled = yield* Effect.flatMap(client, (rpc) =>
          Effect.flip(Stream.runDrain(rpc.watch(Posted, {}, { mode: "poll" }))),
        ).pipe(Effect.scoped, Effect.provide(served()));

        const invalid = yield* Effect.flatMap(client, (rpc) =>
          // @ts-expect-error -- A channel is a string.
          Effect.flip(Stream.runDrain(rpc.watch(Posted, { channel: 1 }))),
        ).pipe(Effect.scoped, Effect.provide(served()));

        expect(polled).toMatchObject({
          _tag: "SubscriptionError",
          reason: { _tag: "Unsupported", feature: "deliveryMode", value: "poll" },
        });
        expect(invalid).toMatchObject({ _tag: "InvalidInput" });
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("serves the event types its actions list alone, owing nothing for the others", () =>
    Effect.gen(function* () {
      const log = makeLog();

      yield* log.post("general", "before");

      const [posted, counted] = yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        return [
          yield* client.watch(Posted, {}, { cursor: "0" }).pipe(Stream.take(1), Stream.runCollect),
          yield* Effect.exit(Stream.runDrain(client.watch(Counted))),
        ] as const;
      }).pipe(
        Effect.scoped,
        Effect.provide(
          overHttp(
            ActionRpc.layer(Rpc, [log.posted, changes, miscounted()], { actions: [Posted] }),
          ),
        ),
      );

      expect(posted).toMatchObject([{ _tag: "Occurrence", eventId: "m1", cursor: "1" }]);
      expect(Exit.isFailure(counted) ? Cause.pretty(counted.cause) : "succeeded").toContain(
        "Unknown request tag",
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("ends a watch of an event the server does not serve as an unknown tag", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        return yield* Effect.exit(Stream.runDrain(client.watch(Counted)));
      }).pipe(
        Effect.scoped,
        Effect.provide(overHttp(ActionRpc.layer(ActionRpc.make([Posted]), makeLog().posted))),
      );

      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded").toContain(
        "Unknown request tag",
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("an RPC watch over Effect's HTTP protocol", () => {
  it.effect(
    "reconnects after its response is cut and after a 503, resuming from its cursor, with the headers set around its stream",
    () =>
      Effect.gen(function* () {
        const log = makeLog();

        const web = serve(
          rpcRoutes(ActionRpc.layer(ActionRpc.make([Posted]), log.posted)).pipe(
            Layer.provide(Event.layerMemory),
          ),
        );

        let answered = 0;
        const carried: Array<boolean> = [];

        const flaky = async (request: Request) => {
          answered += 1;
          carried.push((await request.clone().text()).includes("x-probe"));

          if (answered === 2) return new Response("", { status: 503 });

          if (answered === 3) Effect.runSync(log.post("general", "after the cut"));

          const response = await web.handler(request);

          return answered === 1 ? cutAfterAnOccurrence(response) : response;
        };

        yield* log.post("general", "before the cut");

        const watched = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(ActionRpc.make([Posted]));

          const fiber = yield* client
            .watch(Posted, {}, { cursor: "0" })
            .pipe(
              Stream.updateService(
                RpcClient.CurrentHeaders,
                Headers.merge(Headers.fromInput({ "x-probe": "kept" })),
              ),
              Stream.take(2),
              Stream.runCollect,
              Effect.forkChild,
            );

          yield* Effect.repeat(TestClock.adjust("1 second"), { times: 10 });

          return yield* Fiber.join(fiber);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
              Layer.provide(RpcSerialization.layerNdjson),
              Layer.provide(Testing.layer(flaky)),
            ),
          ),
        );

        expect(watched).toMatchObject([
          { _tag: "Occurrence", eventId: "m1", data: { text: "before the cut" } },
          { _tag: "Occurrence", eventId: "m2", data: { text: "after the cut" } },
        ]);
        expect(answered).toBe(3);
        expect(carried).toEqual([true, true, true]);
      }),
  );
});

describe("an RPC watch over a protocol keeping subscriptions", () => {
  const keptOver = (acknowledges: boolean) =>
    Effect.gen(function* () {
      const log = makeLog();
      const kept: Array<ActionRpc.KeptSubscription> = [];
      const sent: Array<RpcMessage.FromServerEncoded> = [];
      const chunks = () => sent.filter(({ _tag }) => _tag === "Chunk").length;

      const keeper: ActionRpc.SubscriptionKeeper = {
        keep: (subscription) => Effect.sync(() => kept.push(subscription)),
      };

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(ActionRpc.make([Posted]));

        const fiber = yield* client
          .watch(Posted, {}, { cursor: "0" })
          .pipe(
            Stream.updateService(
              RpcClient.CurrentHeaders,
              Headers.merge(Headers.fromInput({ "x-probe": "kept" })),
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );

        yield* settle;

        const started = chunks();

        yield* TestClock.adjust("90 seconds");

        const quiet = chunks();

        yield* log.post("general", "after the quiet");
        yield* TestClock.adjust("5 seconds");

        return { received: yield* Fiber.join(fiber), started, quiet };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          inMemoryValuesProtocolTo(ActionRpc.layer(ActionRpc.make([Posted]), log.posted), {
            acknowledges,
            keeper,
            sent,
          }),
        ),
      );

      return { ...watched, kept };
    }).pipe(Effect.provide(Event.layerMemory));

  it.effect(
    "keeps each subscription as admitted, sends no heartbeat, and stays open while silent where the client's protocol acknowledges",
    () =>
      Effect.gen(function* () {
        const { received, started, quiet, kept } = yield* keptOver(true);

        expect(received).toMatchObject([
          { _tag: "Occurrence", eventId: "m1", data: { text: "after the quiet" } },
        ]);
        expect(started).toBe(1);
        expect(quiet).toBe(started);
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatchObject({
          tag: Posted.name,
          payload: { input: {}, cursor: "0" },
        });
        expect(kept[0]?.headers).toContainEqual(["x-probe", "kept"]);
        expect(
          kept[0]?.resumeFrom([
            { _tag: "Checked", cursor: "1" },
            { _tag: "Checked", cursor: "2" },
            { _tag: "Failed" },
          ]),
        ).toEqual({ input: {}, cursor: "2" });
        expect(kept[0]?.resumeFrom([{ _tag: "Failed" }])).toBeUndefined();
      }),
  );

  it.effect(
    "connects again after 60 silent seconds where the client's protocol does not acknowledge, as Effect's HTTP one",
    () =>
      Effect.gen(function* () {
        const { received, kept } = yield* keptOver(false);

        expect(received).toMatchObject([{ _tag: "Occurrence", eventId: "m1" }]);
        expect(kept).toHaveLength(2);
      }),
  );
});

describe("an RPC watch's reconnect rule", () => {
  const request = HttpClientRequest.post("/rpc");

  const httpFailure = (reason: HttpClientError.HttpClientError["reason"]) =>
    new RpcClientError.RpcClientError({
      reason: RpcClientError.RpcClientError.fields.reason.members[2].fromHttpClientError(
        new HttpClientError.HttpClientError({ reason }),
      ),
    });

  const answered = (status: number) =>
    HttpClientResponse.fromWeb(request, new Response("", { status }));

  it("outlasts a socket's failure, the HTTP transport's, a transient status and silence", () => {
    expect(
      [
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006 }),
        }),
        httpFailure(new HttpClientError.TransportError({ request })),
        httpFailure(new HttpClientError.StatusCodeError({ request, response: answered(503) })),
        new Cause.TimeoutError("silent"),
      ].map(isRpcTransient),
    ).toEqual([true, true, true, true]);
  });

  it("ends on a protocol defect, an application's close code, a status no reconnect outlasts, or a declared error", () => {
    expect(
      [
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({ message: "bad frame", cause: null }),
        }),
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 4001 }),
        }),
        httpFailure(new HttpClientError.StatusCodeError({ request, response: answered(404) })),
        new Action.Forbidden(),
      ].map(isRpcTransient),
    ).toEqual([false, false, false, false]);
  });
});

describe("an RPC watch of a log source", () => {
  it.effect(
    "sends no position of its own for each entry its match skips, where the protocol keeps subscriptions",
    () =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<typeof Posted.payload.Type>();
        const sent: Array<RpcMessage.FromServerEncoded> = [];

        const posted = Event.implement(Posted, {
          log: {
            emit: Stream.fromQueue(queue).pipe(Stream.map((data) => ({ eventId: data.id, data }))),
          },
          match: ({ channel }, data) => channel === undefined || data.channel === channel,
        });

        const skipped = Array.from({ length: 20 }, (_, n) => ({
          id: `r${n}`,
          channel: "random",
          text: `noise ${n}`,
        }));

        const received = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(ActionRpc.make([Posted]));

          const fiber = yield* client
            .watch(Posted, { channel: "general" })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

          yield* settle;
          yield* Queue.offerAll(queue, [...skipped, { id: "g1", channel: "general", text: "hi" }]);

          return yield* Fiber.join(fiber);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            inMemoryValuesProtocolTo(ActionRpc.layer(ActionRpc.make([Posted]), posted), {
              keeper: { keep: () => Effect.void },
              sent,
            }),
          ),
        );

        const values = sent.flatMap((each) => (each._tag === "Chunk" ? each.values : []));

        expect(received).toMatchObject([{ _tag: "Occurrence", eventId: "g1" }]);
        expect(
          values.map((value) => (Predicate.isTagged(value, "Checked") ? "Checked" : "other")),
        ).toEqual(["Checked", "other"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );
});
