import { Effect, Layer, Option, Redacted, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { CurrentUser, Login } from "./app.js";
import { appended, textsSince } from "./texts.js";

export const Noted = Event.make("note.added", {
  description: "A note was added to the object.",
  payload: { n: Schema.Int, text: Schema.String },
  caller: CurrentUser,
});

export const Said = Event.make("thing.said", {
  description: "Something was said in the object.",
  payload: { text: Schema.String },
  caller: CurrentUser,
});

export const Statused = Event.make("status.set", {
  description: "The object's status, whole.",
  payload: { text: Schema.String },
  caller: CurrentUser,
});

export const Watched = ActionRpc.make([Noted, Said, Statused], { authentication: Login });

const statusKey = "status";

const statusOf = Schema.decodeUnknownOption(Schema.String);

const notesKey = "notes";

export const revokedKey = (token: string) => `revoked:${token}`;

const noted = Event.implement(
  Noted,
  Effect.map(ActionDurableObject.State, ({ storage }) => ({
    check: (_input: typeof Noted.input.Type, cursor: string | null) =>
      textsSince(storage, notesKey, "n", cursor),
  })),
  { authorize: Event.allowAll },
);

const said = Event.implement(
  Said,
  { log: {}, match: (_input, data) => data.text.length > 0 },
  { authorize: Event.allowAll },
);

const statused = Event.implement(
  Statused,
  Effect.map(ActionDurableObject.State, ({ storage }) => ({
    current: () =>
      Effect.map(
        Effect.promise(() => storage.get(statusKey)),
        (stored) => ({ text: Option.getOrElse(statusOf(stored), () => "idle") }),
      ),
  })),
  { authorize: Event.allowAll },
);

export const setStatus = (text: string) =>
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;

    yield* Effect.promise(() => storage.put(statusKey, text));
    yield* Event.Events.use((events) => events.notify(Statused));
  });

export const note = (text: string) => appended(notesKey, Noted, text);

export const say = (text: string) =>
  Event.Events.use((events) => events.publish(Said, { data: { text } }));

const revocable = Authentication.layer(
  Login,
  Effect.map(
    ActionDurableObject.State,
    ({ storage }) =>
      (token: Redacted.Redacted<string>) =>
        Effect.flatMap(
          Effect.promise(() => storage.get(revokedKey(Redacted.value(token)))),
          (revoked) =>
            revoked === true
              ? Effect.fail(new Action.Unauthenticated({ message: "Revoked test token." }))
              : Effect.succeed(Redacted.value(token)),
        ),
  ),
);

const sources = [noted, said, statused];

export const watchedRoutes = Layer.mergeAll(
  ActionRpc.layer(Watched, sources).pipe(
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/rpc" })),
  ),
  ActionRpc.layer(Watched, sources).pipe(
    Layer.provide(ActionDurableObject.layerWebSocket({ path: "/also" })),
  ),
).pipe(Layer.provide(revocable));
