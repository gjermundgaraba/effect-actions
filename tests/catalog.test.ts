import { describe, expect, it } from "vite-plus/test";
import { JsonSchema, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionCatalog from "../src/ActionCatalog.js";

describe("offline action catalog", () => {
  it("describes encoded values without binding handlers or adding transport envelopes", () => {
    const Double = Action.make("double", {
      description: "Double a number encoded as a string",
      access: "write",
      input: { n: Schema.FiniteFromString },
      success: Schema.FiniteFromString,
      errors: [Schema.FiniteFromString],
      mcp: { idempotent: true, openWorld: false },
    });

    const catalog = ActionCatalog.make([Double]);
    expect(catalog.version).toBe("5");
    expect(catalog.actions).toHaveLength(1);
    // Exactly these fields: the catalog describes contracts, not transports.
    expect(Object.keys(catalog.actions[0] ?? {})).toEqual([
      "name",
      "description",
      "access",
      "mcp",
      "input",
      "success",
      "errors",
    ]);
    expect(catalog.actions[0]).toMatchObject({
      name: "double",
      description: "Double a number encoded as a string",
      access: "write",
      mcp: {
        readOnly: false,
        destructive: true,
        idempotent: true,
        openWorld: false,
      },
      input: { type: "object", properties: { n: { type: "string" } } },
      success: { type: "string" },
      errors: [{ type: "string" }],
    });
    expect(Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(catalog)))).toEqual(
      catalog,
    );
  });

  it("keeps same-named definitions local to their schema documents", () => {
    const Text = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" });
    const Number = Schema.Struct({ value: Schema.Finite }).annotate({ identifier: "Shared" });

    const catalog = ActionCatalog.make([
      Action.make("text", { description: "Text", access: "write", success: Text }),
      Action.make("number", { description: "Number", access: "read", success: Number }),
    ]);

    expect(catalog.actions.map((entry) => [entry.name, entry.access])).toEqual([
      ["text", "write"],
      ["number", "read"],
    ]);
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

    const catalog = ActionCatalog.make([
      Action.make("read", {
        description: "Read",
        access: "read",
        input: Text,
        success: Number,
        errors: [Text],
      }),
    ]);

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

    const catalog = ActionCatalog.make([
      Action.make("read", {
        description: "Recursive tree",
        access: "write",
        input: Node,
        success: Node,
      }),
    ]);

    expect(catalog.actions[0]?.input).toMatchObject({
      $ref: "#/$defs/acme~1Node~0x",
      $defs: {
        "acme/Node~x": {
          properties: { children: { items: { $ref: "#/$defs/acme~1Node~0x" } } },
        },
      },
    });
  });

  it("lists each action's own errors, and its hints", () => {
    const Own = Schema.Literal("own");

    const catalog = ActionCatalog.make([
      Action.make("read", {
        description: "Read",
        access: "read",
        success: Schema.String,
        errors: [Own],
      }),
      Action.make("write", {
        description: "Write",
        access: "write",
        success: Schema.String,
      }),
    ]);

    expect(catalog.actions[0]?.errors).toMatchObject([{ enum: ["own"] }]);
    expect(catalog.actions[1]).toEqual(
      expect.objectContaining({
        access: "write",
        errors: [],
        mcp: { readOnly: false, destructive: true, idempotent: false, openWorld: true },
      }),
    );
  });

  it("preserves dictionary values instead of projecting an empty object", () => {
    const catalog = ActionCatalog.make([
      Action.make("read", {
        description: "Read values by arbitrary key",
        access: "write",
        input: Schema.Record(Schema.String, Schema.FiniteFromString),
        success: Schema.Record(Schema.String, Schema.Finite),
      }),
    ]);

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
    const catalog = ActionCatalog.make([
      Action.make("read", {
        description: "Read",
        access: "read",
        success: Schema.Struct({
          at: Schema.Date,
          note: Schema.Option(Schema.String),
          count: Schema.BigInt,
        }),
      }),
    ]);

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

    const catalog = ActionCatalog.make([
      Action.make("read", { description: "Read", access: "read", success: StartsWithX }),
    ]);

    expect(catalog.actions[0]?.success).toMatchObject({ type: "string", pattern: "^X" });
  });

  it("does not describe checks on the decoded side of a transformation", () => {
    const Positive = Schema.FiniteFromString.check(Schema.isGreaterThan(0));

    const catalog = ActionCatalog.make([
      Action.make("read", {
        description: "Read",
        access: "read",
        input: Positive,
        success: Positive,
      }),
    ]);

    expect(catalog.actions[0]?.input).toEqual({
      $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
      type: "string",
    });
    expect(Schema.decodeUnknownExit(Positive)("-1")._tag).toBe("Failure");
  });

  it("refuses equal action names", () => {
    const read = () =>
      Action.make("read", {
        description: "Read",
        access: "write",
        success: Schema.String,
      });

    const Read = read();

    const Other = Action.make("other", {
      description: "Other",
      access: "read",
      success: Schema.String,
    });

    expect(ActionCatalog.make([Read, Other]).actions).toHaveLength(2);
    expect(() => ActionCatalog.make([Read, read()])).toThrow("Duplicate action: read");
    expect(() => ActionCatalog.make([Read, Read])).toThrow("Duplicate action: read");
    expect(ActionCatalog.make([])).toEqual({ version: "5", actions: [] });
  });
});
