// Compile-only assertions, included by `vp check`, on what MCP serves: input that is one
// object with keys, which `layerHttp` and `runStdio` refuse otherwise, naming its actions;
// and the `tools` they and `Testing.mcpClient` take.
import { Effect, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";
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
  Action.implement(Action.make("none", read), done, Action.allowAll),
  Action.implement(
    Action.make("fields", { ...read, input: { id: Schema.String } }),
    done,
    Action.allowAll,
  ),
  Action.implement(Action.make("struct", { ...read, input: One }), done, Action.allowAll),
  Action.implement(
    Action.make("identified", { ...read, input: One.annotate({ identifier: "One" }) }),
    done,
    Action.allowAll,
  ),
  Action.implement(
    Action.make("optional", { ...read, input: Schema.Struct({ id: Schema.optionalKey(One) }) }),
    done,
    Action.allowAll,
  ),
  Action.implement(
    Action.make("record", { ...read, input: Schema.Record(Schema.String, Schema.Number) }),
    done,
    Action.allowAll,
  ),
  Action.implement(Action.make("class", { ...read, input: Fields }), done, Action.allowAll),
  Action.implement(Action.make("tree", { ...read, input: Tree }), done, Action.allowAll),
] as const;

ActionMcp.layerHttp(served, options);

ActionMcp.runStdio(served, options);

const union = Action.implement(
  Action.make("union", { ...read, input: Schema.Union([One, Other]) }),
  done,
  Action.allowAll,
);

const nullable = Action.implement(
  Action.make("nullable", { ...read, input: Schema.NullOr(One) }),
  done,
  Action.allowAll,
);

const scalar = Action.implement(
  Action.make("scalar", { ...read, input: Schema.String }),
  done,
  Action.allowAll,
);

const array = Action.implement(
  Action.make("array", { ...read, input: Schema.Array(One) }),
  done,
  Action.allowAll,
);

const tuple = Action.implement(
  Action.make("tuple", { ...read, input: Schema.Tuple([Schema.String]) }),
  done,
  Action.allowAll,
);

const anything = Action.implement(
  Action.make("anything", { ...read, input: Schema.Struct({}) }),
  done,
  Action.allowAll,
);

const fieldless = Action.implement(
  Action.make("fieldless", { ...read, input: NoFields }),
  done,
  Action.allowAll,
);

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

// `tools` names served actions, and a tool's `text` a top-level string field of its
// action's encoded success, an optional one too.
const Page = Action.make("page", {
  ...read,
  success: {
    markdown: Schema.String,
    words: Schema.Finite,
    note: Schema.optionalKey(Schema.String),
  },
});

// Each member has `body`, but the union's JSON Schema has no top-level property.
const Either = Action.make("either", {
  ...read,
  success: Schema.Union([
    Schema.Struct({ body: Schema.String, kind: Schema.Literal("a") }),
    Schema.Struct({ body: Schema.String, kind: Schema.Literal("b") }),
  ]),
});

const Scalar = Action.make("text", { ...read, success: Schema.String });

const Dictionary = Action.make("dictionary", {
  ...read,
  success: Schema.Record(Schema.String, Schema.String),
});

// A struct with rest: its declared field is a top-level property, its record's keys are not.
const Rest = Action.make("rest", {
  ...read,
  success: Schema.StructWithRest(Schema.Struct({ markdown: Schema.String }), [
    Schema.Record(Schema.String, Schema.String),
  ]),
});

const pages = Action.implement(
  [Page, Either, Scalar, Dictionary, Rest],
  {
    page: () => Effect.succeed({ markdown: "", words: 0 }),
    either: () => Effect.succeed({ body: "", kind: "a" as const }),
    text: () => Effect.succeed(""),
    dictionary: () => Effect.succeed({}),
    rest: () => Effect.succeed({ markdown: "" }),
  },
  Action.allowAll,
);

ActionMcp.layerHttp(pages, { ...options, tools: { page: { text: "markdown" } } });

ActionMcp.runStdio(pages, { ...options, tools: { page: { text: "note" } } });

// @ts-expect-error `words` is a number.
ActionMcp.layerHttp(pages, { ...options, tools: { page: { text: "words" } } });

// @ts-expect-error The success has no such field.
ActionMcp.layerHttp(pages, { ...options, tools: { page: { text: "missing" } } });

// @ts-expect-error No served action has that name.
ActionMcp.layerHttp(pages, { ...options, tools: { other: { text: "markdown" } } });

// @ts-expect-error A union of structs has no field of its own.
ActionMcp.layerHttp(pages, { ...options, tools: { either: { text: "body" } } });

// @ts-expect-error A string success has no fields.
ActionMcp.runStdio(pages, { ...options, tools: { text: { text: "length" } } });

// @ts-expect-error Nor has a record a field of its own.
ActionMcp.layerHttp(pages, { ...options, tools: { dictionary: { text: "body" } } });

ActionMcp.layerHttp(pages, { ...options, tools: { rest: { text: "markdown" } } });

// @ts-expect-error A key only the rest allows is no declared field.
ActionMcp.layerHttp(pages, { ...options, tools: { rest: { text: "extra" } } });

/** The tool options `tools` accepts for the actions `A`, by name. */
type ToolsOf<A extends Action.Any> = NonNullable<ActionMcp.Options<A>["tools"]>;

const texts: [
  Equal<NonNullable<ToolsOf<typeof Page>["page"]>["text"], "markdown" | "note" | undefined>,
  Equal<NonNullable<ToolsOf<typeof Either>["either"]>["text"], undefined>,
  Equal<NonNullable<ToolsOf<typeof Dictionary>["dictionary"]>["text"], undefined>,
  // The types cannot read an erased success: any name, which the layer build checks.
  Equal<NonNullable<ToolsOf<Action.Any>[string]>["text"], string | undefined>,
] = [true, true, true, true];

void texts;

// `Testing.mcpClient` takes the endpoint's `tools`, typed alike.
Testing.mcpClient([Page], { tools: { page: { text: "markdown" } } });

// @ts-expect-error `words` is a number.
Testing.mcpClient([Page], { tools: { page: { text: "words" } } });

// A helper's own type parameter spread beside its own implementations: `tools` checks the
// entries of the helper's actions, and leaves any other name to the call and the layer build.
export const serveWithPages = <const Apps extends ReadonlyArray<Action.AnyImplementation>>(
  apps: Apps,
) => ActionMcp.layerHttp([...apps, pages], { ...options, tools: { page: { text: "markdown" } } });

export const serveWithWords = <const Apps extends ReadonlyArray<Action.AnyImplementation>>(
  apps: Apps,
) =>
  // @ts-expect-error `words` is a number.
  ActionMcp.layerHttp([...apps, pages], { ...options, tools: { page: { text: "words" } } });

// So does `Testing.mcpClient`'s, for a helper's actions spread beside its own.
export const pagesClient = <const Actions extends ReadonlyArray<Action.Any>>(actions: Actions) =>
  Testing.mcpClient([...actions, Page], { tools: { page: { text: "markdown" } } });

export const wordsClient = <const Actions extends ReadonlyArray<Action.Any>>(actions: Actions) =>
  // @ts-expect-error `words` is a number.
  Testing.mcpClient([...actions, Page], { tools: { page: { text: "words" } } });
