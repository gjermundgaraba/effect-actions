import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpRouter } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import { withMcpClient } from "./mcp-client.js";
import { as, mcpRequest, rawToolCall, withBearer } from "./requests.js";
import { defectOf } from "./defect.js";
import { serve } from "./serve.js";
import { converse } from "./stdio-host.js";

/** The caller every page tool reads, signed in by a bearer token naming them. */
class Principal extends Context.Service<Principal, string>()("text-test/Principal") {}

const SignIn = Authentication.make("text-test.SignIn", Principal);

/** Signs in whoever the token names. */
const signIn = Authentication.layer(SignIn, (token: Redacted.Redacted<string>) =>
  Effect.succeed(Redacted.value(token)),
);

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
  auth: Principal,
});

const Fetch = Action.make("fetch", { ...page("read"), hints: { text: "body" } });

const Store = Action.make("store", { ...page("write"), hints: { text: "body" } });

// Structured twins: every answer but success must be the one a text tool gives.
const FetchJson = Action.make("fetchJson", page("read"));

const StoreJson = Action.make("storeJson", page("write"));

// The text field is the only required key, and optional in `excerpt`.
const Head = Action.make("head", {
  description: "The start of a document.",
  access: "read",
  auth: Principal,
  input: { url: Schema.String },
  success: { markdown: Schema.String, next: Schema.optionalKey(Schema.String) },
  hints: { text: "markdown" },
});

const Excerpt = Action.make("excerpt", {
  description: "An excerpt of a document, when it has one.",
  access: "read",
  auth: Principal,
  input: { url: Schema.String },
  success: { markdown: Schema.optionalKey(Schema.String), url: Schema.String },
  hints: { text: "markdown" },
});

const tricky = ' leading\n"quoted" \\ é 😀   trailing\t ';

const fetchPage = ({ url }: { readonly url: string }) =>
  Effect.gen(function* () {
    const owner = yield* Principal;

    if (url === "missing") return yield* new PageNotFound({ url });

    // `invalid` breaks the success schema's check, so it cannot be encoded.
    return { body: tricky, end: url === "invalid" ? -1 : tricky.length, owner };
  });

// Refuses writes, so an authorizer refusal is exercised on both result shapes.
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
  {
    authorize: (action) =>
      action.access === "write"
        ? Effect.fail(new Action.Forbidden({ message: "Read only." }))
        : Effect.void,
  },
);

const server = { name: "pages", version: "1.0.0" } as const;

const rest = { end: tricky.length, owner: "ada" };

const endpoint = ActionMcp.layerHttp(app, { ...server, authentication: SignIn }).pipe(
  Layer.provide(signIn),
);

/** The endpoint in memory, each request signed in as the caller `ada`. */
const serveHttp = () => {
  const web = serve(endpoint);

  return { handler: (request: Request) => web.handler(withBearer(request, "ada")) };
};

/** The same server over stdio, as the caller `ada`. */
const stdio = ActionMcp.runStdio(app, server).pipe(Effect.provideService(Principal, "ada"));

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
  it("send the field once, raw, then the JSON of the rest, without structured content", async () => {
    const response = await serveHttp().handler(rawToolCall("fetch", { url: "a" }));
    const message = (await response.text()).trim();
    const { result } = Schema.decodeUnknownSync(Reply)(message);

    expect(result).toEqual({
      _meta: { "io.modelcontextprotocol/serverInfo": server },
      resultType: "complete",
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

  it("list no output schema for a tool with a text field", async () => {
    const response = await serveHttp().handler(mcpRequest({ method: "tools/list" }));
    const listed = outputSchemas(await response.text());

    expect(listed.get("fetch")).toBeUndefined();
    expect(listed.get("head")).toBeUndefined();
    expect(listed.has("fetch")).toBe(true);
    expect(listed.get("fetchJson")).toHaveProperty("properties.body");
  });

  it.each([
    ["a declared error", "fetch", { url: "missing" }],
    ["an authorizer refusal", "store", { url: "a" }],
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

  it("send a success without the field whole, as its JSON text alone", async () => {
    const web = serveHttp();

    expect(await resultOf(await web.handler(rawToolCall("excerpt", { url: "none" })))).toEqual({
      _meta: { "io.modelcontextprotocol/serverInfo": server },
      resultType: "complete",
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ url: "none" }) }],
    });
    expect(await resultOf(await web.handler(rawToolCall("excerpt", { url: "a" })))).toEqual({
      _meta: { "io.modelcontextprotocol/serverInfo": server },
      resultType: "complete",
      isError: false,
      content: [
        { type: "text", text: tricky },
        { type: "text", text: JSON.stringify({ url: "a" }) },
      ],
    });
  });

  it.effect("send the same two text blocks on a 2025 revision over stdio", () =>
    Effect.gen(function* () {
      const [listed = "", called = ""] = yield* converse(stdio, "2025-06-18", [
        { method: "tools/list" },
        { method: "tools/call", params: { name: "fetch", arguments: { url: "a" } } },
      ]);

      expect(outputSchemas(listed).get("fetch")).toBeUndefined();
      expect(outputSchemas(listed).get("fetchJson")).toHaveProperty("properties.body");
      expect(JSON.parse(called)).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {
          isError: false,
          content: [
            { type: "text", text: tricky },
            { type: "text", text: JSON.stringify(rest) },
          ],
        },
      });
    }),
  );

  it.effect("are read from the text blocks by mcpClient, which reads the same hints", () =>
    Effect.gen(function* () {
      const whole = { body: tricky, ...rest };
      const mcp = yield* Testing.mcpClient([Fetch, FetchJson, Head, Excerpt], as("ada"));

      const results = [
        yield* mcp.fetch({ url: "a" }),
        yield* mcp.fetchJson({ url: "a" }),
        yield* mcp.head({ url: "a" }),
        yield* mcp.excerpt({ url: "a" }),
        yield* mcp.excerpt({ url: "none" }),
      ];

      expect(results).toEqual([
        whole,
        whole,
        { markdown: tricky },
        { markdown: tricky, url: "a" },
        { url: "none" },
      ]);
    }).pipe(Effect.provide(Testing.layer(endpoint))),
  );

  it("reach the official client as text alone, with no listed schema to check", async () => {
    const web = serveHttp();

    const called = await withMcpClient({ fetch: web.handler }, async (client) => {
      // The client validates structured content only against a listed output schema.
      await client.listTools();

      return Promise.all(
        ["fetch", "head"].map((name) => client.callTool({ name, arguments: { url: "a" } })),
      );
    });

    expect(called.map((result) => "structuredContent" in result)).toEqual([false, false]);
    expect(called).toMatchObject([
      {
        content: [
          { type: "text", text: tricky },
          { type: "text", text: JSON.stringify(rest) },
        ],
      },
      {
        content: [
          { type: "text", text: tricky },
          { type: "text", text: "{}" },
        ],
      },
    ]);
  });

  it.effect("leave the Toolkit serving the whole success", () => {
    const binding = ActionToolkit.make(app);

    return Effect.gen(function* () {
      const handled = yield* binding.toolkit;
      const called = yield* Stream.runCollect(yield* handled.handle("fetch", { url: "a" }));

      expect(called).toMatchObject([{ result: { body: tricky, ...rest }, isFailure: false }]);
    }).pipe(Effect.provide(binding.layer), Effect.provideService(Principal, "ada"));
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
        auth: "public",
        success: Schema.Union([Schema.Struct({ body: Schema.String })]),
        hints: { text: "body" },
      });

      const single = Action.implement(Single, () => Effect.succeed({ body: "x" }));

      expect(
        yield* defectOf(
          Layer.build(ActionMcp.layerHttp(single, server).pipe(Layer.provide(HttpRouter.layer))),
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
  ] as const)(
    "fails the layer build for %s field named by a hint the types cannot read",
    ([, success]) =>
      Effect.gen(function* () {
        // Typed only as `string`, a hint the types leave to the layer build.
        const text: string = "body";

        const Erased = Action.make("erased", {
          description: "A success the types cannot read",
          access: "read",
          auth: "public",
          success,
          hints: { text },
        });

        const erased = Action.implement(Erased, () =>
          Effect.succeed({ body: "x", kind: "a" as const }),
        );

        expect(
          yield* defectOf(
            Layer.build(ActionMcp.layerHttp(erased, server).pipe(Layer.provide(HttpRouter.layer))),
          ),
        ).toBe(cannot("erased"));
      }),
  );
});
