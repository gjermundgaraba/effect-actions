import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect } from "effect";

import { Noted, Said } from "../support/events.js";
import { upgradeToRpc } from "../support/socket.js";
import {
  bearer,
  clientOver,
  collected,
  keptCursors,
  until,
  untilKept,
} from "../support/watching.js";
import type { Served } from "../worker.js";

const served = (name: string) => env.SERVED.getByName(name);

const watchedSocket = (stub: DurableObjectStub) =>
  Effect.gen(function* () {
    const socket = yield* upgradeToRpc(stub, bearer("ada"));
    const client = yield* clientOver(socket);

    yield* collected(client.watch(Noted, {}, { cursor: "0" }));
    yield* untilKept(stub, (cursors) => cursors.length === 1);

    return socket;
  });

describe("ObjectServer.layer in a class make does not build", () => {
  it.live(
    "delivers an event published through the Event.Events it outputs to a socket watching over its routes",
    () =>
      Effect.gen(function* () {
        const stub = served("shares-events");

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

        expect(received).toStrictEqual(["one"]);
      }).pipe(Effect.scoped)
  );

  it.live("forgets a socket's subscriptions as webSocketClose runs", () =>
    Effect.gen(function* () {
      const stub = served("closes");
      const socket = yield* watchedSocket(stub);

      socket.close(1000);

      yield* untilKept(stub, (cursors) => cursors.length === 0);

      expect(yield* keptCursors(stub)).toStrictEqual([]);
    }).pipe(Effect.scoped)
  );

  it.live("forgets a socket's subscriptions as webSocketError runs", () =>
    Effect.gen(function* () {
      const stub = served("fails");

      yield* watchedSocket(stub);
      yield* Effect.promise(async () => {
        await runInDurableObject(stub, async (instance: Served, state) => {
          const [socket] = state.getWebSockets();

          if (socket === undefined) {
            throw new Error("No socket");
          }

          await instance.webSocketError(socket, new Error("lost"));
        });
      });

      expect(yield* keptCursors(stub)).toStrictEqual([]);
    }).pipe(Effect.scoped)
  );

  it.effect("gives a request the services the Layer was built with", () =>
    Effect.gen(function* () {
      const answer = yield* Effect.promise(async () => {
        const response = await served("greeting").fetch(
          "https://object/greeting"
        );

        return await response.text();
      });

      expect(answer).toBe("built with the object");
    })
  );

  it.effect("runs the routes on the scheduler fetch runs on", () =>
    Effect.gen(function* () {
      const answer = yield* Effect.promise(async () => {
        const response = await served("scheduler").fetch(
          "https://object/scheduler"
        );

        return await response.text();
      });

      expect(answer).toBe("the event's");
    })
  );
});
