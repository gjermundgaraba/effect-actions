import { describe, expect, it } from "@effect/vitest";
import type { Redacted } from "effect";
import { Effect, Layer, Predicate, Schema } from "effect";
import { TestRunner } from "effect/cluster";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { DeclaredFailure } from "../../src/rpc/erased.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { unaryOf } from "../support/rpc.js";
import { secretOf } from "../support/webhook.js";

const room = { room: Schema.String };

const Lookup = Action.make("lookup", {
  description: "Answer the room it was asked about.",
  input: room,
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});

const Relay = Action.make("relay", {
  description: "Ask, in process, about another room.",
  input: { ...room, other: Schema.String },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});

const looking = Action.implement(Lookup, ({ room: named }) =>
  Effect.succeed(`seen ${named}`)
);

describe("ActionEntity's key check", () => {
  it.live(
    "checks the entity's own call alone: its handler calling another contract in process with an input naming another entity is answered",
    () => {
      const Relayer = ActionEntity.make("Relayer", [Relay], {
        key: ({ room: named }) => named,
      });

      const relaying = Action.implement(
        Relay,
        Effect.map(
          Action.client(looking),
          (local) =>
            ({ other }) =>
              local.lookup({ room: other })
        )
      );

      return Effect.gen(function* () {
        const client = yield* ActionEntity.client(Relayer);

        expect(yield* client.relay({ room: "lobby", other: "kitchen" })).toBe(
          "seen kitchen"
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ActionEntity.layer(Relayer, relaying).pipe(
            Layer.provideMerge(TestRunner.layer)
          )
        )
      );
    }
  );

  it.live(
    "runs once the entity verified the caller and before the authorizer, on a call, a poll, a release and a webhook subscribe and unsubscribe",
    () => {
      const steps: string[] = [];

      const Guarded = Action.make("guarded", {
        description: "Answer the signed-in caller's room.",
        input: room,
        success: Schema.String,
        readOnly: true,
        caller: CurrentActor,
      });

      const Moved = Event.make("room.moved", {
        description: "A room, whole, as its signed-in caller sees it.",
        input: room,
        payload: room,
        caller: CurrentActor,
      });

      const Guard = ActionEntity.make("Guard", [Guarded, Moved], {
        authentication: Login,
        key: ({ room: named }) => named,
      });

      const authorized = () =>
        Effect.sync(() => {
          steps.push("authorized");
        });

      const guarding = ActionEntity.layer(Guard, [
        Action.implement(Guarded, ({ room: named }) => Effect.succeed(named), {
          authorize: authorized,
        }),
        Event.implement(
          Moved,
          { current: ({ room: named }) => Effect.succeed({ room: named }) },
          { authorize: authorized }
        ),
      ]).pipe(
        Layer.provideMerge(TestRunner.layer),
        Layer.provide([
          Authentication.layer(Login, (token: Redacted.Redacted) =>
            Effect.andThen(
              Effect.sync(() => {
                steps.push("verified");
              }),
              verify(token)
            )
          ),
          Event.layerMemory,
        ])
      );

      return Effect.gen(function* () {
        const lobby = (yield* Guard.client)("lobby");
        const elsewhere = { room: "kitchen" };
        const delivery = { url: "https://hooks.example.com/alice" };

        const outcomeOf = (tag: string, payload: Schema.Json, token?: string) =>
          Effect.match(
            unaryOf(
              lobby[tag]?.(
                payload,
                token === undefined
                  ? undefined
                  : { headers: { authorization: `Bearer ${token}` } }
              ),
              tag
            ),
            {
              onSuccess: () => "answered",
              onFailure: (failure) =>
                failure instanceof DeclaredFailure &&
                Predicate.hasProperty(failure.json, "_tag") &&
                Predicate.isString(failure.json._tag)
                  ? failure.json._tag
                  : "undeclared",
            }
          );

        const signedIn = [
          yield* outcomeOf("guarded", elsewhere, "alice"),
          yield* outcomeOf(
            ActionRpc.pollTag(Moved.name),
            { input: elsewhere, cursor: null },
            "alice"
          ),
          yield* outcomeOf(
            "room.moved/subscribe",
            {
              input: elsewhere,
              delivery: { ...delivery, secret: secretOf(1) },
            },
            "alice"
          ),
          yield* outcomeOf(
            "room.moved/unsubscribe",
            { input: elsewhere, delivery },
            "alice"
          ),
        ];

        expect(signedIn).toStrictEqual(
          Array.from({ length: 4 }, () => "Forbidden")
        );
        expect(yield* outcomeOf("guarded", elsewhere)).toBe("Unauthenticated");
        expect(steps).toStrictEqual(
          Array.from({ length: 4 }, () => "verified")
        );
      }).pipe(Effect.scoped, Effect.provide(guarding));
    }
  );
});
