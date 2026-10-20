import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { McpServer } from "effect/ai";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import { mcpRequest } from "../support/requests.js";
import { serve } from "../support/serve.js";

const Count = Action.make("count", { description: "Count", readOnly: true, caller: Action.Anyone });

const counting = Action.implement(Count, () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;

    yield* server.notifications["notifications/progress"]({ progressToken: "p", progress: 1 });
  }),
);

describe("a handler's progress notification on 2026-07-28", () => {
  it("is sent with the token its request carried alone, and the call answered either way", async () => {
    const web = serve(ActionMcp.layerHttp(counting, { name: "progress", version: "0" }));

    const sentFor = async (meta: { readonly progressToken?: string }) => {
      const response = await web.handler(
        mcpRequest({ method: "tools/call", params: { name: "count", arguments: {}, _meta: meta } }),
      );

      const text = await response.text();

      return [
        response.status,
        text.includes('"method":"notifications/progress"'),
        text.includes('"isError":false'),
      ];
    };

    expect(await sentFor({ progressToken: "p" })).toEqual([200, true, true]);
    expect(await sentFor({ progressToken: "q" })).toEqual([200, false, true]);
    expect(await sentFor({})).toEqual([200, false, true]);
  });
});
