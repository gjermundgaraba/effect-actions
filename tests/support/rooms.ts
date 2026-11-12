import { Effect, Schema } from "effect";
import { Entity } from "effect/cluster";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { verify } from "./app/authentication.js";
import { authorize, CurrentActor } from "./app/authorization.js";
import { Login } from "./app/binding.js";

export const Payload = Schema.Struct({
  text: Schema.String,
  amount: Schema.Finite,
  count: Schema.Int,
  note: Schema.optional(Schema.String),
  level: Schema.Literals(["low", "high"]),
  tags: Schema.Array(Schema.String),
});

export class RoomClosed extends Schema.TaggedError<
  RoomClosed,
  { readonly brand: unique symbol }
>()("RoomClosed", { room: Schema.String, reason: Schema.String }) {}

const room = { room: Schema.String };

export const Echo = Action.make("echo", {
  description: "Return the payload.",
  input: { ...room, payload: Payload },
  success: Payload,
  readOnly: true,
  caller: Action.Anyone,
});

export const Post = Action.make("post", {
  description: "Post a message to a room.",
  input: { ...room, text: Schema.String },
  success: { count: Schema.Int, by: Schema.String },
  readOnly: false,
  caller: CurrentActor,
});

export const Read = Action.make("read", {
  description: "Read a room's messages.",
  input: room,
  success: { entity: Schema.String, texts: Schema.Array(Schema.String) },
  readOnly: true,
  caller: Action.Anyone,
});

export const Shut = Action.make("shut", {
  description: "Refuse, as a closed room does.",
  input: room,
  success: Schema.Void,
  error: RoomClosed,
  readOnly: true,
  caller: Action.Anyone,
});

export const Boom = Action.make("boom", {
  description: "Die.",
  input: room,
  success: Schema.Void,
  readOnly: true,
  caller: Action.Anyone,
});

export const Posted = Event.make("room.posted", {
  description: "A message was posted to a room.",
  input: room,
  payload: { text: Schema.String },
  caller: Action.Anyone,
});

export const RoomRpc = ActionRpc.make([Echo, Post, Read, Shut, Boom, Posted], {
  authentication: Login,
});

export const signIn = Authentication.layer(Login, verify);

const byRoom = ({ room: named }: { readonly room: string }) => named;

export const Room = ActionEntity.make("Room", RoomRpc, {
  key: {
    echo: byRoom,
    post: byRoom,
    read: byRoom,
    shut: byRoom,
    boom: byRoom,
    "room.posted": byRoom,
  },
});

export const makeRooms = () => {
  const ran = { echo: 0, post: 0, read: 0, builds: 0 };

  const echoing = Action.implement(Echo, ({ payload }) =>
    Effect.sync(() => {
      ran.echo += 1;

      return payload;
    })
  );

  const actions = Action.implement(
    [Post, Read, Shut, Boom],
    Effect.gen(function* () {
      const { entityId } = yield* Entity.CurrentAddress;
      const events = yield* Event.Events;
      const texts: string[] = [];

      ran.builds += 1;

      return {
        post: ({ room: named, text }) =>
          Effect.gen(function* () {
            const actor = yield* CurrentActor;

            ran.post += 1;
            texts.push(text);

            yield* events.publish(Posted, { data: { text } }, { key: named });

            return { count: texts.length, by: actor.id };
          }),
        read: () =>
          Effect.sync(() => {
            ran.read += 1;

            return { entity: entityId, texts: [...texts] };
          }),
        shut: ({ room: named }) =>
          Effect.fail(new RoomClosed({ room: named, reason: "shut" })),
        boom: () => Effect.die(new Error("boom")),
      };
    }),
    { authorize }
  );

  const posted = Event.implement(Posted, {
    log: {},
    key: ({ room: named }) => named,
  });

  return { ran, echoing, implementations: [echoing, actions, posted] as const };
};
