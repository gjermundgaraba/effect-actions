import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, SchemaGetter } from "effect";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Testing from "../src/Testing.js";
import { makeTestHttp } from "./server.js";
import { post } from "./requests.js";
import { GetUser, RenameUser } from "../examples/contracts.js";
import { serve } from "./serve.js";

describe("contracts", () => {
  it("defaults to no input, Schema.Void and no errors, an undefined option as an omitted one", () => {
    const Reset = Action.make("reset", { description: "Reset", access: "write", auth: "public" });

    const Undefined = Action.make("reset", {
      description: "Reset",
      access: "write",
      auth: "public",
      input: undefined,
      success: undefined,
      errors: undefined,
    });

    for (const action of [Reset, Undefined]) {
      expect(Schema.is(action.input)({})).toBe(true);
      expect(Schema.is(action.input)({ unexpected: 1 })).toBe(false);
      expect(action.success).toBe(Schema.Void);
      expect(action.errors).toEqual([]);
    }
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
      auth: "public",
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
      auth: "public",
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
        Action.make(name, {
          description: "",
          access: "write",
          auth: "public",
          success: Schema.String,
        }),
      ).toThrow("Invalid action name");
    }

    // A leading digit or underscore is fine.
    for (const name of ["x".repeat(128), "1st", "_private"]) {
      expect(
        Action.make(name, {
          description: "",
          access: "write",
          auth: "public",
          success: Schema.String,
        }).name,
      ).toBe(name);
    }
  });

  it("refuses an error with a built-in error's tag, the built-in itself included", () => {
    class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
      error: Schema.String,
    }) {}

    // Widened, as plain JavaScript passes them: the types refuse a built-in error listed. Each
    // with the built-in tag it encodes with.
    const errors: ReadonlyArray<readonly [Schema.Codec<unknown, unknown>, string]> = [
      [Forbidden, "Forbidden"],
      [
        Schema.TaggedStruct("InvalidInput", { issues: Schema.Array(Schema.String) }),
        "InvalidInput",
      ],
      [
        Schema.Union([
          Schema.TaggedStruct("Busy", {}),
          Schema.TaggedStruct("Unauthenticated", { reason: Schema.String }),
        ]),
        "Unauthenticated",
      ],
      // A union behind a transformation, which only its encoding shows.
      [
        Schema.Union([Forbidden, Schema.TaggedStruct("Busy", {})]).pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transform(({ _tag }) => _tag),
            encode: SchemaGetter.transform((_tag) => ({ _tag: "Busy" as const })),
          }),
        ),
        "Forbidden",
      ],
      // Every surface declares the built-in errors already, annotated or not.
      [Action.Forbidden, "Forbidden"],
      [Schema.Union([Action.Unauthenticated, Schema.TaggedStruct("Late", {})]), "Unauthenticated"],
      [Action.InvalidInput.annotate({ description: "Out of stock" }), "InvalidInput"],
      // Suspended, as a recursive error is written, or tagged by a union of literals or an enum.
      [Schema.suspend(() => Forbidden), "Forbidden"],
      [Schema.Struct({ _tag: Schema.Literals(["Busy", "Unauthenticated"]) }), "Unauthenticated"],
      [Schema.Struct({ _tag: Schema.Enum({ Forbidden: "Forbidden", Busy: "Busy" }) }), "Forbidden"],
    ];

    // Refused where the contract is made, so neither a server nor a client of it meets one.
    for (const [error, tag] of errors) {
      expect(() =>
        Action.make("guarded", {
          description: "",
          access: "write",
          auth: "public",
          errors: [error],
        }),
      ).toThrow(`Action "guarded": error _tag "${tag}" is built in, and declared on every surface`);
    }

    // Other tags, in a union too, are fine.
    const Allowed = Action.make("allowed", {
      description: "",
      access: "write",
      auth: "public",
      errors: [
        Schema.TaggedStruct("Busy", {}),
        Schema.Union([Schema.TaggedStruct("Late", {}), Schema.TaggedStruct("Gone", {})]),
      ],
    });

    expect(Action.implement(Allowed, () => Effect.void).actions).toEqual([Allowed]);
  });

  it.effect(
    "tells errors sharing a _tag apart by their other fields, as members of any union",
    () =>
      Effect.gen(function* () {
        const EmailInvalid = Schema.TaggedStruct("Validation", { field: Schema.Literal("email") });
        const NameInvalid = Schema.TaggedStruct("Validation", { field: Schema.Literal("name") });

        const Register = Action.make("register", {
          description: "",
          access: "write",
          auth: "public",
          input: { field: Schema.Literals(["email", "name"]) },
          errors: [EmailInvalid, NameInvalid],
        });

        // A binding may list one of them too.
        const Http = ActionHttp.make([Register], { errors: [NameInvalid] });

        const app = Action.implement(Register, ({ field }) =>
          field === "email"
            ? Effect.fail(EmailInvalid.make({ field }))
            : Effect.fail(NameInvalid.make({ field })),
        );

        const local = yield* Action.client(app);

        const remote = yield* ActionHttp.client(Http).pipe(
          Effect.provide(Testing.layer(ActionHttp.layer(Http, app))),
        );

        for (const client of [local, remote]) {
          expect(yield* Effect.flip(client.register({ field: "email" }))).toEqual(
            EmailInvalid.make({ field: "email" }),
          );
          expect(yield* Effect.flip(client.register({ field: "name" }))).toEqual(
            NameInvalid.make({ field: "name" }),
          );
        }
      }),
  );

  it("answers a built-in error as itself beside a loose error schema of the action's", async () => {
    const Loose = Action.make("loose", {
      description: "An error schema any object with a message matches",
      access: "write",
      auth: "public",
      errors: [Schema.Struct({ message: Schema.String })],
    });

    const web = makeTestHttp(
      Action.implement(Loose, () => Effect.fail(new Action.Forbidden({ message: "no" }))),
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

  it("accepts struct fields wherever a struct schema is accepted", () => {
    const Fields = Action.make("fields", {
      description: "Fields shorthand",
      access: "read",
      auth: "public",
      input: { id: Schema.String, limit: Schema.optionalKey(Schema.FiniteFromString) },
      success: { total: Schema.Finite },
    });

    const Schemas = Action.make("schemas", {
      description: "Schemas",
      access: "read",
      auth: "public",
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
      auth: "public",
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
      auth: "public",
      success: created,
    });

    expect(Create.success).toBe(created);

    const web = makeTestHttp(Action.implement(Create, () => Effect.succeed({})));
    const response = await web.handler(post("/api/create"));

    expect(response.status).toBe(201);
  });

  it("keys a list of actions by name, each its own contract, refusing a name held twice", () => {
    const contracts = Action.byName([GetUser, RenameUser]);

    expect(Object.keys(contracts)).toEqual(["getUser", "renameUser"]);
    expect(contracts.getUser).toBe(GetUser);
    expect(contracts.renameUser.success).toBe(RenameUser.success);

    const Again = Action.make("getUser", { description: "Again", access: "read", auth: "public" });

    expect(() => Action.byName([GetUser, Again])).toThrow("Duplicate action: getUser");
  });
});

describe("implementations", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    access: "write",
    auth: "public",
    input: { name: Schema.String },
    success: Schema.String,
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

    expect(await (await web.handler(post("/a/hello", { name: "Ada" }))).json()).toBe("from A");
    expect(await (await web.handler(post("/b/hello", { name: "Ada" }))).json()).toBe("from B");
  });

  const Proto = Action.make("__proto__", {
    description: "Prototype-safe",
    access: "write",
    auth: "public",
    success: Schema.String,
  });

  it.each([
    {
      form: "one action",
      make: () => Action.implement(Proto, () => Effect.succeed("safe")),
    },
    {
      form: "a record",
      make: () => Action.implement([Proto], { ["__proto__"]: () => Effect.succeed("safe") }),
    },
  ])("routes prototype-sensitive action names through native HTTP: $form", async ({ make }) => {
    const web = makeTestHttp(make());

    const response = await web.handler(post("/api/__proto__"));

    expect(await response.json()).toBe("safe");
  });
});
