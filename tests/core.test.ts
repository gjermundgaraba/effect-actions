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
    expect(GetUser.mcp).toEqual({
      name: "get_user",
      readOnly: true,
      destructive: false,
      idempotent: false,
      openWorld: true,
    });
    expect(RenameUser.mcp).toEqual({
      name: "rename_user",
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: true,
    });

    const Write = Action.make("write", {
      description: "Default hints",
      access: "write",
      success: Schema.String,
    });

    expect(Write.mcp).toEqual({
      name: "write",
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: true,
    });
    expect(Write.http).toBe(true);
  });

  it("rejects invalid names at definition time", () => {
    for (const name of ["bad name", "then"]) {
      expect(() =>
        Action.make(name, { description: "", access: "write", success: Schema.String }),
      ).toThrow("Invalid action name");
    }

    expect(() => ActionGroup.make({ name: "then" })).toThrow("Invalid action group name");
    expect(() =>
      Action.make("ok", {
        description: "",
        access: "write",
        success: Schema.String,
        mcp: { name: "bad name" },
      }),
    ).toThrow("Invalid MCP name");
    expect(() =>
      Action.make("ok", {
        description: "",
        access: "write",
        success: Schema.String,
        mcp: { name: "then" },
      }),
    ).toThrow("Invalid MCP name");
  });

  it("accepts relaxed HTTP segment names and keeps MCP validation independent", () => {
    expect(
      Action.make("1st", { description: "", access: "write", success: Schema.String }).name,
    ).toBe("1st");
    expect(
      Action.make("_private", { description: "", access: "write", success: Schema.String }).name,
    ).toBe("_private");
    expect(
      ActionGroup.make(
        { name: "9_group" },
        Action.make("_action", { description: "", access: "write", success: Schema.String }),
      ).name,
    ).toBe("9_group");
    expect(
      Action.make("x".repeat(129), {
        description: "Long HTTP-only action",
        access: "write",
        success: Schema.String,
        mcp: false,
      }).mcp,
    ).toBe(false);
  });

  it("rejects duplicate names at definition time", () => {
    expect(() => ActionGroup.make({ name: "users" }, GetUser, GetUser)).toThrow("Duplicate action");

    const Alias = Action.make("alias", {
      description: "Alias collision",
      access: "write",
      success: Schema.String,
      mcp: { name: "get_user" },
    });

    expect(() => ActionGroup.make({ name: "users" }, GetUser, Alias)).toThrow("Duplicate MCP");
    expect(() => ActionGroup.make({ name: "bad name" }, GetUser)).toThrow(
      "Invalid action group name",
    );
  });
});

describe("implementations", () => {
  const Hello = Action.make("hello", {
    description: "Greets",
    access: "write",
    input: Schema.Struct({ name: Schema.String }),
    success: Schema.String,
  });

  const Group = ActionGroup.make({ name: "greetings" }, Hello);

  const request = (prefix: string) =>
    new Request(`http://localhost${prefix}/greetings/hello`, {
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

  const Pair = ActionGroup.make(
    { name: "pair" },
    Hello,
    Action.make("bye", { description: "Parts", access: "write", success: Schema.String }),
  );

  // A class instance's handlers are inherited methods, called with the instance as `this`.
  class PairHandlers {
    readonly greeting = "hi";

    hello(): Effect.Effect<string> {
      return Effect.succeed(this.greeting);
    }

    bye(): Effect.Effect<string> {
      return Effect.succeed(`${this.greeting}, bye`);
    }
  }

  // An action named after what every object inherits from `Object.prototype`.
  const Named = ActionGroup.make(
    { name: "pair" },
    Hello,
    Action.make("toString", { description: "Names", access: "read", success: Schema.String }),
  );

  // The types require a function for every action; plain JavaScript, a cast or a record
  // changed after it was typed can still bind something else.
  const withBye = (bye: string | undefined) => {
    const handlers = { hello: () => Effect.succeed("hi"), bye: () => Effect.succeed("bye") };
    Reflect.set(handlers, "bye", bye);

    return handlers;
  };

  const withoutBye = () => {
    const handlers = { hello: () => Effect.succeed("hi"), bye: () => Effect.succeed("bye") };
    Reflect.deleteProperty(handlers, "bye");

    return handlers;
  };

  const withoutToString = () => {
    const handlers = { hello: () => Effect.succeed("hi"), toString: () => Effect.succeed("") };
    Reflect.deleteProperty(handlers, "toString");

    return handlers;
  };

  it.each([
    {
      handlers: "a missing key",
      web: () => makeTestHttp(Pair.implement(withoutBye()), Layer.empty, { apiPath: "/api" }),
      missing: "bye",
    },
    {
      handlers: "an undefined value",
      web: () => makeTestHttp(Pair.implement(withBye(undefined)), Layer.empty, { apiPath: "/api" }),
      missing: "bye",
    },
    {
      handlers: "a non-function value",
      web: () => makeTestHttp(Pair.implement(withBye("bye")), Layer.empty, { apiPath: "/api" }),
      missing: "bye",
    },
    {
      handlers: "a builder Effect's record with a missing key",
      web: () =>
        makeTestHttp(Pair.implement(Effect.sync(withoutBye)), Layer.empty, { apiPath: "/api" }),
      missing: "bye",
    },
    {
      handlers: "a missing key only Object.prototype supplies",
      web: () => makeTestHttp(Named.implement(withoutToString()), Layer.empty, { apiPath: "/api" }),
      missing: "toString",
    },
    {
      handlers: "a class instance whose methods use `this`",
      web: () => makeTestHttp(Pair.implement(new PairHandlers()), Layer.empty, { apiPath: "/api" }),
      missing: undefined,
    },
  ])("checks $handlers before serving anything", async ({ web, missing }) => {
    // A plain record is refused by `implement`; a builder's record by the adapter build.
    // Either way no request reaches a handler, not even the action that has one.
    const hello = async () => {
      const { handler, dispose } = web();
      onTestFinished(() => dispose());

      const response = await handler(
        new Request("http://localhost/api/pair/hello", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ada" }),
        }),
      );

      return response.json();
    };

    if (missing === undefined) {
      expect(await hello()).toBe("hi");
    } else {
      await expect(hello()).rejects.toThrow(`Missing handlers for group "pair": ${missing}`);
    }
  });

  it("keeps same-contract implementations apart", async () => {
    const appA = Group.implement({ hello: () => Effect.succeed("from A") });
    const appB = Group.implement({ hello: () => Effect.succeed("from B") });

    const web = HttpRouter.toWebHandler(
      Layer.mergeAll(
        ActionHttp.make({ apiPath: "/a" }, Group).layer([appA]),
        ActionHttp.make({ apiPath: "/b" }, Group).layer([appB]),
      ).pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );

    onTestFinished(() => web.dispose());
    expect(await (await web.handler(request("/a"))).json()).toBe("from A");
    expect(await (await web.handler(request("/b"))).json()).toBe("from B");
  });

  it("routes prototype-sensitive action names through native HTTP", async () => {
    const Proto = ActionGroup.make(
      { name: "safe" },
      Action.make("__proto__", {
        description: "Prototype-safe",
        access: "write",
        success: Schema.String,
      }),
    );

    const app = Proto.implement({ ["__proto__"]: () => Effect.succeed("safe") });

    const web = HttpRouter.toWebHandler(
      ActionHttp.make({ apiPath: "/api" }, Proto)
        .layer([app])
        .pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );

    onTestFinished(() => web.dispose());

    const response = await web.handler(
      new Request("http://localhost/api/safe/__proto__", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(await response.json()).toBe("safe");
  });
});
