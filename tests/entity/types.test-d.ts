import { expectTypeOf } from "@effect/vitest";
import { Context, Effect, Redacted, Schema } from "effect";
import type { Stream, Layer } from "effect";
import { Entity } from "effect/cluster";
import type { ClusterError, Sharding } from "effect/cluster";
import { Rpc as NativeRpc, RpcGroup } from "effect/rpc";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

class Actor extends Context.Service<Actor, string>()("entity-types/Actor") {}

class Tenant extends Context.Service<Tenant, string>()("entity-types/Tenant") {}

class Rooms extends Context.Service<Rooms, ReadonlyMap<string, string>>()(
  "entity-types/Rooms"
) {}

class Missing extends Schema.TaggedError<
  Missing,
  { readonly brand: unique symbol }
>()("Missing", { id: Schema.String }) {}

const Get = Action.make("get", {
  description: "Read a note in a room",
  readOnly: true,
  caller: Actor,
  input: { room: Schema.String, id: Schema.String },
  success: Schema.String,
  error: Missing,
});

const Open = Action.make("open", {
  description: "Answer anyone in a room",
  readOnly: true,
  caller: Action.Anyone,
  input: { room: Schema.String },
  success: Schema.String,
});

const Changed = Event.make("changed", {
  description: "A room changed",
  input: { room: Schema.String },
  payload: { id: Schema.String },
  caller: Action.Anyone,
});

const SignedIn = Authentication.make("entity-types.SignedIn", Actor);

const signIn = Authentication.layer(SignedIn, (token) =>
  Effect.succeed(Redacted.value(token))
);

const Rpc = ActionRpc.make([Get, Open, Changed], { authentication: SignedIn });

const byRoom = ({ room }: { readonly room: string }) => room;

const Room = ActionEntity.make("Room", Rpc, {
  key: { get: byRoom, open: byRoom, changed: byRoom },
});

// @ts-expect-error -- every action and event type of the binding needs a key.
ActionEntity.make("Room", Rpc, { key: { get: byRoom, open: byRoom } });

ActionEntity.make(
  "Room",
  // @ts-expect-error -- an entity serves no native rpcs.
  ActionRpc.make([Open], { rpcs: RpcGroup.make(NativeRpc.make("ping")) }),
  { key: { open: byRoom } }
);

const notes = Action.implement(
  [Get, Open],
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress;
    const rooms = yield* Rooms;

    return {
      get: ({ id }) =>
        Effect.map(
          Tenant,
          (tenant) => `${tenant}/${rooms.get(entityId) ?? ""}/${id}`
        ),
      open: () => Effect.succeed(entityId),
    };
  }),
  { authorize: () => Effect.void }
);

const changes = Event.implement(Changed, { log: {} });

const served = ActionEntity.layer(Room, [notes, changes]);

expectTypeOf<Layer.Error<typeof served>>().toEqualTypeOf<never>();

expectTypeOf<Layer.Services<typeof served>>().toEqualTypeOf<
  | Rooms
  | Tenant
  | Event.Events
  | Layer.Success<typeof signIn>
  | Sharding.Sharding
>();

const clientOf = ActionEntity.client(Room);

expectTypeOf<
  Effect.Services<typeof clientOf>
>().toEqualTypeOf<Sharding.Sharding>();

type RoomClient = ActionEntity.Client<typeof Rpc>;

type Reached =
  | ClusterError.MailboxFull
  | ClusterError.AlreadyProcessingMessage
  | ClusterError.PersistenceError
  | ClusterError.EntityNotAssignedToRunner;

expectTypeOf<ReturnType<RoomClient["get"]>>().toEqualTypeOf<
  Effect.Effect<string, Missing | Action.BuiltIn | Reached>
>();

declare const room: RoomClient;

expectTypeOf(room.watch(Changed, { room: "a" })).toEqualTypeOf<
  Stream.Stream<
    Event.Received<typeof Changed>,
    Event.SubscriptionError | Action.BuiltIn | Reached
  >
>();
