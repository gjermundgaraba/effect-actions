// Compile-only assertions, included by `vp check`, on the `tools` that `layerHttp`,
// `runStdio` and `Testing.mcpClient` take. Input is checked when a server is made
// (registration.test.ts), so the types take any implementations, a helper's own included.
import { Effect, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";
import type { Equal } from "./equal.js";

const options = { name: "t", version: "0" };

const read = { description: "", access: "read" } as const;

const done = () => Effect.void;

const status = Action.implement(Action.make("status", read), done, Action.allowAll);

declare const erased: ReadonlyArray<Action.AnyImplementation>;

ActionMcp.layerHttp(erased, options);

ActionMcp.runStdio(erased, options);

// A helper generic over implementations compiles, its type parameter alone, spread into a
// list or listed beside another implementation.
export const serveMcp = <
  const Apps extends Action.AnyImplementation | ReadonlyArray<Action.AnyImplementation>,
>(
  apps: Apps,
) => ActionMcp.layerHttp(apps, options);

export const serveBeside = <const Apps extends ReadonlyArray<Action.AnyImplementation>>(
  apps: Apps,
) => ActionMcp.layerHttp([...apps, status], options);

export const runListed = <App extends Action.AnyImplementation>(app: App) =>
  ActionMcp.runStdio([app, status], options);

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

// Listed rather than spread, a helper's type parameter leaves `tools` untyped: an entry of the
// helper's own actions is refused, a valid one too.
export const serveListedPages = <App extends Action.AnyImplementation>(app: App) =>
  // @ts-expect-error The listed parameter's actions are unread.
  ActionMcp.layerHttp([app, pages], { ...options, tools: { page: { text: "markdown" } } });

// So does `Testing.mcpClient`'s, for a helper's actions spread beside its own.
export const pagesClient = <const Actions extends ReadonlyArray<Action.Any>>(actions: Actions) =>
  Testing.mcpClient([...actions, Page], { tools: { page: { text: "markdown" } } });

export const wordsClient = <const Actions extends ReadonlyArray<Action.Any>>(actions: Actions) =>
  // @ts-expect-error `words` is a number.
  Testing.mcpClient([...actions, Page], { tools: { page: { text: "words" } } });

// An implementation's `actions` are its exact contracts: a client of them has one method per
// tool the implementation serves, and no other.
const listed = Action.implement(
  [Action.make("first", read), Action.make("second", read)],
  { first: done, second: done },
  Action.allowAll,
);

export const listedClient = Effect.map(Testing.mcpClient(listed.actions), (mcp) => {
  const methods: Equal<keyof typeof mcp, "first" | "second"> = true;

  return methods;
});
