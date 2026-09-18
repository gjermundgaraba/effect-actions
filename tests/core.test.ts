import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Effect, Layer, Schema } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionHttp from "../src/ActionHttp.js";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { makeTestHttp } from "./server.js";
import { Double, GetUser, RenameUser, WhoAmI } from "../examples/contracts.js";

describe("contracts", () => {
  it("defaults to no input and errors to none", () => {
    expect(Schema.is(WhoAmI.input)({})).toBe(true);
    expect(Schema.is(WhoAmI.input)({ unexpected: 1 })).toBe(false);
    expect(WhoAmI.errors).toEqual([]);
    expect(Double.errors).toEqual([]);
  });

  it("derives MCP hints: destructive follows readOnly unless stated", () => {
    expect(GetUser.mcp).toEqual({ name: "get_user", readOnly: true, destructive: false });
    expect(RenameUser.mcp).toEqual({ name: "rename_user", readOnly: false, destructive: false });
    const Write = Action.make("write", { description: "Default hints", success: Schema.String });
    expect(Write.mcp).toEqual({ name: "write", readOnly: false, destructive: true });
    expect(Write.http).toBe(true);
  });

  it("rejects invalid names at definition time", () => {
    for (const name of ["bad name", "1st", "_private", "then"]) {
      expect(() => Action.make(name, { description: "", success: Schema.String })).toThrow(
        "Invalid action name",
      );
    }

    expect(() => ActionGroup.make({ name: "then" })).toThrow("Invalid action group name");
    expect(() =>
      Action.make("ok", { description: "", success: Schema.String, mcp: { name: "bad name" } }),
    ).toThrow("Invalid MCP name");
  });

  it("rejects duplicate names at definition time", () => {
    expect(() => ActionGroup.make({ name: "users" }, GetUser, GetUser)).toThrow("Duplicate action");

    const Alias = Action.make("alias", {
      description: "Alias collision",
      success: Schema.String,
      mcp: { name: "get_user" },
    });

    expect(() => ActionGroup.make({ name: "users" }, GetUser, Alias)).toThrow("Duplicate MCP");
    expect(() => ActionGroup.make({ name: "bad name" }, GetUser)).toThrow(
      "Invalid action group name",
    );
  });

  it("rejects an action exposed on no transport", () => {
    expect(() =>
      Action.make("nowhere", {
        description: "",
        success: Schema.String,
        http: false,
        mcp: false,
      }),
    ).toThrow("exposed on no transport");
  });
});

describe("implementations", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    input: Schema.Struct({ name: Schema.String }),
    success: Schema.String,
  });

  const Group = ActionGroup.make({ name: "greetings" }, Hello);

  const request = (prefix: string) =>
    new Request(`http://localhost${prefix}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });

  it("binds a plain handler record without exposing service bindings", async () => {
    const app = Group.implement({ hello: ({ name }) => Effect.succeed(`hi ${name}`) });
    expect(Object.keys(app)).toEqual(["group"]);
    expect(app.group).toBe(Group);
    expect(app).not.toHaveProperty("handlers");
    expect(app).not.toHaveProperty("layer");
    const web = makeTestHttp(app, Layer.empty);
    onTestFinished(() => web.dispose());
    expect(await (await web.handler(request("/api/actions"))).json()).toBe("hi Ada");
  });

  it.each(["same contract", "different contracts"])(
    "keeps implementations apart: %s",
    async (kind) => {
      const appA = Group.implement({ hello: () => Effect.succeed("from A") });

      const appB: ActionGroup.Implementation<ActionGroup.Any, never, never, never> =
        kind === "same contract"
          ? Group.implement({ hello: () => Effect.succeed("from B") })
          : ActionGroup.make(
              { name: "numeric" },
              Action.make("hello", {
                description: "Numeric",
                input: Hello.input,
                success: Schema.Number,
              }),
            ).implement({ hello: () => Effect.succeed(42) });

      const web = HttpRouter.toWebHandler(
        Layer.mergeAll(
          ActionHttp.make({ apiPath: "/a" }, appA.group).layer(appA),
          ActionHttp.make({ apiPath: "/b" }, appB.group).layer(appB),
        ).pipe(Layer.provide(HttpServer.layerServices)),
        { disableLogger: true },
      );

      onTestFinished(() => web.dispose());
      expect(await (await web.handler(request("/a"))).json()).toBe("from A");
      expect(await (await web.handler(request("/b"))).json()).toBe(
        kind === "same contract" ? "from B" : 42,
      );
    },
  );
});
