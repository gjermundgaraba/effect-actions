// Compile-only assertions on the input MCP serves, included by `vp check`: one object with
// keys. `layerHttp` and `runStdio` refuse any other, naming its actions.
import { Effect, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import type { Equal } from "./equal.js";

const options = { name: "t", version: "0" };

const read = { description: "", access: "read" } as const;

const done = () => Effect.void;

const One = Schema.Struct({ kind: Schema.Literal("one"), id: Schema.String });

const Other = Schema.Struct({ kind: Schema.Literal("other"), code: Schema.Number });

class Fields extends Schema.Class<Fields>("Fields")({ id: Schema.String }) {}

class NoFields extends Schema.Class<NoFields>("NoFields")({}) {}

interface Tree {
  readonly name: string;
  readonly children: ReadonlyArray<Tree>;
}

const Tree = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
});

// No input, fields, a struct, identified or with only optional fields, a record, a class and
// a recursive struct: each one object with keys.
const served = [
  Action.implement(Action.make("none", read), done),
  Action.implement(Action.make("fields", { ...read, input: { id: Schema.String } }), done),
  Action.implement(Action.make("struct", { ...read, input: One }), done),
  Action.implement(
    Action.make("identified", { ...read, input: One.annotate({ identifier: "One" }) }),
    done,
  ),
  Action.implement(
    Action.make("optional", { ...read, input: Schema.Struct({ id: Schema.optionalKey(One) }) }),
    done,
  ),
  Action.implement(
    Action.make("record", { ...read, input: Schema.Record(Schema.String, Schema.Number) }),
    done,
  ),
  Action.implement(Action.make("class", { ...read, input: Fields }), done),
  Action.implement(Action.make("tree", { ...read, input: Tree }), done),
] as const;

ActionMcp.layerHttp(served, options);

ActionMcp.runStdio(served, options);

const union = Action.implement(
  Action.make("union", { ...read, input: Schema.Union([One, Other]) }),
  done,
);

const nullable = Action.implement(
  Action.make("nullable", { ...read, input: Schema.NullOr(One) }),
  done,
);

const scalar = Action.implement(Action.make("scalar", { ...read, input: Schema.String }), done);

const array = Action.implement(Action.make("array", { ...read, input: Schema.Array(One) }), done);

const tuple = Action.implement(
  Action.make("tuple", { ...read, input: Schema.Tuple([Schema.String]) }),
  done,
);

const anything = Action.implement(
  Action.make("anything", { ...read, input: Schema.Struct({}) }),
  done,
);

const fieldless = Action.implement(Action.make("fieldless", { ...read, input: NoFields }), done);

// @ts-expect-error A union's JSON Schema root is `anyOf`, not an object.
ActionMcp.layerHttp(union, options);

// @ts-expect-error A nullable struct is a union too.
ActionMcp.layerHttp(nullable, options);

// @ts-expect-error A scalar is not an object.
ActionMcp.layerHttp(scalar, options);

// @ts-expect-error Nor is an array.
ActionMcp.layerHttp(array, options);

// @ts-expect-error Nor a tuple.
ActionMcp.layerHttp(tuple, options);

// @ts-expect-error `Schema.Struct({})` has no keys, and accepts any value but `null`.
ActionMcp.layerHttp(anything, options);

// @ts-expect-error Nor has a class without fields.
ActionMcp.layerHttp(fieldless, options);

// @ts-expect-error One refused action refuses the list serving it.
ActionMcp.layerHttp([...served, scalar], options);

// @ts-expect-error `runStdio` refuses what `layerHttp` does.
ActionMcp.runStdio(union, options);

/** What `layerHttp` asks of `Apps`: the implementations, and the rule on their input. */
type Asked<Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>> =
  Parameters<typeof ActionMcp.layerHttp<Apps>>[0];

type Rule = "MCP tool input must be one object with keys, such as a struct";

const mixed = [...served, scalar, anything, union] as const;

const rule: [
  // The refusal names every action whose input is not one object with keys, and no other.
  Equal<Asked<typeof mixed>[Rule], "scalar" | "anything" | "union">,
  Equal<Asked<typeof nullable>[Rule], "nullable">,
  // Served input is asked nothing more.
  Equal<Asked<typeof served>, typeof served>,
] = [true, true, true];

void rule;

// Erased input passes; the native server refuses what the types cannot see.
declare const erased: ReadonlyArray<Action.AnyImplementation>;

ActionMcp.layerHttp(erased, options);

ActionMcp.runStdio(erased, options);

// A helper generic over implementations compiles.
export const serveMcp = <
  const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
>(
  apps: Apps,
) => ActionMcp.layerHttp(apps, options);

export const runMcp = <App extends Action.AnyImplementation>(app: App) =>
  ActionMcp.runStdio(app, options);

// A helper's own type parameter, spread into a list, compiles too.
export const serveBeside = <const Apps extends ReadonlyArray<Action.AnyImplementation>>(
  apps: Apps,
) => ActionMcp.layerHttp([...apps, ...served], options);

// A list holding a helper's type parameter is refused, the refusal naming `NotObjectInput`
// rather than an action: the rule cannot read that input.
export const serveListed = <App extends Action.AnyImplementation>(app: App) => {
  // @ts-expect-error Nothing runs: the list's input is unread, so it is refused.
  void ActionMcp.runStdio([app, ...served], options);
};

// An argument chosen by a condition passes when one choice's input does: the native server
// refuses another's when the layer is built. When none does, it is refused.
declare const debug: boolean;

ActionMcp.layerHttp(debug ? [...served, scalar] : served, options);

// @ts-expect-error No choice's input is one object with keys.
ActionMcp.layerHttp(debug ? [scalar] : [array], options);
