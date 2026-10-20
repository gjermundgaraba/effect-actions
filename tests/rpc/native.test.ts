import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { authenticate } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { Status, WhoAmI } from "../support/app/contracts.js";
import { status, userActions } from "../support/app/handlers.js";
import { Users } from "../support/app/users.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";

const Countdown = Rpc.make("countdown", {
  payload: { from: Schema.Int },
  success: Schema.String,
  stream: true,
});

const Whose = Rpc.make("whose", { success: Schema.String });

const Native = RpcGroup.make(Countdown, Whose);

const Protected = ActionRpc.make([Status, WhoAmI], { authentication: Login, rpcs: Native });

const Public = ActionRpc.make([Status], { rpcs: RpcGroup.make(Countdown) });

const countdown = <R>(
  { from }: { readonly from: number },
  label: Effect.Effect<string, never, R>,
) =>
  Stream.unwrap(
    Effect.map(label, (by) =>
      Stream.make(...Array.from({ length: from }, (_, index) => `${by}:${from - index}`)),
    ),
  );

const signedIn = Protected.rpcs.toLayer({
  countdown: (payload) =>
    countdown(
      payload,
      Effect.map(CurrentActor, (actor) => actor.id),
    ),
  whose: () => Effect.map(CurrentActor, (actor) => actor.id),
});

const anyone = Public.rpcs.toLayer({
  countdown: (payload) => countdown(payload, Effect.succeed("anyone")),
});

const overHttp = <E, R>(server: Layer.Layer<never, E, R>) =>
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(
      Testing.layer(
        server.pipe(
          Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
      ),
    ),
  );

const protectedRoutes = ActionRpc.layer(Protected, [status, userActions]).pipe(
  Layer.provide(signedIn),
  Layer.provide(authenticate),
);

const withProtected = <A, E, R>(
  program: (client: ActionRpc.Client<typeof Protected>) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(ActionRpc.client(Protected), program).pipe(
    Effect.scoped,
    Effect.provide(overHttp(protectedRoutes)),
    Effect.provide(Users.layerMemory),
  );

const as = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });

describe("ActionRpc native rpcs", () => {
  it.effect("streams a native rpc's chunks to its client, its handler given the identity", () =>
    Effect.gen(function* () {
      const chunks = yield* withProtected((client) =>
        client.countdown({ from: 3 }).pipe(Stream.runCollect, as("alice")),
      );

      expect(chunks).toEqual(["alice:3", "alice:2", "alice:1"]);
    }),
  );

  it.effect("authenticates each message of a native rpc by its own token", () =>
    Effect.gen(function* () {
      const callers = yield* withProtected((client) =>
        Effect.all([client.whose().pipe(as("alice")), client.whose().pipe(as("bob"))]),
      );

      expect(callers).toEqual(["alice", "bob"]);
    }),
  );

  it.effect("refuses a native rpc without a credential with a typed Unauthenticated", () =>
    Effect.gen(function* () {
      const unary = yield* Effect.flip(withProtected((client) => client.whose()));

      const streamed = yield* Effect.flip(
        withProtected((client) => Stream.runCollect(client.countdown({ from: 2 }))),
      );

      expect(unary).toBeInstanceOf(Action.Unauthenticated);
      expect(unary).toMatchObject({ message: "A bearer token is required." });
      expect(streamed).toBeInstanceOf(Action.Unauthenticated);
    }),
  );

  it.effect("refuses an unknown token on a native rpc with the verifier's own refusal", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withProtected((client) => client.whose().pipe(as("mallory"))),
      );

      expect(error).toBeInstanceOf(Action.Unauthenticated);
      expect(error).toMatchObject({ message: "Unknown demo token." });
    }),
  );

  it.effect("still serves the binding's actions beside its native rpcs", () =>
    Effect.gen(function* () {
      const answer = yield* withProtected((client) => client.whoAmI().pipe(as("alice")));

      expect(answer).toEqual({ id: "alice", tenantId: "acme" });
    }),
  );

  it.effect("serves a public binding's native rpcs without authenticating them", () =>
    Effect.gen(function* () {
      const chunks = yield* Effect.flatMap(ActionRpc.client(Public), (client) =>
        Stream.runCollect(client.countdown({ from: 2 })),
      ).pipe(
        Effect.scoped,
        Effect.provide(overHttp(ActionRpc.layer(Public, [status]).pipe(Layer.provide(anyone)))),
        Effect.provide(Users.layerMemory),
      );

      expect(chunks).toEqual(["anyone:2", "anyone:1"]);
    }),
  );

  it("refuses a native rpc named after one of the binding's actions", () => {
    expect(() => ActionRpc.make([Status], { rpcs: RpcGroup.make(Rpc.make("status")) })).toThrow(
      'ActionRpc binding: the rpc "status" of rpcs is named after an action (rename one)',
    );
  });
});
