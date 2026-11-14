import { expectTypeOf } from "@effect/vitest";
import { Context, Effect, Redacted, Schema } from "effect";
import type { Layer, Stream } from "effect";
import { Entity } from "effect/cluster";
import type { ClusterError, Sharding } from "effect/cluster";
import { HttpServerRequest } from "effect/http";
import { Rpc as NativeRpc, RpcGroup } from "effect/rpc";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
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

const SignedIn = Authentication.make("entity-types.SignedIn", Actor, {
  principal: (actor) => actor,
});

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
  // @ts-expect-error -- an entity's binding holds no native rpcs.
  ActionRpc.make([Open], { rpcs: RpcGroup.make(NativeRpc.make("ping")) }),
  { key: { open: byRoom } }
);

const notes = Action.implement(
  [Get, Open],
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress;
    const rooms = yield* Rooms;
    const tenant = yield* Tenant;

    return {
      get: ({ id }) =>
        Effect.map(
          Actor,
          (actor) => `${tenant}/${rooms.get(entityId) ?? ""}/${id}/${actor}`
        ),
      open: () => Effect.succeed(entityId),
    };
  }),
  { authorize: () => Effect.void }
);

const changes = Event.implement(Changed, { log: {} });

const served = ActionEntity.layer(Room, [notes, changes]);

type Services = Layer.Services<typeof served>;

expectTypeOf<Layer.Error<typeof served>>().toEqualTypeOf<never>();

expectTypeOf<Rooms>().toExtend<Services>();

expectTypeOf<Tenant>().toExtend<Services>();

expectTypeOf<Event.Events>().toExtend<Services>();

expectTypeOf<Layer.Success<typeof signIn>>().toExtend<Services>();

expectTypeOf<Sharding.Sharding>().toExtend<Services>();

expectTypeOf<
  Exclude<
    Services,
    | Rooms
    | Tenant
    | Event.Events
    | Layer.Success<typeof signIn>
    | Sharding.Sharding
  >
>().toBeNever();

const readingPerCall = Action.implement(
  [Get, Open],
  {
    get: ({ id }) => Effect.map(Tenant, (tenant) => `${tenant}/${id}`),
    open: () => Effect.succeed(""),
  },
  { authorize: () => Effect.void }
);

// @ts-expect-error -- an entity provides no service per call, so a handler reads none.
ActionEntity.layer(Room, [readingPerCall, changes]);

const authorizingPerCall = Action.implement(
  [Get, Open],
  { get: () => Effect.succeed(""), open: () => Effect.succeed("") },
  { authorize: () => Effect.asVoid(Tenant) }
);

// @ts-expect-error -- an entity provides no service per call, so an authorizer reads none.
ActionEntity.layer(Room, [authorizingPerCall, changes]);

const checkingPerCall = Event.implement(Changed, {
  check: (_input, cursor) =>
    Effect.map(Tenant, (tenant) => ({
      cursor: cursor ?? "0",
      events: [{ eventId: tenant, data: { id: tenant } }],
    })),
});

// @ts-expect-error -- an entity provides no service per call, so an event source reads none per subscription.
ActionEntity.layer(Room, [notes, checkingPerCall]);

const readingTheRequest = Action.implement(
  [Get, Open],
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    return {
      get: () => Effect.succeed(request.url),
      open: () => Effect.succeed(request.url),
    };
  }),
  { authorize: () => Effect.void }
);

const servedReadingTheRequest = ActionEntity.layer(Room, [
  readingTheRequest,
  changes,
]);

expectTypeOf<HttpServerRequest.HttpServerRequest>().toExtend<
  Layer.Services<typeof servedReadingTheRequest>
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

const Http = ActionHttp.make([Get, Open, Changed], {
  authentication: SignedIn,
});

const reached = ActionEntity.reaching(Room);

const overHttp = ActionHttp.layer(Http, reached);

const overRpc = ActionRpc.layer(Rpc, reached);

const overMcp = ActionMcp.layerHttp(reached, {
  name: "rooms",
  version: "0.0.0",
  authentication: SignedIn,
});

type ReachedOverHttp = Layer.Services<typeof overHttp>;

type ReachedOverRpc = Layer.Services<typeof overRpc>;

type ReachedOverMcp = Layer.Services<typeof overMcp>;

expectTypeOf<Sharding.Sharding>().toExtend<ReachedOverHttp>();

expectTypeOf<Sharding.Sharding>().toExtend<ReachedOverRpc>();

expectTypeOf<Sharding.Sharding>().toExtend<ReachedOverMcp>();

expectTypeOf<Actor>().not.toExtend<ReachedOverHttp>();

expectTypeOf<Actor>().not.toExtend<ReachedOverRpc>();

expectTypeOf<Actor>().not.toExtend<ReachedOverMcp>();
