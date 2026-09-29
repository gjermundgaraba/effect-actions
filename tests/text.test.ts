import { describe, expect, it, onTestFinished } from "vite-plus/test";
import {
  Context,
  Effect,
  Exit,
  Layer,
  Predicate,
  Schedule,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { mcpCall, mcpRequest } from "../src/Testing.js";
import { withMcpClient } from "../src/TestingClient.js";
import { rawToolCall } from "./requests.js";
import { testMcpPath, testMcpUrl } from "./server.js";

class Principal extends Context.Service<Principal, string>()("text-test/Principal") {}

class PageNotFound extends Schema.TaggedError<PageNotFound>()(
  "PageNotFound",
  { url: Schema.String },
  { httpApiStatus: 404 },
) {}

class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

const Page = Schema.Struct({
  body: Schema.String,
  end: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  owner: Schema.String,
});

const Input = Schema.Struct({ url: Schema.String });

const page = (access: Action.Access) => ({
  description: "Fetch one page of a document.",
  input: Input,
  success: Page,
  errors: [PageNotFound],
  access,
});

const Fetch = Action.make("fetch", { ...page("read"), mcp: { text: "body" } });

const Store = Action.make("store", { ...page("write"), mcp: { text: "body" } });

// Structured twins: every answer but success must be the one a text tool gives.
const FetchJson = Action.make("fetchJson", page("read"));

const StoreJson = Action.make("storeJson", page("write"));

// The text field is the only required key, and optional in `excerpt`.
const Head = Action.make("head", {
  description: "The start of a document.",
  access: "read",
  input: Input,
  success: Schema.Struct({ markdown: Schema.String, next: Schema.optionalKey(Schema.String) }),
  mcp: { text: "markdown" },
});

const Excerpt = Action.make("excerpt", {
  description: "An excerpt of a document, when it has one.",
  access: "read",
  input: Input,
  success: Schema.Struct({ markdown: Schema.optionalKey(Schema.String), url: Schema.String }),
  mcp: { text: "markdown" },
});

const Pages = ActionGroup.make(
  { name: "pages" },
  Fetch,
  Store,
  FetchJson,
  StoreJson,
  Head,
  Excerpt,
);

const tricky = ' leading\n"quoted" \\ é 😀   trailing\t ';

const fetchPage = ({ url }: typeof Input.Type) =>
  Effect.gen(function* () {
    const owner = yield* Principal;

    if (url === "missing") return yield* new PageNotFound({ url });

    // `invalid` breaks the success schema's check, so it cannot be encoded.
    return { body: tricky, end: url === "invalid" ? -1 : tricky.length, owner };
  });

const app = Pages.implement({
  fetch: fetchPage,
  store: fetchPage,
  fetchJson: fetchPage,
  storeJson: fetchPage,
  head: () => Effect.succeed({ markdown: tricky }),
  excerpt: ({ url }) => Effect.succeed(url === "none" ? { url } : { markdown: tricky, url }),
});

const rest = { end: tricky.length, owner: "ada" };

/** Refuses writes, so a hook refusal is exercised on both result shapes. */
const before = (action: Action.Any) =>
  action.access === "write" ? Effect.fail(new Forbidden({ message: "Read only." })) : Effect.void;

const server = { name: "pages", version: "1.0.0" } as const;

const serveHttp = () => {
  const web = HttpRouter.toWebHandler(
    ActionMcp.layerHttp([app], { ...server, path: testMcpPath, errors: [Forbidden], before }).pipe(
      HttpRouter.provideRequest(Layer.succeed(Principal, "ada")),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  onTestFinished(() => web.dispose());

  return web;
};

/** One `tools/call` to an in-memory stdio server; its first output line. */
const callStdio = async (name: string, args: Schema.Json) => {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
      },
    },
  });

  let written = "";
  const decoder = new TextDecoder();

  const layer = ActionMcp.layerStdio([app], { ...server, errors: [Forbidden], before }).pipe(
    Layer.provide(Layer.succeed(Principal, "ada")),
    Layer.provide(
      Stdio.layerTest({
        // Standard input stays open, as a host's does, so the server keeps running.
        stdin: Stream.concat(Stream.make(new TextEncoder().encode(`${request}\n`)), Stream.never),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              written += Predicate.isString(chunk) ? chunk : decoder.decode(chunk);
            }),
          ),
      }),
    ),
  );

  const replied = Effect.suspend(() =>
    written.includes("\n") ? Effect.void : Effect.fail("no reply yet"),
  ).pipe(Effect.retry(Schedule.spaced("5 millis")));

  await Effect.runPromise(Effect.raceFirst(Layer.launch(layer), replied));

  return written.slice(0, written.indexOf("\n"));
};

const Reply = Schema.fromJsonString(Schema.Struct({ result: Schema.Json }));

const resultOf = async (response: Response): Promise<Schema.Json> =>
  Schema.decodeUnknownSync(Reply)(await response.text()).result;

describe("MCP text fields", () => {
  it("send the field once, raw, before the structured rest and its JSON copy", async () => {
    const web = serveHttp();
    const message = (await (await web.handler(rawToolCall("fetch", { url: "a" }))).text()).trim();

    expect(JSON.parse(message)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        _meta: { "io.modelcontextprotocol/serverInfo": server },
        resultType: "complete",
        isError: false,
        structuredContent: rest,
        content: [
          { type: "text", text: tricky },
          { type: "text", text: JSON.stringify(rest) },
        ],
      },
    });
    // Re-serializing the parsed message reproduces the bytes sent, so a result's encoded
    // size can be measured from the parsed object.
    expect(JSON.stringify(JSON.parse(message))).toBe(message);
    // Over stdio the same message is one line.
    expect(await callStdio("fetch", { url: "a" })).toBe(message);
  });

  it("list an output schema without the field", async () => {
    const web = serveHttp();

    const Listed = Schema.fromJsonString(
      Schema.Struct({
        result: Schema.Struct({ tools: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
      }),
    );

    const { tools } = Schema.decodeUnknownSync(Listed)(
      await (await web.handler(mcpRequest({ url: testMcpUrl, method: "tools/list" }))).text(),
    ).result;

    const outputSchema = (name: string) => tools.find((tool) => tool.name === name)?.outputSchema;

    const { properties, required } = Schema.decodeUnknownSync(
      Schema.Struct({
        properties: Schema.Record(Schema.String, Schema.Json),
        required: Schema.Array(Schema.String),
      }),
    )(outputSchema("fetch"));

    expect(Object.keys(properties)).toEqual(["end", "owner"]);
    expect(required).toEqual(["end", "owner"]);
    expect(outputSchema("fetchJson")).toHaveProperty("properties.body");
    expect(outputSchema("head")).toMatchObject({ properties: { next: { type: "string" } } });
    expect(outputSchema("head")).not.toHaveProperty("required");
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

  it("are returned by mcpCall with the structured rest as the value", async () => {
    const web = serveHttp();

    const call = (name: string) =>
      mcpCall(web.handler, { url: testMcpUrl, name, arguments: { url: "a" } });

    expect(await call("fetch")).toEqual({ isError: false, value: rest, text: tricky });
    expect(await call("fetchJson")).toEqual({ isError: false, value: { body: tricky, ...rest } });
  });

  it("send a success without the field whole", async () => {
    const web = serveHttp();

    const call = (url: string) =>
      mcpCall(web.handler, { url: testMcpUrl, name: "excerpt", arguments: { url } });

    expect(await call("a")).toEqual({ isError: false, value: { url: "a" }, text: tricky });
    expect(await call("none")).toEqual({ isError: false, value: { url: "none" } });
  });

  it("are accepted by the official client, which checks results against the listed schema", async () => {
    const web = serveHttp();

    const called = await withMcpClient(
      { fetch: web.handler, path: testMcpPath },
      async (client) => {
        // The client validates structured content only against a listed output schema.
        await client.listTools();

        return Promise.all(
          ["fetch", "head"].map((name) => client.callTool({ name, arguments: { url: "a" } })),
        );
      },
    );

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
    const binding = ActionToolkit.make([app]);

    const called = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* binding.toolkit;
          const calls = yield* tools.handle("fetch", { url: "a" });

          return yield* Stream.runCollect(calls);
        }).pipe(Effect.provide(binding.layer), Effect.provideService(Principal, "ada")),
      ),
    );

    expect(called).toMatchObject([{ result: { body: tricky, ...rest }, isFailure: false }]);
  });

  it("refuse a field that is not a top-level property when the layer is built", async () => {
    const Either = Action.make("either", {
      description: "A union has no top-level properties",
      access: "read",
      success: Schema.Union([
        Schema.Struct({ body: Schema.String, kind: Schema.Literal("a") }),
        Schema.Struct({ body: Schema.String, kind: Schema.Literal("b") }),
      ]),
      mcp: { text: "body" },
    });

    const layer = ActionMcp.layerStdio(
      [
        ActionGroup.make({ name: "either" }, Either).implement({
          either: () => Effect.succeed({ body: "x", kind: "a" as const }),
        }),
      ],
      server,
    ).pipe(Layer.provide(Stdio.layerTest({})));

    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)));

    expect(Exit.isFailure(exit) ? String(exit.cause) : "built").toContain(
      "MCP tool 'either' cannot send 'body' as text: it is not a top-level property of its success",
    );
  });
});
