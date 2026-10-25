import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { ShelfCalls, ShelfChanged, ShelfHttp, ShelfRpc, shelves } from "../support/placed.js";
import { protocolOver, upgradeToRpc } from "../support/socket.js";

const worker = Testing.layer(
  ActionHttp.layer(
    ShelfHttp,
    ActionDurableObject.reaching(shelves, () => env.SHELF),
  ),
);

const untilSeen = (seen: ReadonlyArray<unknown>, count: number) =>
  Effect.sleep("10 millis").pipe(Effect.repeat({ while: () => seen.length < count }));

describe("ActionDurableObject.placed", () => {
  it.live(
    "serves each call in the object its input names, and follows an event there, through a Worker serving none",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionHttp.client(ShelfHttp);
        const seen: Array<ReadonlyArray<string>> = [];

        const watching = yield* client.watch(ShelfChanged, { shelf: "placed-a" }).pipe(
          Stream.runForEach((item) =>
            Effect.sync(() => seen.push(item._tag === "Gap" ? [] : item.data.titles)),
          ),
          Effect.forkChild,
        );

        yield* untilSeen(seen, 1);

        const counts = [
          yield* client.putBook({ onto: "placed-a", title: "Dune" }),
          yield* client.putBook({ onto: "placed-b", title: "Emma" }),
          yield* client.putBook({ onto: "placed-a", title: "Ulysses" }),
        ];

        yield* untilSeen(seen, 3);
        yield* Fiber.interrupt(watching);

        expect(counts).toEqual([1, 1, 2]);
        expect(seen).toEqual([[], ["Dune"], ["Dune", "Ulysses"]]);
      }).pipe(Effect.provide(worker), Effect.timeout("5 seconds")),
  );

  it.live(
    "refuses, in the object, an input naming another object, over its routes, its socket and its stub",
    () =>
      Effect.gen(function* () {
        const stub = env.SHELF.getByName("placed-c");

        const refused = new Action.Forbidden({
          message: "This object is placed-c, and the input of putBook names placed-d",
        });

        const overHttp = yield* Effect.flatMap(
          ActionHttp.client(ShelfHttp, { baseUrl: "https://object" }),
          (client) => Effect.flip(client.putBook({ onto: "placed-d", title: "Dune" })),
        ).pipe(Effect.provide(ActionDurableObject.layerHttpClient(stub)));

        const protocol = yield* Layer.build(protocolOver(yield* upgradeToRpc(stub)));

        const overSocket = yield* Effect.flatMap(ActionRpc.client(ShelfRpc), (client) =>
          Effect.flip(client.putBook({ onto: "placed-d", title: "Dune" })),
        ).pipe(Effect.provideContext(protocol));

        const overStub = yield* Effect.flatMap(ActionRpc.client(ShelfCalls), (client) =>
          Effect.flip(client.putBook({ onto: "placed-d", title: "Dune" })),
        ).pipe(Effect.provide(ActionDurableObject.layerStubClient(() => stub)));

        expect([overHttp, overSocket, overStub]).toEqual([refused, refused, refused]);
      }).pipe(Effect.scoped),
  );
});
