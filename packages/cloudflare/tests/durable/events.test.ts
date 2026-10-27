import { describe, expect, it, vi } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { RpcMessage } from "effect/rpc";

import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { layerEvents } from "../../src/durable/events.js";
import { groupTag, socketIdOf } from "../../src/durable/frames.js";
import { keptPrefix } from "../../src/durable/subscriptions.js";
import { Noted, Said, Statused, Watched } from "../support/events.js";
import {
  protocolOver,
  protocolUpgrading,
  upgradeTo,
  upgradeToRpc,
} from "../support/socket.js";

const watching = (name: string) => env.WATCHING.getByName(name);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const clientOver = (socket: WebSocket) =>
  Effect.flatMap(Layer.build(protocolOver(socket)), (protocol) =>
    ActionRpc.client(Watched).pipe(Effect.provideContext(protocol))
  );

const Resumed = Schema.Struct({
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const resumedOf = Schema.decodeUnknownOption(Resumed);

const keptCursors = (stub: DurableObjectStub) =>
  Effect.promise(
    async () =>
      await runInDurableObject(stub, async (_, state) => {
        const kept = await state.storage.list({
          prefix: `${keptPrefix}payload/`,
        });

        return [...kept.values()];
      })
  ).pipe(
    Effect.map((kept) =>
      kept.map((value) =>
        Option.match(resumedOf(value), {
          onNone: () => "unreadable",
          onSome: ({ cursor }) => cursor ?? null,
        })
      )
    )
  );

const until = (check: () => boolean) =>
  Effect.promise(
    async () => await vi.waitUntil(check, { timeout: 5000, interval: 10 })
  );

const untilKept = (
  stub: DurableObjectStub,
  check: (cursors: Array<string | null>) => boolean
) =>
  Effect.promise(
    async () =>
      await vi.waitUntil(
        async () => check(await Effect.runPromise(keptCursors(stub))),
        {
          timeout: 5000,
          interval: 10,
        }
      )
  );

const collected = <E>(
  stream: Stream.Stream<
    | Event.Received<typeof Noted>
    | Event.Received<typeof Said>
    | Event.Received<typeof Statused>,
    E
  >
) =>
  Effect.gen(function* () {
    const received: string[] = [];

    const fiber = yield* stream.pipe(
      Stream.runForEach((item) =>
        Effect.sync(() =>
          received.push(item._tag === "Gap" ? "gap" : item.data.text)
        )
      ),
      Effect.exit,
      Effect.forkScoped
    );

    return { received, fiber };
  });

const evicted = (stub: DurableObjectStub) =>
  Effect.promise(async () => {
    await evictDurableObject(stub);
  });

const keptWatch = (stub: DurableObjectStub, suffix: string) =>
  Effect.promise(async () => {
    await runInDurableObject(stub, async (_, state) => {
      await state.storage.put({
        [`${keptPrefix}request/${suffix}`]: {
          _tag: "Request",
          id: 1,
          tag: Noted.name,
          headers: [["authorization", "Bearer ada"]],
        },
        [`${keptPrefix}payload/${suffix}`]: { input: {}, cursor: "0" },
      });
    });
  });

describe("an event subscription over layerWebSocket", () => {
  it.live(
    "resumes a socket's watch of a check source on the instance after an eviction, from the position it reached",
    () =>
      Effect.gen(function* () {
        const stub = watching("check-resumes");

        const client = yield* clientOver(
          yield* upgradeToRpc(stub, bearer("ada"))
        );

        const { received } = yield* collected(
          client.watch(Noted, {}, { cursor: "0" })
        );

        yield* untilKept(stub, (cursors) => cursors.length === 1);
        yield* Effect.promise(async () => {
          await stub.note("one");
        });
        yield* until(() => received.length === 1);
        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.note("two");
        });
        yield* until(() => received.length === 2);

        expect(received).toStrictEqual(["one", "two"]);
        expect(yield* keptCursors(stub)).toStrictEqual(["2"]);
      }).pipe(Effect.scoped)
  );

  it.live(
    'keeps two watches apart whose request ids are 1 and "1", through an eviction',
    () =>
      Effect.gen(function* () {
        const stub = watching("mixed-ids");
        const ids = [RpcMessage.RequestId(1), RpcMessage.RequestId("1")];

        const protocol = yield* Layer.build(
          protocolOver(yield* upgradeToRpc(stub, bearer("ada")))
        );

        const client = yield* ActionRpc.client(Watched, {
          generateRequestId: () => ids.shift() ?? RpcMessage.RequestId(100),
        }).pipe(Effect.provideContext(protocol));

        const first = yield* collected(
          client.watch(Noted, {}, { cursor: "0" })
        );

        const second = yield* collected(
          client.watch(Noted, {}, { cursor: "0" })
        );

        yield* untilKept(stub, (cursors) => cursors.length === 2);
        yield* Effect.promise(async () => {
          await stub.note("one");
        });
        yield* until(
          () => first.received.length === 1 && second.received.length === 1
        );
        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.note("two");
        });
        yield* until(
          () => first.received.length === 2 && second.received.length === 2
        );

        expect([first.received, second.received]).toStrictEqual([
          ["one", "two"],
          ["one", "two"],
        ]);
      }).pipe(Effect.scoped)
  );

  it.live(
    "resumes a socket's watch of a log source after an eviction, its log kept in storage",
    () =>
      Effect.gen(function* () {
        const stub = watching("log-resumes");

        const client = yield* clientOver(
          yield* upgradeToRpc(stub, bearer("ada"))
        );

        const { received } = yield* collected(client.watch(Said));

        yield* untilKept(
          stub,
          (cursors) => cursors.length === 1 && cursors[0] !== null
        );
        yield* Effect.promise(async () => {
          await stub.say("one");
        });
        yield* until(() => received.length === 1);
        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.say("two");
        });
        yield* until(() => received.length === 2);

        expect(received).toStrictEqual(["one", "two"]);
      }).pipe(Effect.scoped)
  );

  it.live(
    "resumes a socket's watch of a current source after an eviction at the revision it reached, sending the value only when notified",
    () =>
      Effect.gen(function* () {
        const stub = watching("current-resumes");

        const client = yield* clientOver(
          yield* upgradeToRpc(stub, bearer("ada"))
        );

        const { received } = yield* collected(client.watch(Statused));

        yield* until(() => received.length === 1);
        yield* Effect.promise(async () => {
          await stub.status("busy");
        });
        yield* until(() => received.length === 2);
        yield* untilKept(
          stub,
          (cursors) =>
            cursors.length === 1 && cursors[0]?.endsWith(":1") === true
        );
        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.say("wakes it");
        });
        yield* Effect.promise(async () => {
          await stub.status("done");
        });
        yield* until(() => received.length >= 3);

        expect(received).toStrictEqual(["idle", "busy", "done"]);
      }).pipe(Effect.scoped)
  );

  it.live(
    "authenticates a resumed watch again, ending it as unauthenticated where its token was revoked while the object slept",
    () =>
      Effect.gen(function* () {
        const stub = watching("revoked");

        const client = yield* clientOver(
          yield* upgradeToRpc(stub, bearer("ada"))
        );

        const { received, fiber } = yield* collected(
          client.watch(Noted, {}, { cursor: "0" })
        );

        yield* untilKept(stub, (cursors) => cursors.length === 1);
        yield* Effect.promise(async () => {
          await stub.revoke("ada");
        });
        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.note("one");
        });

        const exit = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"));

        expect(
          Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit
        ).toBeInstanceOf(Action.Unauthenticated);
        expect(received).toStrictEqual([]);
        expect(yield* keptCursors(stub)).toStrictEqual([]);
      }).pipe(Effect.scoped)
  );

  it.live(
    "forgets a subscription its client stops reading, and every one of a socket that closes",
    () =>
      Effect.gen(function* () {
        const stub = watching("forgets");
        const socket = yield* upgradeToRpc(stub, bearer("ada"));
        const client = yield* clientOver(socket);

        const noted = yield* collected(
          client.watch(Noted, {}, { cursor: "0" })
        );

        yield* collected(client.watch(Said));
        yield* untilKept(stub, (cursors) => cursors.length === 2);
        yield* Fiber.interrupt(noted.fiber);
        yield* untilKept(stub, (cursors) => cursors.length === 1);

        socket.close(1000);

        yield* untilKept(stub, (cursors) => cursors.length === 0);
      }).pipe(Effect.scoped)
  );

  it.live(
    "closes a socket whose kept subscription it cannot resume, and its watch connects again and reads on",
    () =>
      Effect.gen(function* () {
        const stub = watching("unresumable");

        const client = yield* Effect.flatMap(
          Layer.build(protocolUpgrading(stub, bearer("ada"))),
          (protocol) =>
            ActionRpc.client(Watched).pipe(Effect.provideContext(protocol))
        );

        const { received } = yield* collected(
          client.watch(Noted, {}, { cursor: "0" })
        );

        yield* untilKept(stub, (cursors) => cursors.length === 1);

        yield* Effect.promise(async () => {
          await runInDurableObject(stub, async (_, state) => {
            const requests = await state.storage.list({
              prefix: `${keptPrefix}request/`,
            });

            for (const key of requests.keys()) {
              await state.storage.put(key, "from another version");
            }
          });
        });

        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.note("one");
        });
        yield* until(() => received.length === 1);

        expect(received).toStrictEqual(["one"]);
        expect(yield* keptCursors(stub)).toStrictEqual(["1"]);
      }).pipe(Effect.scoped)
  );

  it.live(
    "forgets, as it wakes, a kept subscription whose socket is gone",
    () =>
      Effect.gen(function* () {
        const stub = watching("orphaned");

        yield* keptWatch(stub, "/rpc#999#n1");
        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.note("one");
        });

        expect(yield* keptCursors(stub)).toStrictEqual([]);
      })
  );

  it.live(
    "reads a log entry that no longer decodes, or whose data no longer does, as a gap, and reads on past it",
    () =>
      Effect.gen(function* () {
        const stub = watching("undecodable");

        const client = yield* clientOver(
          yield* upgradeToRpc(stub, bearer("ada"))
        );

        const { received } = yield* collected(client.watch(Said));

        yield* untilKept(
          stub,
          (cursors) => cursors.length === 1 && cursors[0] !== null
        );
        yield* Effect.promise(async () => {
          await stub.say("one");
        });
        yield* until(() => received.length === 1);

        yield* Effect.promise(async () => {
          await runInDurableObject(stub, async (_, state) => {
            const log = "effect-actions/log/thing.said/";

            const position = await state.storage.get<{
              readonly epoch: string;
            }>(`${log}meta`);

            await state.storage.put({
              [`${log}entry/0000000000000002`]: "from another version",
              [`${log}entry/0000000000000003`]: {
                at: Date.now(),
                data: { text: 3 },
              },
              [`${log}meta`]: { epoch: position?.epoch, last: 3 },
            });
          });
        });

        yield* Effect.promise(async () => {
          await stub.say("four");
        });
        yield* until(() => received.length === 4);

        expect(received).toStrictEqual(["one", "gap", "gap", "four"]);
      }).pipe(Effect.scoped)
  );
});

const failureIn = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, Event.Events | Scope.Scope>
) =>
  Effect.promise(
    async () =>
      await runInDurableObject(
        watching(name),
        async (_, state) =>
          await Effect.runPromiseExit(
            effect.pipe(
              Effect.scoped,
              Effect.provide(layerEvents),
              Effect.provideService(ActionDurableObject.State, state)
            )
          )
      )
  ).pipe(
    Effect.map((exit) =>
      Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : exit
    )
  );

const namesake = () =>
  Event.make("thing.namesake", {
    description: "Two event types of one name.",
    payload: { text: Schema.String },
    caller: Action.Anyone,
  });

describe("the object's Event.Events", () => {
  it.live(
    "refuses a second log source whose event type shares the first's name",
    () =>
      Effect.gen(function* () {
        const [first, second] = [namesake(), namesake()];

        const failure = yield* failureIn(
          "namesakes",
          Effect.gen(function* () {
            const one = yield* Action.client([
              Event.implement(first, { log: {} }),
            ]);

            const other = yield* Action.client([
              Event.implement(second, { log: {} }),
            ]);

            yield* Stream.runDrain(Stream.take(one.watch(first), 0));
            yield* Stream.runDrain(Stream.take(other.watch(second), 0));
          })
        );

        expect(failure).toContain('two event types are named "thing.namesake"');
      })
  );

  it.live("refuses a log source fed by emit", () =>
    Effect.gen(function* () {
      const Emitted = Event.make("thing.emitted", {
        description: "An occurrence a stream feeds.",
        payload: { text: Schema.String },
        caller: Action.Anyone,
      });

      const failure = yield* failureIn(
        "emitted",
        Action.client([
          Event.implement(Emitted, {
            log: { emit: Stream.make({ data: { text: "one" } }) },
          }),
        ])
      );

      expect(failure).toContain(
        'Event "thing.emitted" has a log source fed by emit, which this Event.Events does not consume'
      );
    })
  );
});

const alsoSockets = (stub: DurableObjectStub) =>
  Effect.promise(
    async () =>
      await runInDurableObject(stub, (_, state) =>
        state
          .getWebSockets(groupTag("/also"))
          .map((socket) => socketIdOf(state.getTags(socket)))
      )
  );

describe("layerWebSocket's kept subscriptions", () => {
  it.live(
    "forgets, as it wakes, a subscription its path kept for a socket id another path's open socket has since",
    () =>
      Effect.gen(function* () {
        const stub = watching("cross-path");

        yield* upgradeTo(stub, "https://object/also", bearer("ada"));

        const [other] = yield* alsoSockets(stub);

        yield* keptWatch(stub, `/rpc#${other}#n1`);
        yield* evicted(stub);
        yield* Effect.promise(async () => {
          await stub.note("one");
        });

        expect(yield* alsoSockets(stub)).toStrictEqual([other]);
        expect(yield* keptCursors(stub)).toStrictEqual([]);
      })
  );
});
