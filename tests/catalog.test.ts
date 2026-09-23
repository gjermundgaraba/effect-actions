import { describe, expect, it } from "vite-plus/test";
import { JsonSchema, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionCatalog from "../src/ActionCatalog.js";

describe("offline action catalog", () => {
  it("describes encoded values without binding handlers or adding transport envelopes", () => {
    const Group = ActionGroup.make(
      { name: "numbers" },
      Action.make("double", {
        description: "Double a number encoded as a string",
        access: "write",
        input: Schema.Struct({ n: Schema.FiniteFromString }),
        success: Schema.FiniteFromString,
        errors: [Schema.FiniteFromString],
        mcp: { name: "double_number", idempotent: true, openWorld: false },
      }),
    );

    const catalog = ActionCatalog.make(Group);
    expect(catalog.version).toBe("4");
    expect(catalog.actions).toHaveLength(1);
    expect(catalog.actions[0]).toMatchObject({
      id: "numbers.double",
      group: "numbers",
      name: "double",
      mcp: { name: "double_number", idempotent: true, openWorld: false },
      input: { type: "object", properties: { n: { type: "string" } } },
      success: { type: "string" },
      errors: [{ type: "string" }],
      httpSchemaErrors: [],
    });
    expect(catalog.actions[0]).not.toHaveProperty("http");
    expect(Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(catalog)))).toEqual(
      catalog,
    );
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
    expect(catalog.actions[0]?.success).toMatchObject({
      $ref: "#/$defs/Shared",
      $defs: { Shared: { properties: { value: { type: "string" } } } },
    });
    expect(catalog.actions[1]?.success).toMatchObject({
      $ref: "#/$defs/Shared",
      $defs: { Shared: { properties: { value: { type: "number" } } } },
    });
  });

  it("isolates equal identifiers across fields of a single entry", () => {
    const Text = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" });
    const Number = Schema.Struct({ value: Schema.Finite }).annotate({ identifier: "Shared" });

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "fields" },
        Action.make("read", {
          description: "Read",
          access: "read",
          input: Text,
          success: Number,
          errors: [Text],
        }),
      ),
    );

    const [entry] = catalog.actions;

    expect(entry?.input).toMatchObject({
      $ref: "#/$defs/Shared",
      $defs: { Shared: { properties: { value: { type: "string" } } } },
    });
    expect(entry?.success).toMatchObject({
      $ref: "#/$defs/Shared",
      $defs: { Shared: { properties: { value: { type: "number" } } } },
    });
    expect(entry?.errors[0]).toEqual(entry?.input);
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

    expect(catalog.actions[0]?.input).toMatchObject({
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
      {
        name: "errors",
        errors: [Shared],
        schemaError: {
          invalid: { schema: Policy, make: () => "invalid" as const },
          internal: { schema: Policy, make: () => "invalid" as const },
        },
      },
      Action.make("read", {
        description: "Read",
        access: "write",
        success: Schema.String,
        errors: [Own],
      }),
      Action.make("hidden", {
        description: "Hidden from MCP",
        access: "write",
        success: Schema.String,
        mcp: false,
      }),
    );

    const catalog = ActionCatalog.make(Group);

    expect(catalog.actions[0]?.errors).toMatchObject([{ enum: ["own"] }, { enum: ["shared"] }]);
    expect(catalog.actions[0]?.httpSchemaErrors).toMatchObject([{ enum: ["invalid"] }]);
    expect(catalog.actions[1]).toMatchObject({
      mcp: false,
      httpSchemaErrors: [{ enum: ["invalid"] }],
    });
    expect(catalog.actions[1]?.errors).toMatchObject([{ enum: ["shared"] }]);
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

    expect(catalog.actions[0]?.input).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
    });
    expect(catalog.actions[0]?.success).toMatchObject({
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  it("describes JSON wire forms for dates, options, and bigint", () => {
    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "stamps" },
        Action.make("read", {
          description: "Read",
          access: "read",
          success: Schema.Struct({
            at: Schema.Date,
            note: Schema.Option(Schema.String),
            count: Schema.BigInt,
          }),
        }),
      ),
    );

    expect(catalog.actions[0]?.success).toMatchObject({
      type: "object",
      properties: { at: { type: "string" }, count: { type: "string" } },
    });
    expect(JSON.stringify(catalog.actions[0]?.success)).toContain('"Some"');
  });

  it("keeps what a filter declares for JSON Schema", () => {
    const StartsWithX = Schema.String.check(
      Schema.makeFilter((text) => text.startsWith("X"), {
        toJsonSchema: () => ({ pattern: "^X" }),
      }),
    );

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "codes" },
        Action.make("read", { description: "Read", access: "read", success: StartsWithX }),
      ),
    );

    expect(catalog.actions[0]?.success).toMatchObject({ type: "string", pattern: "^X" });
  });

  it("does not describe checks on the decoded side of a transformation", () => {
    const Positive = Schema.FiniteFromString.check(Schema.isGreaterThan(0));

    const catalog = ActionCatalog.make(
      ActionGroup.make(
        { name: "numbers" },
        Action.make("read", {
          description: "Read",
          access: "read",
          input: Positive,
          success: Positive,
        }),
      ),
    );

    expect(catalog.actions[0]?.input).toEqual({
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      type: "string",
    });
    expect(Schema.decodeUnknownExit(Positive)("-1")._tag).toBe("Failure");
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
    expect(ActionCatalog.make()).toEqual({ version: "4", actions: [] });
  });
});
