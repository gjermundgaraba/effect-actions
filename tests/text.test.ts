import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Testing from "../src/Testing.js";
import { withMcpClient } from "./mcp-client.js";
import { mcpRequest, rawToolCall } from "./requests.js";
import { defectOf } from "./defect.js";
import { serve } from "./serve.js";
import { converse } from "./stdio-host.js";

class Principal extends Context.Service<Principal, string>()("text-test/Principal") {}

class PageNotFound extends Schema.TaggedError<PageNotFound>()(
  "PageNotFound",
  { url: Schema.String },
  { httpApiStatus: 404 },
) {}

const Page = Schema.Struct({
  body: Schema.String,
  end: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  owner: Schema.String,
});

const page = (access: Action.Access) => ({
  description: "Fetch one page of a document.",
  input: { url: Schema.String },
  success: Page,
  errors: [PageNotFound],
  access,
});

const Fetch = Action.make("fetch", page("read"));

const Store = Action.make("store", page("write"));

// Structured twins: every answer but success must be the one a text tool gives.
const FetchJson = Action.make("fetchJson", page("read"));

const StoreJson = Action.make("storeJson", page("write"));

// The text field is the only required key, and optional in `excerpt`.
const Head = Action.make("head", {
  description: "The start of a document.",
  access: "read",
  input: { url: Schema.String },
  success: { markdown: Schema.String, next: Schema.optionalKey(Schema.String) },
});

const Excerpt = Action.make("excerpt", {
  description: "An excerpt of a document, when it has one.",
  access: "read",
  input: { url: Schema.String },
  success: { markdown: Schema.optionalKey(Schema.String), url: Schema.String },
});

const tricky = ' leading\n"quoted" \\ é 😀   trailing\t ';

const fetchPage = ({ url }: { readonly url: string }) =>
  Effect.gen(function* () {
    const owner = yield* Principal;

    if (url === "missing") return yield* new PageNotFound({ url });

    // `invalid` breaks the success schema's check, so it cannot be encoded.
    return { body: tricky, end: url === "invalid" ? -1 : tricky.length, owner };
  });

// Refuses writes, so a hook refusal is exercised on both result shapes.
const app = Action.implement(
  [Fetch, Store, FetchJson, StoreJson, Head, Excerpt],
  {
    fetch: fetchPage,
    store: fetchPage,
    fetchJson: fetchPage,
    storeJson: fetchPage,
    head: () => Effect.succeed({ markdown: tricky }),
    excerpt: ({ url }) => Effect.succeed(url === "none" ? { url } : { markdown: tricky, url }),
  },
  (action) =>
    action.access === "write"
      ? Effect.fail(new Action.Forbidden({ message: "Read only." }))
      : Effect.void,
);

const tools = {
  fetch: { text: "body" },
  store: { text: "body" },
  head: { text: "markdown" },
  excerpt: { text: "markdown" },
} as const;

const server = { name: "pages", version: "1.0.0" } as const;

const rest = { end: tricky.length, owner: "ada" };

const endpoint = ActionMcp.layerHttp(app, { ...server, tools });

/** The endpoint in memory, as the caller `ada`. */
const serveHttp = () =>
  serve(endpoint.pipe(HttpRouter.provideRequest(Layer.succeed(Principal, "ada"))));

/** The same server over stdio, as the caller `ada`. */
const stdio = ActionMcp.runStdio(app, { ...server, tools }).pipe(
  Effect.provideService(Principal, "ada"),
);

const Reply = Schema.fromJsonString(Schema.Struct({ result: Schema.Json }));

const resultOf = async (response: Response): Promise<Schema.Json> =>
  Schema.decodeUnknownSync(Reply)(await response.text()).result;

const Listed = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({ name: Schema.String, outputSchema: Schema.optionalKey(Schema.JsonObject) }),
      ),
    }),
  }),
);

/** Each tool's listed output schema, by name, from a `tools/list` reply. */
const outputSchemas = (reply: string) =>
  new Map(
    Schema.decodeUnknownSync(Listed)(reply).result.tools.map((tool) => [
      tool.name,
      tool.outputSchema,
    ]),
  );

describe("MCP text fields", () => {
  it("send the field once, raw, before the structured rest and its JSON copy", async () => {
    const response = await serveHttp().handler(rawToolCall("fetch", { url: "a" }));
    const message = (await response.text()).trim();
    const { result } = Schema.decodeUnknownSync(Reply)(message);

    expect(result).toHaveProperty("structuredContent", rest);
    expect(result).toMatchObject({
      isError: false,
      content: [
        { type: "text", text: tricky },
        { type: "text", text: JSON.stringify(rest) },
      ],
    });
    // Re-serializing the parsed message reproduces the bytes sent, so a result's encoded
    // size can be measured from the parsed object.
    expect(JSON.stringify(JSON.parse(message))).toBe(message);
  });

  it("list an output schema without the field", async () => {
    const response = await serveHttp().handler(mcpRequest({ method: "tools/list" }));
    const listed = outputSchemas(await response.text());

    const { properties, required } = Schema.decodeUnknownSync(
      Schema.Struct({
        properties: Schema.Record(Schema.String, Schema.Json),
        required: Schema.Array(Schema.String),
      }),
    )(listed.get("fetch"));

    expect(Object.keys(properties)).toEqual(["end", "owner"]);
    expect(required).toEqual(["end", "owner"]);
    expect(listed.get("fetchJson")).toHaveProperty("properties.body");
    // The only required field was the text field: `required` goes with it.
    expect(listed.get("head")).toMatchObject({ properties: { next: { type: "string" } } });
    expect(listed.get("head")).not.toHaveProperty("required");
  });

  it.each([
    ["a declared error", "fetch", { url: "missing" }],
    ["a hook refusal", "store", { url: "a" }],
    ["invalid arguments", "fetch", { url: 1 }],
    ["an undeclared argument", "fetch", { url: "a", extra: true }],
    ["an unencodable success", "fetch", { url: "invalid" }],
  ] as const)("answer %s exactly as a structured tool does", async (_, name, args) => {
    const web = serveHttp();

    const text = await resultOf(await web.handler(rawToolCall(name, args)));
    const structured = await resultOf(await web.handler(rawToolCall(`${name}Json`, args)));

    // The native messages name the tool; nothing else may differ.
    expect(JSON.stringify(text)).toBe(
      JSON.stringify(structured).replaceAll(`'${name}Json'`, `'${name}'`),
    );
    expect(text).toMatchObject({ isError: true });
  });

  it("send a success without the field whole", async () => {
    const web = serveHttp();

    expect(await resultOf(await web.handler(rawToolCall("excerpt", { url: "none" })))).toEqual({
      _meta: { "io.modelcontextprotocol/serverInfo": server },
      resultType: "complete",
      isError: false,
      structuredContent: { url: "none" },
      content: [{ type: "text", text: JSON.stringify({ url: "none" }) }],
    });
    expect(await resultOf(await web.handler(rawToolCall("excerpt", { url: "a" })))).toMatchObject({
      structuredContent: { url: "a" },
      content: [
        { type: "text", text: tricky },
        { type: "text", text: JSON.stringify({ url: "a" }) },
      ],
    });
  });

  it.effect("send the field as text on a 2025 revision over stdio, with the rest structured", () =>
    Effect.gen(function* () {
      const [listed = "", called = ""] = yield* converse(stdio, "2025-06-18", [
        { method: "tools/list" },
        { method: "tools/call", params: { name: "fetch", arguments: { url: "a" } } },
      ]);

      expect(outputSchemas(listed).get("fetch")).toMatchObject({ required: ["end", "owner"] });
      expect(outputSchemas(listed).get("fetch")).not.toHaveProperty("properties.body");
      expect(JSON.parse(called)).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {
          isError: false,
          structuredContent: rest,
          content: [
            { type: "text", text: tricky },
            { type: "text", text: JSON.stringify(rest) },
          ],
        },
      });
    }),
  );

  it("are put back under their field by mcpClient, given the endpoint's tools", async () => {
    const whole = { body: tricky, ...rest };

    const results = await Effect.gen(function* () {
      const mcp = yield* Testing.mcpClient([Fetch, FetchJson, Head, Excerpt], { tools });

      return [
        yield* mcp.fetch({ url: "a" }),
        yield* mcp.fetchJson({ url: "a" }),
        yield* mcp.head({ url: "a" }),
        yield* mcp.excerpt({ url: "a" }),
        yield* mcp.excerpt({ url: "none" }),
      ];
    }).pipe(
      Effect.provide(Testing.layer(endpoint).pipe(Layer.provide(Layer.succeed(Principal, "ada")))),
      Effect.runPromise,
    );

    expect(results).toEqual([
      whole,
      whole,
      { markdown: tricky },
      { markdown: tricky, url: "a" },
      { url: "none" },
    ]);
  });

  it("are missing from the success mcpClient decodes without the endpoint's tools", async () => {
    const failure = await Testing.mcpClient([Fetch]).pipe(
      Effect.flatMap((mcp) => Effect.flip(mcp.fetch({ url: "a" }))),
      Effect.provide(Testing.layer(endpoint).pipe(Layer.provide(Layer.succeed(Principal, "ada")))),
      Effect.runPromise,
    );

    expect(Schema.isSchemaError(failure) && failure.message).toContain('at ["body"]');
  });

  it("are accepted by the official client, which checks results against the listed schema", async () => {
    const web = serveHttp();

    const called = await withMcpClient({ fetch: web.handler }, async (client) => {
      // The client validates structured content only against a listed output schema.
      await client.listTools();

      return Promise.all(
        ["fetch", "head"].map((name) => client.callTool({ name, arguments: { url: "a" } })),
      );
    });

    expect(called).toMatchObject([
      {
        structuredContent: rest,
        content: [
          { type: "text", text: tricky },
          { type: "text", text: JSON.stringify(rest) },
        ],
      },
      {
        structuredContent: {},
        content: [
          { type: "text", text: tricky },
          { type: "text", text: "{}" },
        ],
      },
    ]);
  });

  it("leave the Toolkit serving the whole success", async () => {
    const binding = ActionToolkit.make(app);

    const called = await Effect.gen(function* () {
      const handled = yield* binding.toolkit;

      return yield* Stream.runCollect(yield* handled.handle("fetch", { url: "a" }));
    }).pipe(
      Effect.provide(binding.layer),
      Effect.provideService(Principal, "ada"),
      Effect.runPromise,
    );

    expect(called).toMatchObject([{ result: { body: tricky, ...rest }, isFailure: false }]);
  });
});

describe("a text field MCP cannot send", () => {
  const cannot = (name: string) =>
    `MCP tool '${name}' cannot send 'body' as text: it is not a top-level property of its success`;

  it.effect("fails the layer build when its success has no such top-level property", () =>
    Effect.gen(function* () {
      // A union of one struct: an object to the types, `anyOf` to its JSON Schema.
      const Single = Action.make("single", {
        description: "A page, as a union of one struct",
        access: "read",
        success: Schema.Union([Schema.Struct({ body: Schema.String })]),
      });

      const single = Action.implement(Single, () => Effect.succeed({ body: "x" }), Action.allowAll);

      expect(
        yield* defectOf(
          Layer.build(
            ActionMcp.layerHttp(single, { ...server, tools: { single: { text: "body" } } }).pipe(
              Layer.provide(HttpRouter.layer),
            ),
          ),
        ),
      ).toBe(cannot("single"));
    }),
  );

  it.effect.each([
    [
      "a union's",
      Schema.Union([
        Schema.Struct({ body: Schema.String, kind: Schema.Literal("a") }),
        Schema.Struct({ body: Schema.String, kind: Schema.Literal("b") }),
      ]),
    ],
    ["a missing", Schema.Struct({ title: Schema.String })],
  ] as const)("fails the layer build for %s field of an erased success", ([, success]) =>
    Effect.gen(function* () {
      const Erased = Action.make("erased", {
        description: "A success the types cannot read",
        access: "read",
        success,
      });

      // Erased, as in a list of implementations typed as any: any field compiles.
      const erased: Action.Implementation<
        Action.Any,
        { readonly [name: string]: never },
        never,
        never
      > = Action.implement(
        Erased,
        () => Effect.succeed({ body: "x", kind: "a" as const }),
        Action.allowAll,
      );

      expect(
        yield* defectOf(
          Layer.build(
            ActionMcp.layerHttp(erased, { ...server, tools: { erased: { text: "body" } } }).pipe(
              Layer.provide(HttpRouter.layer),
            ),
          ),
        ),
      ).toBe(cannot("erased"));
    }),
  );

  it("refuses a tools key no served action has, where a plain object slips past the types", () => {
    // Widened, as plain JavaScript passes it.
    const stale = Object.fromEntries([["read", {}]]);

    expect(() => ActionMcp.layerHttp(app, { ...server, tools: stale })).toThrow(
      "Unknown tools: read",
    );
  });
});
