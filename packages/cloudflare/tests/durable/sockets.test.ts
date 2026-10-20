import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Effect, Schedule } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { Overdrawn } from "../support/app.js";
import { nextMessage, scopedClientOver, upgradeTo, upgradeToRpc } from "../support/socket.js";

const manual = (name: string) => env.MANUAL.getByName(name);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("Sockets", () => {
  it.effect("dispatches a class's own socket events to the protocol serving its rpcs", () =>
    Effect.gen(function* () {
      const client = yield* scopedClientOver(yield* upgradeToRpc(manual("serves"), bearer("ada")));

      expect(yield* client.whoami()).toBe("ada");
      expect(yield* client.spend({ amount: 4 })).toEqual({ left: 6 });
      expect(yield* Effect.flip(client.spend({ amount: 7 }))).toEqual(new Overdrawn({ by: 1 }));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "dispatches a socket's message on the instance it woke, once the routes are built",
    () =>
      Effect.gen(function* () {
        const stub = manual("hibernates");
        const client = yield* scopedClientOver(yield* upgradeToRpc(stub, bearer("grace")));

        expect(yield* client.spend({ amount: 3 })).toEqual({ left: 7 });

        yield* Effect.promise(() => evictDurableObject(stub));

        expect(yield* client.whoami()).toBe("grace");
        expect(yield* client.spend({ amount: 3 })).toEqual({ left: 7 });
      }).pipe(Effect.scoped),
  );

  it.effect("never gives a new socket the id of one closed before the object was rebuilt", () =>
    Effect.gen(function* () {
      const stub = env.ROOM.getByName("socket-ids");

      const tagsOf = Effect.promise(() =>
        runInDurableObject(stub, (_, state) =>
          state.getWebSockets().map((socket) => state.getTags(socket)),
        ),
      );

      const first = yield* upgradeToRpc(stub);

      first.close(1000);

      yield* tagsOf.pipe(
        Effect.repeat({
          while: (tags) => tags.length > 0,
          schedule: Schedule.spaced("10 millis"),
        }),
      );

      yield* Effect.promise(() => evictDurableObject(stub));
      yield* upgradeToRpc(stub);

      const [tags] = yield* tagsOf;

      expect(tags).toContain("effect-actions/socket#2");
    }),
  );

  it.effect("leaves a client's ping to the runtime", () =>
    Effect.gen(function* () {
      const stub = manual("pings");
      const socket = yield* upgradeToRpc(stub);
      const pong = nextMessage(socket);

      socket.send(JSON.stringify({ _tag: "Ping" }));

      expect(JSON.parse(yield* pong)).toEqual({ _tag: "Pong" });

      const autoResponded = yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) =>
          state.getWebSockets().map((held) => state.getWebSocketAutoResponseTimestamp(held)),
        ),
      );

      expect(autoResponded).toEqual([expect.any(Date)]);
    }),
  );

  it.effect("answers false for a socket no protocol accepted, which the class answers", () =>
    Effect.gen(function* () {
      const stub = manual("own");
      const own = yield* upgradeTo(stub, "https://object/own");
      const echo = nextMessage(own);

      own.send("hello");

      expect(yield* echo).toBe("hello");

      const client = yield* scopedClientOver(yield* upgradeToRpc(stub, bearer("ada")));

      expect(yield* client.whoami()).toBe("ada");
    }).pipe(Effect.scoped),
  );
});
