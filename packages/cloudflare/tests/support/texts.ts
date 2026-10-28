import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Option, Schema } from "effect";

import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

const Texts = Schema.Array(Schema.String);

const textsOf = Schema.decodeUnknownOption(Texts);

export const textsIn = (storage: DurableObjectStorage, key: string) =>
  Effect.map(
    Effect.promise(async () => await storage.get(key)),
    (stored) => Option.getOrElse(textsOf(stored), (): readonly string[] => [])
  );

export const textsSince = (
  storage: DurableObjectStorage,
  key: string,
  prefix: string,
  cursor: string | null
) =>
  Effect.map(textsIn(storage, key), (texts) => {
    const seen = cursor === null ? texts.length : Number(cursor);

    return {
      cursor: String(texts.length),
      events: texts.slice(seen).map((text, index) => ({
        eventId: `${prefix}${seen + index + 1}`,
        data: { n: seen + index + 1, text },
      })),
    };
  });

export const appended = (key: string, event: Event.Any, text: string) =>
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;
    const texts = yield* textsIn(storage, key);

    yield* Effect.promise(async () => {
      await storage.put(key, [...texts, text]);
    });
    yield* Event.Events.use((events) => events.notify(event));
  });
