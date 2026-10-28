import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { Rpc, RpcClient, RpcGroup, RpcMiddleware } from "effect/rpc";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { authenticate, verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { Status, WhoAmI } from "../support/app/contracts.js";
import { status, userActions } from "../support/app/handlers.js";
import { Users } from "../support/app/users.js";
import { recorder } from "../support/reporter.js";
import { overHttp } from "../support/rpc.js";

const Countdown = Rpc.make("countdown", {
  payload: { from: Schema.Int },
  success: Schema.String,
  stream: true,
});

const Whose = Rpc.make("whose", { success: Schema.String });

const Native = RpcGroup.make(Countdown, Whose);

const Protected = ActionRpc.make([Status, WhoAmI], {
  authentication: Login,
  rpcs: Native,
});

const Public = ActionRpc.make([Status], { rpcs: RpcGroup.make(Countdown) });

const countdown = <R>(
  { from }: { readonly from: number },
  label: Effect.Effect<string, never, R>
) =>
  Stream.unwrap(
    Effect.map(label, (by) =>
      Stream.make(
        ...Array.from({ length: from }, (_, index) => `${by}:${from - index}`)
      )
    )
  );

const signedIn = Protected.rpcs.toLayer({
  countdown: (payload) =>
    countdown(
      payload,
      Effect.map(CurrentActor, (actor) => actor.id)
    ),
  whose: () => Effect.map(CurrentActor, (actor) => actor.id),
});

const anyone = Public.rpcs.toLayer({
  countdown: (payload) => countdown(payload, Effect.succeed("anyone")),
});

const protectedRoutes = ActionRpc.layer(Protected, [status, userActions]).pipe(
  Layer.provide(signedIn),
  Layer.provide(authenticate)
);

const withProtected = <A, E, R>(
  program: (
    client: ActionRpc.Client<typeof Protected>
  ) => Effect.Effect<A, E, R>
) =>
  Effect.flatMap(ActionRpc.client(Protected), program).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(overHttp(protectedRoutes), Users.layerMemory)
    )
  );

const as = (token: string) =>
  RpcClient.withHeaders({ authorization: `Bearer ${token}` });

class Shadow extends RpcMiddleware.Service<Shadow>()(
  "effect-actions/ActionRpc/Authenticated"
) {}

const passThrough = Layer.succeed(Shadow)((effect) => effect);

const OnlyNative = ActionRpc.make([], { authentication: Login, rpcs: Native });

const whoseOver = <B extends ActionRpc.Any, E, R, CallE>(
  binding: B,
  server: Layer.Layer<never, E, R>,
  call: (client: ActionRpc.Client<B>) => Effect.Effect<string, CallE>
) =>
  Effect.flatMap(ActionRpc.client(binding), call).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(overHttp(server), Users.layerMemory))
  );

const recordingActor =
  (seen: string[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Effect.serviceOption(CurrentActor), (actor) => {
      seen.push(
        Option.match(actor, { onNone: () => "nobody", onSome: ({ id }) => id })
      );

      return effect;
    });

describe("ActionRpc native rpcs", () => {
  it.effect(
    "streams a native rpc's chunks to its client, its handler given the identity",
    () =>
      Effect.gen(function* () {
        const chunks = yield* withProtected((client) =>
          client.countdown({ from: 3 }).pipe(Stream.runCollect, as("alice"))
        );

        expect(chunks).toStrictEqual(["alice:3", "alice:2", "alice:1"]);
      })
  );

  it.effect("authenticates each message of a native rpc by its own token", () =>
    Effect.gen(function* () {
      const callers = yield* withProtected((client) =>
        Effect.all([
          client.whose().pipe(as("alice")),
          client.whose().pipe(as("bob")),
        ])
      );

      expect(callers).toStrictEqual(["alice", "bob"]);
    })
  );

  it.effect(
    "refuses a native rpc without a credential with a typed Unauthenticated",
    () =>
      Effect.gen(function* () {
        const unary = yield* Effect.flip(
          withProtected((client) => client.whose())
        );

        const streamed = yield* Effect.flip(
          withProtected((client) =>
            Stream.runCollect(client.countdown({ from: 2 }))
          )
        );

        expect(unary).toBeInstanceOf(Action.Unauthenticated);
        expect(unary).toMatchObject({ message: "A bearer token is required." });
        expect(streamed).toBeInstanceOf(Action.Unauthenticated);
      })
  );

  it.effect(
    "refuses an unknown token on a native rpc with the verifier's own refusal",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          withProtected((client) => client.whose().pipe(as("mallory")))
        );

        expect(error).toBeInstanceOf(Action.Unauthenticated);
        expect(error).toMatchObject({ message: "Unknown demo token." });
      })
  );

  it.effect("still serves the binding's actions beside its native rpcs", () =>
    Effect.gen(function* () {
      const answer = yield* withProtected((client) =>
        client.whoAmI().pipe(as("alice"))
      );

      expect(answer).toStrictEqual({ id: "alice", tenantId: "acme" });
    })
  );

  it.effect(
    "serves a public binding's native rpcs without authenticating them",
    () =>
      Effect.gen(function* () {
        const chunks = yield* Effect.flatMap(
          ActionRpc.client(Public),
          (client) => Stream.runCollect(client.countdown({ from: 2 }))
        ).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.provideMerge(
              overHttp(
                ActionRpc.layer(Public, [status]).pipe(Layer.provide(anyone))
              ),
              Users.layerMemory
            )
          )
        );

        expect(chunks).toStrictEqual(["anyone:2", "anyone:1"]);
      })
  );

  it.effect(
    "authenticates a protected binding's native rpcs whatever actions it serves, a host's Layer under the middleware's key passing nothing through",
    () =>
      Effect.gen(function* () {
        const servers = {
          publicOnly: ActionRpc.layer(Protected, [status, userActions], {
            actions: [Status],
          }),
          noAction: ActionRpc.layer(OnlyNative, []),
        };

        for (const server of Object.values(servers)) {
          const routes = server.pipe(
            Layer.provide(signedIn),
            Layer.provide(authenticate)
          );

          for (const outer of [Layer.empty, passThrough]) {
            const served = routes.pipe(Layer.provide(outer));

            const refused = yield* Effect.flip(
              whoseOver(Protected, served, (client) => client.whose())
            );

            const signed = yield* whoseOver(Protected, served, (client) =>
              client.whose().pipe(as("alice"))
            );

            expect(refused).toBeInstanceOf(Action.Unauthenticated);
            expect(signed).toBe("alice");
          }
        }
      })
  );

  it.effect(
    "runs a native rpc's own group middleware after its authentication, given the identity, and never for a refused call",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];

        class Seen extends RpcMiddleware.Service<Seen>()("native-test/Seen") {}

        const Watched = ActionRpc.make([Status], {
          authentication: Login,
          rpcs: RpcGroup.make(Whose).middleware(Seen),
        });

        const server = ActionRpc.layer(Watched, [status]).pipe(
          Layer.provide(
            Watched.rpcs.toLayer({
              whose: () => Effect.map(CurrentActor, (actor) => actor.id),
            })
          ),
          Layer.provide(authenticate),
          Layer.provide(Layer.succeed(Seen)(recordingActor(seen)))
        );

        const refused = yield* Effect.flip(
          whoseOver(Watched, server, (client) => client.whose())
        );

        const signed = yield* whoseOver(Watched, server, (client) =>
          client.whose().pipe(as("bob"))
        );

        expect(refused).toBeInstanceOf(Action.Unauthenticated);
        expect(signed).toBe("bob");
        expect(seen).toStrictEqual(["bob"]);
      })
  );

  it.effect(
    "refuses to serve a protected binding's native rpc added without its authentication",
    () =>
      Effect.gen(function* () {
        const Extra = Rpc.make("extra", { success: Schema.String });
        const added = { ...Protected, rpcs: Protected.rpcs.add(Extra) };

        const exit = yield* Effect.exit(
          whoseOver(
            Protected,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            ActionRpc.layer(added as typeof Protected, [
              status,
              userActions,
            ]).pipe(Layer.provide(signedIn), Layer.provide(authenticate)),
            (client) => client.whose().pipe(as("alice"))
          )
        );

        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
          "the native rpc extra of a protected binding runs without its authentication"
        );
      })
  );

  it.effect(
    "serves a native rpc whose host middleware runs outside its authentication, before the identity exists",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];

        class Outer extends RpcMiddleware.Service<Outer>()(
          "native-test/Outer"
        ) {}

        const Wrapped = {
          ...Protected,
          rpcs: Protected.rpcs.middleware(Outer),
        };

        const server = ActionRpc.layer(Wrapped, [status, userActions]).pipe(
          Layer.provide(
            Wrapped.rpcs.toLayer({
              countdown: (payload) =>
                countdown(payload, Effect.succeed("unused")),
              whose: () => Effect.map(CurrentActor, (actor) => actor.id),
            })
          ),
          Layer.provide(authenticate),
          Layer.provide(Layer.succeed(Outer)(recordingActor(seen)))
        );

        const refused = yield* Effect.flip(
          whoseOver(Wrapped, server, (client) => client.whose())
        );

        const signed = yield* whoseOver(Wrapped, server, (client) =>
          client.whose().pipe(as("alice"))
        );

        expect(refused).toBeInstanceOf(Action.Unauthenticated);
        expect(signed).toBe("alice");
        expect(seen).toStrictEqual(["nobody", "nobody"]);
      })
  );

  it.effect(
    "fails a native rpc with its verifier's own declared error, decoded as its class",
    () =>
      Effect.gen(function* () {
        class Unavailable extends Schema.TaggedError<
          Unavailable,
          { readonly brand: unique symbol }
        >()("Unavailable", {}) {}

        const Down = Authentication.make("native-test.Down", CurrentActor, {
          error: Unavailable,
        });

        const Guarded = ActionRpc.make([], {
          authentication: Down,
          rpcs: RpcGroup.make(Whose),
        });

        const server = ActionRpc.layer(Guarded, []).pipe(
          Layer.provide(
            Guarded.rpcs.toLayer({
              whose: () => Effect.map(CurrentActor, (actor) => actor.id),
            })
          ),
          Layer.provide(
            Authentication.layer(Down, (token: Redacted.Redacted) =>
              Redacted.value(token) === "down"
                ? Effect.fail(new Unavailable())
                : verify(token)
            )
          )
        );

        const refused = yield* Effect.flip(
          whoseOver(Guarded, server, (client) =>
            client.whose().pipe(as("down"))
          )
        );

        expect(refused).toBeInstanceOf(Unavailable);
      })
  );

  it.effect(
    "answers a verifier's defect on a native rpc with Internal server error, its cause reported",
    () =>
      Effect.gen(function* () {
        const reported: string[] = [];

        const server = ActionRpc.layer(Protected, [status, userActions]).pipe(
          Layer.provide(signedIn),
          Layer.provide(
            Authentication.layer(Login, (token: Redacted.Redacted) =>
              Redacted.value(token) === "dying"
                ? Effect.die(new Error("verifier secret"))
                : verify(token)
            )
          ),
          Layer.provide(ErrorReporter.layer([recorder(reported)]))
        );

        const exit = yield* Effect.exit(
          whoseOver(Protected, server, (client) =>
            client.whose().pipe(as("dying"))
          )
        );

        const answered = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;

        expect(answered).toStrictEqual(new Error("Internal server error"));
        expect(String(answered)).not.toContain("secret");
        expect(reported).toStrictEqual([
          expect.stringContaining("verifier secret"),
        ]);
      })
  );

  it.effect(
    "serves native rpcs beside event types, the client watching and calling on one protocol",
    () =>
      Effect.gen(function* () {
        const Ticked = Event.make("clock.ticked", {
          description: "The clock ticked.",
          payload: { at: Schema.Int },
          caller: Action.Anyone,
        });

        const ticks: number[] = [];

        const ticked = Event.implement(Ticked, {
          check: (_input, cursor) =>
            Effect.sync(() => ({
              cursor: String(ticks.length),
              events: ticks
                .slice(cursor === null ? ticks.length : Number(cursor))
                .map((at) => ({ eventId: String(at), data: { at } })),
            })),
        });

        const Mixed = ActionRpc.make([Status, Ticked], {
          rpcs: RpcGroup.make(Countdown),
        });

        const server = ActionRpc.layer(Mixed, [status, ticked]).pipe(
          Layer.provide(
            Mixed.rpcs.toLayer({
              countdown: (payload) =>
                countdown(payload, Effect.succeed("mixed")),
            })
          )
        );

        ticks.push(1);

        const [chunks, received] = yield* Effect.flatMap(
          ActionRpc.client(Mixed),
          (client) =>
            Effect.all([
              Stream.runCollect(client.countdown({ from: 2 })),
              client
                .watch(Ticked, {}, { cursor: "0" })
                .pipe(Stream.take(1), Stream.runCollect),
            ])
        ).pipe(
          Effect.scoped,
          Effect.provide(overHttp(server)),
          Effect.provide([Users.layerMemory, Event.layerMemory])
        );

        expect(chunks).toStrictEqual(["mixed:2", "mixed:1"]);
        expect(
          received.map((item) =>
            item._tag === "Occurrence" ? item.data.at : item._tag
          )
        ).toStrictEqual([1]);
      })
  );

  it("refuses a native rpc named after an action, an event type, then or the client's watch", () => {
    const Ticked = Event.make("clock.ticked", {
      description: "The clock ticked.",
      payload: { at: Schema.Int },
      caller: Action.Anyone,
    });

    for (const tag of ["status", "clock.ticked", "then", "watch"]) {
      expect(() =>
        ActionRpc.make([Status, Ticked], { rpcs: RpcGroup.make(Rpc.make(tag)) })
      ).toThrow(
        `ActionRpc binding: the rpc "${tag}" of rpcs is named after an action, an event type or a name the client keeps, "then" or "watch" (rename it)`
      );
    }
  });
});
