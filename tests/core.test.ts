import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema, SchemaGetter } from "effect";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { makeTestHttp } from "./server.js";
import { Double, GetUser, RenameUser, WhoAmI } from "../examples/contracts.js";
import { serve } from "./serve.js";

describe("contracts", () => {
  it("defaults to no input and errors to none", () => {
    expect(Schema.is(WhoAmI.input)({})).toBe(true);
    expect(Schema.is(WhoAmI.input)({ unexpected: 1 })).toBe(false);
    expect(WhoAmI.errors).toEqual([]);
    expect(Double.errors).toEqual([]);
  });

  it("defaults an omitted success to Schema.Void", () => {
    const Reset = Action.make("reset", { description: "Reset", access: "write" });

    expect(Reset.success).toBe(Schema.Void);
  });

  it("takes an undefined option as an omitted one", () => {
    const Reset = Action.make("reset", {
      description: "Reset",
      access: "write",
      input: undefined,
      success: undefined,
      errors: undefined,
    });

    expect(Schema.is(Reset.input)({})).toBe(true);
    expect(Reset.success).toBe(Schema.Void);
    expect(Reset.errors).toEqual([]);
  });

  it("derives tool hints: destructive follows access, and only a write may state it", () => {
    expect(GetUser.hints).toEqual({
      destructive: false,
      idempotent: false,
      openWorld: true,
    });
    expect(RenameUser.hints).toEqual({
      destructive: false,
      idempotent: false,
      openWorld: true,
    });

    const Write = Action.make("write", {
      description: "Default hints",
      access: "write",
      success: Schema.String,
    });

    expect(Write.hints).toEqual({
      destructive: true,
      idempotent: false,
      openWorld: true,
    });

    const Read = Action.make("read", {
      description: "A read stating destructive",
      access: "read",
      success: Schema.String,
      // @ts-expect-error A read is never destructive; plain JavaScript can still say so.
      hints: { destructive: true },
    });

    expect(Read.hints.destructive).toBe(false);
  });

  it("owns the built-in failures, each with a default message", () => {
    expect(new Action.Forbidden().message).toBe("Not allowed.");
    expect(new Action.Unauthenticated().message).toBe("Authentication is required.");
    expect(new Action.InvalidInput().message).toBe("The input does not match the action's input.");
    expect(new Action.InvalidInput({ message: "Expected string" }).message).toBe("Expected string");
  });

  it("rejects invalid names at definition time, where they are also tool names", () => {
    // A name is a route segment, a client method and an MCP tool name, which is at
    // most 128 characters.
    for (const name of ["bad name", "then", "", "x".repeat(129)]) {
      expect(() =>
        Action.make(name, { description: "", access: "write", success: Schema.String }),
      ).toThrow("Invalid action name");
    }

    expect(
      Action.make("x".repeat(128), { description: "", access: "write", success: Schema.String })
        .name,
    ).toHaveLength(128);
  });

  it("refuses an error sharing a built-in error's tag, which no client could tell apart", () => {
    class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
      error: Schema.String,
    }) {}

    const errors = [
      Forbidden,
      Schema.TaggedStruct("InvalidInput", { issues: Schema.Array(Schema.String) }),
      Schema.Union([
        Schema.TaggedStruct("Busy", {}),
        Schema.TaggedStruct("Unauthenticated", { reason: Schema.String }),
      ]),
      // A union behind a transformation, which only its encoding shows.
      Schema.Union([Forbidden, Schema.TaggedStruct("Busy", {})]).pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform(({ _tag }) => _tag),
          encode: SchemaGetter.transform((_tag) => ({ _tag: "Busy" as const })),
        }),
      ),
    ];

    // The contract is plain data a client may hold; serving it is refused.
    for (const [error, tag] of errors.map(
      (error, i) =>
        [error, ["Forbidden", "InvalidInput", "Unauthenticated", "Forbidden"][i]] as const,
    )) {
      const Guarded = Action.make("guarded", { description: "", access: "write", errors: [error] });

      expect(() => Action.implement(Guarded, () => Effect.void)).toThrow(
        `Action "guarded": error _tag "${tag}" is built in; declare Action.${tag} itself`,
      );
    }

    // The built-in errors themselves, in a union too, and other tags, are fine.
    const Allowed = Action.make("allowed", {
      description: "",
      access: "write",
      errors: [
        Action.Forbidden,
        Schema.TaggedStruct("Busy", {}),
        Schema.Union([Action.Unauthenticated, Schema.TaggedStruct("Late", {})]),
      ],
    });

    expect(Action.implement(Allowed, () => Effect.void).actions).toEqual([Allowed]);
  });

  it("accepts names that start with a digit or an underscore", () => {
    expect(
      Action.make("1st", { description: "", access: "write", success: Schema.String }).name,
    ).toBe("1st");
    expect(
      Action.make("_private", { description: "", access: "write", success: Schema.String }).name,
    ).toBe("_private");
    expect(
      ActionHttp.make([
        Action.make("9_action", { description: "", access: "write", success: Schema.String }),
      ]).actions.map((action) => action.name),
    ).toEqual(["9_action"]);
  });

  it("rejects duplicate names where they are bound", () => {
    expect(() => ActionHttp.make([GetUser, GetUser])).toThrow("Duplicate action: getUser");
    expect(() =>
      Action.implement([GetUser, GetUser], { getUser: () => Effect.die("unused") }),
    ).toThrow("Duplicate action: getUser");
  });

  it("accepts struct fields wherever a struct schema is accepted", () => {
    const Fields = Action.make("fields", {
      description: "Fields shorthand",
      access: "read",
      input: { id: Schema.String, limit: Schema.optionalKey(Schema.FiniteFromString) },
      success: { total: Schema.Finite },
    });

    const Schemas = Action.make("schemas", {
      description: "Schemas",
      access: "read",
      input: Schema.Struct({ id: Schema.String }),
      success: Schema.Finite,
    });

    // The fields become the struct they stand for; a schema is kept as it is.
    expect(Schema.isSchema(Fields.input)).toBe(true);
    expect(Schema.decodeUnknownSync(Fields.input)({ id: "a", limit: "2" })).toEqual({
      id: "a",
      limit: 2,
    });
    expect(Schema.decodeUnknownSync(Fields.input)({ id: "a" })).toEqual({ id: "a" });
    expect(Schema.is(Fields.success)({ total: 1 })).toBe(true);
    expect(Schema.is(Fields.success)({ total: "1" })).toBe(false);
    expect(Schemas.success).toBe(Schema.Finite);

    // The decoded types follow the fields.
    const input: { readonly id: string; readonly limit?: number } = Schema.decodeUnknownSync(
      Fields.input,
    )({ id: "a" });

    const total: number = Schema.decodeUnknownSync(Fields.success)({ total: 3 }).total;
    expect([input.id, total]).toEqual(["a", 3]);
  });
});

describe("implementations", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    access: "write",
    input: { name: Schema.String },
    success: Schema.String,
  });

  const request = (path: string) =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });

  it("binds a plain handler, with its actions as its only data", async () => {
    const app = Action.implement(Hello, ({ name }) => Effect.succeed(`hi ${name}`));
    expect(Object.keys(app)).toEqual(["actions"]);
    expect(app.actions).toEqual([Hello]);
    const web = makeTestHttp(app);

    expect(await (await web.handler(request("/api/hello"))).json()).toBe("hi Ada");
  });

  it("keeps same-contract implementations apart", async () => {
    const appA = Action.implement(Hello, () => Effect.succeed("from A"));
    const appB = Action.implement(Hello, () => Effect.succeed("from B"));

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Hello], { prefix: "/a" }), appA),
        ActionHttp.layer(ActionHttp.make([Hello], { prefix: "/b" }), appB),
      ),
    );

    expect(await (await web.handler(request("/a/hello"))).json()).toBe("from A");
    expect(await (await web.handler(request("/b/hello"))).json()).toBe("from B");
  });

  const Proto = Action.make("__proto__", {
    description: "Prototype-safe",
    access: "write",
    success: Schema.String,
  });

  it.each([
    { form: "one action", make: () => Action.implement(Proto, () => Effect.succeed("safe")) },
    {
      form: "a record",
      make: () => Action.implement([Proto], { ["__proto__"]: () => Effect.succeed("safe") }),
    },
  ])("routes prototype-sensitive action names through native HTTP: $form", async ({ make }) => {
    const web = makeTestHttp(make());

    const response = await web.handler(
      new Request("http://localhost/api/__proto__", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(await response.json()).toBe("safe");
  });
});
