import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema, SchemaGetter } from "effect";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { makeTestHttp } from "./server.js";
import { post } from "./requests.js";
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

  it("refuses an error with a built-in error's tag, the built-in itself included", () => {
    class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
      error: Schema.String,
    }) {}

    // Widened, as plain JavaScript passes them: the types refuse a built-in error listed.
    const errors: ReadonlyArray<Schema.Codec<unknown, unknown>> = [
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
      // Every surface declares the built-in errors already, annotated or not.
      Action.Forbidden,
      Schema.Union([Action.Unauthenticated, Schema.TaggedStruct("Late", {})]),
      Action.InvalidInput.annotate({ description: "Out of stock" }),
    ];

    const tags = [
      "Forbidden",
      "InvalidInput",
      "Unauthenticated",
      "Forbidden",
      "Forbidden",
      "Unauthenticated",
      "InvalidInput",
    ];

    // The contract is plain data a client may hold; serving it is refused.
    for (const [error, tag] of errors.map((error, i) => [error, tags[i]] as const)) {
      const Guarded = Action.make("guarded", { description: "", access: "write", errors: [error] });

      expect(() => Action.implement(Guarded, () => Effect.void, Action.allowAll)).toThrow(
        `Action "guarded": error _tag "${tag}" is built in, and declared on every surface`,
      );
    }

    // Other tags, in a union too, are fine.
    const Allowed = Action.make("allowed", {
      description: "",
      access: "write",
      errors: [
        Schema.TaggedStruct("Busy", {}),
        Schema.Union([Schema.TaggedStruct("Late", {}), Schema.TaggedStruct("Gone", {})]),
      ],
    });

    expect(Action.implement(Allowed, () => Effect.void, Action.allowAll).actions).toEqual([
      Allowed,
    ]);
  });

  it("refuses two errors one caller may receive with one _tag", () => {
    const Busy = Schema.TaggedStruct("Busy", { retryAfter: Schema.Finite });

    const Twice = Action.make("twice", {
      description: "",
      access: "write",
      errors: [
        Busy,
        Schema.Union([Schema.TaggedStruct("Busy", {}), Schema.TaggedStruct("Late", {})]),
      ],
    });

    expect(() => Action.implement(Twice, () => Effect.void, Action.allowAll)).toThrow(
      'Duplicate error _tag in action "twice": Busy',
    );

    // An action's error beside its binding's, where the client tries both for one status.
    const Once = Action.make("once", { description: "", access: "write", errors: [Busy] });
    const app = Action.implement(Once, () => Effect.void, Action.allowAll);

    expect(() =>
      ActionHttp.layer(
        ActionHttp.make([Once], {
          errors: [Schema.TaggedStruct("Busy", { reason: Schema.String })],
        }),
        app,
      ),
    ).toThrow('Duplicate error _tag in action "once" and its binding: Busy');

    // One schema listed by both is one error.
    expect(() => ActionHttp.layer(ActionHttp.make([Once], { errors: [Busy] }), app)).not.toThrow();
  });

  it("answers a built-in error as itself beside a loose error schema of the action's", async () => {
    const Loose = Action.make("loose", {
      description: "An error schema any object with a message matches",
      access: "write",
      errors: [Schema.Struct({ message: Schema.String })],
    });

    const web = makeTestHttp(
      Action.implement(
        Loose,
        () => Effect.fail(new Action.Forbidden({ message: "no" })),
        Action.allowAll,
      ),
    );

    const refused = await web.handler(post("/api/loose"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Action.Forbidden)(new Action.Forbidden({ message: "no" })),
    );

    const invalid = await web.handler(post("/api/loose", { unexpected: 1 }));
    expect(invalid.status).toBe(400);
    expect(Schema.decodeUnknownSync(Action.InvalidInput)(await invalid.json())).toBeInstanceOf(
      Action.InvalidInput,
    );
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
      Action.implement(
        [GetUser, GetUser],
        { getUser: () => Effect.die("unused") },
        Action.allowAll,
      ),
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

  it("reads fields keyed by symbols as fields, as a struct of them does", () => {
    const key = Symbol("key");

    const Keyed = Action.make("keyed", {
      description: "Symbol-keyed fields",
      access: "read",
      input: { [key]: Schema.String },
      success: Schema.String,
    });

    expect(Schema.decodeUnknownSync(Keyed.input)({ [key]: "a" })).toEqual({ [key]: "a" });
    expect(Schema.is(Keyed.input)({})).toBe(false);
  });

  it("keeps a given empty struct as it is, its HTTP status included", async () => {
    const created = Schema.Struct({}).annotate({ httpApiStatus: 201 });

    const Create = Action.make("create", {
      description: "Creates, answering 201",
      access: "write",
      success: created,
    });

    expect(Create.success).toBe(created);

    const web = makeTestHttp(Action.implement(Create, () => Effect.succeed({}), Action.allowAll));
    const response = await web.handler(post("/api/create"));

    expect(response.status).toBe(201);
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
    const app = Action.implement(
      Hello,
      ({ name }) => Effect.succeed(`hi ${name}`),
      Action.allowAll,
    );

    expect(Object.keys(app)).toEqual(["actions"]);
    expect(app.actions).toEqual([Hello]);
    const web = makeTestHttp(app);

    expect(await (await web.handler(request("/api/hello"))).json()).toBe("hi Ada");
  });

  it("keeps same-contract implementations apart", async () => {
    const appA = Action.implement(Hello, () => Effect.succeed("from A"), Action.allowAll);
    const appB = Action.implement(Hello, () => Effect.succeed("from B"), Action.allowAll);

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
    {
      form: "one action",
      make: () => Action.implement(Proto, () => Effect.succeed("safe"), Action.allowAll),
    },
    {
      form: "a record",
      make: () =>
        Action.implement([Proto], { ["__proto__"]: () => Effect.succeed("safe") }, Action.allowAll),
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
