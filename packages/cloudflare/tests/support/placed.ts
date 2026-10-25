import { Effect, Layer, Option, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export const PutBook = Action.make("putBook", {
  description: "Put a book on a shelf.",
  input: { onto: Schema.String, title: Schema.String },
  success: Schema.Int,
  readOnly: false,
  caller: Action.Anyone,
});

export const ShelfChanged = Event.make("shelf.changed", {
  description: "A shelf's books, whole.",
  input: { shelf: Schema.String },
  payload: { titles: Schema.Array(Schema.String) },
  caller: Action.Anyone,
});

export const ShelfHttp = ActionHttp.make([PutBook, ShelfChanged]);

export const ShelfRpc = ActionRpc.make([PutBook, ShelfChanged]);

export const ShelfCalls = ActionRpc.make([PutBook]);

export const shelves = ActionDurableObject.placed(ShelfHttp, {
  putBook: ({ onto }) => onto,
  "shelf.changed": ({ shelf }) => shelf,
});

const Titles = Schema.Array(Schema.String);

const titlesOf = Schema.decodeUnknownOption(Titles);

const titlesIn = (storage: DurableObjectStorage) =>
  Option.getOrElse(titlesOf(storage.kv.get("titles")), (): ReadonlyArray<string> => []);

const books = Action.implement(
  PutBook,
  Effect.map(
    Effect.all([ActionDurableObject.State, Event.Events]),
    ([{ storage }, events]) =>
      ({ title }) => {
        const put = [...titlesIn(storage), title];

        storage.kv.put("titles", put);

        return Effect.as(events.notify(ShelfChanged), put.length);
      },
  ),
);

const changes = Event.implement(
  ShelfChanged,
  Effect.map(ActionDurableObject.State, ({ storage }) => ({
    current: () => Effect.sync(() => ({ titles: titlesIn(storage) })),
  })),
);

export const shelfRoutes = Layer.mergeAll(
  ActionHttp.layer(ShelfHttp, [books, changes]),
  ActionRpc.layer(ShelfRpc, [books, changes]).pipe(
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  ),
);

export const shelfCalls = ActionRpc.layer(ShelfCalls, books);
