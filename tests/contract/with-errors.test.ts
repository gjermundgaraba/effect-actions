import { describe, expect, it } from "@effect/vitest";
import { Effect, pipe, Schema } from "effect";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";

class Missing extends Schema.TaggedError<
  Missing,
  { readonly brand: unique symbol }
>()("NotFound", { id: Schema.String }, { httpApiStatus: 404 }) {}

class Archived extends Schema.TaggedError<
  Archived,
  { readonly brand: unique symbol }
>()("NotFound", { id: Schema.String, archivedAt: Schema.String }) {}

class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", {}, { httpApiStatus: 503 }) {}

const Gone = Schema.TaggedStruct("Gone", {});

const Lookup = Action.make("lookup", {
  description: "Lookup",
  readOnly: true,
  caller: Action.Anyone,
  input: { id: Schema.String },
  success: Schema.String,
  error: Missing,
});

const made = (error: Action.Errors) =>
  Action.make("lookup", {
    description: "",
    readOnly: true,
    caller: Action.Anyone,
    error,
  });

const outcome = (build: () => Action.Any) => {
  try {
    return { error: build().error };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : "" };
  }
};

describe("Action.withErrors", () => {
  it("declares the errors after the action's own, data-first or piped, and leaves the action as it was", () => {
    const dataFirst = Action.withErrors(Lookup, [Unavailable, Gone]);
    const piped = pipe(Lookup, Action.withErrors([Unavailable, Gone]));

    expect(dataFirst.error).toStrictEqual([Missing, Unavailable, Gone]);
    expect(piped.error).toStrictEqual([Missing, Unavailable, Gone]);
    expect(Lookup.error).toStrictEqual([Missing]);
    expect({ ...dataFirst, error: Lookup.error }).toStrictEqual(Lookup);
    expect(dataFirst).not.toBe(Lookup);
  });

  it("accepts and refuses the lists make accepts and refuses for the action's errors followed by them", () => {
    const pairs: ReadonlyArray<readonly [Action.Errors, Action.Errors]> = [
      [[Missing], [Archived]],
      [[Missing], [Schema.Union([Archived, Gone])]],
      [[Missing], [Schema.TaggedStruct("NotFound", { id: Schema.String })]],
      [[Missing], [Schema.TaggedStruct("Forbidden", {})]],
      [[], [Schema.TaggedStruct("InvalidInput", {})]],
      [[Missing], [Missing]],
      [[Missing], [Schema.Union([Missing, Gone])]],
      [[Missing], [Action.Forbidden]],
      [[], [Missing, Unavailable]],
      [[Missing, Gone], []],
    ];

    const refusedCount = pairs.filter(([own, more]) => {
      const appended = outcome(() => Action.withErrors(made(own), more));

      expect(appended).toStrictEqual(outcome(() => made([...own, ...more])));

      return "refused" in appended;
    }).length;

    expect(refusedCount).toBe(5);
  });

  it("refuses an added error whose _tag the action's own or a built-in one holds", () => {
    expect(() => Action.withErrors(Lookup, [Archived])).toThrow(
      'Action "lookup": error _tag "NotFound" names two error schemas'
    );

    expect(() =>
      Action.withErrors(Lookup, [Schema.TaggedStruct("Forbidden", {})])
    ).toThrow("for a built-in's tag, fail with the built-in itself");
  });

  it.effect(
    "lets the handler fail with an added error, which a surface answers and its client decodes",
    () =>
      Effect.gen(function* () {
        const Proxied = pipe(Lookup, Action.withErrors([Unavailable]));

        const app = Action.implement(Proxied, ({ id }) =>
          id === "down" ? Effect.fail(new Unavailable()) : Effect.succeed(id)
        );

        const Http = ActionHttp.make([Proxied]);

        const remote = yield* ActionHttp.client(Http).pipe(
          Effect.provide(Testing.layer(ActionHttp.layer(Http, app)))
        );

        expect(yield* remote.lookup({ id: "up" })).toBe("up");
        expect(
          yield* Effect.flip(remote.lookup({ id: "down" }))
        ).toBeInstanceOf(Unavailable);
      })
  );
});
