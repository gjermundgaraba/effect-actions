import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, SchemaGetter } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import { makeTestHttp } from "../support/server.js";
import { post } from "../support/requests.js";
import { GetUser, RenameUser } from "../support/app/contracts.js";
import { serve } from "../support/serve.js";

describe("contracts", () => {
  it("defaults to no input, Schema.Void and no errors, an undefined option as an omitted one", () => {
    const Reset = Action.make("reset", {
      description: "Reset",
      readOnly: false,
      caller: Action.Anyone,
    });

    const Undefined = Action.make("reset", {
      description: "Reset",
      readOnly: false,
      caller: Action.Anyone,
      input: undefined,
      success: undefined,
      error: undefined,
    });

    for (const action of [Reset, Undefined]) {
      expect(Schema.is(action.input)({})).toBe(true);
      expect(Schema.is(action.input)({ unexpected: 1 })).toBe(false);
      expect(action.success).toBe(Schema.Void);
      expect(action.error).toEqual([]);
    }
  });

  it("takes one error schema or a list, as HttpApiEndpoint does, and holds a list", () => {
    class Gone extends Schema.TaggedError<Gone>()("Gone", {}, { httpApiStatus: 410 }) {}

    class Busy extends Schema.TaggedError<Busy>()("Busy", {}) {}

    const One = Action.make("one", {
      description: "One",
      readOnly: true,
      caller: Action.Anyone,
      error: Gone,
    });

    const Two = Action.make("two", {
      description: "Two",
      readOnly: true,
      caller: Action.Anyone,
      error: [Gone, Busy],
    });

    expect(One.error).toEqual([Gone]);
    expect(Two.error).toEqual([Gone, Busy]);
    expect(ActionHttp.make([One], { error: Busy }).error).toEqual([Busy]);
    expect(ActionHttp.make([One], { error: [Busy] }).error).toEqual([Busy]);
  });

  it("names a public caller with a symbol every copy of the package shares", () => {
    expect(Action.Anyone).toBe(Symbol.for("@gjermundgaraba/effect-actions/Anyone"));
  });

  it("keeps the mcp options as given, defaulting none", () => {
    expect(GetUser.mcp).toEqual({});
    expect(RenameUser.mcp).toEqual({ destructiveHint: false });

    const options = { title: "Write", idempotentHint: true } as const;

    const Write = Action.make("write", {
      description: "Given mcp options",
      readOnly: false,
      caller: Action.Anyone,
      success: Schema.String,
      mcp: options,
    });

    expect(Write.mcp).toEqual(options);
    expect(Write.mcp).not.toBe(options);
  });

  it("owns the built-in failures, each with a default message", () => {
    expect(new Action.Forbidden().message).toBe("Not allowed.");
    expect(new Action.Unauthenticated().message).toBe("Authentication is required.");
    expect(new Action.InvalidInput().message).toBe("The input does not match the action's input.");
    expect(new Action.InvalidInput({ message: "Expected string" }).message).toBe("Expected string");
  });

  it("rejects invalid names at definition time, where they are also tool names", () => {
    const invalidNames = ["bad name", "then", "", "x".repeat(129)];
    const validNames = ["x".repeat(128), "1st", "_private"];

    for (const name of invalidNames) {
      expect(() =>
        Action.make(name, {
          description: "",
          readOnly: false,
          caller: Action.Anyone,
          success: Schema.String,
        }),
      ).toThrow(`Invalid action name: ${name} (use [A-Za-z0-9_-]{1,128}, other than "then")`);
    }

    for (const name of validNames) {
      expect(
        Action.make(name, {
          description: "",
          readOnly: false,
          caller: Action.Anyone,
          success: Schema.String,
        }).name,
      ).toBe(name);
    }
  });

  it("refuses an error with a built-in error's tag, and accepts the built-in itself", () => {
    class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
      error: Schema.String,
    }) {}

    const widenedErrorsWithBuiltInTag: ReadonlyArray<
      readonly [Schema.Codec<unknown, unknown>, string]
    > = [
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
      [
        Schema.Union([Forbidden, Schema.TaggedStruct("Busy", {})]).pipe(
          Schema.decodeTo(Schema.String, {
            decode: SchemaGetter.transform(({ _tag }) => _tag),
            encode: SchemaGetter.transform((_tag) => ({ _tag: "Busy" as const })),
          }),
        ),
        "Forbidden",
      ],
      [Action.InvalidInput.annotate({ description: "Out of stock" }), "InvalidInput"],
      [Schema.suspend(() => Forbidden), "Forbidden"],
      [
        Schema.TaggedStruct("Forbidden", { message: Schema.String }).pipe(
          Schema.decodeTo(
            Schema.Union([Schema.TaggedStruct("Local", {}), Schema.TaggedStruct("Other", {})]),
            {
              decode: SchemaGetter.transform(({ message }) => ({
                _tag: message === "other" ? ("Other" as const) : ("Local" as const),
              })),
              encode: SchemaGetter.transform(({ _tag }) => ({
                _tag: "Forbidden" as const,
                message: _tag,
              })),
            },
          ),
        ),
        "Forbidden",
      ],
      [
        Schema.TaggedStruct("Forbidden", { message: Schema.String }).pipe(
          Schema.decodeTo(
            Schema.suspend(() => Schema.TaggedStruct("Local", { message: Schema.String })),
            {
              decode: SchemaGetter.transform(({ message }) => ({
                _tag: "Local" as const,
                message,
              })),
              encode: SchemaGetter.transform(({ message }) => ({
                _tag: "Forbidden" as const,
                message,
              })),
            },
          ),
        ),
        "Forbidden",
      ],
      [Schema.Struct({ _tag: Schema.Literals(["Busy", "Unauthenticated"]) }), "Unauthenticated"],
      [Schema.Struct({ _tag: Schema.Enum({ Forbidden: "Forbidden", Busy: "Busy" }) }), "Forbidden"],
    ];

    for (const [error, tag] of widenedErrorsWithBuiltInTag) {
      expect(() =>
        Action.make("guarded", {
          description: "",
          readOnly: false,
          caller: Action.Anyone,
          error: [error],
        }),
      ).toThrow(
        `Action "guarded": error _tag "${tag}" names two error schemas, which a client cannot tell apart (reuse one schema value, or merge them into one whose fields tell them apart; for a built-in's tag, fail with the built-in itself)`,
      );
    }

    const Allowed = Action.make("allowed", {
      description: "",
      readOnly: false,
      caller: Action.Anyone,
      error: [
        Schema.TaggedStruct("Busy", {}),
        Schema.Union([Schema.TaggedStruct("Late", {}), Schema.TaggedStruct("Gone", {})]),
      ],
    });

    expect(Action.implement(Allowed, () => Effect.void).actions).toEqual([Allowed]);
  });

  it("refuses two error schemas sharing a _tag, listed apart or as members of one union", () => {
    class Missing extends Schema.TaggedError<Missing>()("NotFound", { id: Schema.String }) {}

    class Archived extends Schema.TaggedError<Archived>()("NotFound", {
      id: Schema.String,
      archivedAt: Schema.String,
    }) {}

    const errorsSharingATag: ReadonlyArray<Action.Errors> = [
      [Missing, Archived],
      [Schema.Union([Missing, Archived])],
      [Missing, Schema.TaggedStruct("NotFound", { id: Schema.String })],
      [Missing, Schema.Struct({ _tag: Schema.Literals(["Late", "NotFound"]) })],
      [
        Missing,
        Schema.Union([Missing, Schema.TaggedStruct("Gone", {})]).annotate({ httpApiStatus: 404 }),
      ],
      [Schema.suspend(() => Archived), Missing],
    ];

    for (const error of errorsSharingATag) {
      expect(() =>
        Action.make("lookup", { description: "", readOnly: true, caller: Action.Anyone, error }),
      ).toThrow(`Action "lookup": error _tag "NotFound" names two error schemas`);
    }
  });

  it("accepts one error schema reached twice, listed again, through a union or suspended", () => {
    class Missing extends Schema.TaggedError<Missing>()("NotFound", { id: Schema.String }) {}

    const Gone = Schema.TaggedStruct("Gone", {});

    const oneSchemaReachedTwice: ReadonlyArray<Action.Errors> = [
      [Missing, Missing],
      [Missing, Schema.Union([Missing, Gone])],
      [Schema.Union([Missing, Missing])],
      [Schema.suspend(() => Missing), Missing],
      [Action.Forbidden, Missing],
      [Schema.Union([Action.Unauthenticated, Missing])],
      [
        Schema.Struct({ id: Schema.String }).pipe(
          Schema.encodeTo(
            Schema.Union([
              Schema.TaggedStruct("Variant", { id: Schema.String }),
              Schema.TaggedStruct("Variant", { legacyId: Schema.String }),
            ]),
            {
              decode: SchemaGetter.transform((encoded) => ({
                id: "id" in encoded ? encoded.id : encoded.legacyId,
              })),
              encode: SchemaGetter.transform(({ id }) => ({ _tag: "Variant" as const, id })),
            },
          ),
        ),
      ],
      [
        Schema.TaggedStruct("Wire", { message: Schema.String }).pipe(
          Schema.decodeTo(Schema.Union([Schema.TaggedStruct("Forbidden", {}), Missing]), {
            decode: SchemaGetter.transform(({ message }) =>
              message === ""
                ? { _tag: "Forbidden" as const }
                : { _tag: "NotFound" as const, id: message },
            ),
            encode: SchemaGetter.transform((value) => ({
              _tag: "Wire" as const,
              message: value._tag === "NotFound" ? value.id : "",
            })),
          }),
        ),
      ],
    ];

    for (const error of oneSchemaReachedTwice) {
      expect(
        Action.make("lookup", { description: "", readOnly: true, caller: Action.Anyone, error })
          .error,
      ).toEqual(error);
    }
  });

  it.effect("tells variants of one _tag apart by its schema's fields, on each client", () =>
    Effect.gen(function* () {
      const Validation = Schema.TaggedStruct("Validation", {
        field: Schema.Literals(["email", "name"]),
      });

      const Register = Action.make("register", {
        description: "",
        readOnly: false,
        caller: Action.Anyone,
        input: { field: Schema.Literals(["email", "name"]) },
        error: Validation,
      });

      const HttpListingItToo = ActionHttp.make([Register], { error: Validation });

      const app = Action.implement(Register, ({ field }) =>
        Effect.fail(Validation.make({ field })),
      );

      const local = yield* Action.client(app);

      const remote = yield* ActionHttp.client(HttpListingItToo).pipe(
        Effect.provide(Testing.layer(ActionHttp.layer(HttpListingItToo, app))),
      );

      for (const client of [local, remote]) {
        for (const field of ["email", "name"] as const) {
          expect(yield* Effect.flip(client.register({ field }))).toEqual({
            _tag: "Validation",
            field,
          });
        }
      }
    }),
  );

  it("answers a built-in error as itself beside a loose error schema of the action's", async () => {
    const Loose = Action.make("loose", {
      description: "An error schema any object with a message matches",
      readOnly: false,
      caller: Action.Anyone,
      error: [Schema.Struct({ message: Schema.String })],
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
      readOnly: true,
      caller: Action.Anyone,
      input: { id: Schema.String, limit: Schema.optionalKey(Schema.FiniteFromString) },
      success: { total: Schema.Finite },
    });

    const Schemas = Action.make("schemas", {
      description: "Schemas",
      readOnly: true,
      caller: Action.Anyone,
      input: Schema.Struct({ id: Schema.String }),
      success: Schema.Finite,
    });

    expect(Schema.isSchema(Fields.input)).toBe(true);
    expect(Schema.decodeUnknownSync(Fields.input)({ id: "a", limit: "2" })).toEqual({
      id: "a",
      limit: 2,
    });
    expect(Schema.decodeUnknownSync(Fields.input)({ id: "a" })).toEqual({ id: "a" });
    expect(Schema.is(Fields.success)({ total: 1 })).toBe(true);
    expect(Schema.is(Fields.success)({ total: "1" })).toBe(false);
    expect(Schemas.success).toBe(Schema.Finite);

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
      readOnly: true,
      caller: Action.Anyone,
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
      readOnly: false,
      caller: Action.Anyone,
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

    const Again = Action.make("getUser", {
      description: "Again",
      readOnly: true,
      caller: Action.Anyone,
    });

    expect(() => Action.byName([GetUser, Again])).toThrow(
      "Duplicate action: getUser (list it once, or rename one)",
    );
  });
});

describe("implementations", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    readOnly: false,
    caller: Action.Anyone,
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
    readOnly: false,
    caller: Action.Anyone,
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
