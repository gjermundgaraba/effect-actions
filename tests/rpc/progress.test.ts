import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Schema, Stream } from "effect";
import { RpcClient, RpcMiddleware } from "effect/rpc";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { overHttp } from "../support/rpc.js";

class Halted extends Schema.TaggedError<Halted>()("Halted", { at: Schema.Finite }) {}

const Import = Action.make("importAll", {
  description: "Import every item, reporting how many are done.",
  input: {
    count: Schema.Finite,
    halt: Schema.optional(Schema.Literal("after")),
  },
  success: { imported: Schema.Finite },
  progress: { done: Schema.Finite, total: Schema.Finite },
  error: Halted,
  readOnly: false,
  caller: Action.Anyone,
});

const Touch = Action.make("touch", {
  description: "Touch as the caller, reporting who touched.",
  progress: { by: Schema.String },
  readOnly: false,
  caller: CurrentActor,
});

const Login = Authentication.make("rpc-progress.Login", CurrentActor);

const imports = Action.implement(Import, ({ count, halt }, { progress }) =>
  Effect.gen(function* () {
    for (let done = 1; done <= count; done++) yield* progress({ done, total: count });

    if (halt === "after") return yield* new Halted({ at: count });

    return { imported: count };
  }),
);

const touches = Action.implement(
  Touch,
  (_input, { progress }) => Effect.flatMap(CurrentActor, (actor) => progress({ by: actor.id })),
  { authorize: () => Effect.void },
);

const Rpc = ActionRpc.make([Import, Touch], { authentication: Login });

const served = overHttp(
  ActionRpc.layer(Rpc, [imports, touches]).pipe(Layer.provide(Authentication.layer(Login, verify))),
);

const signedInAs = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });

describe("RPC progress", () => {
  it.effect("hands on each value, in order, then answers", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const seen: Array<number> = [];

      const answer = yield* client.importAll(
        { count: 3 },
        { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
      );

      expect([seen, answer]).toEqual([[1, 2, 3], { imported: 3 }]);
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("answers alike without onProgress", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      expect(yield* client.importAll({ count: 3 })).toEqual({ imported: 3 });
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect(
    "streams each value as a Progress, then the answer as a Final, to a native client",
    () =>
      Effect.gen(function* () {
        const client = yield* RpcClient.make(Rpc.group);

        const elements = yield* Stream.runCollect(client.importAll({ count: 2 }));

        expect(elements).toEqual([
          { _tag: "Progress", value: { done: 1, total: 2 } },
          { _tag: "Progress", value: { done: 2, total: 2 } },
          { _tag: "Final", value: { imported: 2 } },
        ]);
      }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("fails with a declared failure after its progress, as typed", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const seen: Array<number> = [];

      const exit = yield* Effect.exit(
        client.importAll(
          { count: 2, halt: "after" },
          { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
        ),
      );

      expect(seen).toEqual([1, 2]);
      expect(exit).toEqual(Exit.fail(new Halted({ at: 2 })));
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("runs a protected action's handler as the call's caller, answering nothing", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const by: Array<string> = [];

      const answer = yield* client
        .touch({}, { onProgress: (progress) => Effect.sync(() => by.push(progress.by)) })
        .pipe(signedInAs("alice"));

      const refused = yield* Effect.exit(client.touch({}));

      expect([answer, by]).toEqual([undefined, ["alice"]]);
      expect(refused).toEqual(Exit.fail(expect.objectContaining({ _tag: "Unauthenticated" })));
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect(
    "runs a listed middleware around the call's start, ended before its caller has progress the handler then waits on",
    () =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        const note = (step: string) => Effect.sync(() => void seen.push(step));
        const received = yield* Deferred.make<void>();

        class Timed extends RpcMiddleware.Service<Timed>()("rpc-progress/Timed") {}

        const Steps = Action.make("steps", {
          description: "Report one step.",
          progress: { step: Schema.Finite },
          readOnly: true,
          caller: Action.Anyone,
        });

        const steps = Action.implement(Steps, (_input, { progress }) =>
          Effect.andThen(note("handler"), progress({ step: 1 })).pipe(
            Effect.andThen(Deferred.await(received)),
            Effect.andThen(note("handler end")),
          ),
        );

        const Bound = ActionRpc.make([Steps]);

        const answer = yield* Effect.flatMap(ActionRpc.client(Bound), (client) =>
          client.steps({}, { onProgress: () => Deferred.succeed(received, undefined) }),
        ).pipe(
          Effect.scoped,
          Effect.provide(
            overHttp(
              ActionRpc.layer(Bound, steps, { middleware: [Timed] }).pipe(
                Layer.provide(
                  Layer.succeed(Timed, (effect) =>
                    Effect.andThen(note("middleware"), effect).pipe(
                      Effect.ensuring(note("middleware end")),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );

        expect(answer).toBeUndefined();
        expect(seen).toEqual(["middleware", "handler", "middleware end", "handler end"]);
      }),
  );
});
