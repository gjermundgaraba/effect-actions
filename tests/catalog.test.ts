import { describe, expect, it } from "vite-plus/test";
import { Exit, JsonSchema, Option, Schema, SchemaRepresentation } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionCatalog from "../src/ActionCatalog.js";

/** What a consumer does: parse the serialized document, then revive its encoded value. */
const revive = (
  described: ActionCatalog.Described | undefined,
  revivers: ReadonlyArray<SchemaRepresentation.AnyReviver> = [],
) => {
  const persisted = Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(JSON.stringify(described?.representation)),
  );

  const revived = SchemaRepresentation.fromRepresentation(
    SchemaRepresentation.fromJson(persisted),
    { revivers },
  );

  const decode = Schema.decodeUnknownExit(Schema.make<Schema.Codec<unknown>>(revived.ast));

  return (wire: Schema.Json) => Exit.isSuccess(decode(wire));
};

describe("offline action catalog", () => {
  it("describes encoded values without binding handlers or adding transport envelopes", () => {
    const Group = ActionGroup.make(
      { name: "numbers" },
      Action.make("double", {
        description: "Double a number encoded as a string",
        access: "write",
        input: Schema.Struct({ n: Schema.FiniteFromString }),
        success: Schema.FiniteFromString,
        mcp: { name: "double_number", idempotent: true, openWorld: false },
      }),
    );

    const catalog = ActionCatalog.make(Group);
    expect(catalog.version).toBe("2");
    expect(catalog.actions).toHaveLength(1);
    expect(catalog.actions[0]).toMatchObject({
      id: "numbers.double",
      group: "numbers",
      name: "double",
      http: true,
      mcp: { name: "double_number", idempotent: true, openWorld: false },
      input: { jsonSchema: { type: "object", properties: { n: { type: "string" } } } },
      success: { jsonSchema: { type: "string" } },
      errors: [],
      httpSchemaErrors: [],
    });
    expect(() => JSON.stringify(catalog)).not.toThrow();
  });

  it("keeps same-named definitions local to their schema documents", () => {
    const Text = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" });
    const Number = Schema.Struct({ value: Schema.Finite }).annotate({ identifier: "Shared" });

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "text" },
        Action.make("read", { description: "Text", access: "write", success: Text }),
      ),
      ActionGroup.make(
        { name: "number" },
        Action.make("read", { description: "Number", access: "write", success: Number }),
      ),
    );

    expect(catalog.actions.map((entry) => entry.id)).toEqual(["text.read", "number.read"]);
    expect(catalog.actions[0]?.success.jsonSchema).toMatchObject({
      $ref: "#/$defs/Shared",
      $defs: { Shared: { properties: { value: { type: "string" } } } },
    });
    expect(catalog.actions[1]?.success.jsonSchema).toMatchObject({
      $ref: "#/$defs/Shared",
      $defs: { Shared: { properties: { value: { type: "number" } } } },
    });
  });

  it("preserves recursive references and escaped definition names", () => {
    interface Node {
      readonly children: ReadonlyArray<Node>;
    }

    const Node: Schema.Codec<Node> = Schema.Struct({
      children: Schema.Array(Schema.suspend(() => Node)),
    }).annotate({ identifier: "acme/Node~x" });

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "trees" },
        Action.make("read", {
          description: "Recursive tree",
          access: "write",
          input: Node,
          success: Node,
        }),
      ),
    );

    expect(catalog.actions[0]?.input.jsonSchema).toMatchObject({
      $ref: "#/$defs/acme~1Node~0x",
      $defs: {
        "acme/Node~x": {
          properties: { children: { items: { $ref: "#/$defs/acme~1Node~0x" } } },
        },
      },
    });
  });

  it("distinguishes shared domain errors from HTTP-only policy errors", () => {
    const Shared = Schema.Literal("shared");
    const Own = Schema.Literal("own");
    const Policy = Schema.Literal("invalid");

    const Group = ActionGroup.make(
      { name: "errors", errors: [Shared], schemaError: { errors: [Policy], map: () => "invalid" } },
      Action.make("read", {
        description: "Read",
        access: "write",
        success: Schema.String,
        errors: [Own],
      }),
      Action.make("local", {
        description: "Local only",
        access: "write",
        success: Schema.String,
        http: false,
        mcp: false,
      }),
    );

    const catalog = ActionCatalog.make(Group);

    expect(catalog.actions[0]?.errors).toMatchObject([
      { jsonSchema: { enum: ["own"] } },
      { jsonSchema: { enum: ["shared"] } },
    ]);
    expect(catalog.actions[0]?.httpSchemaErrors).toMatchObject([
      { jsonSchema: { enum: ["invalid"] } },
    ]);
    expect(catalog.actions[1]).toMatchObject({ http: false, mcp: false, httpSchemaErrors: [] });
    expect(catalog.actions[1]?.errors).toMatchObject([{ jsonSchema: { enum: ["shared"] } }]);
  });

  it("preserves dictionary values instead of projecting an empty object", () => {
    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "dictionaries" },
        Action.make("read", {
          description: "Read values by arbitrary key",
          access: "write",
          input: Schema.Record(Schema.String, Schema.FiniteFromString),
          success: Schema.Record(Schema.String, Schema.Finite),
        }),
      ),
    );

    expect(catalog.actions[0]?.input.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
    });
    expect(catalog.actions[0]?.success.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  it("revives the encoded value, with the filters JSON Schema cannot name", () => {
    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "numbers" },
        Action.make("double", {
          description: "Double a number encoded as a string",
          access: "write",
          input: Schema.Struct({
            n: Schema.FiniteFromString,
            label: Schema.String.check(Schema.isMinLength(3)),
          }),
          success: Schema.FiniteFromString,
        }),
      ),
    );

    const accepts = revive(catalog.actions[0]?.input, [SchemaRepresentation.isMinLengthReviver]);

    // The wire value: `n` stays the string it is encoded as.
    expect(accepts({ n: "2", label: "abc" })).toBe(true);
    expect(accepts({ n: 2, label: "abc" })).toBe(false);
    expect(accepts({ n: "2", label: "ab" })).toBe(false);
  });

  it("describes what the adapters send, not the schema's own encoded side", () => {
    const stamp = { at: Schema.Date, note: Schema.Option(Schema.String) };
    const Stamped = Schema.Struct({ ...stamp, count: Schema.BigInt });
    // The same wire shape, except that `count` may be any string.
    const Unchecked = Schema.Struct({ ...stamp, count: Schema.String });

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "stamps" },
        Action.make("read", { description: "Read", access: "read", success: Stamped }),
      ),
    );

    // No declaration revivers: on the wire a Date, a bigint and an Option are plain JSON.
    const accepts = revive(catalog.actions[0]?.success, [
      SchemaRepresentation.isStringBigIntReviver,
    ]);

    const value = { at: new Date(0), note: Option.some("a") };

    expect(accepts(Schema.encodeSync(Schema.toCodecJson(Stamped))({ ...value, count: 1n }))).toBe(
      true,
    );
    expect(
      accepts(Schema.encodeSync(Schema.toCodecJson(Unchecked))({ ...value, count: "one" })),
    ).toBe(false);
  });

  it("has no representation for a schema Effect cannot persist, however deep the check", () => {
    const StartsWithX = Schema.String.check(Schema.makeFilter((text) => text.startsWith("X")));

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "codes" },
        Action.make("read", {
          description: "Read",
          access: "read",
          input: Schema.Struct({
            // A check carrying a schema of its own.
            byCode: Schema.Record(Schema.String, Schema.Number).check(
              Schema.isPropertyNames(StartsWithX),
            ),
          }),
          success: Schema.String.check(
            // Effect persists a group's members, so annotating the group is not enough.
            Schema.makeFilterGroup([Schema.makeFilter((text) => text.startsWith("X"))], {
              representation: { id: "acme/startsWithX", payload: null },
            }),
          ),
          errors: [
            Schema.String.check(
              Schema.makeFilter((text) => text.startsWith("X"), {
                toJsonSchema: () => ({ pattern: "^X" }),
              }),
            ),
          ],
        }),
      ),
    );

    const [entry] = catalog.actions;
    expect(entry?.input.representation).toBeUndefined();
    expect(entry?.success.representation).toBeUndefined();
    // The JSON Schema is unaffected and keeps what the filter declares for it.
    expect(entry?.errors[0]?.representation).toBeUndefined();
    expect(entry?.errors[0]?.jsonSchema).toMatchObject({ pattern: "^X" });
    expect(JSON.stringify(catalog)).not.toContain('"representation"');
  });

  it("describes the wire form only: a check after a transformation is in neither", () => {
    const Positive = Schema.FiniteFromString.check(Schema.isGreaterThan(0));

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "numbers" },
        Action.make("read", {
          description: "Read",
          access: "read",
          input: Positive,
          // An anonymous filter on the decoded side does not block persistence either.
          success: Schema.FiniteFromString.check(Schema.makeFilter((n) => n > 0)),
        }),
      ),
    );

    const [entry] = catalog.actions;
    expect(entry?.input.jsonSchema).toEqual({
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      type: "string",
    });
    expect(entry?.input.representation).toMatchObject({ representation: { checks: [] } });
    expect(entry?.success.representation).toBeDefined();

    const revived = SchemaRepresentation.fromRepresentation(
      SchemaRepresentation.fromJson(entry?.input.representation ?? null),
      { revivers: [] },
    );

    const decode = Schema.decodeUnknownExit(Schema.make<Schema.Codec<unknown>>(revived.ast));
    expect(decode("-1")._tag).toBe("Success");
    expect(Schema.decodeUnknownExit(Positive)("-1")._tag).toBe("Failure");
  });

  it("leaves annotations to Effect: JSON persisted verbatim, the rest omitted", () => {
    interface Cyclic {
      readonly name: string;
      self?: Cyclic;
    }

    const cyclic: Cyclic = { name: "cyclic" };
    cyclic.self = cyclic;

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "codes" },
        Action.make("read", {
          description: "Read",
          access: "read",
          success: Schema.String.annotate({
            acme: { checks: [{ note: "data, not a check" }] },
            at: new Date(0),
            cyclic,
          }),
        }),
      ),
    );

    expect(catalog.actions[0]?.success.representation).toMatchObject({
      representation: { annotations: { acme: { checks: [{ note: "data, not a check" }] } } },
    });
    expect(JSON.stringify(catalog)).not.toMatch(/"at"|"cyclic"/);
  });

  it("keeps the one declaration the wire form has, which revives with JsonReviver", () => {
    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "bags" },
        Action.make("read", {
          description: "Read",
          access: "read",
          success: Schema.Struct({ payload: Schema.Unknown }),
        }),
      ),
    );

    expect(() => revive(catalog.actions[0]?.success)).toThrow("effect/schema/Json");
    expect(
      revive(catalog.actions[0]?.success, [SchemaRepresentation.JsonReviver])({ payload: [1] }),
    ).toBe(true);
  });

  it("keeps same-named references local to their representations", () => {
    const Text = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" });
    const Number = Schema.Struct({ value: Schema.Finite }).annotate({ identifier: "Shared" });

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "text" },
        Action.make("read", { description: "Text", access: "write", success: Text }),
      ),
      ActionGroup.make(
        { name: "number" },
        Action.make("read", { description: "Number", access: "write", success: Number }),
      ),
    );

    const text = revive(catalog.actions[0]?.success);
    const number = revive(catalog.actions[1]?.success, [SchemaRepresentation.isFiniteReviver]);

    expect([text({ value: "a" }), text({ value: 1 })]).toEqual([true, false]);
    expect([number({ value: "a" }), number({ value: 1 })]).toEqual([false, true]);
  });

  it("owns only its group/action namespace, not a server's tool registry", () => {
    const Read = Action.make("read", {
      description: "Read",
      access: "write",
      success: Schema.String,
    });

    const First = ActionGroup.make({ name: "first" }, Read);
    const Second = ActionGroup.make({ name: "second" }, Read);

    expect(ActionCatalog.make(First, Second).actions).toHaveLength(2);
    expect(() => ActionCatalog.make(First, First)).toThrow("Duplicate catalog group");
    expect(ActionCatalog.make()).toEqual({ version: "2", actions: [] });
  });
});
