import { expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect } from "effect";

import { Http } from "../src/Api.js";
import { Greet } from "../src/greeting/Greeting.js";
import { routes } from "../src/routes.js";

it.effect("greets over HTTP and as an MCP tool", () =>
  Effect.gen(function* () {
    const http = yield* ActionHttp.client(Http);
    const mcp = yield* ActionMcp.client([Greet]);

    expect(yield* http.greet({ name: "Ada" })).toBe("Hello, Ada!");
    expect(yield* mcp.greet({ name: "Ada" })).toBe("Hello, Ada!");
  }).pipe(Effect.provide(Testing.layer(routes)))
);
