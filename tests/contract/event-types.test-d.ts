import { expectTypeOf } from "@effect/vitest";
import { Context, Effect, Schema, Stream } from "effect";
import type { Scope } from "effect";

import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import { CurrentActor } from "../support/app/authorization.js";
import { userActions } from "../support/app/handlers.js";
import type { Users } from "../support/app/users.js";

class Feed extends Context.Service<
  Feed,
  {
    readonly since: (cursor: string | null) => Effect.Effect<readonly string[]>;
  }
>()("test/Feed") {}

class Tenant extends Context.Service<Tenant, string>()("test/Tenant") {}

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  input: { id: Schema.optional(Schema.String) },
  payload: { id: Schema.String, name: Schema.String },
  caller: CurrentActor,
});

const Ticked = Event.make("clock.ticked", {
  description: "The clock ticked.",
  payload: { at: Schema.Finite },
  caller: Action.Anyone,
});

const changes = Event.implement(
  Changed,
  Effect.gen(function* () {
    const feed = yield* Feed;

    return {
      check: (input, cursor) => {
        expectTypeOf(input).toEqualTypeOf<{
          readonly id?: string | undefined;
        }>();
        expectTypeOf(cursor).toEqualTypeOf<string | null>();

        return Effect.gen(function* () {
          const tenant = yield* Tenant;
          const ids = yield* feed.since(cursor);

          return {
            cursor: cursor ?? "0",
            events: ids.map((id) => ({
              eventId: id,
              data: { id, name: tenant },
            })),
          };
        });
      },
    };
  }),
  { authorize: Event.allowAll }
);

const ticks = Event.implement(Ticked, {
  log: { emit: Stream.make({ data: { at: 1 } }) },
  match: (input, data) => {
    expectTypeOf(input).toEqualTypeOf<{ readonly [x: string]: never }>();
    expectTypeOf(data).toEqualTypeOf<{ readonly at: number }>();

    return true;
  },
});

// @ts-expect-error -- A tick carries a number, not a string.
Event.implement(Ticked, { log: { emit: Stream.make({ data: { at: "1" } }) } });

// @ts-expect-error -- A check answers a page, not the occurrences alone.
Event.implement(Ticked, { check: () => Effect.succeed([]) });

const acquired = Action.client([userActions, changes, ticks]);

expectTypeOf<Effect.Services<typeof acquired>>().toEqualTypeOf<
  Users | Feed | Event.Events | Scope.Scope
>();

const unavailable: Event.CursorStore<"unavailable"> = {
  get: () => Effect.fail("unavailable"),
  set: () => Effect.fail("unavailable"),
};

export const watchTypedByTheEventAndOwingItsSubscription = Effect.gen(
  function* () {
    const client = yield* acquired;
    const changed = client.watch(Changed, { id: "1" });
    const ticked = client.watch(Ticked);

    expectTypeOf<Stream.Success<typeof changed>>().toEqualTypeOf<
      Event.Received<typeof Changed>
    >();
    expectTypeOf<Stream.Error<typeof changed>>().toEqualTypeOf<
      Event.SubscriptionError | Action.BuiltIn
    >();
    expectTypeOf<Stream.Services<typeof changed>>().toEqualTypeOf<
      Tenant | CurrentActor
    >();
    expectTypeOf<Stream.Services<typeof ticked>>().toBeNever();

    const kept = client.watch(
      Ticked,
      {},
      {
        resume: { store: unavailable, key: "ticks" },
      }
    );

    expectTypeOf<Stream.Error<typeof kept>>().toEqualTypeOf<
      Event.SubscriptionError | Action.BuiltIn | "unavailable"
    >();

    // @ts-expect-error -- Its input is the event's.
    void client.watch(Changed, { id: 1 });
    void client.watch(
      // @ts-expect-error -- Only the events of the implementations it was given.
      Event.make("x.y", { description: "", payload: {}, caller: Action.Anyone })
    );
    // @ts-expect-error -- No such option.
    void client.watch(Ticked, {}, { modes: "poll" });
  }
);

export const noWatchWithoutEvents = Effect.gen(function* () {
  const client = yield* Action.client(userActions);

  // @ts-expect-error -- A client given no event implementation has no `watch`.
  void client.watch;
});

export const surfacesServingNoEventsRefuseThem = () => {
  // @ts-expect-error -- A toolkit serves no events.
  ActionToolkit.make([userActions, ticks]);
};
