import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";

const Read = Action.make("read", {
  description: "Read a shelf.",
  input: { shelf: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});

const Changed = Event.make("shelf.changed", {
  description: "A shelf, whole.",
  input: { shelf: Schema.String },
  payload: { shelf: Schema.String },
  caller: Action.Anyone,
});

const Http = ActionHttp.make([Read, Changed]);

const refused = new Action.Forbidden({ message: "Not this shelf." });

const routes = ActionHttp.layer(Http, [
  Action.implement(Read, ({ shelf }) => Effect.succeed(shelf)),
  Event.implement(Changed, {
    current: ({ shelf }) => Effect.succeed({ shelf }),
  }),
]).pipe(
  Layer.provide(Event.layerMemory),
  Layer.provide(
    Layer.succeed(Action.InputCheck)((_contract, input) =>
      Schema.is(Schema.Struct({ shelf: Schema.Literal("mine") }))(input)
        ? Effect.void
        : Effect.fail(refused)
    )
  )
);

describe("Action.InputCheck", () => {
  it.effect(
    "refuses each call and subscription whose input it refuses, served or watched, and passes the rest",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        const firstOf = (shelf: string, mode: "poll" | "stream") =>
          client
            .watch(Changed, { shelf }, { mode })
            .pipe(Stream.take(1), Stream.runCollect);

        expect(yield* client.read({ shelf: "mine" })).toBe("mine");
        expect(
          yield* Effect.flip(client.read({ shelf: "theirs" }))
        ).toStrictEqual(refused);
        expect(yield* firstOf("mine", "poll")).toHaveLength(1);
        expect(yield* Effect.flip(firstOf("theirs", "poll"))).toStrictEqual(
          refused
        );
        expect(yield* Effect.flip(firstOf("theirs", "stream"))).toStrictEqual(
          refused
        );
      }).pipe(Effect.provide(Testing.layer(routes)))
  );

  it.effect(
    "runs once the surface has verified the caller, and before the authorizer",
    () =>
      Effect.gen(function* () {
        class Reader extends Context.Service<Reader, string>()(
          "tests/input-check/Reader"
        ) {}

        const Login = Authentication.make("input-check.Login", Reader);

        const Shelf = Action.make("shelf", {
          description: "Read a shelf as its reader.",
          input: { shelf: Schema.String },
          success: Schema.String,
          readOnly: true,
          caller: Reader,
        });

        const Protected = ActionHttp.make([Shelf], { authentication: Login });
        const steps: string[] = [];

        const served = ActionHttp.layer(
          Protected,
          Action.implement(Shelf, ({ shelf }) => Effect.succeed(shelf), {
            authorize: () =>
              Effect.sync(() => {
                steps.push("authorized");
              }),
          })
        ).pipe(
          Layer.provide(
            Authentication.layer(Login, (token: Redacted.Redacted) =>
              Effect.sync(() => {
                steps.push("verified");

                return Redacted.value(token);
              })
            )
          ),
          Layer.provide(
            Layer.succeed(Action.InputCheck)(() =>
              Effect.andThen(
                Effect.sync(() => {
                  steps.push("checked");
                }),
                Effect.fail(refused)
              )
            )
          )
        );

        const as = (token: string | undefined) =>
          ActionHttp.client(Protected, {
            transformClient: (client) =>
              token === undefined
                ? client
                : HttpClient.mapRequest(
                    client,
                    HttpClientRequest.bearerToken(token)
                  ),
          });

        const signedIn = yield* Effect.flatMap(as("alice"), (client) =>
          Effect.flip(client.shelf({ shelf: "theirs" }))
        ).pipe(Effect.provide(Testing.layer(served)));

        const signedOut = yield* Effect.flatMap(as(undefined), (client) =>
          Effect.flip(client.shelf({ shelf: "theirs" }))
        ).pipe(Effect.provide(Testing.layer(served)));

        expect(signedIn).toStrictEqual(refused);
        expect(signedOut).toBeInstanceOf(Action.Unauthenticated);
        expect(steps).toStrictEqual(["verified", "checked"]);
      })
  );

  it("refuses a call and a watch with no identity in process before it checks their input", async () => {
    class Reader extends Context.Service<Reader, string>()(
      "tests/input-check/LocalReader"
    ) {}

    const Shelf = Action.make("shelf", {
      description: "Read a shelf as its reader.",
      input: { shelf: Schema.String },
      success: Schema.String,
      readOnly: true,
      caller: Reader,
    });

    const Shelved = Event.make("shelf.shelved", {
      description: "A shelf, whole, as its reader sees it.",
      input: { shelf: Schema.String },
      payload: { shelf: Schema.String },
      caller: Reader,
    });

    const checked: string[] = [];

    const refusals = await Effect.runPromise(
      // @ts-expect-error -- Deliberately call without a caller, as no surface verified one.
      Effect.gen(function* () {
        const client = yield* Action.client([
          Action.implement(Shelf, ({ shelf }) => Effect.succeed(shelf), {
            authorize: Action.allowAll,
          }),
          Event.implement(
            Shelved,
            { current: ({ shelf }) => Effect.succeed({ shelf }) },
            { authorize: Event.allowAll }
          ),
        ]);

        return [
          yield* Effect.flip(client.shelf({ shelf: "theirs" })),
          yield* Effect.flip(
            client
              .watch(Shelved, { shelf: "theirs" })
              .pipe(Stream.take(1), Stream.runCollect)
          ),
        ];
      }).pipe(
        Effect.scoped,
        Effect.provide(Event.layerMemory),
        Effect.provideService(Action.InputCheck, (contract) =>
          Effect.andThen(
            Effect.sync(() => {
              checked.push(contract.name);
            }),
            Effect.fail(refused)
          )
        )
      )
    );

    expect(
      refusals.map((refusal) => refusal instanceof Action.Unauthenticated)
    ).toStrictEqual([true, true]);
    expect(checked).toStrictEqual([]);
  });

  it.effect(
    "runs on a watch once the surface has verified the caller, and before the authorizer, polled or streamed",
    () =>
      Effect.gen(function* () {
        class Reader extends Context.Service<Reader, string>()(
          "tests/input-check/WatchReader"
        ) {}

        const Login = Authentication.make("input-check.WatchLogin", Reader);

        const Shelved = Event.make("shelf.shelved", {
          description: "A shelf, whole, as its reader sees it.",
          input: { shelf: Schema.String },
          payload: { shelf: Schema.String },
          caller: Reader,
        });

        const Protected = ActionHttp.make([Shelved], { authentication: Login });
        const steps: string[] = [];

        const served = ActionHttp.layer(
          Protected,
          Event.implement(
            Shelved,
            { current: ({ shelf }) => Effect.succeed({ shelf }) },
            {
              authorize: () =>
                Effect.sync(() => {
                  steps.push("authorized");
                }),
            }
          )
        ).pipe(
          Layer.provide(Event.layerMemory),
          Layer.provide(
            Authentication.layer(Login, (token: Redacted.Redacted) =>
              Effect.sync(() => {
                steps.push("verified");

                return Redacted.value(token);
              })
            )
          ),
          Layer.provide(
            Layer.succeed(Action.InputCheck)(() =>
              Effect.andThen(
                Effect.sync(() => {
                  steps.push("checked");
                }),
                Effect.fail(refused)
              )
            )
          )
        );

        const refusals = yield* Effect.gen(function* () {
          const client = yield* ActionHttp.client(Protected, {
            transformClient: (http) =>
              HttpClient.mapRequest(
                http,
                HttpClientRequest.bearerToken("alice")
              ),
          });

          const firstOf = (mode: "poll" | "stream") =>
            Effect.flip(
              client
                .watch(Shelved, { shelf: "theirs" }, { mode })
                .pipe(Stream.take(1), Stream.runCollect)
            );

          return [yield* firstOf("poll"), yield* firstOf("stream")];
        }).pipe(Effect.provide(Testing.layer(served)));

        expect(refusals).toStrictEqual([refused, refused]);
        expect(steps).toStrictEqual([
          "verified",
          "checked",
          "verified",
          "checked",
        ]);
      })
  );
});
