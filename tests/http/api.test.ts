import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { HttpApi, OpenApi } from "effect/http-api";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";

const publicAction = (name: string) =>
  Action.make(name, {
    description: name,
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

const Protected = Action.make("protected", {
  description: "Protected",
  readOnly: true,
  caller: CurrentActor,
  success: Schema.String,
});

const combined = (
  first: ReturnType<typeof ActionHttp.make>,
  second: ReturnType<typeof ActionHttp.make>,
) => HttpApi.make("app").addHttpApi(first.api).addHttpApi(second.api);

describe("a binding's native api", () => {
  it("combined with another sharing an action name, throws when documented", () => {
    const api = combined(
      ActionHttp.make([publicAction("echo")], { prefix: "/a" }),
      ActionHttp.make([publicAction("echo")], { prefix: "/b" }),
    );

    expect(() => OpenApi.fromApi(api)).toThrow("Duplicate OpenAPI operationId: echo");
  });

  it("combined with another sharing its prefix, silently loses one binding's actions", () => {
    const api = combined(
      ActionHttp.make([publicAction("first")], { prefix: "/a" }),
      ActionHttp.make([publicAction("second")], { prefix: "/a" }),
    );

    expect(Object.keys(OpenApi.fromApi(api).paths)).toEqual(["/a/second"]);
  });

  it("documents a security scheme only for a binding holding a protected action", () => {
    const open = ActionHttp.make([publicAction("open")]);
    const guarded = ActionHttp.make([publicAction("open"), Protected], { authentication: Login });

    expect(Object.keys(OpenApi.fromApi(open.api).components.securitySchemes)).toEqual([]);
    expect(Object.keys(OpenApi.fromApi(guarded.api).components.securitySchemes)).not.toEqual([]);
  });
});
