import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import {
  Headers,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import {
  Rpc as NativeRpc,
  RpcClient,
  RpcClientError,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import type { RpcMessage } from "effect/rpc";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { erasedOf } from "../../src/rpc/erased.js";
import { isRpcTransient } from "../../src/rpc/watch.js";
import * as Testing from "../../src/testing/Testing.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { makeMessages, Posted, settle } from "../support/events.js";
import { overHttp, rpcRoutes } from "../support/rpc.js";
import { serve } from "../support/serve.js";
import { inMemoryValuesProtocolTo } from "../support/values.js";

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

const Login = Authentication.make("rpc-events.Login", CurrentActor, {
  principal: (actor) => actor.id,
});

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
                cursor === null
                  ? []
                  : [{ eventId: `by-${actor.id}`, data: { by: actor.id } }],
            }))
      ),
  },
  {
    authorize: () =>
      Effect.flatMap(CurrentActor, (actor) =>
        actor.permissions.includes("users:write")
          ? Effect.void
          : Effect.fail(
              new Action.Forbidden({ message: "Requires users:write." })
            )
      ),
  }
);

const counts = Event.implement(Counted, {
  check: () => Effect.succeed({ cursor: "0", events: [] }),
});

const Rpc = ActionRpc.make([Posted, Changed, Counted], {
  authentication: Login,
});

const clientTo = (handler: (request: Request) => Promise<Response>) =>
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Testing.layer(handler))
  );

const cutAfterAnOccurrence = (response: Response) => {
  const decoder = new TextDecoder();

  return new Response(
    response.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);

          if (decoder.decode(chunk).includes('"Occurrence"')) {
            controller.terminate();
          }
        },
      })
    ),
    { headers: response.headers }
  );
};

const served = (log = makeMessages()) =>
  overHttp(
    ActionRpc.layer(Rpc, [log.implementation, changes, counts]).pipe(
      Layer.provide(Authentication.layer(Login, verify))
    )
  );

const signedInAs = (token: string) =>
  RpcClient.withHeaders({ authorization: `Bearer ${token}` });

describe("RPC events", () => {
  it.effect("streams what happened since a cursor, and from now", () =>
    Effect.gen(function* () {
      const log = makeMessages();

      log.post("general", "before");

      const watched = yield* Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        const fromCursor = yield* client
          .watch(Posted, { channel: "general" }, { cursor: "0" })
          .pipe(Stream.take(1), Stream.runCollect);

        const fromNow = yield* client
          .watch(Posted)
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;
        log.post("general", "after");
        yield* TestClock.adjust("5 seconds");

        return [fromCursor, yield* Fiber.join(fromNow)];
      }).pipe(Effect.scoped, Effect.provide(served(log)));

      expect(watched).toMatchObject([
        [
          {
            _tag: "Occurrence",
            eventId: "m1",
            data: { text: "before" },
            cursor: "1",
          },
        ],
        [
          {
            _tag: "Occurrence",
            eventId: "m2",
            data: { text: "after" },
            cursor: "2",
          },
        ],
      ]);
    }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "watches a protected event as the message's caller, refused when it starts and later",
    () =>
      Effect.gen(function* () {
        const [changed, refused, revoked, signedOut] = yield* Effect.gen(
          function* () {
            const client = yield* ActionRpc.client(Rpc);
            const watch = client.watch(Changed, {}, { cursor: "1" });

            const revoking = yield* Effect.flip(Stream.runDrain(watch)).pipe(
              signedInAs("alice"),
              Effect.forkChild
            );

            yield* settle;
            yield* TestClock.adjust("5 seconds");

            return yield* Effect.all([
              watch.pipe(
                Stream.take(1),
                Stream.runCollect,
                signedInAs("alice")
              ),
              Effect.flip(Stream.runDrain(watch)).pipe(signedInAs("reader")),
              Fiber.join(revoking),
              Effect.flip(Stream.runDrain(watch)),
            ]);
          }
        ).pipe(Effect.scoped, Effect.provide(served()));

        expect(changed).toMatchObject([
          { eventId: "by-alice", data: { by: "alice" } },
        ]);
        expect(refused).toMatchObject({
          _tag: "Forbidden",
          message: "Requires users:write.",
        });
        expect(revoked).toMatchObject({
          _tag: "Forbidden",
          message: "Revoked.",
        });
        expect(signedOut).toMatchObject({ _tag: "Unauthenticated" });
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "fails an input that does not encode with InvalidInput, sending nothing",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();
        let requests = 0;

        const web = serve(
          rpcRoutes(
            ActionRpc.layer(ActionRpc.make([Posted]), log.implementation)
          ).pipe(Layer.provide(Event.layerMemory))
        );

        log.post("general", "sent");

        const [invalid, refusedRequests, watched] = yield* Effect.gen(
          function* () {
            const rpc = yield* ActionRpc.client(ActionRpc.make([Posted]));

            const input = yield* Effect.flip(
              // @ts-expect-error -- A channel is a string.
              Stream.runDrain(rpc.watch(Posted, { channel: 1 }))
            );

            const before = requests;

            return [
              input,
              before,
              yield* rpc
                .watch(Posted, {}, { cursor: "0" })
                .pipe(Stream.take(1), Stream.runCollect),
            ] as const;
          }
        ).pipe(
          Effect.scoped,
          Effect.provide(
            clientTo(async (request) => {
              requests += 1;

              return await web.handler(request);
            })
          )
        );

        expect(invalid).toMatchObject({ _tag: "InvalidInput" });
        expect(refusedRequests).toBe(0);
        expect([watched, requests]).toMatchObject([[{ eventId: "m1" }], 1]);
      })
  );

  it.effect(
    "serves the event types its actions list alone, a watch of another failing with NotServed, with no mode or with mode stream",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();

        log.post("general", "before");

        const [posted, counted, streamed] = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(Rpc);

          return [
            yield* client
              .watch(Posted, {}, { cursor: "0" })
              .pipe(Stream.take(1), Stream.runCollect),
            yield* Effect.flip(Stream.runDrain(client.watch(Counted))),
            yield* Effect.flip(
              Stream.runDrain(client.watch(Counted, {}, { mode: "stream" }))
            ),
          ] as const;
        }).pipe(
          Effect.scoped,
          Effect.provide(
            overHttp(
              ActionRpc.layer(Rpc, [log.implementation, changes, counts], {
                actions: [Posted],
              })
            )
          )
        );

        expect(posted).toMatchObject([
          { _tag: "Occurrence", eventId: "m1", cursor: "1" },
        ]);
        expect(counted).toMatchObject({
          _tag: "SubscriptionError",
          event: "counter.counted",
          reason: { _tag: "NotServed" },
        });
        expect(streamed).toMatchObject({
          _tag: "SubscriptionError",
          event: "counter.counted",
          reason: { _tag: "NotServed" },
        });
      }).pipe(Effect.provide(Event.layerMemory))
  );
});

describe("ActionRpc.layer's poll rpc", () => {
  it.effect(
    "sets a protected event's subscription hook up for each principal polling without a watch, as that caller",
    () =>
      Effect.gen(function* () {
        const held: string[] = [];

        const hooked = Event.implement(
          Changed,
          {
            check: () => Effect.succeed({ cursor: "0", events: [] }),
            subscription: () =>
              Effect.flatMap(CurrentActor, (actor) =>
                Effect.sync(() => held.push(actor.id))
              ),
          },
          { authorize: Event.allowAll }
        );

        const pages = yield* Effect.gen(function* () {
          const client = yield* RpcClient.make(
            erasedOf([], [Changed], ["poll"])
          );

          const polled = (token: string) => {
            const answer = client[ActionRpc.pollTag(Changed.name)]?.({
              input: {},
              cursor: null,
            });

            return answer !== undefined && Effect.isEffect(answer)
              ? signedInAs(token)(answer)
              : Effect.die(new Error("No unary poll rpc"));
          };

          return yield* Effect.forEach(["alice", "bob", "alice"], polled);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            overHttp(
              ActionRpc.layer(
                ActionRpc.make([Changed], { authentication: Login }),
                hooked
              ).pipe(Layer.provide(Authentication.layer(Login, verify)))
            )
          )
        );

        expect(pages).toMatchObject([
          { cursor: "0" },
          { cursor: "0" },
          { cursor: "0" },
        ]);
        expect(held).toStrictEqual(["alice", "bob"]);
      }).pipe(Effect.provide(Event.layerMemory))
  );
});

describe("an RPC watch over Effect's HTTP protocol", () => {
  it.effect(
    "reconnects after its response is cut and after a 503, resuming from its cursor, with the headers set around its stream",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();

        const web = serve(
          rpcRoutes(
            ActionRpc.layer(ActionRpc.make([Posted]), log.implementation)
          ).pipe(Layer.provide(Event.layerMemory))
        );

        let answered = 0;
        const carried: boolean[] = [];

        const flaky = async (request: Request) => {
          answered += 1;
          const body = await request.clone().text();
          carried.push(body.includes("x-probe"));

          if (answered === 2) {
            return new Response("", { status: 503 });
          }

          if (answered === 3) {
            log.post("general", "after the cut");
          }

          const response = await web.handler(request);

          return answered === 1 ? cutAfterAnOccurrence(response) : response;
        };

        log.post("general", "before the cut");

        const watched = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(ActionRpc.make([Posted]));

          const fiber = yield* client
            .watch(Posted, {}, { cursor: "0" })
            .pipe(
              Stream.updateService(
                RpcClient.CurrentHeaders,
                Headers.merge(Headers.fromInput({ "x-probe": "kept" }))
              ),
              Stream.take(2),
              Stream.runCollect,
              Effect.forkChild
            );

          yield* Effect.repeat(TestClock.adjust("1 second"), { times: 10 });

          return yield* Fiber.join(fiber);
        }).pipe(Effect.scoped, Effect.provide(clientTo(flaky)));

        expect(watched).toMatchObject([
          {
            _tag: "Occurrence",
            eventId: "m1",
            data: { text: "before the cut" },
          },
          {
            _tag: "Occurrence",
            eventId: "m2",
            data: { text: "after the cut" },
          },
        ]);
        expect(answered).toBe(3);
        expect(carried).toStrictEqual([true, true, true]);
      })
  );
});

const SilentPosted = RpcGroup.make(
  NativeRpc.make(Posted.name, {
    payload: Schema.Json,
    success: Schema.Json,
    stream: true,
  })
);

const silentWatch = (acknowledges: boolean) =>
  Effect.gen(function* () {
    let subscribed = 0;

    const silent = RpcServer.layer(SilentPosted).pipe(
      Layer.provide(
        SilentPosted.toLayer({
          [Posted.name]: () => {
            subscribed += 1;

            return Stream.never;
          },
        })
      )
    );

    return yield* Effect.gen(function* () {
      const client = yield* ActionRpc.client(ActionRpc.make([Posted]));

      yield* client
        .watch(Posted, {}, { cursor: "0" })
        .pipe(Stream.runDrain, Effect.forkChild);

      yield* settle;
      yield* TestClock.adjust("60999 millis");

      const beforeSilence = subscribed;

      yield* TestClock.adjust("1 millis");

      return [beforeSilence, subscribed];
    }).pipe(
      Effect.scoped,
      Effect.provide(inMemoryValuesProtocolTo(silent, { acknowledges }))
    );
  });

describe("an RPC watch of a silent server", () => {
  it.effect(
    "connects again after 60 silent seconds where the client's protocol does not acknowledge, as Effect's HTTP one",
    () =>
      Effect.gen(function* () {
        expect(yield* silentWatch(false)).toStrictEqual([1, 2]);
      })
  );

  it.effect(
    "stays connected through the silence where the client's protocol acknowledges, as a socket's",
    () =>
      Effect.gen(function* () {
        expect(yield* silentWatch(true)).toStrictEqual([1, 1]);
      })
  );
});

const httpFailure = (reason: HttpClientError.HttpClientError["reason"]) =>
  new RpcClientError.RpcClientError({
    reason:
      RpcClientError.RpcClientError.fields.reason.members[2].fromHttpClientError(
        new HttpClientError.HttpClientError({ reason })
      ),
  });

describe("an RPC watch's reconnect rule", () => {
  const request = HttpClientRequest.post("/rpc");

  const answered = (status: number) =>
    HttpClientResponse.fromWeb(request, new Response("", { status }));

  it("outlasts a socket's failure, the HTTP transport's, a transient status and silence", () => {
    expect(
      [
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006 }),
        }),
        httpFailure(new HttpClientError.TransportError({ request })),
        httpFailure(
          new HttpClientError.StatusCodeError({
            request,
            response: answered(503),
          })
        ),
        new Cause.TimeoutError("silent"),
      ].map(isRpcTransient)
    ).toStrictEqual([true, true, true, true]);
  });

  it("ends on a protocol defect, an application's close code, a status no reconnect outlasts, or a declared error", () => {
    expect(
      [
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "bad frame",
            cause: null,
          }),
        }),
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 4001 }),
        }),
        httpFailure(
          new HttpClientError.StatusCodeError({
            request,
            response: answered(404),
          })
        ),
        new Action.Forbidden(),
      ].map(isRpcTransient)
    ).toStrictEqual([false, false, false, false]);
  });
});

describe("an RPC watch of a log source", () => {
  it.effect("sends no position of its own for each entry its match skips", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<typeof Posted.payload.Type>();
      const sent: RpcMessage.FromServerEncoded[] = [];

      const posted = Event.implement(Posted, {
        log: {
          emit: Stream.fromQueue(queue).pipe(
            Stream.map((data) => ({ eventId: data.id, data }))
          ),
        },
        match: ({ channel }, data) =>
          channel === undefined || data.channel === channel,
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
        yield* Queue.offerAll(queue, [
          ...skipped,
          { id: "g1", channel: "general", text: "hi" },
        ]);

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          inMemoryValuesProtocolTo(
            ActionRpc.layer(ActionRpc.make([Posted]), posted),
            { sent }
          )
        )
      );

      const values = sent.flatMap((each) =>
        each._tag === "Chunk" ? each.values : []
      );

      expect(received).toMatchObject([{ _tag: "Occurrence", eventId: "g1" }]);
      expect(
        values.map((value) =>
          Predicate.isTagged(value, "Checked") ? "Checked" : "other"
        )
      ).toStrictEqual(["Checked", "other"]);
    }).pipe(Effect.provide(Event.layerMemory))
  );
});
