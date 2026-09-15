import assert from "node:assert/strict";
import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  McpServer,
  createMcpHandler,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

const Input = Schema.Struct({ amount: Schema.FiniteFromString });
const Output = Schema.Struct({ doubled: Schema.Finite });
const standard = Input.pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1);
const compatible: StandardSchemaWithJSON<{ readonly amount: string }, { readonly amount: number }> =
  standard;
assert.deepEqual(await compatible["~standard"].validate({ amount: "21" }), {
  value: { amount: 21 },
});
console.log(
  "standard input:",
  JSON.stringify(compatible["~standard"].jsonSchema.input({ target: "draft-2020-12" })),
);
console.log(
  "standard output:",
  JSON.stringify(compatible["~standard"].jsonSchema.output({ target: "draft-2020-12" })),
);
const server = new McpServer({ name: "schema-spike", version: "1.0.0" });
server.registerTool("double", { inputSchema: standard }, async ({ amount }) => ({
  content: [{ type: "text", text: String(amount * 2) }],
}));
console.log("SDK v2 registerTool: accepted Effect Standard Schema + Standard JSON Schema");

const Double = Tool.make("double", { parameters: Input, success: Output });
const toolkit = Toolkit.make(Double);
const handlers = toolkit.toLayer({
  double: ({ amount }) => Effect.succeed({ doubled: amount * 2 }),
});
const results = await Effect.runPromise(
  Effect.gen(function* () {
    const ready = yield* toolkit;
    return yield* ready.handle("double", { amount: "21" }).pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(Effect.provide(handlers)),
);
assert.equal(results.length, 1);
assert.deepEqual(results[0]?.encodedResult, { doubled: 42 });
console.log(
  "Toolkit.handle: decoded wire input, executed handler, encoded output",
  JSON.stringify(results),
);
console.log(
  "empty Struct MCP schema:",
  JSON.stringify(Tool.getJsonSchema(Tool.make("empty", { parameters: Schema.Struct({}) }))),
);
console.log(
  "EmptyParams MCP schema:",
  JSON.stringify(Tool.getJsonSchema(Tool.make("none", { parameters: Tool.EmptyParams }))),
);

const http = createMcpHandler(() => {
  const s = new McpServer({ name: "wire-spike", version: "1.0.0" });
  s.registerTool("double", { inputSchema: standard }, async ({ amount }) => ({
    content: [{ type: "text", text: String(amount * 2) }],
  }));
  return s;
});
for (const [method, params] of [
  ["tools/list", {}],
  ["tools/call", { name: "double", arguments: { amount: "21" } }],
  ["tools/call", { name: "double", arguments: { amount: "not-a-number" } }],
] as const) {
  const response = await http.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const wire = await response.text();
  assert.equal(response.status, 200);
  if (method === "tools/list") assert.match(wire, /"amount":\{"type":"string"/);
  if (method === "tools/call" && params.arguments.amount === "21")
    assert.match(wire, /"text":"42"/);
  if (method === "tools/call" && params.arguments.amount !== "21")
    assert.match(wire, /isError|"error"/);
  console.log(method, response.status, wire);
}
await http.close();
