import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export class Subscriber extends Context.Service<Subscriber, string>()("test/Subscriber") {}

const HookLogin = Authentication.make("test.HookLogin", Subscriber, {
  principal: (subscriber) => subscriber,
  schema: Schema.String,
});

export const Hooked = Event.make("note.hooked", {
  description: "A note was added to the object, delivered by webhook.",
  payload: { n: Schema.Int, text: Schema.String },
  caller: Subscriber,
});

const HookHttp = ActionHttp.make([Hooked], { authentication: HookLogin });

const hookedKey = "hooked";

export const receivedKey = "received";

export const answerKey = "answer";

const Texts = Schema.Array(Schema.String);

const textsOf = Schema.decodeUnknownOption(Texts);

const textsIn = (storage: DurableObjectStorage, key: string) =>
  Effect.map(
    Effect.promise(() => storage.get(key)),
    (stored) => Option.getOrElse(textsOf(stored), (): ReadonlyArray<string> => []),
  );

const hooked = Event.implement(
  Hooked,
  Effect.map(ActionDurableObject.State, ({ storage }) => ({
    check: (_input: typeof Hooked.input.Type, cursor: string | null) =>
      Effect.map(textsIn(storage, hookedKey), (notes) => {
        const seen = cursor === null ? notes.length : Number(cursor);

        return {
          cursor: String(notes.length),
          events: notes.slice(seen).map((text, index) => ({
            eventId: `h${seen + index + 1}`,
            data: { n: seen + index + 1, text },
          })),
        };
      }),
  })),
  { authorize: Event.allowAll },
);

export const hook = (text: string) =>
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;
    const notes = yield* textsIn(storage, hookedKey);

    yield* Effect.promise(() => storage.put(hookedKey, [...notes, text]));
    yield* Event.Events.use((events) => events.notify(Hooked));
  });

const Body = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.optional(Schema.String),
    challenge: Schema.optional(Schema.String),
  }),
);

const bodyOf = Schema.decodeUnknownOption(Body);

const Status = Schema.Int;

const statusOf = Schema.decodeUnknownOption(Status);

const callbackRecordingIn = (storage: DurableObjectStorage) => ({
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Request(input, init).text();
    const received = await Effect.runPromise(textsIn(storage, receivedKey));

    await storage.put(receivedKey, [...received, body]);

    const challenge = Option.flatMap(bodyOf(body), ({ type, challenge }) =>
      type === "verification" ? Option.fromUndefinedOr(challenge) : Option.none(),
    );

    if (Option.isSome(challenge)) return Response.json({ challenge: challenge.value });

    return new Response(null, {
      status: Option.getOrElse(statusOf(await storage.get(answerKey)), () => 200),
    });
  },
});

export const hookedRoutes = ActionHttp.layer(HookHttp, [hooked]).pipe(
  Layer.provide(ActionDurableObject.layerWebhooks()),
  Layer.provide(
    Layer.unwrap(
      Effect.map(ActionDurableObject.State, ({ storage }) =>
        ActionDurableObject.layerHttpClient(callbackRecordingIn(storage)),
      ),
    ),
  ),
  Layer.provide(
    Authentication.layer(HookLogin, (token: Redacted.Redacted<string>) =>
      Effect.succeed(Redacted.value(token)),
    ),
  ),
);
