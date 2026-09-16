import { withMcpClient } from "@gjermundgaraba/effect-actions/testing/client";
import { Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { routes } from "./quickstart.js";

const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
  disableLogger: true,
});
try {
  await withMcpClient(web.handler, async (client) => {
    const reply = await client.callTool({ name: "greet", arguments: { name: "Ada" } });
    if (
      Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }))(reply.structuredContent)
        .value !== "Hello, Ada!"
    )
      throw new Error("Official MCP client failed");
  });
} finally {
  await web.dispose();
}
